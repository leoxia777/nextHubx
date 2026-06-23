import { getName, getVersion } from '@tauri-apps/api/app'
import { fetch } from '@tauri-apps/plugin-http'
import { once } from 'foxts/once'

import { nxDebug } from '@/services/nexthubx-debug'
import { debugLog } from '@/utils/debug'

const getUserAgentPromise = once(async () => {
  try {
    const [name, version] = await Promise.all([getName(), getVersion()])
    return `${name}/${version}`
  } catch (error) {
    console.debug('Failed to build User-Agent, fallback to default', error)
    return 'clash-verge-rev'
  }
})
// Get current IP and geolocation information （refactored IP detection with service-specific mappings）
export interface IpInfo {
  ip: string
  country_code: string
  country: string
  region: string
  city: string
  organization: string
  asn: number
  asn_organization: string
  longitude: number
  latitude: number
  timezone: string
}

// IP检测服务配置
interface ServiceConfig {
  name: string // 展示名(多源校验列表用)
  url: string
  mapping: (data: any) => IpInfo
  timeout?: number
}

// 单源探测结果:用于「多源交叉校验」列表展示
export type IpProbeStatus = 'ok' | 'ratelimited' | 'failed'
export interface IpProbeResult {
  source: string
  status: IpProbeStatus
  ip: string | null
  countryCode: string | null
  asn: number | null
}

// 可用的IP检测服务列表及字段映射。
// 自有源 ip.nexthubx.io 置首(走代理调用即得出口 IP,无第三方频率限制),作为主结果优先来源;
// 其余第三方作交叉校验,任一限频/失败仅在列表标注,不影响主结果。
const IP_CHECK_SERVICES: ServiceConfig[] = [
  {
    name: 'ip.nexthubx.io',
    url: 'https://ip.nexthubx.io/',
    mapping: (data) => ({
      ip: data.ip || '',
      country_code: data.country || '',
      country: data.country || '',
      region: data.region || '',
      city: data.city || '',
      organization: data.asOrganization || '',
      asn: data.asn || 0,
      asn_organization: data.asOrganization || '',
      longitude: 0,
      latitude: 0,
      timezone: '',
    }),
  },
  {
    name: 'api.ip.sb',
    url: 'https://api.ip.sb/geoip',
    mapping: (data) => ({
      ip: data.ip || '',
      country_code: data.country_code || '',
      country: data.country || '',
      region: data.region || '',
      city: data.city || '',
      organization: data.organization || data.isp || '',
      asn: data.asn || 0,
      asn_organization: data.asn_organization || '',
      longitude: data.longitude || 0,
      latitude: data.latitude || 0,
      timezone: data.timezone || '',
    }),
  },
  {
    name: 'ipapi.co',
    url: 'https://ipapi.co/json',
    mapping: (data) => ({
      ip: data.ip || '',
      country_code: data.country_code || '',
      country: data.country_name || '',
      region: data.region || '',
      city: data.city || '',
      organization: data.org || '',
      asn: data.asn ? parseInt(data.asn.replace('AS', '')) : 0,
      asn_organization: data.org || '',
      longitude: data.longitude || 0,
      latitude: data.latitude || 0,
      timezone: data.timezone || '',
    }),
  },
  {
    name: 'ipapi.is',
    url: 'https://api.ipapi.is/',
    mapping: (data) => ({
      ip: data.ip || '',
      country_code: data.location?.country_code || '',
      country: data.location?.country || '',
      region: data.location?.state || '',
      city: data.location?.city || '',
      organization: data.asn?.org || data.company?.name || '',
      asn: data.asn?.asn || 0,
      asn_organization: data.asn?.org || '',
      longitude: data.location?.longitude || 0,
      latitude: data.location?.latitude || 0,
      timezone: data.location?.timezone || '',
    }),
  },
  {
    name: 'ipwho.is',
    url: 'https://ipwho.is/',
    mapping: (data) => ({
      ip: data.ip || '',
      country_code: data.country_code || '',
      country: data.country || '',
      region: data.region || '',
      city: data.city || '',
      organization: data.connection?.org || data.connection?.isp || '',
      asn: data.connection?.asn || 0,
      asn_organization: data.connection?.isp || '',
      longitude: data.longitude || 0,
      latitude: data.latitude || 0,
      timezone: data.timezone?.id || '',
    }),
  },
  {
    name: 'ip.api.skk.moe',
    url: 'https://ip.api.skk.moe/cf-geoip',
    mapping: (data) => ({
      ip: data.ip || '',
      country_code: data.country || '',
      country: data.country || '',
      region: data.region || '',
      city: data.city || '',
      organization: data.asOrg || '',
      asn: data.asn || 0,
      asn_organization: data.asOrg || '',
      longitude: data.longitude || 0,
      latitude: data.latitude || 0,
      timezone: data.timezone || '',
    }),
  },
  {
    name: 'geojs.io',
    url: 'https://get.geojs.io/v1/ip/geo.json',
    mapping: (data) => ({
      ip: data.ip || '',
      country_code: data.country_code || '',
      country: data.country || '',
      region: data.region || '',
      city: data.city || '',
      organization: data.organization_name || '',
      asn: data.asn || 0,
      asn_organization: data.organization_name || '',
      longitude: Number(data.longitude) || 0,
      latitude: Number(data.latitude) || 0,
      timezone: data.timezone || '',
    }),
  },
]

const SERVICE_TIMEOUT = 5000

// 探测单个源,永不抛错;归一成 { info, result }。
// 限频(429/403)单独标 ratelimited,供 UI 提示「自行去查」;其余失败标 failed。
async function probeOne(
  service: ServiceConfig,
  userAgent: string,
): Promise<{ info: IpInfo | null; result: IpProbeResult }> {
  const fail = (
    status: IpProbeStatus,
  ): { info: null; result: IpProbeResult } => ({
    info: null,
    result: {
      source: service.name,
      status,
      ip: null,
      countryCode: null,
      asn: null,
    },
  })

  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => {
    timeoutController.abort()
  }, service.timeout || SERVICE_TIMEOUT)

  try {
    const response = await fetch(service.url, {
      method: 'GET',
      signal: timeoutController.signal,
      connectTimeout: service.timeout || SERVICE_TIMEOUT,
      headers: { 'User-Agent': userAgent },
    })

    if (!response.ok) {
      // 429 Too Many Requests / 部分源超额返回 403 → 视为「限频」
      return fail(
        response.status === 429 || response.status === 403
          ? 'ratelimited'
          : 'failed',
      )
    }

    let data: any
    try {
      data = await response.json()
    } catch {
      return fail('failed')
    }

    if (!data || !data.ip) {
      return fail('failed')
    }

    const info = service.mapping(data)
    return {
      info,
      result: {
        source: service.name,
        status: 'ok',
        ip: info.ip,
        countryCode: info.country_code || null,
        asn: info.asn || null,
      },
    }
  } catch (error) {
    debugLog(`IP检测源失败: ${service.url}`, error)
    return fail('failed')
  } finally {
    clearTimeout(timeoutId)
  }
}

// 获取当前IP和地理位置信息:并发探测所有源,返回主结果 + 各源结果列表(供交叉校验)。
// 主结果优先取自有源(列表第一个成功的源,即 ip.nexthubx.io 若可用),否则取第一个成功源。
// 全部失败才抛错(走卡片错误态 + 触发一次直连同步)。
export const getIpInfo = async (): Promise<
  IpInfo & { lastFetchTs: number; probes: IpProbeResult[] }
> => {
  const userAgent = await getUserAgentPromise()
  void nxDebug('ipcheck.start', { count: IP_CHECK_SERVICES.length })

  const settled = await Promise.all(
    IP_CHECK_SERVICES.map((service) => probeOne(service, userAgent)),
  )
  const probes = settled.map((s) => s.result)

  // settled 保持与 IP_CHECK_SERVICES 同序 → find 命中的就是「最高优先级的成功源」(自有源置首)
  const primary = settled.find((s) => s.info !== null)?.info ?? null
  const okCount = probes.filter((p) => p.status === 'ok').length

  if (!primary) {
    void nxDebug('ipcheck.allfail', { probes })
    throw new Error('所有IP检测服务都失败')
  }

  void nxDebug('ipcheck.ok', {
    ip: primary.ip,
    ok: okCount,
    total: probes.length,
  })
  return Object.assign(primary, { lastFetchTs: Date.now(), probes })
}
