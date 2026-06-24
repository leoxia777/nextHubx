//! TUN 真态**单一权威** reconcile + 谎报通知。
//!
//! 唯一真值:`should_tun_run = is_activated && tun_available`。
//! - `is_activated`:读 `app_home_dir/nexthubx-client.json` 的 `clientToken` 非空(**fail-safe**:
//!   读不到/损坏/缺失 → 视为未激活,宁可不开 TUN 也不裸奔误以为受保护)。
//! - `tun_available`:管理员 或 helper 服务可用(= TUN 能不能起)。
//!
//! 取代原前端两个关 TUN 守卫(`account-card` 未激活守卫 + `use-system-state` 不可用守卫):
//! - **后端权威**:窗口关 / 只剩托盘也照跑,不依赖任何页面挂载。
//! - **幂等**:启动期(`config.rs` init,core 起前,flag-only)+ 运行期(本模块周期,flag+apply)
//!   每次都复算真值 → 卸载/重装残留的 `enable_tun_mode=true` 在启动那刻被纠正,无需清数据。
//! - **去抖**:开 TUN 立即;关 TUN 连续 2 次 should=false 才动(滤掉服务可用性瞬时抖动),
//!   启动 immediate 则立即关(根治残留 flag 把 TUN 带起来)。

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::time::Duration;

use clash_verge_logging::{Type, logging};
use serde_json::Value;
use tauri_plugin_clash_verge_sysinfo::is_current_app_handle_admin;

use crate::cmd::system::tun_adapter_up;
use crate::config::{Config, IVerge};
use crate::core::handle::Handle;
use crate::core::service;
use crate::process::AsyncHandler;
use crate::utils::dirs;
use crate::utils::notification::{NotificationEvent, notify_event};

/// 运行期周期 reconcile 间隔。
const CHECK_INTERVAL: Duration = Duration::from_secs(15);
/// 启动宽限:给服务/核心起 TUN 留时间,避免刚启动就误报谎报。
const STARTUP_GRACE: Duration = Duration::from_secs(20);

/// 已激活 = `nexthubx-client.json` 的 `clientToken` 非空。读不到/损坏/缺失 → false(fail-safe)。
/// 与前端 `loadClientState` 同一文件(`BaseDirectory.AppData` == `app_home_dir`,identifier=APP_ID)。
pub fn is_activated() -> bool {
    let Ok(home) = dirs::app_home_dir() else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(home.join("nexthubx-client.json")) else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };
    v.get("clientToken")
        .and_then(Value::as_str)
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

/// TUN 能不能起:管理员 或 helper 服务可用。
pub async fn tun_available() -> bool {
    is_current_app_handle_admin(Handle::app_handle()) || service::is_service_available().await.is_ok()
}

/// 单一权威:TUN 该不该开。
pub async fn should_tun_run() -> bool {
    is_activated() && tun_available().await
}

async fn current_enable_tun() -> bool {
    Config::verge().await.latest_arc().enable_tun_mode.unwrap_or(false)
}

/// 把 enable_tun_mode 落成目标值 + 应用(走 `patch_verge`,触发 `use_tun` 重建 + TUN 起停)。
async fn apply_tun(enable: bool) {
    let patch = IVerge {
        enable_tun_mode: Some(enable),
        ..IVerge::default()
    };
    match crate::feat::patch_verge(&patch, false).await {
        Ok(()) => logging!(info, Type::Core, "TUN reconcile: enable_tun_mode -> {}", enable),
        Err(e) => logging!(error, Type::Core, "TUN reconcile apply failed: {}", e),
    }
}

static OFF_STREAK: AtomicU8 = AtomicU8::new(0);
static LAST_BAD: AtomicBool = AtomicBool::new(false);

/// 一次 reconcile:`should != current` 时纠正。开 TUN 立即;关 TUN 防抖(连续 2 次 should=false
/// 才关,滤掉服务可用性瞬时抖动);`immediate`=true(启动)不防抖、立即关。
pub async fn reconcile(immediate: bool) {
    let should = should_tun_run().await;
    let current = current_enable_tun().await;
    if should == current {
        OFF_STREAK.store(0, Ordering::Relaxed);
    } else if should {
        OFF_STREAK.store(0, Ordering::Relaxed);
        apply_tun(true).await;
    } else {
        let streak = OFF_STREAK.fetch_add(1, Ordering::Relaxed) + 1;
        if immediate || streak >= 2 {
            OFF_STREAK.store(0, Ordering::Relaxed);
            apply_tun(false).await;
        }
    }
}

/// 启动后台 reconcile + 谎报通知循环(`resolve_setup_async` 末尾调一次)。
pub fn start() {
    AsyncHandler::spawn(|| async move {
        tokio::time::sleep(STARTUP_GRACE).await;
        let mut ticker = tokio::time::interval(CHECK_INTERVAL);
        loop {
            ticker.tick().await;
            reconcile(false).await;
            // 谎报告警:该开(已激活+可用)却 OS 实测没起来 → 系统通知(窗口关/托盘也弹),跳变才发一次。
            let bad = should_tun_run().await && !tun_adapter_up();
            if bad && !LAST_BAD.swap(true, Ordering::Relaxed) {
                logging!(warn, Type::Core, "TUN should run but adapter is down — notifying");
                notify_event(NotificationEvent::TunNotRunning).await;
            } else if !bad {
                LAST_BAD.store(false, Ordering::Relaxed);
            }
        }
    });
}
