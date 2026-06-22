/**
 * nextHubx 后端 API 客户端(M2)。
 *
 * ⚠️ 必须走 Tauri 的 HTTP 插件(`@tauri-apps/plugin-http` 的 `fetch`)——
 * 该 fetch 在 Rust 侧发起请求,不带 webview 的 Origin 头,因此不受后端 CORS 限制。
 * **不要改用 webview 原生 fetch**。参考 `src/services/api.ts`(CVR 下载/IP 检测同样用此 plugin fetch)。
 */
import { getName, getVersion } from '@tauri-apps/api/app'
import {
  BaseDirectory,
  exists,
  readTextFile,
  writeTextFile,
} from '@tauri-apps/plugin-fs'
import { fetch } from '@tauri-apps/plugin-http'

/**
 * 后端控制面 API base —— 业务层域名(nexthubx.com)。
 * 激活 /api/activate、同步 /api/client/sync 属「业务/控制面」走这里;
 * 订阅 /sub 与 VLESS 数据面属「订阅层」(hub4cc.com),在下发的 clash 配置里(server_domain),与此分离。
 * 旧客户端用的 gate.hub4cc.com 仍由网关同时服务 /api,故升级不影响存量。
 */
export const NEXTHUBX_API_BASE = 'https://gate.nexthubx.io'

const REQUEST_TIMEOUT_MS = 15_000

/**
 * 持久安装设备 ID。
 * 权威源 = $APPDATA 文件 nexthubx-device-id(与 clientToken 的 nexthubx-client.json 同目录,
 * 持久化行为一致:普通卸载/重装多保留,干净卸载/清数据一起丢);localStorage 为同步缓存。
 * 解析顺序:文件 → localStorage(迁移旧装)→ 新生成;解析后双写文件 + localStorage。
 * 后端据此强制设备绑定(一席一设备):激活绑定首个设备,sync 校验不符即 401。
 * 干净卸载(连 clientToken 一起丢)后需重新激活(管理员「重置设备」发新码)。
 */
const DEVICE_ID_KEY = 'nexthubx-device-id'
const DEVICE_ID_FILE = 'nexthubx-device-id'
const DEVICE_ID_FILE_OPTS = { baseDir: BaseDirectory.AppData } as const

let cachedDeviceId: string | null = null

async function readDeviceIdFile(): Promise<string> {
  try {
    if (await exists(DEVICE_ID_FILE, DEVICE_ID_FILE_OPTS)) {
      return (await readTextFile(DEVICE_ID_FILE, DEVICE_ID_FILE_OPTS)).trim()
    }
  } catch {
    /* fs 不可用/无权限 → 退回 localStorage */
  }
  return ''
}

async function writeDeviceIdFile(id: string): Promise<void> {
  try {
    await writeTextFile(DEVICE_ID_FILE, id, DEVICE_ID_FILE_OPTS)
  } catch {
    /* 写不了主目录 → localStorage 兜底,不影响功能 */
  }
}

/** 解析并持久化设备 ID(幂等,带内存缓存)。activate / sync 前及展示时 await。 */
export async function ensureDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId
  let id = await readDeviceIdFile()
  if (!id) id = localStorage.getItem(DEVICE_ID_KEY) ?? '' // 迁移:仅有 localStorage 的旧安装
  if (!id) id = crypto.randomUUID()
  await writeDeviceIdFile(id) // 落主目录(跨重装)
  localStorage.setItem(DEVICE_ID_KEY, id) // 同步缓存
  cachedDeviceId = id
  return id
}

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
  /** 分配给该席位的出口公网 IP,客户端用于比对实际出口。可能缺省(老后端/未分配)。 */
  expectedExitIp?: string
  /** 账号使用说明(运营在后台「系统配置」维护,随激活下发)。缺省时客户端回退内置文案。 */
  tips?: string | null
}

/** GET /api/client/sync 响应(active)。 */
export interface SyncActiveResult {
  status: 'active'
  proxyConfig: ProxyConfig
  identityEmail: string
  identityPassword: string
  configFingerprint: string
  /** 分配给该席位的出口公网 IP,客户端用于比对实际出口。可能缺省(老后端/未分配)。 */
  expectedExitIp?: string
  /** 账号使用说明(运营在后台「系统配置」维护,随 sync 下发)。缺省时客户端回退内置文案。 */
  tips?: string | null
  /** team 绑定状态(none / invite_sent / bound);自助绑定流程据此显示状态。可能缺省(老后端)。 */
  bindStatus?: string
  /** 是否自助绑定席位;仅自助席位展示绑定状态 UI。可能缺省(老后端,视为非自助)。 */
  isSelfBind?: boolean
  /** 自助绑定角色:creator(manager@域 主账号,走建团流程、无邀请)/ member(被邀请)。缺省视为 member。 */
  selfBindRole?: string
  /** 自助绑定用户个人邮箱;客户端把文案里的 {pemail} 占位符替换为它。缺省/非自助席位为空。 */
  selfBindPersonalEmail?: string | null
  /** 自助绑定 3 段状态文案(运营后台可编辑,按 bindStatus 显示);缺省/null 或空字段时客户端回退内置 i18n。 */
  selfBindTips?: { pending: string; invited: string; bound: string } | null
  /** 是否已配置 Authenticator(TOTP)。**密钥不下发**——算法在服务端,客户端据此渲染并轮询 /api/client/totp 取码。 */
  hasTotp?: boolean
}

/** GET /api/client/totp 返回:服务端算好的当前码 + 周期 + 剩余秒。 */
export interface TotpCode {
  code: string
  period: number
  remaining: number
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
 * 激活:POST /api/activate { email, token }(双因子:邮箱 + 激活码)
 * - 200 → 返回 clientToken / 账号 / proxyConfig
 * - 409 → 抛 ActivationInvalidError(邮箱或激活码不正确/已失效,后端不区分以防枚举)
 * - 其他非 2xx → 抛 Error
 */
export async function activate(
  email: string,
  token: string,
): Promise<ActivateResult> {
  const userAgent = await buildUserAgent()
  const response = await fetch(`${NEXTHUBX_API_BASE}/api/activate`, {
    method: 'POST',
    connectTimeout: REQUEST_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': userAgent,
    },
    body: JSON.stringify({
      email: email.trim(),
      token,
      deviceId: await ensureDeviceId(),
    }),
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
    'X-Device-Id': await ensureDeviceId(),
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

/**
 * 取当前 2FA(TOTP)码:GET /api/client/totp(算法在服务端,客户端只拿 6 位码 + 倒计时)。
 *   Authorization: Bearer <clientToken> + X-Device-Id(鉴权同 sync)
 * - 200 → { code, period, remaining }
 * - 404 → null(该席位未配置 2FA)
 * - 其他非 2xx → 抛错(调用方保留旧码、下次重试)
 */
export async function fetchTotpCode(
  clientToken: string,
): Promise<TotpCode | null> {
  const userAgent = await buildUserAgent()
  const response = await fetch(`${NEXTHUBX_API_BASE}/api/client/totp`, {
    method: 'GET',
    connectTimeout: REQUEST_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${clientToken}`,
      'User-Agent': userAgent,
      'X-Device-Id': await ensureDeviceId(),
    },
  })
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`Totp fetch failed with status ${response.status}`)
  }
  return (await response.json()) as TotpCode
}

export type ConfirmBindResult =
  | { status: 'ok' }
  | { status: 'unauthorized' }
  /** 邀请尚未发送 / 席位作废等(409):客户端提示稍后再试或联系管理员。 */
  | { status: 'conflict' }

/**
 * 自助绑定末步:用户在客户端自报「已绑定」。POST /api/client/confirm-bind
 *   Authorization: Bearer <clientToken> + X-Device-Id(鉴权同 sync)
 * - 200 → { status:'ok' }(后端 teamBindStatus→bound)
 * - 401 → { status:'unauthorized' }
 * - 409 → { status:'conflict' }(邀请未发送 / 席位作废)
 * 注:与后台运营确认双通道,用户自报后下一次 sync 会回填 bound(指纹含 teamBindStatus)。
 */
export async function confirmBind(
  clientToken: string,
): Promise<ConfirmBindResult> {
  const userAgent = await buildUserAgent()
  const response = await fetch(`${NEXTHUBX_API_BASE}/api/client/confirm-bind`, {
    method: 'POST',
    connectTimeout: REQUEST_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${clientToken}`,
      'User-Agent': userAgent,
      'X-Device-Id': await ensureDeviceId(),
    },
  })
  if (response.status === 401) return { status: 'unauthorized' }
  if (response.status === 409) return { status: 'conflict' }
  if (!response.ok) {
    throw new Error(`Confirm-bind failed with status ${response.status}`)
  }
  return { status: 'ok' }
}
