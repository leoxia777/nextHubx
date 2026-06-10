/**
 * nextHubx 后端 API 客户端(M2)。
 *
 * ⚠️ 必须走 Tauri 的 HTTP 插件(`@tauri-apps/plugin-http` 的 `fetch`)——
 * 该 fetch 在 Rust 侧发起请求,不带 webview 的 Origin 头,因此不会撞后端 CORS
 * (后端只放行 admin.hub4cc.com)。**不要改用 webview 原生 fetch**。
 * 参考 `src/services/api.ts`(CVR 下载/IP 检测同样用此 plugin fetch)。
 */
import { getName, getVersion } from '@tauri-apps/api/app'
import { BaseDirectory, exists, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { fetch } from '@tauri-apps/plugin-http'

import { keychainGet, keychainSet } from './keychain'

/** 后端 API base(已上线)。 */
export const NEXTHUBX_API_BASE = 'https://gate.hub4cc.com'

const REQUEST_TIMEOUT_MS = 15_000

/**
 * 持久安装设备 ID。
 * 权威源 = OS keychain(key=device-id):加密 + **跨「干净卸载」存活**(不随 app 数据目录被清)。
 * $APPDATA 文件 + localStorage 作缓存/回退(keychain 不可用时降级,deviceId 非机密可明文落盘)。
 * 解析顺序:keychain → $APPDATA 文件 → localStorage(迁移旧装)→ 新生成;解析后三处回写。
 * 后端据此强制设备绑定(一席一设备):激活绑定首个设备,sync 校验不符即 401。
 * keychain 存活意味着:即便干净卸载重装,deviceId/clientToken 仍在,无需重新激活(详见 nexthubx-store)。
 */
const DEVICE_ID_KEY = 'nexthubx-device-id'
const DEVICE_ID_KC_KEY = 'device-id'
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
  let id = ''
  try {
    id = (await keychainGet(DEVICE_ID_KC_KEY))?.trim() ?? '' // keychain 优先(跨干净卸载)
  } catch {
    /* keychain 不可用 → 降级到 $APPDATA/localStorage */
  }
  if (!id) id = await readDeviceIdFile() // 迁移:$APPDATA 旧安装
  if (!id) id = localStorage.getItem(DEVICE_ID_KEY) ?? '' // 迁移:仅有 localStorage 的旧安装
  if (!id) id = crypto.randomUUID()
  try {
    await keychainSet(DEVICE_ID_KC_KEY, id) // 权威源,跨卸载
  } catch {
    /* keychain 写失败 → 仅靠下面的文件/缓存,不影响本次功能 */
  }
  await writeDeviceIdFile(id) // 缓存/回退(跨普通重装)
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
    body: JSON.stringify({ token, deviceId: await ensureDeviceId() }),
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
