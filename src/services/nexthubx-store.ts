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
  /** 账号使用说明(后端「系统配置」下发,激活/sync 时更新);缺省时账号卡片回退内置文案。 */
  usageTips?: string
  /** team 绑定状态(none / invite_sent / bound),sync 下发;客户端据此显示 待绑定/已发送邀请/已绑定。 */
  bindStatus?: string
  /** 是否自助绑定席位(sync 下发);仅自助席位展示绑定状态 UI,平台分配席位不展示。 */
  isSelfBind?: boolean
  /** 自助绑定 3 段状态文案(sync 下发,后台可编辑);空/缺省字段回退内置 i18n。 */
  selfBindTips?: { pending: string; invited: string; bound: string } | null
  /**
   * 激活后的「连接验证」是否已走完(service 就绪 + TUN 开启 + 出口 IP 一致)。
   * - `false`:激活码已校验通过、配置已导入,但中途某步未完成 → 重开 app 应**从验证流程续跑**,
   *   而不是回到激活码输入(见 account-card 的 resume 逻辑)。
   * - `true`:全流程完成,正常展示账号。
   * - `undefined`:老版本写入的状态,视为已完成(不强制重验,避免打扰存量已激活用户)。
   */
  setupComplete?: boolean
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
 * 「被重置」通知:席位被管理员重置/作废后,sync 清凭证时留下,供激活界面常驻展示
 * (告诉用户是哪个账号被重置、为何突然回到激活页),并预填邮箱框。重激活成功即被 saveClientState 覆盖清除。
 */
export interface NexthubxResetNotice {
  /** 被重置席位的账号邮箱(清凭证前保留,供用户辨识 + 找管理员)。可能缺失(老状态无邮箱)。 */
  email?: string
  /** 原因:401(凭证/设备失效)或 revoked(席位作废)。 */
  reason: 'unauthorized' | 'revoked'
  /** 触发时间(ISO)。 */
  at: string
}

/**
 * 清除凭证(席位作废 / 重激活前)。capabilities 仅放行 `fs:allow-write-file`(无 remove),
 * 故用写入「抹除」凭证内容(load 时无 clientToken 即视为未激活),不物理删文件。
 * 传入 resetNotice 时保留它(供激活界面常驻提示 + 邮箱预填),其余凭证/账号一律清掉。
 */
export async function clearClientState(
  resetNotice?: NexthubxResetNotice,
): Promise<void> {
  try {
    await writeTextFile(
      STORE_FILE,
      JSON.stringify(resetNotice ? { resetNotice } : {}),
      {
        baseDir: STORE_BASE_DIR,
      },
    )
  } catch (err) {
    console.error('[nexthubx-store] clear failed', err)
  }
}

/** 读「被重置」通知(无 clientToken 时仍可读);不存在 → null。 */
export async function loadResetNotice(): Promise<NexthubxResetNotice | null> {
  try {
    const present = await exists(STORE_FILE, { baseDir: STORE_BASE_DIR })
    if (!present) return null
    const raw = await readTextFile(STORE_FILE, { baseDir: STORE_BASE_DIR })
    const parsed = JSON.parse(raw) as { resetNotice?: NexthubxResetNotice }
    return parsed?.resetNotice ?? null
  } catch (err) {
    console.error('[nexthubx-store] load reset notice failed', err)
    return null
  }
}
