use std::sync::Arc;

use serde::Serialize;
use tauri_plugin_clash_verge_sysinfo::is_current_app_handle_admin;

use crate::config::Config;
use crate::core::handle::Handle;
use crate::core::{CoreManager, manager::RunningMode, service};

/// 获取当前内核运行模式
#[tauri::command]
pub async fn get_running_mode() -> Result<Arc<RunningMode>, String> {
    Ok(CoreManager::global().get_running_mode())
}

/// TUN 真实运行态(给 Home「TUN 校验 card」+ 后端周期通知用)。
///
/// 关键:`adapter_up` 是 **OS 实测**(存在一块 IPv4 落在 `198.18.0.0/16` fake-ip 段的 TUN 网卡),
/// 区别于 `enabled_flag`(verge 里"想不想开 TUN")—— 专治"托盘打了 ✓ 却没真跑"的谎报态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunRuntimeStatus {
    /// is_admin || helper 服务可用 —— TUN 能不能起来
    pub available_can_run: bool,
    /// verge.enable_tun_mode —— 用户/激活流程"想不想开"
    pub enabled_flag: bool,
    /// OS 实测:存在 TUN 网卡(IPv4 落在 198.18.0.0/16)
    pub adapter_up: bool,
    /// 综合判定:TUN 是否真的在跑(当前 = adapter_up)
    pub running: bool,
}

/// OS 实测 TUN 是否起来:枚举网卡,看是否有 IPv4 落在 `198.18.0.0/16`。
/// TUN 接口的 inet4-address 由 `enhance::tun::use_tun` **显式锚定为 `198.18.0.1/30`**
/// (= mihomo 默认,行为不变),所以这里的判定**确定**:TUN 关时没有这块网卡、真起来才有。
/// 这正是手动 `ipconfig | findstr 198.18` 的程序化版本,跨平台(network-interface,mac/win 同样有效)。
pub fn tun_adapter_up() -> bool {
    use network_interface::{Addr, NetworkInterface, NetworkInterfaceConfig as _};

    let Ok(interfaces) = NetworkInterface::show() else {
        return false;
    };
    interfaces.iter().any(|iface| {
        iface.addr.iter().any(|addr| match addr {
            Addr::V4(v4) => {
                let o = v4.ip.octets();
                o[0] == 198 && o[1] == 18
            }
            _ => false,
        })
    })
}

/// 计算 TUN 真态(命令与后端周期通知共用)。
pub async fn tun_runtime_status() -> TunRuntimeStatus {
    let is_admin = is_current_app_handle_admin(Handle::app_handle());
    let service_ok = service::is_service_available().await.is_ok();
    let enabled_flag = Config::verge().await.latest_arc().enable_tun_mode.unwrap_or(false);
    let adapter_up = tun_adapter_up();
    TunRuntimeStatus {
        available_can_run: is_admin || service_ok,
        enabled_flag,
        adapter_up,
        // running = OS 实测网卡在 且 flag 为开:避免崩溃残留的孤儿 198.18 网卡(flag 已 reconcile 成 false)
        // 误判为「运行中」。flag 经后端 reconcile 权威化,可信。
        running: adapter_up && enabled_flag,
    }
}

/// 暴露给前端「TUN 校验 card」轮询。
#[tauri::command]
pub async fn get_tun_runtime_status() -> TunRuntimeStatus {
    tun_runtime_status().await
}
