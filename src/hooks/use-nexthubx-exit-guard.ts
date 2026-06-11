/* eslint-disable @eslint-react/set-state-in-effect */
/**
 * nextHubx 出口 IP 一致性守卫(最终 spec §3)。
 *
 * 在「验证中」与「已激活运行中」两态都持续比对实际出口 IP 与分配出口 IP。
 *
 * 严防误报——仅当下列条件**全部满足**才判定不一致(mismatch):
 *   ① expectedExitIp 非空(已分配,trim 后);
 *   ② 实际 IP 已成功取到(actualIp 非空);
 *   ③ 代理已连接(TUN 开 或 系统代理开)——未连接时实际 IP = 本地直连,绝不报错;
 *   ④ IP 稳定(防抖:同一实际 IP 连续命中 2 次 或 持续 ≥ 3s);
 *   ⑤ v4/v6 规范化(trim + 小写;格式不同不判错)。
 *
 * 命中 mismatch 时除返回状态外,还触发**系统通知 + 唤起/置顶主窗口**(后台也提醒)。
 * 通知做去抖:同一 (expected, actual) 组合只通知一次,直至恢复一致后才会再次通知。
 */
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { UserAttentionType } from '@tauri-apps/api/window'
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useNexthubxClient } from '@/hooks/use-nexthubx-sync'
import { useSystemProxyState } from '@/hooks/use-system-proxy-state'
import { useVerge } from '@/hooks/use-verge'

/** 防抖:同一实际 IP 需连续命中的次数。 */
const STABLE_HIT_COUNT = 2
/** 防抖:或同一实际 IP 持续时长(ms)。 */
const STABLE_DURATION_MS = 3_000

export type ExitMatchStatus = 'match' | 'mismatch' | null

/** IPv4/IPv6 规范化:trim + 小写(IPv6 十六进制大小写无意义)。格式不同不强行折叠。 */
function normalizeIp(ip: string | undefined | null): string {
  return (ip ?? '').trim().toLowerCase()
}

interface ExitGuardInput {
  /** 实际出口 IP(来自 IP Info 轮询)。 */
  actualIp?: string | null
}

interface ExitGuardResult {
  /** 比对状态:match / mismatch / null(条件不足,不显示)。 */
  status: ExitMatchStatus
  expectedExitIp: string | undefined
  actualIp: string | undefined
  /** 初始验证(激活后 service→TUN→IP)进行中:UI 应显示「校验中」而非告警。 */
  setupInProgress: boolean
}

/**
 * 守卫核心:接收实际 IP,产出经防误报过滤后的比对状态,并在命中 mismatch 时
 * 发系统通知 + 唤起主窗口。
 */
export function useNexthubxExitGuard({
  actualIp: actualIpRaw,
}: ExitGuardInput): ExitGuardResult {
  const { t } = useTranslation()
  const { clientState } = useNexthubxClient()
  const { verge } = useVerge()
  const { indicator: systemProxyOn } = useSystemProxyState()

  const expectedExitIp = clientState?.expectedExitIp?.trim() || undefined
  const actualIp = actualIpRaw?.trim() || undefined

  // ③ 代理已连接:TUN 开 或 系统代理开
  const proxyConnected = Boolean(verge?.enable_tun_mode) || systemProxyOn

  const normActual = useMemo(() => normalizeIp(actualIp), [actualIp])
  const normExpected = useMemo(() => normalizeIp(expectedExitIp), [expectedExitIp])

  // ④ 防抖:跟踪同一规范化实际 IP 的连续命中次数 + 首次出现时间,
  // 仅当「连续命中 ≥ STABLE_HIT_COUNT」或「持续 ≥ STABLE_DURATION_MS」后,
  // 才把该 IP 提升为 stableActual(参与不一致判定),避免瞬时抖动误报。
  const trackRef = useRef<{ ip: string; count: number; since: number }>({
    ip: '',
    count: 0,
    since: 0,
  })
  const [stableActual, setStableActual] = useState('')

  useEffect(() => {
    if (!normActual) {
      trackRef.current = { ip: '', count: 0, since: 0 }
      setStableActual('')
      return
    }

    const now = Date.now()
    if (normActual !== trackRef.current.ip) {
      trackRef.current = { ip: normActual, count: 1, since: now }
    } else {
      trackRef.current.count += 1
    }

    const promote = () => setStableActual(normActual)
    if (trackRef.current.count >= STABLE_HIT_COUNT) {
      promote()
      return
    }
    // 未达次数阈值 → 等够时长后再提升
    const elapsed = now - trackRef.current.since
    const wait = Math.max(0, STABLE_DURATION_MS - elapsed)
    const timer = setTimeout(promote, wait)
    return () => clearTimeout(timer)
  }, [normActual])

  const status = useMemo<ExitMatchStatus>(() => {
    // ① expected 非空 ② actual 已取到 ③ 代理已连接
    if (!normExpected || !normActual || !proxyConnected) return null

    // ⑤ 规范化后相等 → 一致(一致无需防抖,立即判定)
    if (normExpected === normActual) return 'match'

    // ④ 仅当该不一致 IP 已稳定(提升为 stableActual)才判 mismatch
    if (stableActual && stableActual === normActual) return 'mismatch'
    return null
  }, [normExpected, normActual, proxyConnected, stableActual])

  // 初始验证(激活后 service→TUN→IP)尚未完成:TUN 切换中 IP 短暂为旧出口属预期,
  // mismatch 大概率是瞬态 → 抑制系统通知/唤起窗口(及全屏警示,见 ExitMismatchGuard),
  // 仅在卡片内呈现「校验中」。undefined(老状态)视为已完成,不抑制。
  const setupInProgress = clientState?.setupComplete === false

  // 命中 mismatch → 系统通知 + 唤起主窗口(去抖:同一组合仅一次)
  const lastNotifiedRef = useRef<string>('')
  useEffect(() => {
    if (status !== 'mismatch' || setupInProgress) {
      // 恢复一致 / 条件不足 → 重置去抖,允许下次再次通知
      if (status === 'match') lastNotifiedRef.current = ''
      return
    }
    const key = `${normExpected}=>${normActual}`
    if (lastNotifiedRef.current === key) return
    lastNotifiedRef.current = key

    void (async () => {
      try {
        let granted = await isPermissionGranted()
        if (!granted) {
          const perm = await requestPermission()
          granted = perm === 'granted'
        }
        if (granted) {
          sendNotification({
            title: t('nexthubx.exitGuard.notifyTitle'),
            body: t('nexthubx.exitGuard.notifyBody', {
              actual: normActual,
              expected: normExpected,
            }),
          })
        }
      } catch (err) {
        console.error('[nexthubx] exit-guard notification failed', err)
      }
      // 唤起 / 置顶主窗口(即便最小化 / 后台)
      try {
        const win = getCurrentWebviewWindow()
        await win.unminimize()
        await win.show()
        await win.setFocus()
        await win.requestUserAttention(UserAttentionType.Critical)
      } catch (err) {
        console.error('[nexthubx] exit-guard window raise failed', err)
      }
    })()
  }, [status, normExpected, normActual, t, setupInProgress])

  return { status, expectedExitIp, actualIp, setupInProgress }
}
