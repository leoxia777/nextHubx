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

/// 检测「官方 Clash Verge」是否配置了**有效**的开机自启(供激活前门控,确保它不会重启后又抢占网络)。
///
/// - macOS:检查其 LaunchAgent plist 是否存在,**并且** plist 指向的可执行文件仍存在。
///   关键:把 Clash Verge.app 拖进垃圾箱**不会**删除这个 LaunchAgent plist,会留下一个指向「已删除
///   app」的孤儿 plist。孤儿 plist 在登录时拉不起任何东西,不应再判为「自启开启」——否则用户删了
///   CV 却仍被激活门控拦住(本次踩坑)。故读 plist 的 ProgramArguments 路径,校验其真实存在。
/// - 其它平台:暂不检测(返回 false),激活门控在这些平台仅按进程运行态判断。
#[cfg(target_os = "macos")]
pub fn detect_official_clash_verge_autostart() -> bool {
    let Some(home) = std::env::var_os("HOME") else {
        return false;
    };
    let plist =
        std::path::Path::new(&home).join("Library/LaunchAgents/io.github.clash-verge-rev.clash-verge-rev.plist");
    let Ok(content) = std::fs::read_to_string(&plist) else {
        return false; // plist 不存在 → 未配置自启
    };
    // 取 plist 里 ProgramArguments 的可执行路径(<string>/.../Clash Verge.app/.../clash-verge</string>),
    // 仅当该文件仍存在才算「自启有效」(排除指向已删 app 的孤儿 plist)。
    content
        .lines()
        .filter_map(|line| {
            let t = line.trim();
            t.strip_prefix("<string>").and_then(|s| s.strip_suffix("</string>"))
        })
        .any(|s| s.starts_with('/') && s.contains("Clash Verge.app") && std::path::Path::new(s).exists())
}

#[cfg(not(target_os = "macos"))]
pub const fn detect_official_clash_verge_autostart() -> bool {
    false
}

/// 杀掉属于**本应用**的残留 mihomo 核心进程(按命令行含 `config_marker` 精确匹配)。返回杀掉的数量。
///
/// 背景(本次踩坑):sidecar 模式下核心由 app 直接 spawn;app 被**强制退出/崩溃/运行中被覆盖安装**时,
/// Tauri 不回收该子进程 → 留下孤儿核心。下次启动若不清理就再 spawn 一个,新旧核心抢同一 mixed 端口
/// (`address already in use`)→ 核心坏、TUN 起不来,并不断累积(本次实测累积到 4 个)。
///
/// 安全:`config_marker` 传本应用配置目录(含 `com.nexthubx.app`),只杀命令行带该标识的核心,
/// **绝不误杀官方 Clash Verge 的同名 `verge-mihomo`**(其命令行带 `io.github.clash-verge-rev` 配置目录)。
/// 在 `start_core_by_sidecar` spawn 前调用(此刻还没有新核心,只会清掉孤儿/残留),实现「起新先清旧」自愈。
pub fn kill_stray_mihomo(config_marker: &str) -> usize {
    if config_marker.is_empty() {
        return 0;
    }
    let marker = config_marker.to_lowercase();
    let mut system = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always)),
    );
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );
    let mut killed = 0usize;
    for process in system.processes().values() {
        // 只认 mihomo 核心(verge-mihomo / verge-mihomo-alpha)。
        if !process.name().to_string_lossy().to_lowercase().contains("verge-mihomo") {
            continue;
        }
        // 命令行必须含本应用配置目录标识,否则可能是官方 CV 的核心 → 跳过,不误杀。
        let cmd_joined = process
            .cmd()
            .iter()
            .map(|s| s.to_string_lossy().to_lowercase())
            .collect::<Vec<_>>()
            .join(" ");
        if !cmd_joined.contains(&marker) {
            continue;
        }
        if process.kill() {
            killed += 1;
        }
    }
    killed
}

/// 一键关停系统中正在运行的「官方 Clash Verge」(GUI + 其 root 核心 verge-mihomo)。
///
/// 背景(本次踩坑):CV 服务模式下,退出 GUI 后核心仍由其 **root 特权服务**托管常驻、继续占着
/// TUN/网络,用户在 CV 内根本停不掉 → NextHubX 激活门控始终被拦。此处一键关停。
/// 核心是 root 进程(TUN 需 root),普通权限杀不掉:macOS 用 osascript 提权(**弹一次系统密码**),
/// 一次性杀掉 CV 的 root 核心 + 用户态 GUI。**只匹配 `Clash Verge.app` 路径下的进程,
/// 绝不误杀 NextHubX 自身的 verge-mihomo(其路径含 com.nexthubx.app)。**
///
/// 返回:Ok(()) = 已关停并确认 CV 不再运行(以进程是否真消失为准,不看 osascript 退出码);
/// Err("CANCELLED") = 用户取消了密码框;Err("STILL_RUNNING") = 杀后 ~6s 仍在(罕见,需手动处理);
/// Err(其它) = osascript 启动失败(连执行都没起来)。
#[cfg(target_os = "macos")]
pub fn stop_official_clash_verge() -> Result<(), String> {
    // ① 关闭 CV 登录自启(用户级,无需提权)——无论 CV 是否在跑都执行。
    //    门控是 `运行中 || 自启`:只杀进程不关自启,CV 重登又抢网、门会一直拦(本次踩坑)。
    disable_official_clash_verge_autostart();

    // ② CV 未在运行 → 无需提权杀进程(避免白弹密码框);自启已关即可放行。
    //    覆盖「CV 已停但自启还开」的场景:此前前端会跳过 stop 致门永远清不掉。
    if !detect_official_clash_verge() {
        return Ok(());
    }

    // ③ CV 在运行 → 提权一次性处理(只弹一个密码框):
    //    - `launchctl disable` 系统服务:**持久禁用**,重启后 launchd 也不再自动加载该服务/拉起 TUN
    //      (不删 app、不删 plist;以后想恢复用 `launchctl enable` 即可)。这是「一键关停=永久生效」的关键。
    //    - `bootout` 卸载当前会话已加载的服务(否则服务模式下核心被秒级复活、pkill 永远赢不了)。
    //    - `pkill` 核心 + GUI。`|| true` 容忍未加载 / 无匹配进程。
    let sh = "/bin/launchctl disable system/io.github.clash-verge-rev.clash-verge-rev.service 2>/dev/null || true; \
              /bin/launchctl bootout system/io.github.clash-verge-rev.clash-verge-rev.service 2>/dev/null || true; \
              /usr/bin/pkill -f 'Clash Verge.app/Contents/MacOS/verge-mihomo' || true; \
              /usr/bin/pkill -f 'Clash Verge.app/Contents/MacOS/clash-verge' || true";
    let script = format!("do shell script \"{sh}\" with administrator privileges");
    let output = std::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("启动 osascript 失败: {e}"))?;
    // 用户取消密码框 → osascript 报 "User canceled. (-128)":这是**唯一**据 stderr 早退的情形。
    let err = String::from_utf8_lossy(&output.stderr);
    if err.contains("-128") || err.to_lowercase().contains("cancel") {
        return Err("CANCELLED".into());
    }
    // ④ **不据 osascript 退出码判失败**:实测「提权 shell 杀进程」场景下它会偶发返回非零 + 空 stderr,
    //    但 kill 其实已成功(老 mac debug.log 铁证:报 fail 后 12s CV 已不在)。早退报失败 → 误判 + 门清不掉,
    //    多版兜圈子的真凶。改以「CV 进程是否真消失」为唯一成功判据:轮询 ~6s,detect 为假即 Ok。
    //    (~6s:bootout 停服务 + 核心/GUI 退出有竞态,2s 太短会误报 STILL_RUNNING。)
    for _ in 0..30 {
        if !detect_official_clash_verge() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    Err("STILL_RUNNING".into())
}

/// 关闭官方 Clash Verge 的登录自启(用户级,无需提权):bootout 本用户已加载的 LaunchAgent + 删其 plist。
/// `detect_official_clash_verge_autostart` 按 plist 文件存在判断 → 删文件即使其转 false,门控放行。
/// 仅针对 CV 专属 label,绝不碰 NextHubX 自身;全程容错,失败不影响关停主流程。
#[cfg(target_os = "macos")]
fn disable_official_clash_verge_autostart() {
    let Some(home) = std::env::var_os("HOME") else {
        return;
    };
    let plist =
        std::path::Path::new(&home).join("Library/LaunchAgents/io.github.clash-verge-rev.clash-verge-rev.plist");
    if !plist.exists() {
        return;
    }
    // 先 bootout 本用户 gui 域里已加载的 agent($(id -u) 交 sh 展开),再删 plist。
    let _ = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg("/bin/launchctl bootout gui/$(id -u)/io.github.clash-verge-rev.clash-verge-rev 2>/dev/null; true")
        .output();
    let _ = std::fs::remove_file(&plist);
}

/// Windows:杀官方 CV 进程(核心可能由服务以 SYSTEM 运行,taskkill 需管理员权限;
/// 若 NextHubX 非管理员可能杀不掉,前端据返回提示手动)。
#[cfg(target_os = "windows")]
pub fn stop_official_clash_verge() -> Result<(), String> {
    let _ = std::process::Command::new("taskkill")
        .args([
            "/F",
            "/IM",
            "verge-mihomo.exe",
            "/IM",
            "verge-mihomo-alpha.exe",
            "/IM",
            "clash-verge.exe",
        ])
        .output()
        .map_err(|e| format!("taskkill 失败: {e}"))?;
    for _ in 0..10 {
        if !detect_official_clash_verge() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    Err("STILL_RUNNING".into())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn stop_official_clash_verge() -> Result<(), String> {
    Err("当前平台暂不支持一键关停".into())
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
