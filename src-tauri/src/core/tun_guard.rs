//! TUN 真态守卫(后端周期探测)。
//!
//! 弥补前端守卫(`account-card` / `use-system-state`)只在**窗口挂载时**才跑的盲区:
//! 窗口关闭 / 仅托盘时,残留的 `enable_tun_mode=true` 会让托盘显示 ✓,但 TUN 实际没跑、
//! 流量裸奔。本守卫在后端按固定间隔探测 TUN 真态,发现"想开却没真跑"(谎报)就发系统通知。
//!
//! 第一批:**仅告警,不改 TUN 状态**(自动修复 / 激活门控属后续批次)。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use clash_verge_logging::{Type, logging};

use crate::cmd::system::tun_runtime_status;
use crate::process::AsyncHandler;
use crate::utils::notification::{NotificationEvent, notify_event};

/// 探测间隔。
const CHECK_INTERVAL: Duration = Duration::from_secs(30);
/// 启动宽限期:给服务/核心起 TUN 留时间,避免刚启动就误报。
const STARTUP_GRACE: Duration = Duration::from_secs(20);

/// 上一轮是否处于谎报态——只在 false→true 跳变时通知一次,避免每 30s 刷屏。
static LAST_BAD: AtomicBool = AtomicBool::new(false);

/// 启动后台 TUN 真态守卫(幂等性由调用方保证:仅在 setup 调一次)。
pub fn start() {
    AsyncHandler::spawn(|| async move {
        tokio::time::sleep(STARTUP_GRACE).await;
        let mut ticker = tokio::time::interval(CHECK_INTERVAL);
        loop {
            ticker.tick().await;
            let status = tun_runtime_status().await;
            // 谎报态 = 想开(enabled)+ 能起(available)+ OS 实测没起(!running)。
            let bad = status.enabled_flag && status.available_can_run && !status.running;
            let was_bad = LAST_BAD.swap(bad, Ordering::Relaxed);
            if bad && !was_bad {
                logging!(
                    warn,
                    Type::Core,
                    "TUN guard: enabled but not actually running — notifying"
                );
                notify_event(NotificationEvent::TunNotRunning).await;
            }
        }
    });
}
