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
 * 立即强制重测出口 IP —— 任何涉及网络的操作后调用,不必等 IP 卡倒计时(300s)/出口守卫轮询(60s)。
 * invalidate 会即时刷新处于挂载态的观察者(IP 卡 / 出口守卫 / 账号卡),几秒内反映最新出口或「网络暂时不通」。
 */
export function refetchIpInfoNow(): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: [IP_INFO_CACHE_KEY] })
}
