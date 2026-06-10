//! OS keychain 凭证存储(NextHubX)。
//!
//! 用系统级密钥库(macOS Keychain / Windows 凭据管理器),存 clientToken / identityPassword /
//! deviceId 等敏感且需「跨卸载重装存活」的数据:既加密、又不随 app 数据目录被卸载清除。
//! 前端经 invoke 调用;失败时前端回退 $APPDATA 文件(见 nexthubx-store / ensureDeviceId)。

use super::CmdResult;
use keyring::Entry;

/// keychain service 名(按 NextHubX 隔离;key 区分不同凭证项)。
const KEYCHAIN_SERVICE: &str = "com.nexthubx.client";

fn entry(key: &str) -> CmdResult<Entry> {
    Entry::new(KEYCHAIN_SERVICE, key).map_err(|e| e.to_string().into())
}

/// 写入(存在则覆盖)。
#[tauri::command]
pub fn keychain_set(key: String, value: String) -> CmdResult<()> {
    entry(&key)?
        .set_password(&value)
        .map_err(|e| e.to_string().into())
}

/// 读取;不存在返回 None(而非错误)。
#[tauri::command]
pub fn keychain_get(key: String) -> CmdResult<Option<String>> {
    match entry(&key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string().into()),
    }
}

/// 删除;不存在视为成功(幂等)。
#[tauri::command]
pub fn keychain_delete(key: String) -> CmdResult<()> {
    match entry(&key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string().into()),
    }
}
