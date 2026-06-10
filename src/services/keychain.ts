/**
 * OS keychain 封装(invoke Rust 的 keychain_* 命令)。
 * 系统级密钥库(macOS Keychain / Windows 凭据管理器):加密 + 跨卸载重装存活。
 * 调用方应 try/catch:keychain 不可用(如部分 Linux 无 secret-service)时回退 $APPDATA。
 */
import { invoke } from '@tauri-apps/api/core'

export function keychainGet(key: string): Promise<string | null> {
  return invoke<string | null>('keychain_get', { key })
}

export function keychainSet(key: string, value: string): Promise<void> {
  return invoke<void>('keychain_set', { key, value })
}

export function keychainDelete(key: string): Promise<void> {
  return invoke<void>('keychain_delete', { key })
}
