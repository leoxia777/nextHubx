/* eslint-disable @eslint-react/set-state-in-effect */
import {
  AccountCircleOutlined,
  ContentCopyRounded,
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

import { useIpInfoQuery } from '@/hooks/use-ip-info'
import { useNexthubxExitGuard } from '@/hooks/use-nexthubx-exit-guard'
import { useNexthubxClient } from '@/hooks/use-nexthubx-sync'
import { useServiceInstaller } from '@/hooks/use-service-installer'
import { useSystemState } from '@/hooks/use-system-state'
import { useVerge } from '@/hooks/use-verge'
import {
  detectOfficialClashVerge,
  detectOfficialClashVergeAutostart,
  isServiceAvailable,
} from '@/services/cmds'
import { ActivationInvalidError, activate } from '@/services/nexthubx-api'
import { errInfo, nxDebug } from '@/services/nexthubx-debug'
import { importAndActivateProfile } from '@/services/nexthubx-profile'
import { loadClientState, saveClientState } from '@/services/nexthubx-store'
import { showNotice } from '@/services/notice-service'

import { EnhancedCard } from './enhanced-card'

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
 * 出口不一致不在此卡片显示账号,改由全局 ExitMismatchGuard 全窗口警示 + 后台通知。
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

  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [reactivating, setReactivating] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  // 分步激活态:null = 未在验证;否则处于「验证中」的某个子阶段
  const [verifyPhase, setVerifyPhase] = useState<VerifyPhase | null>(null)
  const [serviceFailures, setServiceFailures] = useState(0)
  const [installing, setInstalling] = useState(false)
  // 激活前门控:检测到官方 Clash Verge 正在运行 / 开机自启未关时,记录原因并阻断激活。
  const [cvBlock, setCvBlock] = useState<{
    running: boolean
    autostart: boolean
  } | null>(null)

  // 验证中持续轮询实际出口 IP,交给共享守卫做比对(防误报 5 条件)
  const verifying = verifyPhase !== null
  const { data: ipInfo, refetch: refetchIp } = useIpInfoQuery()
  const { status: exitStatus } = useNexthubxExitGuard({ actualIp: ipInfo?.ip })

  // 账号信息显示门控:
  // - 激活验证流程中(verifying)一律不显示(显示「验证中」);
  // - 验证完成后,已激活且出口未被判定为不一致(match 或 条件不足的 null)即显示;
  //   仅在**确证 mismatch**(防误报 5 条件全满足)时隐藏账号 + 由全局 ExitMismatchGuard 全窗口警示。
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

  const copy = useLockFn(async (value: string) => {
    try {
      await writeText(value)
      showNotice.success('nexthubx.account.copied')
    } catch (err) {
      console.error('[nexthubx] copy failed', err)
    }
  })

  const enableTun = useCallback(
    async (value: boolean) => {
      mutateVerge({ ...verge, enable_tun_mode: value }, false)
      await patchVerge({ enable_tun_mode: value })
    },
    [verge, mutateVerge, patchVerge],
  )

  // 激活前门控:检测官方 Clash Verge 是否「正在运行」或「开机自启未关」。
  // 任一命中 → 记录到 cvBlock(渲染指引 + 阻断激活),清空则放行。返回是否通过。
  // 说明:CV 的 TUN 开关无法直接读;但「CV 未运行」即保证其 TUN 不活跃(退出=关 TUN),
  // 自启则查其 LaunchAgent。两者皆否 → CV 现在和重启后都不会抢占网络。
  const checkClashVergeGate = useCallback(async (): Promise<boolean> => {
    const [running, autostart] = await Promise.all([
      detectOfficialClashVerge(),
      detectOfficialClashVergeAutostart(),
    ])
    void nxDebug('gate.check', { cvRunning: running, cvAutostart: autostart })
    if (running || autostart) {
      setCvBlock({ running, autostart })
      return false
    }
    setCvBlock(null)
    return true
  }, [])

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

  // 未激活守卫:从未激活 / token 被吊销(isActivated=false)且不处于激活验证流程(verifying)时,
  // 强制关闭 TUN —— 避免在「无有效订阅配置」下 TUN 仍接管全局流量(走默认/失效出口)。
  // 激活流程 connect 子阶段会主动开 TUN(verifying=true → 本守卫不触发);
  // 已激活用户的手动 TUN 开关不受影响(isActivated=true → 不触发)。设为 false 后 verge 变化使本
  // effect 复跑、条件不再满足 → 自然收敛,无循环。
  useEffect(() => {
    if (isActivated || verifying) return
    if (verge?.enable_tun_mode) {
      void enableTun(false).catch((err) =>
        console.error('[nexthubx] force-disable tun (inactive) failed', err),
      )
    }
  }, [isActivated, verifying, verge?.enable_tun_mode, enableTun])

  // 续跑守卫(#2):激活码已校验、配置已导入,但验证流程未走完(setupComplete===false)时,
  // 重开 app 自动从验证流程起点(service)续跑,而非回到激活码输入。
  // service→TUN→出口 IP 三步均幂等,从头重跑安全;比持久化精确子步骤更稳(子步骤可能续进失效中间态)。
  useEffect(() => {
    if (
      isActivated &&
      clientState?.setupComplete === false &&
      verifyPhase === null &&
      !reactivating
    ) {
      setServiceFailures(0)
      setVerifyPhase('service')
    }
  }, [isActivated, clientState?.setupComplete, verifyPhase, reactivating])

  // 显示激活表单时主动检测一次 Clash Verge 冲突,提前把门控指引展示出来(无需等用户点激活)。
  useEffect(() => {
    if (showForm) void checkClashVergeGate()
  }, [showForm, checkClashVergeGate])

  const onActivate = useLockFn(async () => {
    const trimmed = token.trim()
    if (!trimmed) {
      showNotice.error('nexthubx.activate.feedback.empty')
      return
    }

    // 激活前强制门控:Clash Verge 运行中(TUN/代理活跃)或开机自启未关 → 阻断并展示指引,
    // 待用户关闭后(点「重新检测」通过)才放行,避免激活请求被劫 + 后续 TUN 互相冲突。
    if (!(await checkClashVergeGate())) {
      return
    }

    setSubmitting(true)
    void nxDebug('activate.start')
    try {
      const result = await activate(trimmed)
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
        showNotice.error('nexthubx.activate.feedback.configError')
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
        // 激活码已过、配置已导入,但验证流程(service→TUN→IP)尚未走完。
        // 此时若 app 被关闭,重开时据此从验证流程续跑而非回到输码(见下方 resume effect)。
        setupComplete: false,
      })

      showNotice.success('nexthubx.activate.feedback.success')
      setToken('')
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

    // connect / probe:验证中(账号信息暂不显示)
    const mismatch = exitStatus === 'mismatch'
    return (
      <Stack spacing={2} sx={{ alignItems: 'center', py: 2 }}>
        {mismatch ? (
          <Alert
            severity="error"
            variant="outlined"
            icon={<WarningAmberRounded />}
            sx={{ width: '100%' }}
          >
            <Typography variant="subtitle2">
              {t('nexthubx.exitGuard.title')}
            </Typography>
            <Typography variant="body2">
              {t('nexthubx.activate.verify.mismatchHint')}
            </Typography>
          </Alert>
        ) : (
          <>
            <CircularProgress size={28} />
            <Typography variant="body2" color="text.secondary">
              {t('nexthubx.activate.verify.verifying')}
            </Typography>
          </>
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
      {verifying ? (
        renderVerifying()
      ) : showForm ? (
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            {t('nexthubx.activate.subtitle')}
          </Typography>
          {cvBlock && (
            <Alert
              severity="warning"
              icon={<WarningAmberRounded fontSize="inherit" />}
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => void checkClashVergeGate()}
                >
                  {t('nexthubx.clashVergeConflict.recheck')}
                </Button>
              }
              sx={{ whiteSpace: 'pre-line', alignItems: 'flex-start' }}
            >
              {`${t('nexthubx.clashVergeConflict.blockingActivate')}\n\n${t('nexthubx.clashVergeConflict.steps')}`}
            </Alert>
          )}
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
                      onClick={() => void copy(clientState.identityPassword)}
                      title={t('nexthubx.account.copy')}
                    >
                      <ContentCopyRounded fontSize="small" />
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
          />

          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              {t('nexthubx.account.usage.title')}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t('nexthubx.account.usage.body')}
            </Typography>
          </Box>
        </Stack>
      ) : (
        // 已激活但出口未通过(且非验证中)→ 不显示账号,仅提示
        <Stack spacing={2} sx={{ alignItems: 'center', py: 2 }}>
          <WarningAmberRounded color="error" sx={{ fontSize: 32 }} />
          <Typography variant="body2" color="text.secondary">
            {t('nexthubx.activate.verify.mismatchHint')}
          </Typography>
        </Stack>
      )}
    </EnhancedCard>
  )
}
