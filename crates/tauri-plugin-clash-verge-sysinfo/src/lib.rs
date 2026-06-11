use std::{
    fmt::{Debug, Display},
    time::Instant,
};

pub mod commands;

#[cfg(windows)]
use deelevate::{PrivilegeLevel, Token};
#[cfg(unix)]
pub use libc;
use parking_lot::RwLock;
use sysinfo::{Networks, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System, UpdateKind};
use tauri::{
    Manager as _, Runtime,
    plugin::{Builder, TauriPlugin},
};

#[derive(Clone)]
pub struct SysInfo {
    system_name: String,
    system_version: String,
    system_kernel_version: String,
    system_arch: String,
}

impl Default for SysInfo {
    #[inline]
    fn default() -> Self {
        let system_name = System::name().unwrap_or_else(|| "Null".into());
        let system_version = System::long_os_version().unwrap_or_else(|| "Null".into());
        let system_kernel_version = System::kernel_version().unwrap_or_else(|| "Null".into());
        let system_arch = System::cpu_arch();
        Self {
            system_name,
            system_version,
            system_kernel_version,
            system_arch,
        }
    }
}

#[derive(Clone)]
pub struct AppInfo {
    app_version: String,
    app_core_mode: String,
    pub app_startup_time: Instant,
    pub app_is_admin: bool,
}

impl Default for AppInfo {
    #[inline]
    fn default() -> Self {
        let app_version = "0.0.0".into();
        let app_core_mode = "NotRunning".into();
        let app_is_admin = false;
        let app_startup_time = Instant::now();
        Self {
            app_version,
            app_core_mode,
            app_startup_time,
            app_is_admin,
        }
    }
}

#[derive(Default, Clone)]
pub struct Platform {
    pub sysinfo: SysInfo,
    pub appinfo: AppInfo,
}

impl Debug for Platform {
    #[inline]
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Platform")
            .field("system_name", &self.sysinfo.system_name)
            .field("system_version", &self.sysinfo.system_version)
            .field("system_kernel_version", &self.sysinfo.system_kernel_version)
            .field("system_arch", &self.sysinfo.system_arch)
            .field("app_version", &self.appinfo.app_version)
            .field("app_core_mode", &self.appinfo.app_core_mode)
            .field("app_is_admin", &self.appinfo.app_is_admin)
            .finish()
    }
}

impl Display for Platform {
    #[inline]
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "System Name: {}\nSystem Version: {}\nSystem kernel Version: {}\nSystem Arch: {}\nVerge Version: {}\nRunning Mode: {}\nIs Admin: {}",
            self.sysinfo.system_name,
            self.sysinfo.system_version,
            self.sysinfo.system_kernel_version,
            self.sysinfo.system_arch,
            self.appinfo.app_version,
            self.appinfo.app_core_mode,
            self.appinfo.app_is_admin
        )
    }
}

impl Platform {
    #[inline]
    fn new() -> Self {
        Self::default()
    }
}

#[inline]
fn is_binary_admin() -> bool {
    #[cfg(not(windows))]
    unsafe {
        libc::geteuid() == 0
    }
    #[cfg(windows)]
    Token::with_current_process()
        .and_then(|token| token.privilege_level())
        .map(|level| level != PrivilegeLevel::NotPrivileged)
        .unwrap_or(false)
}

#[inline]
#[cfg(unix)]
pub fn current_gid() -> u32 {
    unsafe { libc::getgid() }
}

#[inline]
pub fn list_network_interfaces() -> Vec<String> {
    let mut networks = Networks::new();
    networks.refresh(false);
    networks.keys().map(|name| name.to_owned()).collect()
}

#[inline]
pub fn set_app_core_mode<R: Runtime>(app: &tauri::AppHandle<R>, mode: impl Into<String>) {
    let platform_spec = app.state::<RwLock<Platform>>();
    let mut spec = platform_spec.write();
    spec.appinfo.app_core_mode = mode.into();
}

#[inline]
pub fn get_app_uptime<R: Runtime>(app: &tauri::AppHandle<R>) -> Instant {
    let platform_spec = app.state::<RwLock<Platform>>();
    let spec = platform_spec.read();
    spec.appinfo.app_startup_time
}

#[inline]
pub fn is_current_app_handle_admin<R: Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let platform_spec = app.state::<RwLock<Platform>>();
    let spec = platform_spec.read();
    spec.appinfo.app_is_admin
}

/// 官方 Clash Verge (clash-verge-rev) 的识别标识。
///
/// 通过 bundle id / 可执行文件路径中的关键词判断，全部小写匹配。
/// 任意一项命中即视为官方版正在运行。
const OFFICIAL_CLASH_VERGE_MARKERS: &[&str] = &[
    "io.github.clash-verge-rev.clash-verge-rev",
    "clash verge.app",
    "clash-verge-rev",
];

/// 本应用 (NextHubX) 自身的标识，命中其中任意一项就排除，避免把自己误判成官方版。
const SELF_MARKERS: &[&str] = &["com.nexthubx.app", "nexthubx"];

/// 特权服务守护进程标识。`clash-verge-service` 是 NextHubX 与 Clash Verge **共用**的后台服务
/// (LaunchDaemon，常驻)，它在运行**不代表官方 Clash Verge 的 GUI 在运行**——CV 退出后该守护
/// 进程仍常驻。冲突告警 / 激活门控只关心 GUI 抢占网络，故命中服务标识即排除，避免误判。
const SERVICE_MARKERS: &[&str] = &["clash-verge-service"];

/// 检测系统中是否有「官方 Clash Verge」(clash-verge-rev) 进程在运行。
///
/// 判定逻辑：枚举所有进程，对每个进程的可执行文件路径 + 进程名（统一转小写）做匹配：
/// - 若其中包含本应用自身标识（`com.nexthubx.app` / `nexthubx`），直接跳过，**不会误判 NextHubX 自己**；
/// - 否则若包含官方标识（bundle id / `Clash Verge.app` / `clash-verge-rev`），即判定为官方版正在运行。
///
/// 该函数为纯检测、无副作用，可被前端命令或后台轮询反复调用。
pub fn detect_official_clash_verge() -> bool {
    let mut system = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing().with_exe(UpdateKind::Always)),
    );
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::Always),
    );

    system.processes().values().any(|process| {
        // 汇总可执行文件路径与进程名作为匹配文本，统一小写。
        let mut haystack = String::new();
        if let Some(exe) = process.exe() {
            haystack.push_str(&exe.to_string_lossy().to_lowercase());
        }
        haystack.push(' ');
        haystack.push_str(&process.name().to_string_lossy().to_lowercase());

        // 先排除自身，避免误判 NextHubX。
        if SELF_MARKERS.iter().any(|marker| haystack.contains(marker)) {
            return false;
        }
        // 再排除共用的特权服务守护进程（clash-verge-service）：它常驻、与 GUI 无关，
        // CV 的 GUI 退出后该守护进程仍在跑，若不排除会持续误判「CV 正在运行」(本次踩坑)。
        if SERVICE_MARKERS.iter().any(|marker| haystack.contains(marker)) {
            return false;
        }
        OFFICIAL_CLASH_VERGE_MARKERS
            .iter()
            .any(|marker| haystack.contains(marker))
    })
}

/// 检测「官方 Clash Verge」是否配置了开机自启(供激活前门控,确保它不会重启后又抢占网络)。
///
/// - macOS:检查其 LaunchAgent plist 是否存在
///   (`~/Library/LaunchAgents/io.github.clash-verge-rev.clash-verge-rev.plist`);
/// - 其它平台:暂不检测(返回 false),激活门控在这些平台仅按进程运行态判断。
#[cfg(target_os = "macos")]
pub fn detect_official_clash_verge_autostart() -> bool {
    match std::env::var_os("HOME") {
        Some(home) => std::path::Path::new(&home)
            .join("Library/LaunchAgents/io.github.clash-verge-rev.clash-verge-rev.plist")
            .exists(),
        None => false,
    }
}

#[cfg(not(target_os = "macos"))]
pub fn detect_official_clash_verge_autostart() -> bool {
    false
}

#[inline]
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("clash_verge_sysinfo")
        // TODO 现在 crate 还不是真正的 tauri 插件，必须由主 lib 自行注册
        // TODO 从 clash-verge 中迁移获取系统信息的 commnand 并实现优雅 structure.field 访问
        // .invoke_handler(tauri::generate_handler![
        //     commands::get_system_info,
        //     commands::get_app_uptime,
        //     commands::app_is_admin,
        //     commands::export_diagnostic_info,
        // ])
        .setup(move |app, _api| {
            let app_version = app.package_info().version.to_string();
            let is_admin = is_binary_admin();

            let mut platform_spec = Platform::new();
            platform_spec.appinfo.app_version = app_version;
            platform_spec.appinfo.app_is_admin = is_admin;

            app.manage(RwLock::new(platform_spec));
            Ok(())
        })
        .build()
}
