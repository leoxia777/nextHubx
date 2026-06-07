import { useCallback, useEffect, useRef, useState } from 'react'

import { detectOfficialClashVerge } from '@/services/cmds'

/** 后台轮询间隔:7 秒(任务要求 5~10 秒)。 */
const POLL_INTERVAL_MS = 7 * 1000

/**
 * 弹窗模式:
 * - `running`:启动检测时官方版已在运行;
 * - `appeared`:运行期间官方版从无到有出现。
 */
export type ClashVergeConflictMode = 'running' | 'appeared'

export interface ClashVergeConflictState {
  /** 是否展示冲突弹窗。 */
  open: boolean
  /** 当前弹窗模式,决定提示文案。 */
  mode: ClashVergeConflictMode
  /** 关闭弹窗(用户点「我知道了」/ 点击遮罩)。 */
  dismiss: () => void
}

/**
 * 检测「官方 Clash Verge」(clash-verge-rev)冲突并驱动弹窗。
 *
 * 行为:
 * 1. 启动时检测一次,命中 → 弹「正在运行」提示(mode=running)。
 * 2. 运行期间每 7 秒轮询一次;在官方版「从无到有」(false → true)时弹
 *    「已启动」提示(mode=appeared)。
 * 3. 去重:同一次出现只提示一次。用户关闭弹窗后,只有官方版先消失、再次出现
 *    才会重新提示;若一直运行不会反复打扰。
 *
 * 仅应在应用顶层挂载一次(见 _layout)。
 */
export const useClashVergeConflict = (): ClashVergeConflictState => {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<ClashVergeConflictMode>('running')

  // 上一次轮询时官方版是否在运行,用于检测「从无到有」的上升沿。
  const prevPresentRef = useRef(false)
  // 防止异步检测重入。
  const checkingRef = useRef(false)

  const dismiss = useCallback(() => {
    setOpen(false)
  }, [])

  useEffect(() => {
    let cancelled = false

    const runCheck = async (isStartup: boolean) => {
      if (checkingRef.current) return
      checkingRef.current = true
      try {
        const present = await detectOfficialClashVerge()
        if (cancelled) return

        if (isStartup) {
          // 启动检测:命中即提示「正在运行」。
          if (present) {
            setMode('running')
            setOpen(true)
          }
        } else if (present && !prevPresentRef.current) {
          // 上升沿(从无到有):提示「已启动」。同一次出现只触发一次。
          setMode('appeared')
          setOpen(true)
        }

        prevPresentRef.current = present
      } finally {
        checkingRef.current = false
      }
    }

    // 启动即检测一次。
    void runCheck(true)
    const timer = setInterval(() => {
      void runCheck(false)
    }, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return { open, mode, dismiss }
}
