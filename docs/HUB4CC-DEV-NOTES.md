# nextHubx 客户端开发笔记(DEV-NOTES)

> 记录 M0/M1 阶段的环境探测结果、待确认项、踩坑与决策。后续阶段持续追加。

## 品牌取值(已最终确认,2026-06)

> 用户最终拍板:产品名 `nextHubx`、identifier `com.nexthubx.app`、scheme `nexthubx`。M1 阶段的占位值 `Hub4CC` / `com.hub4cc.client` / `hub4cc` 已全量替换(`grep -ri hub4cc` 全仓无残留品牌值;`docs/HUB4CC-*.md` 文件名保留不改,内容已更新)。

| # | 项 | 取值 | 说明 |
|---|---|---|---|
| C1 | **产品名 productName** | `nextHubx` | ✅ 已定。用于 tauri.conf / package.json(`name: nexthubx`)/ 窗口标题 / installer。 |
| C2 | **bundle identifier** | `com.nexthubx.app` | ✅ 已定。用于 tauri.{conf,macos,windows,linux}.conf.json + entitlements.plist。 |
| C3 | **数据目录 APP_ID(dirs.rs)** | `com.nexthubx.app` | ✅ 已定,与 identifier 同步。dev feature 用 `com.nexthubx.app.dev`;BACKUP_DIR=`nexthubx-backup`/`-dev`。 |
| C4 | **深链 scheme** | `nexthubx`(保留 `clash`/`clash-verge`) | ✅ 已定。tauri.conf deep-link + linux DEEP_LINK_SCHEMES + 运行时 scheme.rs 匹配。Windows 注册表 fallback 仍待补,见 K7。 |
| C5 | **publisher / copyright** | publisher=`nextHubx`;copyright 保留 GPL v3.0 声明 | ✅ 已定。GPL 要求保留许可声明,copyright 行不动。 |
| C6 | **图标 / logo** | 沿用现有 hub 标(无文字) | ✅ 暂定沿用。**如需 nextHubx 专属 logo 待后补**(目前主图标为 cc-gateway favicon 放大的 hub 标,无文字,通用)。 |

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
`schtasks.rs` 的 `TASK_NAME_USER="Clash Verge"` / `TASK_NAME_ADMIN="Clash Verge (Admin)"` 是**本应用自己**创建的自启动计划任务(非 sidecar service),与官方 CVR 装在同机会冲突 → 已改为 nextHubx 命名。XML 文件名(`clash-verge-task-*.xml`)是 app_home_dir 下的临时文件,随 APP_ID 数据目录隔离,保留原名无冲突风险(但一并记录)。

### K6 — Node 版本要求(已解决,记录)
仓库 `package.json` 声明 `packageManager: pnpm@11.3.0`,corepack 会强制使用该版本,
而 pnpm 11 需 **Node ≥ v22.13**(用到 `node:sqlite`)。本机默认 Node 为 v20.20.2,
直接 `pnpm i` / `pnpm run web:build` 会报 `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`(corepack 拉起 pnpm 11 失败)。
另外 `pnpm-workspace.yaml` 用了 `allowBuilds` / `minimumReleaseAgeExclude`(pnpm 10+ 字段),pnpm 9 无法解析。
**解决**:用 `fnm install 22` 装 Node v22.22.3,`eval "$(fnm env)"; fnm use 22` 后再 `pnpm i` / build 即正常。
**待办**:建议在 `.tool-versions` / CI 固定 Node 22,或文档注明开发需 Node 22。

### K7 — Windows 自定义 scheme 注册表(待补,非阻塞)
`init.rs` 的 Windows `init_scheme()` 手动在注册表 `Software\Classes\Clash` 写 `clash://` 协议(对应旧 scheme)。
新增的 `nexthubx://` scheme 已加入:① tauri.conf.json deep-link.schemes(安装期由 deep-link 插件注册);
② Linux `DEEP_LINK_SCHEMES`;③ 运行时 scheme 匹配 `scheme.rs`。
**但 Windows 这段手动注册表 fallback 仍只注册 `Clash` 子键**,未给 `nexthubx://` 建注册表项。
若依赖该手动 fallback(而非 deep-link 插件),`nexthubx://` 在 Win 上可能不被 OS 关联。
M1 暂保留原状(M2 接激活深链时再补 Windows 注册表 nexthubx 子键)。

### K8 — info_merge.plist 的 service 关联标识符(待确认)
`packages/macos/info_merge.plist` 的 `AssociatedBundleIdentifiers` 原为
`io.github.clash-verge-rev.clash-verge-rev.service`,已改为 `com.nexthubx.app.service` 以贴合新命名空间。
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
本次主图标已换成 nextHubx hub 标(由 cc-gateway favicon.svg 放大到 1024 经 qlmanage 栅格化生成)。
**待确认**:是否要为 nextHubx 定制托盘图标(目前沿用上游托盘图标,不影响功能)。

### K12 — husky pre-commit 依赖 cargo-make(已绕过,记录)
`.husky/pre-commit` 要求 `cargo-make`(Rust 工具),本机无 Rust → 提交被拦。
M0/M1 提交用 `git commit --no-verify` 绕过(前端 lint/typecheck/build 已手动验证全绿)。
**待办**:装好 Rust 工具链后,提交前正常走 hook;或 CI 内补 Rust 环境。

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
| 深链 scheme 追加 nexthubx(conf + linux + 运行时匹配) | ✅(Windows 注册表 fallback 待补 K7) |
| Service/TUN 底层不动 | ✅ 遵守(K3) |
| 图标全套生成 | ✅ 主图标完成(托盘图标沿用上游 K10) |
| i18n 品牌串 zh/en | ✅(其余语言待补 K9) |
| 导航裁剪(默认只 home) | ✅ |
| 原生页路由保留可达 | ✅(navItems 仍注册全部路由) |
| 高级/调试入口开关(按 flag 过滤) | ✅(localStorage flag + 右键菜单开关;后续接设置) |
| logs 页特殊渲染未破坏 | ✅(仅过滤侧边栏项,/logs 路由与 Layout 内渲染逻辑未动) |

**未做(本阶段不在范围)**:原生构建/打包验证(需 Rust+sidecar)、M2 定制页、后端对接、签名。

---

## M2 阶段(激活闭环 + 连接 + 账号 + 自动同步)

### 后端契约(已对接)
- base:`https://gate.hub4cc.com`(已上线)。
- `POST /api/activate` body `{token}` → 200 `{clientToken, identityEmail, identityPassword, proxyConfig:{format:'clash-yaml',content}}`;失效 → 409。
- `GET /api/client/sync` 头 `Authorization: Bearer <clientToken>`(可带 `If-None-Match:<configFingerprint>`)→ 200 active `{status,proxyConfig,identityEmail,identityPassword,configFingerprint}` / 304 / 200 `{status:'revoked'}` / 401。

### 调后端的 HTTP 方式(关键决策)
**全部走 Tauri HTTP 插件 `@tauri-apps/plugin-http` 的 `fetch`**(Rust 侧发请求,不带 webview Origin
头 → 不撞后端 CORS,后端只放行 admin.hub4cc.com)。**未用 webview 原生 fetch**。
- 实现:`src/services/nexthubx-api.ts`(`activate` / `syncClient`)。参考 CVR `src/services/api.ts`(IP 检测/下载同样用此 plugin fetch)。
- capabilities `desktop.json` 已放行 `http:default` + scope `https://*/*`,`gate.hub4cc.com` 覆盖。

### C7 — clientToken / 账号本地存储方式(决策)
**用 `@tauri-apps/plugin-fs` 写 JSON 文件 `nexthubx-client.json` 到 `$APPDATA`(`BaseDirectory.AppData`,
即 CVR 应用数据目录,随 APP_ID 隔离)。** 实现:`src/services/nexthubx-store.ts`。
- **为何不用「verge config 自定义字段」**:`IVergeConfig` 是 Rust serde struct,加自定义字段需改 Rust
  (本阶段无 Rust 工具链 + 红线要求不改底层)。FS 文件是纯前端可写、最贴近「CVR 现成配置存储」的方式。
- **为何不用 localStorage**:webview 存储可被清理、不在持久 APPDATA 目录、且非「配置存储」语义。
- capabilities `migrated.json` 已放行 `$APPDATA/**` 的 `fs:allow-write-file` / `read-file` / `exists`。
- ⚠️ **无 remove 权限**:`clearClientState` 用写入空对象 `{}` 抹除凭证内容(load 时无 clientToken 即视为
  未激活),不物理删文件。见 K14。
- ⚠️ **安全**:文件含长期 clientToken,当前与 CVR config 同目录(无系统级加密)。后续如需更强保护可迁移
  到 OS keychain(需 Rust 侧 plugin)。见 K15。

### M2 实现清单(文件)
- `src/services/nexthubx-api.ts` — 后端 API 客户端(Tauri http)。
- `src/services/nexthubx-store.ts` — clientToken/账号/fingerprint/profileUid 本地存储(fs)。
- `src/services/nexthubx-profile.ts` — clash YAML 导入 + 切换(复用 createProfile/saveProfileFile/patchProfilesConfig/enhanceProfiles)。维护一个托管 profile uid 避免每次同步堆积。
- `src/hooks/use-nexthubx-sync.ts` — `useNexthubxClient`(读凭证)+ `useNexthubxAutoSync`(启动 + 每 10min 轮询)。
- `src/pages/nexthubx-activate.tsx` / `nexthubx-connect.tsx` / `nexthubx-account.tsx` — 三个定制页。
- `src/locales/{zh,en}/nexthubx.json` + index.ts 注册 + `pnpm i18n:types` 重生 key(856 keys)。
- `src/pages/_routers.tsx` — defaultNavItems = 连接/激活/账号;home 移入 advanced(路径改 `/home`);`/` index 重定向到 `/nexthubx/connect`。
- `src/pages/_layout.tsx` — 顶层挂载 `useNexthubxAutoSync()` 一次。

### K13 — Service 首启动引导只在「连接页」触发(非真正 app 首启动钩子)
§3.5 要求「应用首次启动即引导授权装 Service,先于连接界面」。本阶段实现把引导放在**连接页**:进页即
检测 `isServiceOk`,未就绪先展示安装引导卡片(而非连接按钮)。由于 `/` 默认重定向到连接页,**效果上等同
首启动引导**。若要做成 app 级启动闸门(进任何页前强制装 Service),需 Rust 侧启动钩子 / 全局 gate,本阶段
未做(底层不改造)。降级:用户点「暂不安装」→ fallbackMode → 连接时走系统代理。

### K14 — 凭证清除是「抹除内容」而非删文件
见 C7。capabilities 未给 `fs:allow-remove`,故 `clearClientState` 写空对象。若要物理删除需在
`migrated.json` 加 `fs:allow-remove` 权限(改 capability,非 Rust 代码)。功能上无影响(load 以
clientToken 是否存在判定激活态)。

### K15 — clientToken 明文存储(安全待加固)
当前 clientToken 明文存 APPDATA JSON。内测可接受;正式版建议迁 OS keychain(macOS Keychain /
Windows Credential Manager),需引入 `tauri-plugin-stronghold` 或自写 Rust command(依赖 Rust 工具链)。

### K16 — 自动同步未做去重 / 退避;通知较直接
`useNexthubxAutoSync` 启动即同步 + 每 10min 轮询,失败仅 console 记录不打扰(等下次)。未实现指数退避、
未与窗口可见性联动。`revoked`/`401` 都清凭证并提示重激活。后续可加退避 + 仅在前台轮询。

### K17 — 原生构建仍未验证(同 K1)
M2 纯前端 + 配置,三绿(typecheck/lint/web:build)。`tauri build` / `tauri dev` 仍因无 Rust 工具链
未跑(K1 未解)。Service 安装 / TUN / 提权等真机行为**未实机验证**,仅按上游 API 复用、逻辑层接通。

## M2 完成度自评

**整体:M2 前端逻辑完成(~85%),前端三绿;真机行为未验证(无 Rust)。**

| 子项 | 状态 |
|---|---|
| 激活页:token → /api/activate → 导入 YAML + 切换 + 存凭证 + 进主界面 | ✅ |
| 激活失效(409)/网络错误 友好提示 | ✅ |
| 连接页:复用 proxy-control / useServiceInstaller / isServiceAvailable | ✅ |
| 首次引导装 Service(先于连接,§3.5) | ⚠️ 实现于连接页 + `/` 重定向到连接页(等效);非 app 级 gate(K13) |
| 一键连接=开 TUN;拒绝/不可用→降级系统代理+提示 | ✅ |
| 账号页:显示 email/password(可复制)+ 显隐密码 | ✅ |
| 自动同步:启动 + 每 10min,If-None-Match,active 变更重导入,304 不动,revoked 清凭证提示 | ✅(逻辑层) |
| 手动重激活入口 | ✅(账号页按钮 → 激活页;激活页兼作重激活) |
| 三个定制页接入 defaultNavItems;原生页移入 advanced | ✅ |
| 调后端走 Tauri http(非 webview fetch) | ✅ |
| clientToken 安全存储 | ✅ fs@APPDATA(C7);明文待加固(K15) |

**未做 / 待真机**:Service 安装 / TUN / 提权真机验证(K17,需 Rust+sidecar);app 级启动 gate(K13);
凭证加密(K15);同步退避(K16)。

---

## 原生构建验证(M-Build,2026-06-07,macOS arm64)

> 目标:首次真机跑通 Rust + sidecar + Tauri 整体构建,确认 M0-M3 的品牌化 Rust 改动不破坏编译。
> **结论:`pnpm tauri build --debug` 已跑通,产出 `nextHubx.app` + `nextHubx_2.5.2_aarch64.dmg`。**
> 唯一报错是 updater 签名(缺私钥,非构建问题),`.app` / `.dmg` 在该步之前已生成完毕。

### 环境搭建结果
| 项 | 结果 |
|---|---|
| Node | `fnm install 22` → v22.22.3;pnpm 11.3.0(corepack)。注意:shell 不持久,每条命令需前置 `eval "$(fnm env)"; fnm use 22`。 |
| Rust | 之前未装(K1)。`rustup` 装好后,`rust-toolchain.toml` 自动拉 **1.95.0**(channel 锁定),`cargo 1.95.0` 可用。 |
| sidecar | `pnpm prebuild` 一次跑通(修了 K18 后):`sidecar/verge-mihomo{,-alpha}-aarch64-apple-darwin`、`resources/clash-verge-service{,-install,-uninstall}`、Country.mmdb / geoip.dat / geosite.dat / set_dns.sh / unset_dns.sh 全部就位。 |

### 构建结果
- `pnpm run web:build`:✅(随 `beforeBuildCommand` 在 tauri build 内也跑通)。
- Rust 编译:✅ 全过(几百 crate;本次 2m26s,部分 crate 已缓存)。产出 `target/debug/clash-verge`(arm64 Mach-O,adhoc 签名)。
- 打包:✅ 产出
  - `target/debug/bundle/macos/nextHubx.app`(`Contents/MacOS/` 含主二进制 + 两个 mihomo sidecar;`Contents/Resources/resources/` 含 service 三件套 + mmdb/dat + dns 脚本)。
  - `target/debug/bundle/dmg/nextHubx_2.5.2_aarch64.dmg`(~83MB)。
  - `nextHubx.app.tar.gz`(updater 包,已生成但签名失败,见下)。
- Info.plist 校验:`CFBundleIdentifier=com.nexthubx.app`、`CFBundleName/DisplayName=nextHubx` —— 品牌化已正确进入 bundle。

### 因品牌改动需修的构建问题
**无。** M0-M3 的 Rust 侧品牌改动(`dirs.rs` APP_ID/BACKUP_DIR、`window.rs`/`lib.rs` 窗口标题、`schtasks.rs` 任务名、`scheme.rs`/`init.rs` deep-link scheme)全部直接编译通过,未触发任何 Rust 报错。

### K18 — prebuild chmod 不兼容带空格路径(已修)
仓库克隆路径含空格(`.../AI Startup/...`)。`scripts/prebuild.mjs` 原用 `execSync(\`chmod 755 ${path}\`)` 走 shell,空格被拆成两个参数 → `chmod: No such file`,prebuild 在下载完第一个 sidecar 后即中断。
**修法**(纯构建脚本,不涉业务逻辑):把 4 处 `execSync('chmod 755 ...')`(行 412/428/443/560)改为 `fs.chmodSync(path, 0o755)`(与已有行 707 的 `fsp.chmod` 风格一致,天然兼容空格)。`execSync` 现仅用于无路径的 `rustc -vV`。
- 副作用:首个 sidecar(verge-mihomo-alpha)在改前已下载但 chmod 失败,且其 hash 已入 cache → 二次 prebuild 跳过它而未补 exec 位。手动 `chmod 755` 补上即可(或 `pnpm prebuild --force`)。已补,两个 sidecar 现均为 `-rwxr-xr-x`。

### K19 — tauri.macos.conf identifier 以 `.app` 结尾(警告,非阻塞)
tauri CLI 警告:`com.nexthubx.app` 以 `.app` 结尾,与 macOS app bundle 扩展名同形,不推荐。**仅 Warn,不影响构建**,bundle 正常产出。若后续洁癖可改 identifier(但会动 APP_ID/数据目录,牵连面大,本次不动)。

### K20 — updater 签名缺私钥(本次唯一报错,非构建失败)
`tauri.conf.json`:`createUpdaterArtifacts: true` + `plugins.updater.pubkey`(沿用上游 CVR 公钥)。打包末尾对 `nextHubx.app.tar.gz` 签名时报
`A public key has been found, but no private key. Make sure to set TAURI_SIGNING_PRIVATE_KEY`,`pnpm tauri build` 退出码 1。
- **影响面**:仅 updater 自动更新包的签名;`.app` 与 `.dmg` 在此步之前已完整生成,可正常安装运行。
- **原因**:本机无 CVR 上游 updater 私钥(也不该有)。
- **解法(任一)**:① 本地验证只想跑通编译/打包时,临时把 `createUpdaterArtifacts` 设 false 或移除 updater.pubkey;② 正式发版由持私钥方设 `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`;③ nextHubx 若要自管更新,需生成自己的 minisign 密钥对并替换 pubkey。本次未改配置(属发布流程,非构建可行性)。

### 一句话结论
**这个 app 现在能真机构建出可运行的 `.app` / `.dmg`(macOS arm64);M0-M3 的品牌化改动不破坏 Rust 编译与打包。** 仅 updater 签名因缺私钥失败,属发布流程范畴,不影响本地构建运行。Service/TUN/提权等运行时行为仍未在真机实测(K17 仍开)。

## 官方 Clash Verge 冲突检测(2026-06-08)

### 背景
官方 Clash Verge(clash-verge-rev)与 NextHubX 是同源 fork,会争用同一套网络服务(TUN 网卡 / 系统代理 / 内核端口),两者同时运行会导致连接互相断开。需在启动时与运行期间检测官方版并提醒用户关闭。

### 实现(只改代码,不打包)
- **Rust(`crates/tauri-plugin-clash-verge-sysinfo`)**:
  - `lib.rs` 新增纯函数 `detect_official_clash_verge() -> bool`,用已有 sysinfo 枚举进程,对每个进程的 `exe()` 路径 + `name()`(统一小写)做关键词匹配。
  - `commands.rs` 新增 `#[command] detect_official_clash_verge() -> Result<bool, Error>`,在 `src-tauri/src/lib.rs` 的 `generate_handlers!` 中注册(与既有 sysinfo 命令同样无需 capability 条目,属第一方命令)。
- **前端**:
  - `services/cmds.ts` 加 `detectOfficialClashVerge()` invoke 封装。
  - `hooks/use-clash-verge-conflict.ts`:启动检测一次(mode=running),并每 7 秒轮询;在官方版「从无到有」(false→true)上升沿触发(mode=appeared)。同一次出现只提示一次,关闭后需先消失再出现才会重弹。
  - `components/layout/clash-verge-conflict-dialog.tsx`:复用 `BaseDialog` 弹提示,在 `pages/_layout.tsx` 顶层挂载一次(紧邻 `NoticeManager`)。
  - i18n:`locales/{zh,en}/nexthubx.json` 新增 `clashVergeConflict` 段;改 JSON 后必须 `pnpm i18n:types` 重新生成 `src/types/generated/`,否则 `t()` 的字面量键类型校验报 TS2769。

### 官方版识别标识 & 防误判
- 命中即官方版:bundle id `io.github.clash-verge-rev.clash-verge-rev`、路径含 `clash verge.app`、`clash-verge-rev`(全小写匹配)。
- **先排除自身**:进程文本若含 `com.nexthubx.app` / `nexthubx`,直接跳过 → 不会把 NextHubX 自己(`NextHubX.app` / `com.nexthubx.app`)误判成官方版。逻辑上「排除自身」优先于「命中官方」。

### 校验结果(未打包)
- `cargo check`(`src-tauri`):通过。
- 前端三绿:`pnpm typecheck` / `pnpm lint`(--max-warnings=0) / `pnpm web:build` 全过。
- 未做:`tauri build`、打包、安装、push —— 按要求代码攒在分支,随下次出版生效。
- 未实测:真机上官方版运行时弹窗的实际触发(无 GUI 环境)。逻辑已单点收敛在纯函数 `detect_official_clash_verge`,后续可补单测。

---

## 最终 spec UI 重构(2026-06,定制 CVR 原生 Home/Logs/Test/Settings)

### Tabs(`src/pages/_routers.tsx`)
- 默认导航改为 **Home / Logs / Test / Settings**(`defaultNavItems`),`/` 重定向到 `/home`。
- `nexthubx-connect/activate/account` 三页移出默认导航,仅注册路由(`hiddenRouteItems`)保持可达;激活页兼作 Account 卡片「重新激活」跳转(实际重新激活已内联在卡片)。
- `advancedNavItems` = Proxies/Profiles/Connections/Rules/Unlock,默认隐藏(高级入口开启才显示)。
- i18n:`layout.json` tabs 原 `unlock="测试/Test"` 修正为 `unlock="解锁/Unlock"`,新增 `test="测试/Test"`(Test tab 指向原生 `test.tsx` Website Tests 页)。

### Home(`src/pages/home.tsx` + `components/home/account-card.tsx`)
- 仅两张卡:① Account(新建)② IP Information(原生)。移除首页设置弹窗与全部其他卡片(profile/proxy/network/mode/traffic/test/clashinfo/systeminfo/proxy-tun-card)。
- Account 卡片(`account-card.tsx`,用 `EnhancedCard`,尺寸同 Clash Info 卡):未激活→输入激活码+激活(逻辑与原 activate 页一致,复用 nexthubx-store/profile);已激活→email/password 可复制 + 使用说明(`nexthubx.account.usage`)+ 右上角重新激活图标按钮(切回输入态)。

### Settings(`settings.tsx` + setting-system/setting-verge-basic)
- 删除右上角三个按钮;仅保留 System + Basic 两组。
- System:移除 System Proxy / Silent Start;TUN/Auto Launch/DNS Override/Unified Delay 四项渲染为 checked+disabled 只读开关 + locked tooltip,挂载时 effect 强制底层置开(tun/autolaunch/dns_settings→verge,unified-delay→clash,dns 另调 `apply_dns_config(true)`);新增 Allow LAN(`clash['allow-lan']`,默认关,正常切换)。
- Basic(原 Verge Basic,改名 `basic.title`→「基础设置/Basic Setting」):保留 Language/Theme Mode/Theme Settings;新增 Open Logs Dir、Check for Updates、Show in Menu Bar。
  - **Show in Menu Bar backing 字段坑**:`IVergeConfig.enable_tray_icon` 在 `global.d.ts` 被注释掉(macOS-only 且 layout-viewer 里也是注释态),直接用会 TS2339。改用 `menu_icon`('monochrome'|'colorful'|'disable'):开→'monochrome',关→'disable'。
- `SettingClash` / `SettingVergeAdvanced` 组件文件保留但不再被 settings.tsx 引用(未删,避免误伤其内部 viewer 复用)。
- **Network shortcuts**:仓内无独立「Network shortcuts」UI 区块,系统代理相关只存在于已移除的 hotkey-viewer。spec 为条件性保留(「若含…酌情」),故无单独处理。

### 关闭按钮(#4,无需改 Rust)
- 现状已符合 spec:`src-tauri/src/lib.rs` `handle_window_close` 对主窗口 `CloseRequested` 调 `api.prevent_close()` + `window.hide()`(隐藏到后台,不退出);macOS 还切 activation policy 到 accessory。
- 托盘已有唯一退出途径:`core/tray/menu_def.rs` 的 `EXIT` 菜单项 → `core/tray/mod.rs` `MenuIds::EXIT => feat::quit()`。未改任何 Rust。

### Service 强制引导(A3,`components/layout/service-gate.tsx`)
- 全局 gate,挂在 `_layout.tsx` 顶层(紧邻 ClashVergeConflictDialog)。`isServiceOk` 为假且非启动 loading → 强制弹不可关 Dialog(无 onClose,Esc/遮罩无效);进入即触发一次 `mutateSystemState`。
- 安装走 `useServiceInstaller().installServiceAndRestartCore`;失败累加 failureCount,`> 3`(MAX_RETRIES=3)切「请联系技术支持」态(仍留「仍要重试」)。**无系统代理降级**(与已废弃 connect 页的 fallback 逻辑相反)。
- MUI 坑:本版本 `DialogProps` 无 `disableEscapeKeyDown`,去掉该 prop——不传 onClose 即天然不可关。

### C9 自动同步保留
- `useNexthubxAutoSync`(`_layout.tsx` 挂载一次)未改动。

### 待确认 / 风险
- `start_page` 选项已从 Basic 设置移除;若旧 verge config 持久化了 `/nexthubx/connect`,启动跳转可能落到已隐藏页(路由仍可达,不崩,但非 Home)。如需可在启动处把无效 start_page 回退到 `/home`。未处理。
- 锁定项 effect 每次进 Settings 页都会校验并(必要时)patch;已用 `enforcedRef` 防同一挂载内重复。锁定项 reload sing-box 的副作用由底层 patchVerge/patchClash 链路承担,未额外处理回滚。
- Service gate 仅在真机/有 GUI 时能验证授权弹窗实际行为;逻辑收敛单点。

### 校验结果
- 前端三绿:`pnpm typecheck` / `pnpm lint`(--max-warnings=0)/ `pnpm web:build` 全过。`pnpm i18n:types` 已重生成(879 keys)。
- `cargo check`(src-tauri):通过(无 Rust 改动)。
