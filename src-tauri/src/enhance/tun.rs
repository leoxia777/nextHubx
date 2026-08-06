use serde_yaml_ng::{Mapping, Value};

#[cfg(target_os = "macos")]
use crate::process::AsyncHandler;

macro_rules! revise {
    ($map: expr, $key: expr, $val: expr) => {
        let ret_key = Value::String($key.into());
        $map.insert(ret_key, Value::from($val));
    };
}

// if key not exists then append value
#[allow(unused_macros)]
macro_rules! append {
    ($map: expr, $key: expr, $val: expr) => {
        let ret_key = Value::String($key.into());
        if !$map.contains_key(&ret_key) {
            $map.insert(ret_key, Value::from($val));
        }
    };
}

pub fn use_tun(mut config: Mapping, enable: bool) -> Mapping {
    let tun_key = Value::from("tun");
    let tun_val = config.get(&tun_key);
    let mut tun_val = tun_val.map_or_else(Mapping::new, |val| {
        val.as_mapping().cloned().unwrap_or_else(Mapping::new)
    });

    if enable {
        // 读取DNS配置
        let dns_key = Value::from("dns");
        let dns_val = config.get(&dns_key);
        let mut dns_val = dns_val.map_or_else(Mapping::new, |val| {
            val.as_mapping().cloned().unwrap_or_else(Mapping::new)
        });
        let ipv6_key = Value::from("ipv6");
        let ipv6_val = config.get(&ipv6_key).and_then(|v| v.as_bool()).unwrap_or(false);

        // 检查现有的 enhanced-mode 设置
        let current_mode = dns_val
            .get(Value::from("enhanced-mode"))
            .and_then(|v| v.as_str())
            .unwrap_or("fake-ip");

        // 只有当 enhanced-mode 是 fake-ip 或未设置时才修改 DNS 配置
        if current_mode == "fake-ip" || !dns_val.contains_key(Value::from("enhanced-mode")) {
            revise!(dns_val, "enable", true);
            revise!(dns_val, "ipv6", ipv6_val);

            if !dns_val.contains_key(Value::from("enhanced-mode")) {
                revise!(dns_val, "enhanced-mode", "fake-ip");
            }

            if !dns_val.contains_key(Value::from("fake-ip-range")) {
                revise!(dns_val, "fake-ip-range", "198.18.0.1/16");
            }

            #[cfg(target_os = "macos")]
            {
                AsyncHandler::spawn(move || async move {
                    crate::utils::resolve::dns::restore_public_dns().await;
                    crate::utils::resolve::dns::set_public_dns("114.114.114.114".to_string()).await;
                });
            }
        }

        // 当TUN启用时，将修改后的DNS配置写回
        revise!(config, "dns", dns_val);
    } else {
        // TUN未启用时，仅恢复系统DNS，不修改配置文件中的DNS设置
        #[cfg(target_os = "macos")]
        AsyncHandler::spawn(move || async move {
            crate::utils::resolve::dns::restore_public_dns().await;
        });
    }

    // 更新TUN配置
    revise!(tun_val, "enable", enable);

    if enable {
        // ⚠️ strict-route 必须保持**关闭**(2026-06-29 回归定位,实测铁证)。
        // 曾为防 IPv6 泄漏把它统一开启(mac+win),但 strict-route 会**误伤 mihomo 的 DIRECT
        // 直发流量**(网关域 / 私网 / 国内站全走 DIRECT),导致「时通时不通」——老 mac 与
        // 客户 Windows 两条不同网络同样症状。实测对照(老 mac,电信→HK 线路本身完好):
        //   TUN 关 → 裸线到网关 20/20;strict-route 关 → 由 0/20 恢复到 11/20;strict-route 开 → 0/20。
        // 故**显式置 false**(覆盖存量配置里保存的 true,幂等纠正)。
        // IPv6 泄漏改只靠全局 `ipv6:false`(DNS 过滤 AAAA → 应用只拿到 v4 → 走隧道),覆盖绝大多数场景;
        // 「硬编码字面 v6」这种极少数后续用 v6 黑洞路由(快速失败、不破网)处理,不再用 strict-route。
        revise!(tun_val, "strict-route", false);

        // 锚定 TUN 接口 IPv4 地址 = mihomo 默认 198.18.0.1/30(值与默认相同,行为不变),
        // 使后端真态探测(get_tun_runtime_status 查 198.18.x 网卡)**确定可判**,
        // 不依赖 mihomo 隐式默认(默认若变则探测会一直误判没起来)。
        append!(tun_val, "inet4-address", "198.18.0.1/30");

        // TUN MTU 钉到 1500:缺省时 mihomo 用 9000,而 9000 在**虚拟机 / WSL 镜像模式**里是静默杀手。
        // 2026-08-06 真实客户案例(Win11 + WSL2 `networkingMode=mirrored` + Tailscale + VMware,
        // 多虚拟网卡):宿主 TUN 被镜像进 WSL 成 eth4(mtu 9000),WSL 直接按 MSS 8960 发包,
        // 而真实链路是 Wi-Fi 1500 → **小包过、大包丢**:TCP 握手过、SSH banner(40B)过,
        // 一到 KEX 交换主机密钥(1~3KB)就被吞 → 表现为「ssh 连上了却卡死」,而 Windows 原生侧
        // 完全正常(那边 TCP 由 mihomo 用户态栈本地接下、再按真实链路重新分段,9000 的帧不上路)。
        // 设置页 UI 的 mtu 默认值本来就是 1500(tun-viewer.tsx),所以这里补的是「用户从没打开过
        // 该设置」的缺口;顺带把存量配置里 >1500 的值拉回来(纠正 mihomo 默认值落库的情况)。
        // 只在缺省或过大时改,不动用户显式设的更小值(如 1400/1280)。
        if let Some(mtu) = clamp_tun_mtu(tun_val.get(Value::from("mtu")).and_then(|v| v.as_u64())) {
            revise!(tun_val, "mtu", mtu);
        }
    }

    revise!(config, "tun", tun_val);

    config
}

/// 计算应写入的 TUN `mtu`:`None` = 保留现值不动,`Some(v)` = 写入 v。
/// 规则:缺省(mihomo 默认 9000)或 >1500 → 钉到 1500;用户显式设的 ≤1500(如 1400/1280)保留。
/// 抽成纯函数便于单测 —— `use_tun` 本身在 macOS 上会去改系统 DNS,不能在测试里调。
const fn clamp_tun_mtu(current: Option<u64>) -> Option<u64> {
    match current {
        Some(m) if m <= 1500 => None,
        _ => Some(1500),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 回归:2026-08-06 客户案例 —— WSL 镜像模式下宿主 TUN 的 mtu 9000 被 WSL 直接采用,
    // 大包(SSH KEX)在真实 1500 链路上被丢,表现为「ssh 连上却卡死」。
    #[test]
    fn tun_mtu_absent_defaults_to_1500() {
        assert_eq!(clamp_tun_mtu(None), Some(1500));
    }

    #[test]
    fn tun_mtu_9000_is_clamped_to_1500() {
        assert_eq!(clamp_tun_mtu(Some(9000)), Some(1500));
    }

    #[test]
    fn tun_mtu_user_lower_value_is_kept() {
        assert_eq!(clamp_tun_mtu(Some(1400)), None);
        assert_eq!(clamp_tun_mtu(Some(1280)), None);
        assert_eq!(clamp_tun_mtu(Some(1500)), None);
    }
}
