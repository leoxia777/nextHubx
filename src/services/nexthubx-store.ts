/**
 * nextHubx 客户端凭证 / 账号本地存储(M2)。
 *
 * 存储方式选型(记录于 DEV-NOTES C7):
 * - 用 `@tauri-apps/plugin-fs` 写一个 JSON 文件到 **CVR 应用数据目录**(`$APPDATA`,即
 *   `BaseDirectory.AppData` —— 与 CVR 自身 config 同一目录,随 APP_ID 隔离)。
 * - 选它而非「verge config 自定义字段」:`IVergeConfig` 是 Rust serde struct,加自定义字段需改
 *   Rust(本阶段无 Rust 工具链、且红线要求不改造底层)。FS 文件是纯前端可写、最贴近「CVR 现成
 *   配置存储」的方式;capabilities `migrated.json` 已放行 `$APPDATA/**` 读写。
 * - 不用 localStorage:webview 存储可被清理、不在 APPDATA 持久目录,且非「配置存储」。
 *
 * 注:此文件含长期 clientToken,属敏感凭证。当前与 CVR config 同目录(无系统级加密);
 * 后续如需更强保护可迁移到 OS keychain(需 Rust 侧 plugin),见 DEV-NOTES。
 */
import { BaseDirectory } from '@tauri-apps/api/path'
import { exists, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'

const STORE_FILE = 'nexthubx-client.json'
const STORE_BASE_DIR = BaseDirectory.AppData

export interface NexthubxClientState {
  clientToken: string
  identityEmail: string
  identityPassword: string
  /** 上次同步成功的配置指纹,用于 If-None-Match。 */
  configFingerprint?: string
  /** nextHubx 托管的本地 profile uid,用于后续同步时复用更新而非反复新建。 */
  profileUid?: string
  /** 分配给该席位的出口公网 IP,用于在 IP 信息卡片中比对实际出口是否一致。 */
  expectedExitIp?: string
}

export async function loadClientState(): Promise<NexthubxClientState | null> {
  try {
    const present = await exists(STORE_FILE, { baseDir: STORE_BASE_DIR })
    if (!present) return null
    const raw = await readTextFile(STORE_FILE, { baseDir: STORE_BASE_DIR })
    const parsed = JSON.parse(raw) as NexthubxClientState
    if (!parsed?.clientToken) return null
    return parsed
  } catch (err) {
    console.error('[nexthubx-store] load failed', err)
    return null
  }
}

export async function saveClientState(
  state: NexthubxClientState,
): Promise<void> {
  await writeTextFile(STORE_FILE, JSON.stringify(state, null, 2), {
    baseDir: STORE_BASE_DIR,
  })
}

/**
 * 清除凭证(席位作废 / 重激活前)。capabilities 仅放行 `fs:allow-write-file`(无 remove),
 * 故用写入空对象「抹除」凭证内容(load 时无 clientToken 即视为未激活),不物理删文件。
 */
export async function clearClientState(): Promise<void> {
  try {
    await writeTextFile(STORE_FILE, JSON.stringify({}), {
      baseDir: STORE_BASE_DIR,
    })
  } catch (err) {
    console.error('[nexthubx-store] clear failed', err)
  }
}
