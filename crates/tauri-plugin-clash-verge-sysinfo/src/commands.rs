use parking_lot::RwLock;
use serde::Serialize;
use tauri::{AppHandle, Runtime, State, command};
use tauri_plugin_clipboard_manager::{ClipboardExt as _, Error};

use crate::Platform;

#[derive(Serialize)]
pub struct SystemInfo {
    pub system_name: String,
    pub system_version: String,
    pub system_kernel_version: String,
    pub system_arch: String,
    pub app_version: String,
    pub app_core_mode: String,
    pub app_is_admin: bool,
}

impl From<Platform> for SystemInfo {
    fn from(platform: Platform) -> Self {
        Self {
            system_name: platform.sysinfo.system_name,
            system_version: platform.sysinfo.system_version,
            system_kernel_version: platform.sysinfo.system_kernel_version,
            system_arch: platform.sysinfo.system_arch,
            app_version: platform.appinfo.app_version,
            app_core_mode: platform.appinfo.app_core_mode,
            app_is_admin: platform.appinfo.app_is_admin,
        }
    }
}

#[command]
pub fn get_system_info(state: State<'_, RwLock<Platform>>) -> Result<SystemInfo, Error> {
    let platform = state.inner().read();
    Ok(SystemInfo::from(platform.clone()))
}

/// 获取应用的运行时间（毫秒）
#[command]
pub fn get_app_uptime(state: State<'_, RwLock<Platform>>) -> Result<u128, Error> {
    Ok(state.inner().read().appinfo.app_startup_time.elapsed().as_millis())
}

/// 检查应用是否以管理员身份运行
#[command]
pub fn app_is_admin(state: State<'_, RwLock<Platform>>) -> Result<bool, Error> {
    Ok(state.inner().read().appinfo.app_is_admin)
}

/// 检测系统中是否有「官方 Clash Verge」(clash-verge-rev) 正在运行。
///
/// 官方版与 NextHubX 会争用同一网络服务（TUN / 系统代理 / 内核端口），
/// 同时运行会导致连接互相断开。前端据此弹出提醒。
///
/// 仅匹配官方标识（bundle id `io.github.clash-verge-rev.clash-verge-rev`、
/// 路径含 `Clash Verge.app` / `clash-verge-rev`），并显式排除本应用
/// （`com.nexthubx.app` / `nexthubx`），不会误判 NextHubX 自身。
#[command]
pub fn detect_official_clash_verge() -> Result<bool, Error> {
    Ok(crate::detect_official_clash_verge())
}

#[command]
pub fn export_diagnostic_info<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, RwLock<Platform>>,
) -> Result<(), Error> {
    let info = state.inner().read().to_string();
    let clipboard = app_handle.clipboard();
    clipboard.write_text(info)
}
