/* eslint-disable @eslint-react/set-state-in-effect */
import {
  AccountCircleOutlined,
  CheckCircleRounded,
  ContentCopyRounded,
  HourglassTopRounded,
  MarkEmailReadRounded,
  RefreshRounded,
  ShieldRounded,
  SupportAgentRounded,
  VisibilityOffRounded,
  VisibilityRounded,
  WarningAmberRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { useLockFn } from 'ahooks'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useClashVergeGate } from '@/hooks/use-clash-verge-gate'
import { useIpInfoQuery } from '@/hooks/use-ip-info'
import { useNexthubxExitGuard } from '@/hooks/use-nexthubx-exit-guard'
import {
  requestImmediateNexthubxSync,
  useNexthubxClient,
} from '@/hooks/use-nexthubx-sync'
import { useServiceInstaller } from '@/hooks/use-service-installer'
import { useSystemState } from '@/hooks/use-system-state'
import { useVerge } from '@/hooks/use-verge'
import { isAppControlBlocked } from '@/pages/_layout/utils/notification-handlers'
import {
  isServiceAvailable,
  restartCore,
  stopOfficialClashVerge,
} from '@/services/cmds'
import {
  ActivationInvalidError,
  activate,
  confirmBind,
} from '@/services/nexthubx-api'
import { errInfo, nxDebug } from '@/services/nexthubx-debug'
import { importAndActivateProfile } from '@/services/nexthubx-profile'
import {
  loadClientState,
  loadResetNotice,
  saveClientState,
  type NexthubxResetNotice,
} from '@/services/nexthubx-store'
import { showNotice } from '@/services/notice-service'

import { EnhancedCard } from './enhanced-card'
import { TotpField } from './totp-field'

/**
 * Home「账号」卡片(最终 spec ① + 分步激活重构)。
 *
 * 激活分步:输码 → (检查 + 强制装 service) → 连接 → 验证出口 IP → 一致才显示账号信息。
 *
 *   idle       未激活 / 重激活:显示输入激活码表单
 *   verifying  激活码已校验、配置已导入:进入「验证中」(账号不显示)
 *              ├─ 子阶段 service   :检查 + 强制安装 TUN service(失败累计 > 3 → support)
 *              ├─ 子阶段 connect   :开 TUN 连接
 *              └─ 子阶段 probe     :轮询实际出口 IP,与 expectedExitIp 比对
 *   activated  出口 IP 一致 → 显示账号信息(email/password + 使用说明 + 重激活)
 *
 * 出口不一致时隐藏账号,卡内内联提示(短=校验中、持续过久=联系支持)+ 后台被动通知。
 */

type VerifyPhase = 'service' | 'support' | 'connect' | 'probe'

/** service 安装失败 / 被拒累计上限,超过即提示联系技术支持。 */
const MAX_SERVICE_RETRIES = 3

export const AccountCard = () => {
  const { t } = useTranslation()
  const { clientState, isActivated, refresh } = useNexthubxClient()
  const { isServiceOk, mutateSystemState } = useSystemState()
  const { installServiceAndRestartCore } = useServiceInstaller()
  const { verge, mutateVerge, patchVerge } = useVerge()

  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  // 「被重置」通知:席位被管理员重置/作废后常驻提示(含账号邮箱)+ 预填邮箱框。
  const [resetNotice, setResetNotice] = useState<NexthubxResetNotice | null>(
    null,
  )
  const [submitting, setSubmitting] = useState(false)
  const [reactivating, setReactivating] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  // 自助绑定:用户点「确认已绑定」时的提交态。
  const [confirmingBind, setConfirmingBind] = useState(false)

  // 分步激活态:null = 未在验证;否则处于「验证中」的某个子阶段
  const [verifyPhase, setVerifyPhase] = useState<VerifyPhase | null>(null)
  const [serviceFailures, setServiceFailures] = useState(0)
  const [installing, setInstalling] = useState(false)
  // 官方 Clash Verge 冲突门控:共享 hook(7s 轮询 running/autostart),账号卡与 IP 卡共用一份。
  // CV 冲突时:阻断激活(onActivate)+ 不启动出口校验(下方 resume effect)+ IP 查询禁用,只显「一键关停」。
  const { cvBlock, recheck: recheckCvGate } = useClashVergeGate()

  // 验证中持续轮询实际出口 IP,交给共享守卫做比对(防误报 5 条件);CV 冲突时停查(enabled=!cvBlock),关停后恢复。
  const verifying = verifyPhase !== null
  const { data: ipInfo, refetch: refetchIp } = useIpInfoQuery({
    enabled: !cvBlock,
  })
  const { status: exitStatus, prolonged: exitProlonged } = useNexthubxExitGuard(
    { actualIp: ipInfo?.ip },
  )

  // 账号信息显示门控:
  // - 激活验证流程中(verifying)一律不显示(显示「验证中」);
  // - 验证完成后,已激活且出口未被判定为不一致(match 或 条件不足的 null)即显示;
  //   仅在**确证 mismatch**(防误报 5 条件全满足)时隐藏账号 + 卡内提示(短=校验中、久=联系支持);
  //   后台被动通知由 ExitMismatchGuard 负责(不再全屏遮罩)。
  //   不一致是「确证才报」,未连接 / IP 未取到时 status=null,不应误隐藏已激活账号。
  const showAccount =
    isActivated &&
    !reactivating &&
    !verifying &&
    Boolean(clientState) &&
    exitStatus !== 'mismatch' &&
    // 验证流程未走完(setupComplete===false)时不展示账号,交由下方 resume effect 续跑验证。
    // undefined(老状态)视为已完成,不打扰存量用户。
    clientState?.setupComplete !== false

  const showForm = !isActivated || !clientState || (reactivating && !verifying)

  // 自助绑定角色:creator = manager@域 主账号,走「自建第三方 team」流程(无邀请绑定);
  // member = 被邀请加入。creator 的 bindStatus 一直停在 none,直到本人确认建团后 → bound。
  const isCreator = clientState?.selfBindRole === 'creator'

  // 把绑定文案里的 {pemail} 占位符替换为用户个人邮箱(后端可编辑文案已在服务端替换,这里覆盖回退到
  // 内置 i18n 的情形;无个人邮箱时原样保留)。split/join 避免正则特殊字符。
  const withPemail = (s: string): string => {
    const pemail = clientState?.selfBindPersonalEmail
    return pemail ? s.split('{pemail}').join(pemail) : s
  }

  // 个人邮箱脱敏:本地部留前 2 位 + **,域名保留(8912345@qq.com → 89**@qq.com)。
  const maskEmail = (email: string): string => {
    const at = email.indexOf('@')
    if (at <= 0) return email
    return `${email.slice(0, Math.min(2, at))}**${email.slice(at)}`
  }

  const copy = useLockFn(async (value: string) => {
    try {
      await writeText(value)
      showNotice.success('nexthubx.account.copied')
    } catch (err) {
      console.error('[nexthubx] copy failed', err)
    }
  })

  // 自助绑定末步:用户在客户端自报「已绑定」。乐观更新本地 bindStatus=bound + 触发权威同步回填。
  // member 在 invite_sent、creator 在 none(激活后自建团) 时渲染此按钮;后端再按 role 校验来态(不符 → 409)。
  const onConfirmBound = useLockFn(async () => {
    if (!clientState?.clientToken) return
    setConfirmingBind(true)
    try {
      const res = await confirmBind(clientState.clientToken)
      if (res.status === 'ok') {
        const cur = await loadClientState()
        if (cur) await saveClientState({ ...cur, bindStatus: 'bound' })
        refresh()
        requestImmediateNexthubxSync()
        showNotice.success('nexthubx.account.bind.confirmOk')
      } else if (res.status === 'conflict') {
        showNotice.error('nexthubx.account.bind.notInvited')
      } else {
        // unauthorized:凭证/设备失效,下次 sync 会走重置流程
        showNotice.error('nexthubx.account.bind.confirmFail')
      }
    } catch (err) {
      console.error('[nexthubx] confirm-bind failed', err)
      showNotice.error('nexthubx.account.bind.confirmFail')
    } finally {
      setConfirmingBind(false)
    }
  })

  // 绑定等待期手动刷新:即时拉一次 sync(去抖 20s),让 bindStatus 尽快更新。
  // 区别于卡片「重新激活」——这里只是主动拉状态,不重走激活。
  const onRefreshBind = () => {
    requestImmediateNexthubxSync()
    showNotice.info('nexthubx.account.bind.refreshing')
  }

  const enableTun = useCallback(
    async (value: boolean) => {
      mutateVerge({ ...verge, enable_tun_mode: value }, false)
      await patchVerge({ enable_tun_mode: value })
    },
    [verge, mutateVerge, patchVerge],
  )

  const [stoppingCv, setStoppingCv] = useState(false)
  // 一键关停官方 Clash Verge:杀掉其 root 核心 + GUI(macOS 弹一次系统密码),再重新检测放行。
  // CV 服务模式下退 GUI 核心仍由 root 服务托管常驻、用户停不掉,故提供此入口。
  const onForceStopCv = useLockFn(async () => {
    setStoppingCv(true)
    try {
      // 一键关停:停运行中的 CV(若在跑,弹一次密码)+ 关其开机自启(用户级,无密码),都做完再复检放行。
      // 不再用「是否运行」守门——否则「CV 已停但自启还开」会被跳过、门控永远清不掉(stop 内部自己判断:
      // 没运行就只关自启、不白弹密码)。
      await stopOfficialClashVerge()
      const g = (await recheckCvGate()).data
      const ok = !(g?.running || g?.autostart)
      if (ok) {
        showNotice.success('nexthubx.clashVergeConflict.forceStopOk')
        // 自愈:CV 之前可能在 NextHubX 启动时抢占端口/TUN,导致本端 TUN 起坏(自身流量走直连、出口校验过不了)。
        // CV 已停 → 重启本端核心,重建干净的 TUN + auto-route;给核心起 TUN 留几秒,再重查出口 IP + 触发同步,
        // 让出口校验自动恢复,无需用户手动退重开。
        try {
          await restartCore()
          void nxDebug('gate.forceStop.selfHeal', { restartedCore: true })
        } catch (e) {
          void nxDebug('gate.forceStop.selfHeal.fail', errInfo(e))
        }
        setTimeout(() => {
          void refetchIp()
          requestImmediateNexthubxSync()
        }, 3000)
      }
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err)
      void nxDebug('gate.forceStop.fail', errInfo(err))
      if (code.includes('CANCELLED')) {
        showNotice.info('nexthubx.clashVergeConflict.forceStopCancelled')
      } else if (code.includes('STILL_RUNNING')) {
        showNotice.error('nexthubx.clashVergeConflict.forceStopStillRunning')
      } else {
        showNotice.error('nexthubx.clashVergeConflict.forceStopFailed')
      }
    } finally {
      setStoppingCv(false)
    }
  })

  // 强制安装 service(验证流程中的 b 步)
  const onInstallService = useLockFn(async () => {
    setInstalling(true)
    try {
      await installServiceAndRestartCore()
      await mutateSystemState()
      setServiceFailures(0)
      // 安装成功 → 进入连接子阶段(由 effect 推进)
    } catch (err) {
      console.error('[nexthubx] service install failed', err)
      setServiceFailures((c) => {
        const next = c + 1
        if (next > MAX_SERVICE_RETRIES) setVerifyPhase('support')
        return next
      })
    } finally {
      setInstalling(false)
    }
  })

  // 验证流程推进:service 就绪 → connect(开 TUN) → probe(轮询 IP)
  const connectStartedRef = useRef(false)
  useEffect(() => {
    if (!verifying) {
      connectStartedRef.current = false
      return
    }
    if (verifyPhase === 'support') return

    // service 子阶段:就绪则进 connect
    if (verifyPhase === 'service') {
      if (isServiceOk) {
        void nxDebug('service.ready')
        setVerifyPhase('connect')
      }
      return
    }

    // connect 子阶段:开 TUN(仅触发一次),成功后进 probe
    if (verifyPhase === 'connect') {
      if (connectStartedRef.current) return
      connectStartedRef.current = true
      void (async () => {
        try {
          await enableTun(true)
          void nxDebug('tun.enabled')
        } catch (err) {
          console.error('[nexthubx] enable tun failed', err)
          void nxDebug('tun.fail', errInfo(err))
        }
        setVerifyPhase('probe')
      })()
      return
    }
  }, [verifying, verifyPhase, isServiceOk, enableTun])

  // probe 子阶段:持续轮询 IP,直到守卫给出 match → 完成激活;mismatch 交全局警示
  useEffect(() => {
    if (verifyPhase !== 'probe') return
    // 仅记 exitStatus(它已是依赖);实际 IP 见 api.ts 的 ipcheck.ok、期望出口见 activate.ok。
    void nxDebug('probe', { exitStatus })
    if (exitStatus === 'match') {
      // 验证全流程完成 → 持久化 setupComplete,使重开 app 直接展示账号、不再重跑验证。
      void (async () => {
        const cur = await loadClientState()
        if (cur && cur.setupComplete !== true) {
          await saveClientState({ ...cur, setupComplete: true })
          refresh()
        }
      })()
      setVerifyPhase(null)
      setReactivating(false)
      return
    }
    const timer = setInterval(() => {
      void refetchIp()
    }, 5_000)
    // 立即先取一次
    void refetchIp()
    return () => clearInterval(timer)
  }, [verifyPhase, exitStatus, refetchIp, refresh])

  // 未激活守卫已删除:TUN「该不该开」收归后端单一权威(core::tun_guard 的 reconcile,
  // 未激活/不可用即关,幂等、窗口关也生效)。前端不再做 force-disable,避免与后端双写打架/抖动。
  // 激活流程 connect 子阶段仍主动 enableTun(true) 即时开 TUN(供出口校验),与后端 reconcile 一致。

  // 续跑守卫(#2):激活码已校验、配置已导入,但验证流程未走完(setupComplete===false)时,
  // 重开 app 自动从验证流程起点(service)续跑,而非回到激活码输入。
  // service→TUN→出口 IP 三步均幂等,从头重跑安全;比持久化精确子步骤更稳(子步骤可能续进失效中间态)。
  useEffect(() => {
    if (
      isActivated &&
      clientState?.setupComplete === false &&
      verifyPhase === null &&
      !reactivating &&
      !cvBlock // CV 冲突时不启动出口校验;一键关停后 cvBlock 清空,本 effect 重跑、自动续跑校验
    ) {
      setServiceFailures(0)
      setVerifyPhase('service')
    }
  }, [
    isActivated,
    clientState?.setupComplete,
    verifyPhase,
    reactivating,
    cvBlock,
  ])

  // (CV 检测改由共享 hook useClashVergeGate 7s 轮询,账号卡与 IP 卡共用一份,无需本地再轮询。)

  // 未激活时加载「被重置」通知:常驻提示是哪个账号被重置(用户不会一脸懵地回到激活页)+ 预填邮箱。
  useEffect(() => {
    if (isActivated) {
      setResetNotice(null)
      return
    }
    void loadResetNotice().then((n) => {
      setResetNotice(n)
      if (n?.email) setEmail((cur) => cur || n.email!)
    })
  }, [isActivated])

  const onActivate = useLockFn(async () => {
    const trimmedEmail = email.trim()
    const trimmed = token.trim()
    if (!trimmedEmail || !trimmed) {
      showNotice.error('nexthubx.activate.feedback.empty')
      return
    }

    // 激活前强制门控:Clash Verge 运行中(TUN/代理活跃)或开机自启未关 → 阻断并展示指引,
    // 待用户关闭后(点「重新检测」通过)才放行,避免激活请求被劫 + 后续 TUN 互相冲突。
    const cvNow = (await recheckCvGate()).data
    if (cvNow?.running || cvNow?.autostart) {
      return
    }

    setSubmitting(true)
    void nxDebug('activate.start')
    try {
      const result = await activate(trimmedEmail, trimmed)
      void nxDebug('activate.ok', {
        email: result.identityEmail,
        expectedExitIp: result.expectedExitIp,
        cfgLen: result.proxyConfig?.content?.length,
      })

      // 复用已有托管 profile uid(若之前激活过)以更新而非堆积
      const prev = await loadClientState()
      let profileUid: string
      try {
        profileUid = await importAndActivateProfile(
          result.proxyConfig.content,
          prev?.profileUid,
        )
        void nxDebug('importProfile.ok', { profileUid })
      } catch (err) {
        console.error('[nexthubx] import profile failed', err)
        void nxDebug('importProfile.fail', errInfo(err))
        const detail = err instanceof Error ? err.message : String(err)
        if (isAppControlBlocked(detail)) {
          showNotice.error(
            'shared.feedback.validation.config.appControlBlocked',
            detail,
          )
        } else {
          showNotice.error('nexthubx.activate.feedback.configError')
        }
        return
      }

      await saveClientState({
        clientToken: result.clientToken,
        identityEmail: result.identityEmail,
        identityPassword: result.identityPassword,
        profileUid,
        // 激活响应不含 fingerprint;首次同步用 active 结果回填
        configFingerprint: prev?.configFingerprint,
        // 出口比对用:后端缺省时回退到上次值(老后端兼容)
        expectedExitIp: result.expectedExitIp ?? prev?.expectedExitIp,
        // 账号使用说明:后端系统配置下发;缺省回退上次值(老后端兼容)
        usageTips: result.tips ?? prev?.usageTips,
        // 激活码已过、配置已导入,但验证流程(service→TUN→IP)尚未走完。
        // 此时若 app 被关闭,重开时据此从验证流程续跑而非回到输码(见下方 resume effect)。
        setupComplete: false,
      })

      showNotice.success('nexthubx.activate.feedback.success')
      setToken('')
      setEmail('')
      setResetNotice(null)
      refresh()

      // 进入「验证中」:先检查 service,再连接,再验证出口 IP(账号此时不显示)
      setServiceFailures(0)
      let serviceReady = false
      try {
        serviceReady = await isServiceAvailable()
      } catch (svcErr) {
        console.error('[nexthubx] service readiness check failed', svcErr)
      }
      await mutateSystemState()
      void nxDebug('verify.start', { serviceReady })
      setVerifyPhase(serviceReady ? 'connect' : 'service')
    } catch (err) {
      if (err instanceof ActivationInvalidError) {
        void nxDebug('activate.fail.invalid', errInfo(err))
        showNotice.error('nexthubx.activate.feedback.invalid')
      } else {
        console.error('[nexthubx] activate failed', err)
        void nxDebug('activate.fail.network', errInfo(err))
        showNotice.error('nexthubx.activate.feedback.networkError')
      }
    } finally {
      setSubmitting(false)
    }
  })

  const renderVerifying = () => {
    // service 未就绪:强制安装引导
    if (verifyPhase === 'service') {
      return (
        <Stack spacing={2}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <ShieldRounded color="primary" />
            <Typography variant="subtitle1">
              {t('nexthubx.connect.gate.title')}
            </Typography>
          </Box>
          <Typography variant="body2" color="text.secondary">
            {t('nexthubx.connect.gate.body')}
          </Typography>
          <Button
            variant="contained"
            disabled={installing}
            onClick={() => void onInstallService()}
            startIcon={
              installing ? (
                <CircularProgress size={16} color="inherit" />
              ) : (
                <ShieldRounded />
              )
            }
          >
            {installing
              ? t('nexthubx.connect.gate.installing')
              : serviceFailures > 0
                ? t('nexthubx.connect.gate.retry')
                : t('nexthubx.connect.gate.install')}
          </Button>
        </Stack>
      )
    }

    // service 安装反复失败:联系技术支持
    if (verifyPhase === 'support') {
      return (
        <Stack spacing={2}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <SupportAgentRounded color="error" />
            <Typography variant="subtitle1" color="error">
              {t('nexthubx.connect.gate.supportTitle')}
            </Typography>
          </Box>
          <Typography variant="body2" color="text.secondary">
            {t('nexthubx.connect.gate.supportBody')}
          </Typography>
          <Button
            variant="outlined"
            color="inherit"
            disabled={installing}
            onClick={() => {
              setVerifyPhase('service')
            }}
          >
            {t('nexthubx.connect.gate.retryAnyway')}
          </Button>
        </Stack>
      )
    }

    // connect / probe:验证中(账号信息暂不显示)。
    // 始终保持「校验中」加载态;TUN 刚切换时 IP 检测短暂返回旧出口属预期(一般十几秒内收敛),
    // 故 mismatch 仅以 info 提示附注,不再用红色警示吓用户(全屏警示也已在验证期被抑制)。
    const mismatch = exitStatus === 'mismatch'
    return (
      <Stack spacing={2} sx={{ alignItems: 'center', py: 2 }}>
        <CircularProgress size={28} />
        <Typography variant="body2" color="text.secondary">
          {t('nexthubx.activate.verify.verifying')}
        </Typography>
        {mismatch && (
          <Alert severity="info" variant="outlined" sx={{ width: '100%' }}>
            {t('nexthubx.activate.verify.mismatchHint')}
          </Alert>
        )}
      </Stack>
    )
  }

  return (
    <EnhancedCard
      title={t('nexthubx.account.title')}
      icon={<AccountCircleOutlined />}
      iconColor="primary"
      action={
        showAccount ? (
          <Tooltip title={t('nexthubx.account.reactivate')} arrow>
            <IconButton
              size="small"
              color="inherit"
              onClick={() => {
                setReactivating(true)
                setToken('')
              }}
            >
              <RefreshRounded fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : null
      }
    >
      {/* 官方 Clash Verge 冲突:只按 CV 检测结果显隐,常驻卡片顶部(无论是否已激活),不再走全局弹窗。
          带「一键关停」直接关掉其残留进程 + 自启;关掉后下一轮轮询 cvBlock 清空,提示自动消失。 */}
      {cvBlock && (
        <Alert
          severity="warning"
          icon={<WarningAmberRounded fontSize="inherit" />}
          action={
            <Button
              color="inherit"
              size="small"
              variant="outlined"
              disabled={stoppingCv}
              startIcon={
                stoppingCv ? (
                  <CircularProgress size={14} color="inherit" />
                ) : undefined
              }
              onClick={() => void onForceStopCv()}
            >
              {stoppingCv
                ? t('nexthubx.clashVergeConflict.forceStopping')
                : t('nexthubx.clashVergeConflict.forceStop')}
            </Button>
          }
          sx={{ whiteSpace: 'pre-line', alignItems: 'flex-start', mb: 2 }}
        >
          {`${t('nexthubx.clashVergeConflict.runningBody')}\n\n${t('nexthubx.clashVergeConflict.forceStopHint')}`}
        </Alert>
      )}
      {verifying ? (
        renderVerifying()
      ) : showForm ? (
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            {t('nexthubx.activate.subtitle')}
          </Typography>
          {/* 重置通知:CV 冲突提示已上移到卡片顶部;此处仍在 cvBlock 时不显,避免两个 warning 抢注意力。 */}
          {resetNotice && !cvBlock && (
            <Alert
              severity="warning"
              variant="outlined"
              icon={<WarningAmberRounded fontSize="inherit" />}
              sx={{ alignItems: 'flex-start' }}
            >
              {resetNotice.email
                ? t('nexthubx.activate.resetNoticeWithEmail', {
                    email: resetNotice.email,
                  })
                : t('nexthubx.activate.resetNotice')}
            </Alert>
          )}
          <TextField
            fullWidth
            size="small"
            type="email"
            label={t('nexthubx.activate.emailLabel')}
            placeholder={t('nexthubx.activate.emailPlaceholder')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
          />
          <TextField
            fullWidth
            size="small"
            label={t('nexthubx.activate.tokenLabel')}
            placeholder={t('nexthubx.activate.tokenPlaceholder')}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !submitting) {
                void onActivate()
              }
            }}
            disabled={submitting}
          />
          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              onClick={() => void onActivate()}
              disabled={submitting || Boolean(cvBlock)}
            >
              {submitting
                ? t('nexthubx.activate.submitting')
                : t('nexthubx.activate.submit')}
            </Button>
            {isActivated && reactivating && (
              <Button
                variant="text"
                color="inherit"
                onClick={() => {
                  setReactivating(false)
                  setToken('')
                }}
                disabled={submitting}
              >
                {t('shared.actions.cancel')}
              </Button>
            )}
          </Stack>
        </Stack>
      ) : showAccount ? (
        <Stack spacing={2}>
          {/* 顶部小字幕:脱敏个人邮箱(自助席位常显),提示该去哪个邮箱收邀请 + 便于核对身份。 */}
          {clientState.isSelfBind && clientState.selfBindPersonalEmail && (
            <Typography variant="caption" color="text.secondary">
              {t('nexthubx.account.activatedEmail', {
                email: maskEmail(clientState.selfBindPersonalEmail),
              })}
            </Typography>
          )}
          {/* 自助绑定按角色 + team 状态分流(账号密码门控在服务端,客户端据此渲染):
              - member + none(待邀请):提示联系主管、**不显账号密码**(还用不上);
              - creator 未 bound(运营建团中):提示等待运营开通、**不显账号密码**(manager 账号绑订阅卡,运营全程建好再移交);
              - member invite_sent / 任意 bound / 非自助席位:显示账号密码。文案优先取后端可编辑 selfBindTips。 */}
          {clientState.isSelfBind &&
          ((!isCreator && clientState.bindStatus === 'none') ||
            (isCreator && clientState.bindStatus !== 'bound')) ? (
            <Alert
              severity="info"
              variant="outlined"
              icon={<HourglassTopRounded fontSize="inherit" />}
              sx={{ alignItems: 'flex-start' }}
            >
              <Typography variant="subtitle2">
                {t(
                  isCreator
                    ? 'nexthubx.account.bind.creatorTitle'
                    : 'nexthubx.account.bind.pendingTitle',
                )}
              </Typography>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mb: 1, whiteSpace: 'pre-line' }}
              >
                {isCreator
                  ? withPemail(t('nexthubx.account.bind.creatorBody'))
                  : withPemail(
                      clientState.selfBindTips?.pending?.trim() ||
                        t('nexthubx.account.bind.pendingBody'),
                    )}
              </Typography>
              <Button
                size="small"
                variant="outlined"
                color="inherit"
                startIcon={<RefreshRounded fontSize="small" />}
                onClick={onRefreshBind}
              >
                {t('nexthubx.account.bind.refresh')}
              </Button>
            </Alert>
          ) : (
            <>
              <TextField
                fullWidth
                size="small"
                label={t('nexthubx.account.email')}
                value={clientState.identityEmail}
                slotProps={{
                  input: {
                    readOnly: true,
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton
                          edge="end"
                          size="small"
                          onClick={() => void copy(clientState.identityEmail)}
                          title={t('nexthubx.account.copy')}
                        >
                          <ContentCopyRounded fontSize="small" />
                        </IconButton>
                      </InputAdornment>
                    ),
                  },
                }}
              />

              <TextField
                fullWidth
                size="small"
                label={t('nexthubx.account.password')}
                type={showPassword ? 'text' : 'password'}
                value={clientState.identityPassword}
                slotProps={{
                  input: {
                    readOnly: true,
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton
                          size="small"
                          onClick={() => setShowPassword((v) => !v)}
                          title={t(
                            showPassword
                              ? 'nexthubx.account.hidePassword'
                              : 'nexthubx.account.showPassword',
                          )}
                        >
                          {showPassword ? (
                            <VisibilityOffRounded fontSize="small" />
                          ) : (
                            <VisibilityRounded fontSize="small" />
                          )}
                        </IconButton>
                        <IconButton
                          edge="end"
                          size="small"
                          onClick={() =>
                            void copy(clientState.identityPassword)
                          }
                          title={t('nexthubx.account.copy')}
                        >
                          <ContentCopyRounded fontSize="small" />
                        </IconButton>
                      </InputAdornment>
                    ),
                  },
                }}
              />

              {/* 2FA 动态码:运营给该账号录入 Authenticator 密钥后,sync 回 hasTotp=true。
                  算法在服务端,这里只从 /api/client/totp 拉算好的 6 位码 + 倒计时。登 Google
                  被要求两步验证时填它。未配置则不渲染。 */}
              {clientState.hasTotp ? (
                <TotpField clientToken={clientState.clientToken} />
              ) : null}

              {/* creator(manager@域)的建团/确认收归运营侧:未 bound 时根本不显账号密码(上面走等待态),
                  bound 后才进入本分支显示账号密码 + 下方 bound 提示。故此处不再有「建团引导/确认」按钮。 */}

              {/* invite_sent / bound:在账号密码下方展示对应状态提示(文案优先取后端 selfBindTips,缺省回退 i18n)。 */}
              {clientState.isSelfBind &&
                !isCreator &&
                clientState.bindStatus === 'invite_sent' && (
                  <Alert
                    severity="success"
                    variant="outlined"
                    icon={<MarkEmailReadRounded fontSize="inherit" />}
                    sx={{ alignItems: 'flex-start' }}
                  >
                    <Typography variant="subtitle2">
                      {t('nexthubx.account.bind.invitedTitle')}
                    </Typography>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ mb: 1, whiteSpace: 'pre-line' }}
                    >
                      {withPemail(
                        clientState.selfBindTips?.invited?.trim() ||
                          t('nexthubx.account.bind.invitedBody'),
                      )}
                    </Typography>
                    <Stack direction="row" spacing={1}>
                      <Button
                        size="small"
                        variant="contained"
                        disabled={confirmingBind}
                        startIcon={
                          confirmingBind ? (
                            <CircularProgress size={14} color="inherit" />
                          ) : (
                            <CheckCircleRounded />
                          )
                        }
                        onClick={() => void onConfirmBound()}
                      >
                        {confirmingBind
                          ? t('nexthubx.account.bind.confirming')
                          : t('nexthubx.account.bind.confirmButton')}
                      </Button>
                      <Button
                        size="small"
                        variant="text"
                        color="inherit"
                        startIcon={<RefreshRounded fontSize="small" />}
                        onClick={onRefreshBind}
                      >
                        {t('nexthubx.account.bind.refresh')}
                      </Button>
                    </Stack>
                  </Alert>
                )}

              {clientState.isSelfBind && clientState.bindStatus === 'bound' && (
                <Alert
                  severity="success"
                  variant="outlined"
                  icon={<CheckCircleRounded fontSize="inherit" />}
                >
                  {withPemail(
                    isCreator
                      ? t('nexthubx.account.bind.creatorBoundLabel')
                      : clientState.selfBindTips?.bound?.trim() ||
                          t('nexthubx.account.bind.boundLabel'),
                  )}
                </Alert>
              )}

              {/* 使用说明:非自助席位、或自助已绑定才显示(invite_sent 阶段的提示已含登录引导)。
              优先取后端「系统配置」下发的 usageTips,缺省回退内置 i18n。 */}
              {/* {(!clientState.isSelfBind ||
                clientState.bindStatus === 'bound') && (
                <Box>
                  <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                    {t('nexthubx.account.usage.title')}
                  </Typography>
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ whiteSpace: 'pre-line' }}
                  >
                    {clientState?.usageTips?.trim() ||
                      t('nexthubx.account.usage.body')}
                  </Typography>
                </Box>
              )} */}
            </>
          )}
        </Stack>
      ) : (
        // 已激活但出口未通过(且非验证中)→ 不显示账号,卡内提示(不再全屏遮罩):
        // 短暂不一致(可能正在切换 / 瞬态)显示「校验中」;持续过久(prolonged)才升级为
        // 「请联系技术支持」,避免一抖动就吓用户。后台被动通知由 ExitMismatchGuard 负责。
        <Stack spacing={2} sx={{ alignItems: 'center', py: 2 }}>
          {exitProlonged ? (
            <>
              <WarningAmberRounded color="error" sx={{ fontSize: 32 }} />
              <Typography variant="body2" color="text.secondary">
                {t('nexthubx.activate.verify.mismatchHint')}
              </Typography>
            </>
          ) : (
            <>
              <CircularProgress size={28} />
              <Typography variant="body2" color="text.secondary">
                {t('nexthubx.activate.verify.verifying')}
              </Typography>
            </>
          )}
        </Stack>
      )}
    </EnhancedCard>
  )
}
