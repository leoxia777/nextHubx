/**
 * nextHubx 客户端凭证 / 账号本地存储(M2 + keychain)。
 *
 * 存储方式选型(记录于 DEV-NOTES C7):
 * - **权威源 = OS keychain**(macOS Keychain / Windows 凭据管理器,key=`client-state`):
 *   系统级加密,且**跨「干净卸载」存活**——不随 app 数据目录被卸载/清数据清除。
 *   含长期 clientToken / identityPassword,属敏感凭证,理应进系统密钥库而非明文落盘。
 * - **回退 / 迁移 = `$APPDATA` JSON 文件**(`nexthubx-client.json`,与 CVR config 同目录):
 *   keychain 不可用(如部分 Linux 无 secret-service)时降级到此明文文件;
 *   旧版本只写过此文件的安装,首次 load 时自动迁移进 keychain 并抹除明文残留。
 * - 不用 localStorage:webview 存储可被清理、非持久目录。
 *
 * 跨场景语义(与后端权威性配合):
 * - 用户重装(含干净卸载):keychain 保留 → 无需重新激活。
 * - 换设备 / 订阅重置:后端作废 clientToken + 轮换 proxyUuid → 本地即便留着旧凭证也连不上,
 *   sync 返回 401/revoked,需用管理员发的**新激活码**重新激活。本地持久化不削弱后端权威。
 */
import { BaseDirectory } from '@tauri-apps/api/path'
import { exists, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'

import { keychainDelete, keychainGet, keychainSet } from './keychain'

const STORE_FILE = 'nexthubx-client.json'
const STORE_BASE_DIR = BaseDirectory.AppData
const KEYCHAIN_KEY = 'client-state'

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

function parseState(raw: string | null | undefined): NexthubxClientState | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as NexthubxClientState
    return parsed?.clientToken ? parsed : null
  } catch {
    return null
  }
}

/** 读 $APPDATA 明文文件(回退/迁移源)。 */
async function readFileState(): Promise<NexthubxClientState | null> {
  try {
    if (!(await exists(STORE_FILE, { baseDir: STORE_BASE_DIR }))) return null
    return parseState(await readTextFile(STORE_FILE, { baseDir: STORE_BASE_DIR }))
  } catch (err) {
    console.error('[nexthubx-store] read file failed', err)
    return null
  }
}

/** 抹除 $APPDATA 明文(capabilities 无 remove,写空对象抹内容)。 */
async function eraseFileState(): Promise<void> {
  try {
    await writeTextFile(STORE_FILE, JSON.stringify({}), { baseDir: STORE_BASE_DIR })
  } catch {
    /* 抹不掉文件不致命:load 仍以 keychain 为权威源 */
  }
}

export async function loadClientState(): Promise<NexthubxClientState | null> {
  // 1) keychain 优先(跨干净卸载存活)
  try {
    const fromKc = parseState(await keychainGet(KEYCHAIN_KEY))
    if (fromKc) return fromKc
    // keychain 空:迁移旧版本仅落 $APPDATA 的安装
    const fromFile = await readFileState()
    if (fromFile) {
      try {
        await keychainSet(KEYCHAIN_KEY, JSON.stringify(fromFile))
        await eraseFileState() // 迁入 keychain 后抹除明文残留
      } catch (err) {
        console.error('[nexthubx-store] migrate to keychain failed', err)
      }
      return fromFile
    }
    return null
  } catch (err) {
    // 2) keychain 不可用 → 降级 $APPDATA 明文
    console.error('[nexthubx-store] keychain load failed, fallback to file', err)
    return readFileState()
  }
}

export async function saveClientState(
  state: NexthubxClientState,
): Promise<void> {
  const json = JSON.stringify(state, null, 2)
  // 优先存 keychain;成功则抹掉 $APPDATA 明文(只信 keychain)
  try {
    await keychainSet(KEYCHAIN_KEY, json)
    await eraseFileState()
    return
  } catch (err) {
    console.error('[nexthubx-store] keychain save failed, fallback to $APPDATA', err)
  }
  // keychain 不可用 → 降级明文文件
  await writeTextFile(STORE_FILE, json, { baseDir: STORE_BASE_DIR })
}

/**
 * 清除凭证(席位作废 / 重激活前):同时清 keychain 与 $APPDATA 残留。
 */
export async function clearClientState(): Promise<void> {
  try {
    await keychainDelete(KEYCHAIN_KEY)
  } catch (err) {
    console.error('[nexthubx-store] keychain clear failed', err)
  }
  await eraseFileState()
}
