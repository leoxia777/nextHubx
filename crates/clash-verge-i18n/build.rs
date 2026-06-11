// rust-i18n 的 i18n!("locales") 宏在编译期读取 locales/*.yml 并嵌入二进制,
// 但 yml 不在 cargo 的默认依赖跟踪里:只改 yml 不改 src 时 cargo 认为 crate 未变、
// 不重新编译 → 旧文案仍嵌在产物里(本次踩坑:改了 adminInstallPrompt 但弹窗仍显示旧文案)。
// 显式声明 locales 目录为构建输入,任何 yml 变更都触发重编。
fn main() {
    println!("cargo:rerun-if-changed=locales");
}
