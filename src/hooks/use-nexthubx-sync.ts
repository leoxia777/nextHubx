import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef } from 'react'

import { syncClient } from '@/services/nexthubx-api'
import { importAndActivateProfile } from '@/services/nexthubx-profile'
import {
  clearClientState,
  loadClientState,
  saveClientState,
  type NexthubxClientState,
} from '@/services/nexthubx-store'
import { showNotice } from '@/services/notice-service'

const CLIENT_STATE_KEY = ['nexthubx-client-state']
/** 定期同步间隔:每 2 分钟(兜底)。原 10 分钟过慢——重置后用户会先撞上"IP 检测失败"才被感知。 */
const SYNC_INTERVAL_MS = 2 * 60 * 1000
/**
 * 快轮询间隔:5s。仅在「等服务端推进绑定态」时启用 —— 自助绑定席位且 bindStatus≠bound
 * (member 待邀请/已邀请、creator 待确认建团)。这些态下绑定推进多来自服务端(运营发邀请 / 双通道确认),
 * 客户端需尽快感知;bound 后及非自助席位回到 2min 兜底,避免长期空转。304 很轻,desktop 端代价可忽略。
 */
const FAST_SYNC_INTERVAL_MS = 5 * 1000

/**
 * 模块级「立即同步」触发器(去抖 20s)。供 IP 检测/代理疑似中断等场景跨组件请求一次尽快同步:
 * 代理断开时经**直连**的 `/api/client/sync` 尽早拿到 401/revoked → 感知到被重置(设备/订阅重置),
 * 而非干等下次心跳。前提:`gate.nexthubx.com` 已在 clash 规则里走 DIRECT,代理断了此请求仍可达后端。
 */
let immediateSyncRef: (() => Promise<void>) | null = null
let lastImmediateAt = 0
const IMMEDIATE_MIN_GAP_MS = 20 * 1000
export function requestImmediateNexthubxSync(): void {
  const now = Date.now()
  if (now - lastImmediateAt < IMMEDIATE_MIN_GAP_MS) return
  lastImmediateAt = now
  void immediateSyncRef?.()
}

/**
 * 读取本地 nextHubx 客户端凭证 / 账号(响应式)。
 */
export const useNexthubxClient = () => {
  const qc = useQueryClient()
  const { data, refetch } = useQuery({
    queryKey: CLIENT_STATE_KEY,
    queryFn: loadClientState,
    staleTime: 5000,
  })

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: CLIENT_STATE_KEY })
  }, [qc])

  return {
    clientState: data ?? null,
    isActivated: Boolean(data?.clientToken),
    refetch,
    refresh,
  }
}

/**
 * 自动同步(M2):
 * - 启动时 + 每 10 分钟调 `GET /api/client/sync`(带 clientToken + If-None-Match=上次 fingerprint)。
 * - active 且 fingerprint 变化 → 重新导入 profile + 切换 + 更新账号/凭证。
 * - 304 → 不动。
 * - revoked → 提示重激活 + 清本地凭证。
 * - 401 → 视同失效,清凭证 + 提示。
 *
 * 仅应在应用顶层挂载一次(见 _layout)。
 */
export const useNexthubxAutoSync = () => {
  const qc = useQueryClient()
  const runningRef = useRef(false)

  const runSync = useCallback(async () => {
    if (runningRef.current) return
    runningRef.current = true
    try {
      const state = await loadClientState()
      if (!state?.clientToken) return

      const result = await syncClient(
        state.clientToken,
        state.configFingerprint,
      )

      if (result.status === 'not-modified') {
        return
      }

      if (result.status === 'revoked' || result.status === 'unauthorized') {
        // 保留账号邮箱 + 原因到「被重置」通知:激活界面常驻展示是哪个账号被重置 + 预填邮箱。
        await clearClientState({
          email: state.identityEmail,
          reason: result.status,
          at: new Date().toISOString(),
        })
        qc.invalidateQueries({ queryKey: CLIENT_STATE_KEY })
        showNotice.info('nexthubx.sync.revokedNotice')
        return
      }

      // active
      const { data } = result
      const fingerprintChanged =
        data.configFingerprint !== state.configFingerprint

      let profileUid = state.profileUid
      if (fingerprintChanged) {
        profileUid = await importAndActivateProfile(
          data.proxyConfig.content,
          state.profileUid,
        )
        showNotice.info('nexthubx.sync.configUpdated')
      }

      const next: NexthubxClientState = {
        clientToken: state.clientToken,
        identityEmail: data.identityEmail,
        identityPassword: data.identityPassword,
        configFingerprint: data.configFingerprint,
        profileUid,
        // 后端缺省时保留旧值(老后端/未分配),避免误清空导致比对失效
        expectedExitIp: data.expectedExitIp ?? state.expectedExitIp,
        // 账号使用说明:后端系统配置下发;缺省保留旧值(老后端兼容)
        usageTips: data.tips ?? state.usageTips,
        // team 绑定状态 + 是否自助席位:缺省(老后端)保留旧值,避免误清空绑定 UI 依赖
        bindStatus: data.bindStatus ?? state.bindStatus,
        isSelfBind: data.isSelfBind ?? state.isSelfBind,
        // 自助绑定角色:缺省(老后端)保留旧值,避免误清空导致 creator 流程回退成 member
        selfBindRole: data.selfBindRole ?? state.selfBindRole,
        // 自助绑定个人邮箱:缺省(老后端)保留旧值;用于渲染时替换文案 {pemail} 占位符
        selfBindPersonalEmail:
          data.selfBindPersonalEmail ?? state.selfBindPersonalEmail,
        // 自助绑定 3 段文案:缺省(老后端/非自助)保留旧值,避免误清空
        selfBindTips: data.selfBindTips ?? state.selfBindTips,
        // 是否已配置 TOTP:缺省(老后端)保留旧值,避免误隐藏 2FA 区。
        hasTotp: data.hasTotp ?? state.hasTotp,
        // 保留验证完成标志:同步不应把它清掉(否则会误触发重开后重跑验证)
        setupComplete: state.setupComplete,
      }
      await saveClientState(next)
      qc.invalidateQueries({ queryKey: CLIENT_STATE_KEY })
    } catch (err) {
      console.error('[nexthubx] auto-sync failed', err)
      // 网络等瞬时错误不打扰用户,等待下次轮询
    } finally {
      runningRef.current = false
    }
  }, [qc])

  useEffect(() => {
    // 注册模块级「立即同步」触发器(供 IP/代理失败等场景跨组件调用)
    immediateSyncRef = runSync
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // 自重排心跳:每次同步后按当前绑定态决定下次间隔(等服务端推进绑定态 → 5s,否则 2min)。
    const tick = async () => {
      await runSync()
      if (stopped) return
      let fast = false
      try {
        const st = await loadClientState()
        fast = Boolean(st?.isSelfBind) && st?.bindStatus !== 'bound'
      } catch {
        // 读本地态失败 → 用默认 2min 间隔
      }
      if (stopped) return
      timer = setTimeout(
        () => void tick(),
        fast ? FAST_SYNC_INTERVAL_MS : SYNC_INTERVAL_MS,
      )
    }
    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      if (immediateSyncRef === runSync) immediateSyncRef = null
    }
  }, [runSync])

  return { runSync }
}
