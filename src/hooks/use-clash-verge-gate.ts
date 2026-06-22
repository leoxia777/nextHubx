/**
 * 共享的「官方 Clash Verge 冲突」检测(running || autostart),每 7s 轮询。
 *
 * 账号卡(出口校验)与 IP 卡(IP 查询)共用同一份(react-query 同 key 去重,只跑一个轮询),
 * 据此统一门控:CV 冲突时**不跑出口校验 / IP 查询,只显「一键关停」提示**——避免 NextHubX 在
 * CV 抢占网络时去查/校验(起坏 TUN、转圈),把订阅生效/IP 查询等放到 CV 关停之后再触发。
 */
import { useQuery } from '@tanstack/react-query'

import {
  detectOfficialClashVerge,
  detectOfficialClashVergeAutostart,
} from '@/services/cmds'
import { nxDebug } from '@/services/nexthubx-debug'

export interface CvGateState {
  running: boolean
  autostart: boolean
}

export const CV_GATE_CACHE_KEY = 'cv_gate'

export function useClashVergeGate() {
  const { data, refetch } = useQuery({
    queryKey: [CV_GATE_CACHE_KEY],
    queryFn: async (): Promise<CvGateState> => {
      const [running, autostart] = await Promise.all([
        detectOfficialClashVerge(),
        detectOfficialClashVergeAutostart(),
      ])
      void nxDebug('gate.check', { cvRunning: running, cvAutostart: autostart })
      return { running, autostart }
    },
    refetchInterval: 7000,
    refetchOnWindowFocus: false,
    staleTime: 0,
    retry: false,
  })
  const blocked = Boolean(data && (data.running || data.autostart))
  return {
    /** CV 冲突中(running 或 autostart)→ 给出 {running,autostart};否则 null。 */
    cvBlock: blocked ? (data as CvGateState) : null,
    /** 立即重新检测(返回 react-query 结果,.data 为最新 {running,autostart})。 */
    recheck: refetch,
  }
}
