/**
 * 共享的 IP 信息查询 hook。
 *
 * 与 IP Info 卡片共用同一 react-query 缓存键(`cv_ip_info_cache`),因此卡片、
 * 出口守卫、全局警示组件读取的是同一份数据,不会重复请求。
 */
import { useQuery } from '@tanstack/react-query'

import { getIpInfo } from '@/services/api'
import { queryClient } from '@/services/query-client'

export const IP_INFO_CACHE_KEY = 'cv_ip_info_cache'

export function useIpInfoQuery(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [IP_INFO_CACHE_KEY],
    queryFn: getIpInfo,
    // CV 冲突时由调用方传 enabled=false 停查(账号卡 + IP 卡共用同一 query,需都传才真停)。
    enabled: opts?.enabled ?? true,
    staleTime: Infinity,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
    // 原 30s:网络断(如更新后 TUN 未重装)时失败后要等 30s 才重试 → 「网络暂时不通」提示奇慢。
    // 收紧到 3s,配合 refetchIpInfoNow(网络操作后立即重测)让不通状态几秒内浮现。
    retryDelay: 3_000,
  })
}

/**
 * 网络相关操作后重测出口 IP —— 不必等 IP 卡倒计时(300s)/出口守卫轮询(60s)。
 *
 * 抗抖动设计:
 * - **~1.5s settle 延迟**:让 TUN/系统代理/内核切换先落定,避免读到「切换中」的旧出口或瞬时失败(t=0 硬查会误判)。
 * - **去抖(clearTimeout)**:一串连续操作(如一键连 = TUN + 装服务)只在最后一步后触发一次,不中途乱查。
 * - 落定后 invalidate 即时刷新挂载态观察者(IP 卡 / 出口守卫 / 账号卡);配合 query 的 retry:1(3s),
 *   「网络暂时不通」(= 查询 error)只在真·断网 ≥3s 才浮现——子秒抖动被重试吸收、期间显示上次数据不误报。
 * 仍远快于原来的 60–300s 周期。
 */
let ipRecheckTimer: ReturnType<typeof setTimeout> | null = null
export function refetchIpInfoNow(): void {
  if (ipRecheckTimer) clearTimeout(ipRecheckTimer)
  ipRecheckTimer = setTimeout(() => {
    ipRecheckTimer = null
    void queryClient.invalidateQueries({ queryKey: [IP_INFO_CACHE_KEY] })
  }, 1500)
}
