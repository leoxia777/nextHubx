/* eslint-disable @eslint-react/set-state-in-effect */
/**
 * nextHubx 出口 IP 一致性守卫(最终 spec §3,纯计算版)。
 *
 * 在「验证中」与「已激活运行中」两态持续比对实际出口 IP 与分配出口 IP,经防误报过滤后
 * 产出 match / mismatch / null,并跟踪 mismatch 是否「持续过久」(prolonged),供上层
 * 决定何时把提示从「校验中」升级为「联系技术支持」。
 *
 * 本 hook 只做计算、不产生副作用——系统通知由**单一挂载**的 `ExitMismatchGuard`
 * 监测组件负责(不在此发,以免多处调用重复通知);且**不再**全屏遮罩 / 强制唤起置顶窗口。
 *
 * 严防误报——仅当下列条件**全部满足**才判 mismatch:
 *   ① expectedExitIp 非空;② 实际 IP 已取到;③ 代理已连接(TUN 开 或 系统代理开);
 *   ④ IP 稳定(同一实际 IP 连续命中 2 次 或 持续 ≥ 3s);
 *   ⑤ v4/v6 同族——本网关出口纯 IPv4,实际取到 IPv6(含冒号)多为本地 IPv6 泄漏,
 *      异族无法比较 → 返回 null(不把本地 IPv6 误判成「走错出口」)。
 */
import { useEffect, useMemo, useRef, useState } from 'react'

import { useNexthubxClient } from '@/hooks/use-nexthubx-sync'
import { useSystemProxyState } from '@/hooks/use-system-proxy-state'
import { useVerge } from '@/hooks/use-verge'

/** 防抖:同一实际 IP 需连续命中的次数。 */
const STABLE_HIT_COUNT = 2
/** 防抖:或同一实际 IP 持续时长(ms)。 */
const STABLE_DURATION_MS = 3_000
/** 持续不一致达此时长(ms)→ 视为 prolonged,上层据此升级提示「联系技术支持」。 */
const MISMATCH_PROLONGED_MS = 60_000

export type ExitMatchStatus = 'match' | 'mismatch' | null

/** IPv4/IPv6 规范化:trim + 小写(IPv6 十六进制大小写无意义)。 */
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
  /** 已确证 mismatch 且持续 ≥ MISMATCH_PROLONGED_MS:上层据此升级到「联系技术支持」。 */
  prolonged: boolean
}

/**
 * 守卫核心:接收实际 IP,产出经防误报过滤后的比对状态 + prolonged 标志(纯计算,无副作用)。
 */
export function useNexthubxExitGuard({
  actualIp: actualIpRaw,
}: ExitGuardInput): ExitGuardResult {
  const { clientState } = useNexthubxClient()
  const { verge } = useVerge()
  const { indicator: systemProxyOn } = useSystemProxyState()

  const expectedExitIp = clientState?.expectedExitIp?.trim() || undefined
  const actualIp = actualIpRaw?.trim() || undefined

  // ③ 代理已连接:TUN 开 或 系统代理开
  const proxyConnected = Boolean(verge?.enable_tun_mode) || systemProxyOn

  const normActual = useMemo(() => normalizeIp(actualIp), [actualIp])
  const normExpected = useMemo(
    () => normalizeIp(expectedExitIp),
    [expectedExitIp],
  )

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

    // ⑤ v4/v6 异族(一方含冒号、一方不含)→ 无法比较,不判 mismatch(防 IPv6 泄漏误报)
    if (normActual.includes(':') !== normExpected.includes(':')) return null

    // 规范化后相等 → 一致(一致无需防抖,立即判定)
    if (normExpected === normActual) return 'match'

    // ④ 仅当该不一致 IP 已稳定(提升为 stableActual)才判 mismatch
    if (stableActual && stableActual === normActual) return 'mismatch'
    return null
  }, [normExpected, normActual, proxyConnected, stableActual])

  // 初始验证(激活后 service→TUN→IP)尚未完成:TUN 切换中 IP 短暂为旧出口属预期,
  // mismatch 大概率是瞬态 → UI 显示「校验中」,且不计入 prolonged。undefined(老状态)视为已完成。
  const setupInProgress = clientState?.setupComplete === false

  // 持续不一致计时:仅在「确证 mismatch 且非初始验证期」累计;恢复一致 / 条件不足即清零。
  // 达阈值才置 prolonged,避免瞬时抖动就升级到「联系技术支持」。
  const mismatchSinceRef = useRef(0)
  const [prolonged, setProlonged] = useState(false)
  useEffect(() => {
    if (status !== 'mismatch' || setupInProgress) {
      mismatchSinceRef.current = 0
      setProlonged(false)
      return
    }
    if (!mismatchSinceRef.current) mismatchSinceRef.current = Date.now()
    const elapsed = Date.now() - mismatchSinceRef.current
    if (elapsed >= MISMATCH_PROLONGED_MS) {
      setProlonged(true)
      return
    }
    const timer = setTimeout(
      () => setProlonged(true),
      MISMATCH_PROLONGED_MS - elapsed,
    )
    return () => clearTimeout(timer)
  }, [status, setupInProgress])

  return { status, expectedExitIp, actualIp, setupInProgress, prolonged }
}
