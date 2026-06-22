/**
 * 共享的 IP 信息查询 hook。
 *
 * 与 IP Info 卡片共用同一 react-query 缓存键(`cv_ip_info_cache`),因此卡片、
 * 出口守卫、全局警示组件读取的是同一份数据,不会重复请求。
 */
import { useQuery } from '@tanstack/react-query'

import { getIpInfo } from '@/services/api'

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
    retryDelay: 30_000,
  })
}
