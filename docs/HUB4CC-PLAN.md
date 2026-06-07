# Clash Verge 客户端定制开发计划(Hub4CC 专属客户端)

> 基于调研:`clash-verge-rev` v2.5.2(Tauri 2 + React/MUI + Rust + mihomo sidecar)。
> 配合后端 `cc-gateway`(已有 `POST /api/activate` 一次性激活)。

---

## 0. 两个前置决策(动工前必须拍板)

| 决策 | 说明 | 倾向 |
|---|---|---|
| **GPL-3.0 合规** | Clash Verge Rev 是 GPLv3 强 copyleft。**fork 定制后只要对外分发就必须公开客户端源码**;仅同一法律实体内部自用不算分发。商标可自由改。 | **已定:仅内部分发不公开**。⚠️边界:发给**企业客户的员工**=对外分发给第三方,严格说仍触发 GPL 开源义务(社区项目维权概率低但不合规)。**更稳的折中=客户端 fork 公开 GPL + 服务端闭源**(服务端非衍生作品、壁垒不受损)。待最终确认。 |
| **签名 & 公证** | macOS 不公证被 Gatekeeper 拦(可手动绕);Windows 不签名有 SmartScreen 警告。 | **可先无签名内测,M5 前补**(时机待定)。Apple:$99/年(**个人即可**,Developer ID+公证,1~2 天;不需 $299 Enterprise)。Windows:荐 **Azure Trusted Signing ~$10/月**(云签名免硬件 token)或 OV 证书(~$200-400/年需硬件 token)。✅ 更正:**不签名也能跑 TUN**(CVR 即如此,osascript 提权,非 SMJobBless),签名只是免去首次绕 Gatekeeper 的摩擦、更专业(见 §3.5)。 |

> 这两条决定要不要动工、以及商业模式,**排期前先定**。

---

## 1. 目标与范围

基于 Clash Verge Rev fork 出 **Hub4CC 专属客户端**:
- 默认只露极简定制界面:**激活 → 一键连接 → 账号信息 → 更新激活**,全程 Hub4CC 品牌。
- 原生 clash 界面(节点/规则/连接/日志/设置/TUN 状态)**隐藏但保留**,通过「高级/调试」入口可调出(排障用)。
- 平台:**Windows + macOS**。
- 更新激活:**静默自动同步 + 手动重激活**(两者都要)。
- 分发:**直发安装包 + 应用内自动升级**(自建更新源)。

## 2. 架构总览

```
┌─ Hub4CC 客户端(fork CVR) ─────────────┐      ┌─ Hub4CC 后端(cc-gateway) ─┐     ┌─ HK 网关 ─┐
│ React 定制 UI ─ Tauri(Rust)           │ HTTPS│ POST /api/activate(一次性) │     │ Caddy +   │
│   · 激活/连接/账号/更新 + 隐藏的原生页 │─────▶│ GET  /api/client/sync(长期)│     │ sing-box  │
│ mihomo sidecar(内核,TUN 走特权 Service)│      └────────────┬───────────────┘     └─────┬─────┘
└───────────────────┬────────────────────┘                   │ 同一份 DB 真相               │
                    └─────── VLESS over WS+TLS 代理流量 ───────────────────────────────────┘
```

## 3. 客户端改造点(均已定位到文件)

| # | 模块 | 主要改动 | 档 |
|---|---|---|---|
| 3.1 | 导航裁剪 + 高级入口 | `src/pages/_routers.tsx`(navItems 只留定制页;原生页移出导航但保留路由)、`src/pages/_layout.tsx`(高级开关按 flag 过滤) | 小 |
| 3.2 | 定制页 | 新建 `src/pages/hub4cc-{activate,connect,account}.tsx`;连接页复用 `components/shared/proxy-control-switches.tsx`(系统代理+TUN+Service 安装) | 中 |
| 3.3 | 激活落地 | 输 token → fetch 后端拿 Clash YAML → `createProfile({type:'local'}, yaml)` → `patchProfilesConfig({current:uid})`(链路现成,`services/cmds.ts`) | 中 |
| 3.4 | 自动同步 | 启动/定时调 `/api/client/sync`:配置变了→重 createProfile+patch+重连;席位作废→提示重激活 | 中 |
| 3.5 | 品牌化 | `tauri.conf.json` 系列 + `utils/dirs.rs`(APP_ID,换数据目录)+ 窗口标题(`resolve/window.rs`/`lib.rs` 硬编码)+ `icons/`(已有 Hub4CC favicon 可作素材)+ i18n + scheme;**identifier/service 名/计划任务名散落 ~10 处,需全量替换防与官方版冲突** | 小~中 |
| 3.6 | 应用内自动更新 | `tauri.conf.json plugins.updater`:换自己的 minisign `pubkey`、`endpoints` 指向 Hub4CC 源;CI 产 `latest.json`+`.sig`;升级 UI 现成(`update-viewer.tsx`) | 中 |

### 3.5 TUN 模式与特权 Service 授权(重点,决定安装/首连体验)

**为什么必须 TUN + 特权 Service**:TUN 用虚拟网卡接管**全局流量**(所有 app);系统代理只接管"遵守代理设置"的应用。企业场景必须 TUN——才能让 identity 登录的 team 客户端、命令行、各类工具都走对应出口。但创建 TUN 网卡 + 改路由表需**管理员/root**:主程序以普通权限运行,TUN 操作交给一个**特权后台 Service**(Win:Windows Service;macOS:特权 helper / launchd root daemon)执行,安装它需**一次性授权**(Win UAC 弹窗;macOS 输密码授权)。

**安装时机(已定)**:**应用首次启动即引导授权装 Service,先于连接界面**——首次打开 app → 弹授权(Win UAC / macOS 输密码)装 Service → 装好才进主界面/连接页。复用 CVR 的 `installService`/`isServiceAvailable`,失败可重试。好处:进到连接页时 TUN 已就绪,一键连无障碍;坏处:首启动多一步授权(可接受,只一次)。

**底层机制沿用上游(已定)**:Service 的安装、提权(macOS `osascript` 管理员授权 / Windows UAC)、TUN 虚拟网卡管理这一整套**完全保持 Clash Verge Rev 原实现、不改造**——我们只在**外层包一层首启动引导 UX**(调它现成的 `installService` / `isServiceAvailable`),签名与否也沿用其"可签可不签"现状(见 §0)。好处:跟随上游、少踩坑、安全补丁随上游更新,改造面收敛在 UI 层。

**跨平台关键差异**:
- Windows:Windows Service,UAC 授权;**未签名也能装(仅 SmartScreen 警告)** → 内测期 Win 可带 TUN。
- macOS:特权 service 用 **osascript 管理员提权装 launchd daemon**(CVR 即此法,`signingIdentity:null` 也能跑 TUN)——**不签名也能用**,代价是首次要手动绕 Gatekeeper(右键打开 / 隐私设置允许)+ 装 service 输密码。签名公证是**体验/专业度优化**(免绕 Gatekeeper、未来兼容更稳),**非 TUN 必需**。(对比:SMJobBless/SMAppService 才强制签名,CVR 没用那套。)

**连接页 UX(M2 核心难点)**:「一键连接」→ 检测 `isServiceAvailable` → 未就绪弹**授权引导**(向非技术员工解释"需管理员权限以建立全局代理网卡")→ 装好开 TUN → 连接。复用 CVR 现成的 `proxy-control-switches` / `useServiceInstaller` / `installService` / `isServiceAvailable`。
**兜底**:用户拒授权 / Service 不可用 → **降级系统代理模式**(明确提示部分流量不走代理)或引导重装;Service 被杀 / 权限撤销 → 连接前检测并重新引导。高级入口保留 TUN 开关 + Service 状态(排障)。

### 3.6 默认设置项(开 / 关 / 锁定 / 隐藏)

原则:员工非技术 → **能锁就锁、装好即用、稳定少干预、安全**。三类处置:**锁定**(不让改)、**高级可改**(默认值,藏高级入口)、**隐藏**(排障保留)。

**应用层(Verge):**
| 设置 | 默认 | 处置 | 理由 |
|---|---|---|---|
| 开机自启 | 开 | 锁定 | 开机即连 |
| 静默启动(到托盘) | 开 | 锁定 | 不打扰 |
| 启动后自动连接 | 开 | 锁定 | 装好即用(首次需授权 Service) |
| 应用自动更新 | 开 | 基础可见 | 自建源升级(M4) |
| 代理守卫(系统代理被改自恢复) | 开 | 锁定 | 防被改 |
| clash 订阅自动更新 | **关** | 锁定 | **改用 `/api/client/sync`,不走 clash 订阅更新**(否则两套更新打架) |
| 遥测 / 匿名统计 | 关 | 锁定 | 隐私 |
| 语言 / 主题 | 中文 / 跟随系统 | 基础可见 | |

**内核层(Clash/mihomo):**
| 设置 | 默认 | 处置 | 理由 |
|---|---|---|---|
| 连接方式 | **TUN** | 锁定(高级可切系统代理) | 全局接管(§3.5) |
| 系统代理 | 关 | 高级 | 用 TUN,避免双开冲突 |
| 代理模式 mode | **rule** | 锁定 | 用我方 YAML 内置规则(DIRECT 兜底防套娃) |
| allow-lan 局域网连接 | **关** | 高级 | 安全,不向局域网暴露代理 |
| ipv6 | 关 | 高级 | 出口未必支持 v6,避免泄露 / 与出口不一致 |
| DNS / fake-ip | 按我方模板 | 锁定 | 模板已配 fake-ip-filter / hosts(红线 4) |
| 统一延迟 unified-delay | 开 | 隐藏 | 延迟显示更准 |
| TUN stack | gvisor | 高级 | 兼容性,排障可切 system/mixed |
| 日志级别 log-level | info | 高级 | 排障 |

**底线**:凡影响"能不能用 / 走不走对出口"的项(DNS、规则 mode、订阅更新)**一律锁定**,由我方配置 + `/api/client/sync` 决定;TUN / 日志 / ipv6 / stack 等排障项放高级入口可调。

## 4. 后端配合(cc-gateway)

现有 `/api/activate` 是**一次性 redeem**,只够"手动重激活";"自动同步"需新增长期接口:

| # | 改动 | 说明 |
|---|---|---|
| 4.1 | 激活返回增 `clientToken` | `/api/activate` 成功时,除配置/账号外,下发一个**长期客户端凭证**(CorpSeat 新增字段或复用 proxyToken) |
| 4.2 | 新增 `GET /api/client/sync` | 带 clientToken,**可重复调**;返回**当前** proxyConfig + 席位状态(active/rotated/revoked)+ 账号信息 |
| 4.3 | 与双切断回收联动 | 轮换 UUID(踢线)→ sync 下发新配置,客户端无感重连;作废 → sync 返回 revoked,客户端提示重激活 |
| 4.4 | 数据模型 | `CorpSeat` 增 `clientToken`(唯一);`prisma migrate`;`db.ts` 加 sync 查询;rate-limit |

## 5. 打包与分发

- Windows:`nsis`(`tauri.windows.conf.json`,填 `certificateThumbprint`);macOS:`dmg`(`tauri.macos.conf.json`,填 `signingIdentity` + notarytool 公证)。
- CI(GitHub Actions,参考 fork 自带 `.github/`):双平台打包 + 签名 + 产 `latest.json`/`.sig` → 上传 Hub4CC 更新源(HK 网关或对象存储)。

## 6. 阶段里程碑

| 里程碑 | 内容 | 产出 | 档 |
|---|---|---|---|
| **M0 准备** | GPL/签名决策、建 fork 私库(或公开 GPL 库)、生成 minisign 密钥、采购证书 | 可构建的 fork 基线 | 小 |
| **M1 品牌+导航** | 品牌化全量替换、导航裁剪、高级入口 | 能跑出"Hub4CC 壳"(原生功能仍可调出) | 小~中 |
| **M2 激活闭环** | 激活页 + 拉配置导入 + 连接页(含 Service 安装)+ 账号信息页 | 输 token 即可连接、看账号 | 中 |
| **M3 同步+重激活** | 后端 `/api/client/sync` + clientToken;客户端自动同步 + 手动重激活入口 | 换人/轮换无感更新;作废提示重激活 | 中 |
| **M4 自动更新** | 自建更新源 + 应用内升级闭环 | 发版客户端自动提示升级 | 中 |
| **M5 签名发布** | Win/Mac 签名公证 + CI 流水线 + 首个正式版 | 可直发的签名安装包 | **大**(证书/公证工程) |

## 7. 风险与依赖

1. **GPL-3.0 分发合规**(§0)——头号,先决策。
2. **签名/公证工程**(§5/M5)——最大技术工程量,依赖证书采购。
3. **TUN 特权 Service**(详见 §3.5)——**首次启动即引导授权装 Service**(macOS 用 osascript 提权,**不签名也能装**,CVR 即此法);拒绝则降级系统代理;签名公证是体验优化、**非必需**;Service 被杀/权限撤销需启动/连接前检测重引导。
4. **mihomo 内核许可**——通常 GPL 系,作为独立 sidecar 进程分发,需一并核对声明。
5. fork 跟随上游升级的维护成本(建议锁定版本,按需 rebase 安全补丁)。

## 8. 与现有系统的契合

- 代理面完全复用:`renderClashYaml`、CorpSeat(proxyUuid/proxyToken/exitTag)、sing-box auth_user 路由。
- 回收"双切断"(轮换 UUID 踢线 + 改 identity 密码 + signOut)与 §4.3 sync 天然衔接。
