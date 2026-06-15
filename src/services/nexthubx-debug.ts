/**
 * nextHubx 激活流程调试日志(M2 调测)。
 *
 * 把激活/验证各步骤 + 出口 IP 探测的关键事件追加写入 `$APPDATA/<APP_ID>/nexthubx-debug.log`,
 * 便于在用户机上**直接 SSH 读取**定位问题(前端 console 不落盘、SSH 看不到)。
 * 仅保留最近 N 行,避免无限增长。生产期可按需关闭(见 DEBUG_ENABLED)。
 */
import {
  BaseDirectory,
  exists,
  readTextFile,
  writeTextFile,
} from '@tauri-apps/plugin-fs'

const DEBUG_FILE = 'nexthubx-debug.log'
const DEBUG_BASE_DIR = BaseDirectory.AppData
const MAX_LINES = 400
/** 调试日志开关。排障期常开;稳定后可改 false。 */
const DEBUG_ENABLED = true

function ts(): string {
  // 注:此为应用运行时(非 workflow 沙箱),new Date 可用。
  try {
    return new Date().toISOString()
  } catch {
    return ''
  }
}

/**
 * 追加一条调试日志。data 会 JSON 序列化(截断超长)。失败静默(不影响主流程)。
 */
export async function nxDebug(event: string, data?: unknown): Promise<void> {
  if (!DEBUG_ENABLED) return
  try {
    let detail = ''
    if (data !== undefined) {
      try {
        detail = ' ' + JSON.stringify(data)
      } catch {
        detail = ' ' + String(data)
      }
      if (detail.length > 1000) detail = detail.slice(0, 1000) + '…'
    }
    const line = `[${ts()}] ${event}${detail}`
    let prev = ''
    if (await exists(DEBUG_FILE, { baseDir: DEBUG_BASE_DIR })) {
      prev = await readTextFile(DEBUG_FILE, { baseDir: DEBUG_BASE_DIR })
    }
    const lines = (prev ? prev.split('\n') : []).concat(line)
    const trimmed = lines.slice(-MAX_LINES).join('\n')
    await writeTextFile(DEBUG_FILE, trimmed, { baseDir: DEBUG_BASE_DIR })
  } catch {
    /* 调试日志失败不影响主流程 */
  }
}

/** 从 Error/unknown 提取可读摘要(name/message/status 等),供日志用。 */
export function errInfo(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const anyErr = err as Error & { status?: number; code?: unknown }
    return {
      name: err.name,
      message: err.message,
      status: anyErr.status,
      code: anyErr.code,
    }
  }
  return { value: String(err) }
}
