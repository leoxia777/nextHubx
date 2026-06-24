import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { getRunningMode, isAdmin, isServiceAvailable } from '@/services/cmds'

export interface SystemState {
  runningMode: 'Sidecar' | 'Service'
  isAdminMode: boolean
  isServiceOk: boolean
}

const defaultSystemState = {
  runningMode: 'Sidecar',
  isAdminMode: false,
  isServiceOk: false,
} as SystemState

// Grace period for service initialization during startup
const STARTUP_GRACE_MS = 10_000

/**
 * 自定义 hook 用于获取系统运行状态(运行模式 / 管理员 / 服务是否可用)。
 *
 * 注:TUN 的「该不该开」**已收归后端单一权威**(core::tun_guard 的 reconcile:
 * 已激活 && 可用 才开,幂等、窗口关也生效)。本 hook 不再做前端「不可用就关 TUN」的守卫
 * (原 auto-disable 已删除)——避免与后端 reconcile 双写打架 / 抖动。
 */
export function useSystemState() {
  const [isStartingUp, setIsStartingUp] = useState(true)

  useEffect(() => {
    const timer = setTimeout(() => setIsStartingUp(false), STARTUP_GRACE_MS)
    return () => clearTimeout(timer)
  }, [])

  const {
    data: systemState = defaultSystemState,
    refetch: mutateSystemState,
    isLoading,
  } = useQuery({
    queryKey: ['getSystemState'],
    queryFn: async () => {
      const [runningMode, isAdminMode, isServiceOk] = await Promise.all([
        getRunningMode(),
        isAdmin(),
        isServiceAvailable(),
      ])
      return { runningMode, isAdminMode, isServiceOk } as SystemState
    },
    refetchInterval: isStartingUp ? 2000 : 30000,
  })

  const isSidecarMode = systemState.runningMode === 'Sidecar'
  const isServiceMode = systemState.runningMode === 'Service'
  const isTunModeAvailable = systemState.isAdminMode || systemState.isServiceOk

  return {
    runningMode: systemState.runningMode,
    isAdminMode: systemState.isAdminMode,
    isServiceOk: systemState.isServiceOk,
    isSidecarMode,
    isServiceMode,
    isTunModeAvailable,
    mutateSystemState,
    isLoading,
  }
}
