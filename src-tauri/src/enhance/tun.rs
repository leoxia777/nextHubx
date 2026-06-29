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
    }

    revise!(config, "tun", tun_val);

    config
}
