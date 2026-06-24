use std::borrow::Cow;

use crate::core::handle;
use clash_verge_i18n;
use tauri_plugin_notification::NotificationExt as _;

pub enum NotificationEvent<'a> {
    DashboardToggled,
    ClashModeChanged {
        mode: &'a str,
    },
    SystemProxyToggled(bool),
    TunModeToggled(bool),
    LightweightModeEntered,
    ProfilesReactivated,
    /// TUN「想开却没真跑」(谎报)态:后端周期探测发现 enabled 但 OS 无 TUN 网卡时发,
    /// 弥补前端守卫只在窗口开时才跑的盲区(tray-only 也能告警)。
    TunNotRunning,
    AppQuit,
    #[cfg(target_os = "macos")]
    AppHidden,
}

fn notify(title: Cow<'_, str>, body: Cow<'_, str>) {
    let app_handle = handle::Handle::app_handle();
    app_handle.notification().builder().title(title).body(body).show().ok();
}

pub async fn notify_event<'a>(event: NotificationEvent<'a>) {
    match event {
        NotificationEvent::DashboardToggled => {
            let title = clash_verge_i18n::t!("notifications.dashboardToggled.title");
            let body = clash_verge_i18n::t!("notifications.dashboardToggled.body");
            notify(title, body);
        }
        NotificationEvent::ClashModeChanged { mode } => {
            let title = clash_verge_i18n::t!("notifications.clashModeChanged.title");
            let body = clash_verge_i18n::t!("notifications.clashModeChanged.body")
                .replace("{mode}", mode)
                .into();
            notify(title, body);
        }
        NotificationEvent::SystemProxyToggled(enabled) => {
            let title = clash_verge_i18n::t!("notifications.systemProxyToggled.title");
            let key = if enabled {
                "notifications.systemProxyToggled.on"
            } else {
                "notifications.systemProxyToggled.off"
            };

            let body = clash_verge_i18n::t!(key);
            notify(title, body);
        }
        NotificationEvent::TunModeToggled(enabled) => {
            let title = clash_verge_i18n::t!("notifications.tunModeToggled.title");
            let key = if enabled {
                "notifications.tunModeToggled.on"
            } else {
                "notifications.tunModeToggled.off"
            };
            let body = clash_verge_i18n::t!(key);
            notify(title, body);
        }
        NotificationEvent::LightweightModeEntered => {
            let title = clash_verge_i18n::t!("notifications.lightweightModeEntered.title");
            let body = clash_verge_i18n::t!("notifications.lightweightModeEntered.body");
            notify(title, body);
        }
        NotificationEvent::ProfilesReactivated => {
            let title = clash_verge_i18n::t!("notifications.profilesReactivated.title");
            let body = clash_verge_i18n::t!("notifications.profilesReactivated.body");
            notify(title, body);
        }
        NotificationEvent::TunNotRunning => {
            let title = clash_verge_i18n::t!("notifications.tunNotRunning.title");
            let body = clash_verge_i18n::t!("notifications.tunNotRunning.body");
            notify(title, body);
        }
        NotificationEvent::AppQuit => {
            let title = clash_verge_i18n::t!("notifications.appQuit.title");
            let body = clash_verge_i18n::t!("notifications.appQuit.body");
            notify(title, body);
        }
        #[cfg(target_os = "macos")]
        NotificationEvent::AppHidden => {
            let title = clash_verge_i18n::t!("notifications.appHidden.title");
            let body = clash_verge_i18n::t!("notifications.appHidden.body");
            notify(title, body);
        }
    }
}
