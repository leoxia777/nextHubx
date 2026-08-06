//! Claude 保护态审计日志 —— **按天归档、长期留存**,专供封号复盘。
//!
//! ## 为什么不能只靠筛 mihomo 的连接日志
//! 1. **最关键的那类事件在连接日志里天然不存在**:TUN 撤下 / 核心停掉时,流量根本不经过
//!    mihomo,自然一条记录都没有 —— 而"账号那会儿是不是从本机真实 IP 出去的"恰恰要靠它。
//!    「日志里没有」既不能证明泄漏发生过、也不能证明没发生,这个盲区必须单独补。
//! 2. **连接日志留不住**:mihomo 日志按 128KB×8 文件轮转(`app_log_max_*` 默认),
//!    上限约 1MB —— 2026-08-04 那台客户机 58 分钟就写了 ~800KB,所以出事后**连一小时都查不到**。
//!    连接日志体量决定了它只能留几天;要留几个月,只能靠本模块这种极小的状态日志(每天几十行)。
//!
//! ## 记什么
//! - **保护态跳变**:TUN 该开/实际起没起、系统代理开没开、是否已激活。
//! - **泄漏嫌疑**:保护不在,而 Claude 进程仍在跑 → 那段时间它的心跳/刷 token 会走本机真实 IP。
//!   (Claude 桌面 App 常驻且**会自主重连**:2026-08-04 实测 9 秒内自发 13 次连接,无需用户操作。)
//! - 10 分钟一次心跳,保证"这段时间一切正常"也有正面记录,而不是只有异常才留痕。
//!
//! 进程探测只在**保护不在**时才做(那是唯一需要它的时刻),正常态零额外开销。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

use chrono::Local;
use clash_verge_logging::{Type, logging};

use crate::utils::dirs;

/// 心跳间隔(秒):保护态没变化时也定期落一行。
const HEARTBEAT_SECS: i64 = 600;
/// 保留天数:体量极小(每天几十行),留够复盘一次封号所需的时间跨度。
const KEEP_DAYS: i64 = 90;

/// 一次采样到的保护态。
pub struct ProtectionSnapshot {
    /// 已激活(有 clientToken)。
    pub activated: bool,
    /// TUN 该不该开(已激活 + 能起)。
    pub should_tun: bool,
    /// OS 实测 TUN 网卡在不在。
    pub tun_up: bool,
    /// 系统代理开没开(TUN 不在时唯一的兜底)。
    pub system_proxy: bool,
}

impl ProtectionSnapshot {
    /// 有没有任何一层保护在生效。两层都没有 → 本机流量直出真实 IP。
    const fn protected(&self) -> bool {
        self.tun_up || self.system_proxy
    }

    fn fingerprint(&self) -> String {
        format!(
            "activated={} should_tun={} tun_up={} sys_proxy={}",
            self.activated, self.should_tun, self.tun_up, self.system_proxy
        )
    }
}

fn log_path() -> Option<PathBuf> {
    let dir = dirs::app_logs_dir().ok()?.join("claude");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(format!("claude-{}.log", Local::now().format("%Y-%m-%d"))))
}

/// 追加一行。**刻意用最朴素的按天文件名 + append**,不走 flexi_logger 的
/// 尺寸轮转 —— 支持排障时要的是「给我 8 月 4 日那天的」,文件名必须一眼可指。
fn append(line: &str) {
    let Some(path) = log_path() else { return };
    let stamped = format!("[{}] {}\n", Local::now().format("%Y-%m-%d %H:%M:%S"), line);
    if let Err(e) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, stamped.as_bytes()))
    {
        // 只报一次量级的噪音即可,别让审计失败反过来淹没主日志。
        logging!(warn, Type::System, "claude audit write failed: {e}");
    }
}

/// 删掉超过 `KEEP_DAYS` 天的归档(启动时跑一次)。按文件名里的日期判,不看 mtime
/// —— 拷贝/恢复目录不会让整批日志"复活"或被误删。
pub fn cleanup_old() {
    let Ok(dir) = dirs::app_logs_dir().map(|d| d.join("claude")) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let cutoff = Local::now().date_naive() - chrono::Duration::days(KEEP_DAYS);
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(date_part) = name.strip_prefix("claude-").and_then(|s| s.strip_suffix(".log")) else {
            continue;
        };
        if let Ok(d) = chrono::NaiveDate::parse_from_str(date_part, "%Y-%m-%d")
            && d < cutoff
            && let Err(e) = std::fs::remove_file(entry.path())
        {
            logging!(warn, Type::System, "claude audit cleanup failed for {name}: {e}");
        }
    }
}

/// Claude 相关进程在不在跑。只在保护不在时才调 —— 那是唯一需要知道它的时刻。
/// Windows 上桌面 App 的映像名实测为 `claude.exe`(2026-08-04 客户机 mihomo 日志);
/// macOS 上 App 是 `Claude`,CLI 是 `claude`。
fn claude_running() -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        for image in ["claude.exe", "Claude.exe"] {
            let hit = std::process::Command::new("tasklist")
                .args(["/FI", &format!("IMAGENAME eq {image}"), "/NH"])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .is_some_and(|s| s.to_lowercase().contains("claude.exe"));
            if hit {
                return true;
            }
        }
        false
    }
    #[cfg(not(target_os = "windows"))]
    {
        ["Claude", "claude"].iter().any(|name| {
            std::process::Command::new("pgrep")
                .args(["-x", name])
                .output()
                .is_ok_and(|o| o.status.success())
        })
    }
}

static LAST_FINGERPRINT: std::sync::LazyLock<parking_lot::RwLock<String>> =
    std::sync::LazyLock::new(|| parking_lot::RwLock::new(String::new()));
static LAST_WRITE_TS: AtomicI64 = AtomicI64::new(0);
static LEAK_ACTIVE: AtomicBool = AtomicBool::new(false);

/// 每次 tun_guard 轮询调一次(复用它的 15s 周期,不另起定时器)。
/// 保护态跳变 → 立即落一行;没跳变 → 每 `HEARTBEAT_SECS` 落一行心跳。
pub fn tick(snap: &ProtectionSnapshot) {
    let fp = snap.fingerprint();
    let now = Local::now().timestamp();
    let changed = *LAST_FINGERPRINT.read() != fp;
    let due = now - LAST_WRITE_TS.load(Ordering::Relaxed) >= HEARTBEAT_SECS;

    // 保护不在时才查进程,并且只在「进入/离开泄漏态」时记 —— 避免每 15 秒刷一行。
    if snap.protected() {
        if LEAK_ACTIVE.swap(false, Ordering::Relaxed) {
            append(&format!("LEAK-END  保护恢复 | {fp}"));
            LAST_WRITE_TS.store(now, Ordering::Relaxed);
            *LAST_FINGERPRINT.write() = fp;
            return;
        }
    } else {
        let running = claude_running();
        if running && !LEAK_ACTIVE.swap(true, Ordering::Relaxed) {
            append(&format!(
                "LEAK      ⚠️ 无任何代理保护,但 Claude 进程在跑 —— 其请求正从本机真实 IP 直出 | {fp}"
            ));
            logging!(
                warn,
                Type::Core,
                "claude audit: unprotected while Claude is running ({fp})"
            );
            LAST_WRITE_TS.store(now, Ordering::Relaxed);
            *LAST_FINGERPRINT.write() = fp;
            return;
        }
        if !running {
            LEAK_ACTIVE.store(false, Ordering::Relaxed);
        }
    }

    if changed || due {
        let tag = if changed { "CHANGE  " } else { "HEARTBEAT" };
        append(&format!(
            "{tag} protected={} | {fp}",
            if snap.protected() { "yes" } else { "NO" }
        ));
        LAST_WRITE_TS.store(now, Ordering::Relaxed);
        *LAST_FINGERPRINT.write() = fp;
    }
}

/// 客户端自身生命周期事件(启动 / 退出 / 主动停 TUN)。这些是"空窗期"的边界,
/// 必须单独记 —— 光看保护态采样会漏掉进程刚退出、还没来得及采样的那一段。
pub fn record_event(event: &str) {
    append(&format!("EVENT     {event}"));
    LAST_WRITE_TS.store(Local::now().timestamp(), Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(tun_up: bool, system_proxy: bool) -> ProtectionSnapshot {
        ProtectionSnapshot {
            activated: true,
            should_tun: true,
            tun_up,
            system_proxy,
        }
    }

    #[test]
    fn protected_requires_tun_or_system_proxy() {
        assert!(snap(true, false).protected());
        assert!(snap(false, true).protected());
        assert!(snap(true, true).protected());
        // 两层都没有 = 裸奔,这正是要抓的泄漏窗口
        assert!(!snap(false, false).protected());
    }

    #[test]
    fn fingerprint_changes_with_state() {
        assert_ne!(snap(true, false).fingerprint(), snap(false, false).fingerprint());
        assert_eq!(snap(true, false).fingerprint(), snap(true, false).fingerprint());
    }
}
