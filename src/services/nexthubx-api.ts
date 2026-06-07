/**
 * nextHubx 后端 API 客户端(M2)。
 *
 * ⚠️ 必须走 Tauri 的 HTTP 插件(`@tauri-apps/plugin-http` 的 `fetch`)——
 * 该 fetch 在 Rust 侧发起请求,不带 webview 的 Origin 头,因此不会撞后端 CORS
 * (后端只放行 admin.hub4cc.com)。**不要改用 webview 原生 fetch**。
 * 参考 `src/services/api.ts`(CVR 下载/IP 检测同样用此 plugin fetch)。
 */
import { getName, getVersion } from '@tauri-apps/api/app'
import { fetch } from '@tauri-apps/plugin-http'

/** 后端 API base(已上线)。 */
export const NEXTHUBX_API_BASE = 'https://gate.hub4cc.com'

const REQUEST_TIMEOUT_MS = 15_000

export interface ProxyConfig {
  format: 'clash-yaml'
  content: string
}

/** POST /api/activate 成功响应。 */
export interface ActivateResult {
  clientToken: string
  identityEmail: string
  identityPassword: string
  proxyConfig: ProxyConfig
}

/** GET /api/client/sync 响应(active)。 */
export interface SyncActiveResult {
  status: 'active'
  proxyConfig: ProxyConfig
  identityEmail: string
  identityPassword: string
  configFingerprint: string
}

export type SyncResult =
  | { status: 'active'; data: SyncActiveResult }
  | { status: 'not-modified' }
  | { status: 'revoked' }
  | { status: 'unauthorized' }

/** 激活码失效(409)。 */
export class ActivationInvalidError extends Error {
  constructor() {
    super('Activation token is invalid or expired')
    this.name = 'ActivationInvalidError'
  }
}

async function buildUserAgent(): Promise<string> {
  try {
    const [name, version] = await Promise.all([getName(), getVersion()])
    return `${name}/${version}`
  } catch {
    return 'nextHubx'
  }
}

/**
 * 激活:POST /api/activate { token }
 * - 200 → 返回 clientToken / 账号 / proxyConfig
 * - 409 → 抛 ActivationInvalidError(激活码失效)
 * - 其他非 2xx → 抛 Error
 */
export async function activate(token: string): Promise<ActivateResult> {
  const userAgent = await buildUserAgent()
  const response = await fetch(`${NEXTHUBX_API_BASE}/api/activate`, {
    method: 'POST',
    connectTimeout: REQUEST_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': userAgent,
    },
    body: JSON.stringify({ token }),
  })

  if (response.status === 409) {
    throw new ActivationInvalidError()
  }
  if (!response.ok) {
    throw new Error(`Activate failed with status ${response.status}`)
  }

  const data = (await response.json()) as ActivateResult
  if (!data?.clientToken || !data?.proxyConfig?.content) {
    throw new Error('Activate response missing required fields')
  }
  return data
}

/**
 * 同步:GET /api/client/sync
 *   Authorization: Bearer <clientToken>
 *   If-None-Match: <configFingerprint>(可选)
 * - 200 active → { status:'active', data }
 * - 304 → { status:'not-modified' }
 * - 200 revoked → { status:'revoked' }
 * - 401 → { status:'unauthorized' }
 */
export async function syncClient(
  clientToken: string,
  configFingerprint?: string | null,
): Promise<SyncResult> {
  const userAgent = await buildUserAgent()
  const headers: Record<string, string> = {
    Authorization: `Bearer ${clientToken}`,
    'User-Agent': userAgent,
  }
  if (configFingerprint) {
    headers['If-None-Match'] = configFingerprint
  }

  const response = await fetch(`${NEXTHUBX_API_BASE}/api/client/sync`, {
    method: 'GET',
    connectTimeout: REQUEST_TIMEOUT_MS,
    headers,
  })

  if (response.status === 304) {
    return { status: 'not-modified' }
  }
  if (response.status === 401) {
    return { status: 'unauthorized' }
  }
  if (!response.ok) {
    throw new Error(`Sync failed with status ${response.status}`)
  }

  const data = (await response.json()) as
    | SyncActiveResult
    | { status: 'revoked' }
  if (data.status === 'revoked') {
    return { status: 'revoked' }
  }
  return { status: 'active', data: data as SyncActiveResult }
}
