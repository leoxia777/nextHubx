# Hub4CC 客户端开发笔记(DEV-NOTES)

> 记录 M0/M1 阶段的环境探测结果、待确认项、踩坑与决策。后续阶段持续追加。

## 待确认项(需产品/负责人拍板)

| # | 项 | 当前取值 | 说明 |
|---|---|---|---|
| C1 | **产品名 productName** | `Hub4CC` | M1 暂定。已用于 tauri.conf / package.json / 窗口标题 / installer。 |
| C2 | **bundle identifier** | `com.hub4cc.client` | M1 暂定。已用于 tauri.{conf,macos,windows,linux}.conf.json。⚠️ 见 C3。 |
| C3 | **数据目录 APP_ID(dirs.rs)** | `com.hub4cc.client` | 与 identifier 同步。**改它会换数据目录**——老用户(若有)配置不迁移。内测期无存量用户,可直接改。dev feature 用 `com.hub4cc.client.dev`。 |
| C4 | **深链 scheme** | 追加 `hub4cc`(保留 `clash`/`clash-verge`) | tauri.conf.json deep-link。保留旧 scheme 以兼容,新增 hub4cc 供后续激活深链用。Windows 注册表 scheme(init.rs)仍注册 `Clash`,见 K2。 |
| C5 | **publisher / copyright** | publisher 改 `Hub4CC`;copyright 保留 GPL v3.0 声明 | GPL 要求保留许可声明,copyright 行不动。 |

## 环境探测结果(M0)

| 工具 | 版本 | 状态 |
|---|---|---|
| node | v20.20.2 | OK |
| pnpm | 9.15.0(仓库声明 packageManager pnpm@11.3.0) | OK,版本略低于声明,安装无碍 |
| npm | 10.8.2 | OK |
| rustc / cargo / rustup | **未安装** | ⚠️ 见 K1 |
| `pnpm i` | — | ✅ 成功(需 Node 22,见 K6) |
| `pnpm run web:build`(= tsc --noEmit && vite build) | — | ✅ **成功**(Node 22 下,dist 产出正常) |
| `pnpm run typecheck` / `pnpm run lint` | — | ✅ 全绿(M1 改动后) |

## 已知问题 / 踩坑(K)

### K1 — Rust 工具链缺失(阻塞原生构建,不阻塞 M1 前端改造)
本机无 `rustc`/`cargo`/`rustup`。影响:
- `pnpm run build`(`tauri build`)、`pnpm dev`(`tauri dev`)无法运行——这两个需要 Rust 编译 src-tauri。
- **不影响** M1 的前端/配置/品牌改造(纯文件编辑 + `pnpm run web:build` 前端构建)。
- 待补:安装 rustup(`rust-toolchain.toml` 已锁定工具链版本,装好 rustup 后会自动按文件取版本)。

### K2 — sidecar 二进制缺失(阻塞原生构建)
`tauri.conf.json` 的 `externalBin` 指向 `sidecar/verge-mihomo*`、`sidecar/clash-verge-service*`。
仓库内 `src-tauri/sidecar/` 需由 `scripts/prebuild.mjs`(`pnpm prebuild`)下载,首次构建前必须跑。
未跑时 `tauri build` 会因找不到 sidecar 失败。M1 不涉及,记录待补。

### K3 — Service/TUN 底层不改造(红线,已遵守)
上游 Service 层的命名 **不可改**,否则会与预编译 sidecar 二进制 / IPC 路径对不上:
- 服务二进制:`clash-verge-service(.exe)` / `clash-verge-service-install` / `-uninstall`(externalBin + service.rs 文件名拼接,`with_file_name(...)`)。
- IPC crate:`clash_verge_service_ipc`(固定 IPC_PATH / 服务名)。
- Windows 服务名:installer.nsi 里的 `clash_verge_service`(SimpleSC 操作的就是 sidecar 装出来的服务)。
- macOS 安装走 `osascript ... CLASH_VERGE_SERVICE_GID=...`(service.rs)。
**结论:这些一律保持原样**,品牌化只改"应用自身"的命名(productName / identifier / APP_ID / 窗口标题 / 计划任务名 / publisher / scheme)。

### K4 — 图标生成依赖 Rust tauri-cli
`pnpm tauri icon <png>` 需要 tauri CLI(JS CLI 可跑 icon 子命令,但稳妥起见需先 `pnpm i` 完成,已完成)。
favicon.svg → 1024 PNG 转换需要 rsvg/imagemagick/inkscape 之一,若本机缺失则记录待补。见构建探测章节实际结果。

### K5 — Windows 计划任务名 vs 官方版冲突
`schtasks.rs` 的 `TASK_NAME_USER="Clash Verge"` / `TASK_NAME_ADMIN="Clash Verge (Admin)"` 是**本应用自己**创建的自启动计划任务(非 sidecar service),与官方 CVR 装在同机会冲突 → 已改为 Hub4CC 命名。XML 文件名(`clash-verge-task-*.xml`)是 app_home_dir 下的临时文件,随 APP_ID 数据目录隔离,保留原名无冲突风险(但一并记录)。

### K6 — Node 版本要求(已解决,记录)
仓库 `package.json` 声明 `packageManager: pnpm@11.3.0`,corepack 会强制使用该版本,
而 pnpm 11 需 **Node ≥ v22.13**(用到 `node:sqlite`)。本机默认 Node 为 v20.20.2,
直接 `pnpm i` / `pnpm run web:build` 会报 `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`(corepack 拉起 pnpm 11 失败)。
另外 `pnpm-workspace.yaml` 用了 `allowBuilds` / `minimumReleaseAgeExclude`(pnpm 10+ 字段),pnpm 9 无法解析。
**解决**:用 `fnm install 22` 装 Node v22.22.3,`eval "$(fnm env)"; fnm use 22` 后再 `pnpm i` / build 即正常。
**待办**:建议在 `.tool-versions` / CI 固定 Node 22,或文档注明开发需 Node 22。

### K7 — Windows 自定义 scheme 注册表(待补,非阻塞)
`init.rs` 的 Windows `init_scheme()` 手动在注册表 `Software\Classes\Clash` 写 `clash://` 协议(对应旧 scheme)。
新增的 `hub4cc://` scheme 已加入:① tauri.conf.json deep-link.schemes(安装期由 deep-link 插件注册);
② Linux `DEEP_LINK_SCHEMES`;③ 运行时 scheme 匹配 `scheme.rs`。
**但 Windows 这段手动注册表 fallback 仍只注册 `Clash` 子键**,未给 `hub4cc://` 建注册表项。
若依赖该手动 fallback(而非 deep-link 插件),`hub4cc://` 在 Win 上可能不被 OS 关联。
M1 暂保留原状(M2 接激活深链时再补 Windows 注册表 hub4cc 子键)。

### K8 — info_merge.plist 的 service 关联标识符(待确认)
`packages/macos/info_merge.plist` 的 `AssociatedBundleIdentifiers` 原为
`io.github.clash-verge-rev.clash-verge-rev.service`,已改为 `com.hub4cc.client.service` 以贴合新命名空间。
⚠️ **待确认**:实际特权 service(上游预编译 sidecar)的 bundle id 是否真为 `<app-id>.service`。
若 service 二进制有自己固定的 bundle id,此处需对齐 service 真实 id(否则关联失效)。
service 二进制 / IPC / Windows 服务名一律未改(见 K3)。

### K9 — 其余语言 i18n 品牌串(待补)
仅替换了 **zh / en** 的品牌显示串(productName 不入 i18n,这里指 "Verge 版本/设置" 等 label)。
其余语言(ru/de/ko/id/es/jp/fa/ar/tr/tt/zhtw)仍含 "Clash Verge" / "Verge" 字样(例:ru 含 "Clash Verge Rev")。
非阻塞,后续统一过一遍。`pnpm run i18n:types` 已重新生成 key 类型(新增 showAdvanced/hideAdvanced)。

### K10 — 托盘图标未替换(设计确认)
`pnpm tauri icon` 只重生成主应用图标(32/128/icns/ico/Square*Logo/StoreLogo/icon.png/icon.ico),
**未触碰** `src-tauri/icons/tray-icon-*.ico`(那是托盘状态指示图标,功能性,非品牌 logo)。
本次主图标已换成 Hub4CC hub 标(由 cc-gateway favicon.svg 放大到 1024 经 qlmanage 栅格化生成)。
**待确认**:是否要为 Hub4CC 定制托盘图标(目前沿用上游托盘图标,不影响功能)。

### K11 — 图标转换工具(已解决,记录)
本机无 rsvg-convert / imagemagick / inkscape。改用 macOS 自带 `qlmanage -t -s 1024` 栅格化 SVG → PNG,
再 `sips -z 1024 1024` 归一,最后 `pnpm tauri icon`。跨平台 / CI 上建议改用 rsvg-convert 或 sharp 以保证可复现。

## M1 完成度自评

**整体:M1 基本完成(~90%)**,前端三绿(typecheck/lint/web:build),原生构建因无 Rust 工具链未验证(K1)。

| 子项 | 状态 |
|---|---|
| 品牌化 productName / identifier / APP_ID / publisher | ✅ 完成(待确认取值 C1-C3) |
| 窗口标题(window.rs / lib.rs) | ✅ |
| 计划任务名(schtasks.rs) | ✅ |
| 深链 scheme 追加 hub4cc(conf + linux + 运行时匹配) | ✅(Windows 注册表 fallback 待补 K7) |
| Service/TUN 底层不动 | ✅ 遵守(K3) |
| 图标全套生成 | ✅ 主图标完成(托盘图标沿用上游 K10) |
| i18n 品牌串 zh/en | ✅(其余语言待补 K9) |
| 导航裁剪(默认只 home) | ✅ |
| 原生页路由保留可达 | ✅(navItems 仍注册全部路由) |
| 高级/调试入口开关(按 flag 过滤) | ✅(localStorage flag + 右键菜单开关;后续接设置) |
| logs 页特殊渲染未破坏 | ✅(仅过滤侧边栏项,/logs 路由与 Layout 内渲染逻辑未动) |

**未做(本阶段不在范围)**:原生构建/打包验证(需 Rust+sidecar)、M2 定制页、后端对接、签名。
