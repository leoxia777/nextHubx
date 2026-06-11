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
/** 定期同步间隔:每 10 分钟。 */
const SYNC_INTERVAL_MS = 10 * 60 * 1000

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

      const result = await syncClient(state.clientToken, state.configFingerprint)

      if (result.status === 'not-modified') {
        return
      }

      if (result.status === 'revoked' || result.status === 'unauthorized') {
        await clearClientState()
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
    // 启动即同步一次
    void runSync()
    const timer = setInterval(() => {
      void runSync()
    }, SYNC_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [runSync])

  return { runSync }
}
