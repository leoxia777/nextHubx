# NextHubX 发布 Runbook(M4 自动更新 + M5 CI 打包/签名/发布)

> 本文档描述 nextHubx 客户端从「打 tag」到「用户应用内自动升级」的完整发布链路,
> 以及尚未配置的 secrets / Cloudflare R2 / 证书清单。
>
> **分发策略:沿用 Clash Verge 的无签名分发** —— 不做 Apple 公证、不做 Windows 代码签名。
> macOS 出 adhoc 签名包、Windows 出未签名包;用户**首次启动需手动绕过 Gatekeeper / SmartScreen**
> (见 §4)。这与 updater 的 minisign 签名**互不相关**:自动更新仍走 minisign 校验包完整性,必须保留。
>
> 现状(框架阶段):代码与 CI 框架已就位,但 **updater 密钥 secret / R2 未配齐**,
> 故 CI 在缺失这些时会**跳过 .sig 生成 / R2 上传**,仍能产出可安装包。配齐后即转为正式自动更新发布。

---

## 0. 链路总览

```
打 tag vX.Y.Z (从 main)
  → .github/workflows/release.yml 触发
    ├─ check-version : 校验 tag 在 main 上 且 == v<package.json.version>
    ├─ build (matrix): macOS(aarch64, adhoc) + Windows(x64, 未签名)
    │     tauri-action → 出 .dmg / -setup.exe + updater 包(.app.tar.gz / .nsis.zip)+ .sig
    │     (无 OS 代码签名;仅 updater minisign 签 .sig)
    │     → 创建 draft GitHub Release 并上传上述产物
    └─ publish:
          ├─ 从 draft release 资产读 url + .sig,生成 per-target latest.json
          │     out/darwin-aarch64/latest.json
          │     out/windows-x86_64/latest.json
          ├─ aws s3 cp 上传到 Cloudflare R2(S3 兼容)
          └─ 发布(un-draft)GitHub Release

应用侧(M4):
  tauri.conf.json plugins.updater.endpoints =
    https://updates.nexthubx.com/{{target}}-{{arch}}/latest.json
  → updater 插件按 {target}-{arch} 拉对应 latest.json
  → 用 plugins.updater.pubkey(minisign 公钥)校验 .sig
  → core/updater.rs 静默后台下载 + 启动时安装(已内置,无需改)
```

`{{target}}-{{arch}}` 由 Tauri 在运行时替换,对本项目两平台分别解析为:
- macOS Apple Silicon → `darwin-aarch64`
- Windows x64 → `windows-x86_64`

故 R2 上的对象路径必须是 `darwin-aarch64/latest.json`、`windows-x86_64/latest.json`。

---

## 1. 需配置的 GitHub Secrets(全清单)

在仓库 `Settings → Secrets and variables → Actions → New repository secret` 添加。
未配齐前 CI 会自动降级(见各项「缺失时行为」)。

> **不做 OS 代码签名**(沿用 Clash Verge):故**无** Apple(`APPLE_*`)/ Windows(`AZURE_*` / 证书指纹)
> 任何 secret。只需下面两类:**updater 签名** + **R2**。
> 三个 updater 相关值的本地备份在 `nextHubx/.env.production`(已 `.gitignore`,绝不入库);
> GitHub secret 的值即取自该文件(见 §3)。

### 1.1 Updater 签名(minisign)——M4 必需

| Secret | 来源 | 缺失时行为 |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `.env.production` 的 `TAURI_SIGNING_PRIVATE_KEY`(= `src-tauri/nexthubx-updater.key` 文件**全部内容**,见 §3) | 不产 `.sig` → 应用端无法校验更新 → 自动更新失效(但 dmg/exe 仍出) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | `.env.production` 的同名值(生成密钥时设的强密码) | 同上 |

> updater minisign 签名**与 OS 代码签名无关**,仅用于自动更新包的完整性校验,**必须保留**。

### 1.2 Cloudflare R2 上传(更新源)——M5 必需

| Secret | 说明 | 缺失时行为 |
|---|---|---|
| `R2_ACCESS_KEY_ID` | R2 API Token 的 Access Key ID | publish job **跳过 R2 上传**(latest.json 仅作为 workflow artifact 留存),自动更新无源 |
| `R2_SECRET_ACCESS_KEY` | R2 API Token 的 Secret | 同上 |
| `R2_BUCKET` | R2 bucket 名,如 `nexthubx-updates` | 同上 |
| `R2_ENDPOINT` | R2 S3 endpoint,形如 `https://<accountid>.r2.cloudflarestorage.com` | 同上 |

> `GITHUB_TOKEN` 由 Actions 自动注入,无需手动配置(用于建/发 Release)。

---

## 2. Cloudflare R2 开通 + bucket + 公开自定义域

更新源用 R2 托管 `latest.json`(以及可选的安装包镜像)。步骤:

1. **开通 R2**:Cloudflare Dashboard → R2 → 启用(需绑卡,免费额度足够 latest.json 这类小文件)。
2. **建 bucket**:`Create bucket`,名字如 `nexthubx-updates`,区域 `Automatic`。
3. **生成 API Token**:R2 → `Manage R2 API Tokens` → `Create API Token`,
   权限选 `Object Read & Write`,限定到该 bucket。
   记下 **Access Key ID / Secret Access Key**,以及 **S3 endpoint**
   (`https://<account_id>.r2.cloudflarestorage.com`)。→ 填入 §1.4 四个 secret。
4. **绑定公开自定义域 `updates.nexthubx.com`**:
   - bucket → `Settings` → `Public access` → `Custom Domains` → `Connect Domain`,
     输入 `updates.nexthubx.com`(`nexthubx.com` 须在该 Cloudflare 账号托管 DNS)。
   - Cloudflare 自动建 CNAME 并签发证书。等状态变 `Active`。
   - ⚠️ 这是当前 `tauri.conf.json` 里 endpoint 占位用的域名。**若最终用别的域,
     需同步改 `src-tauri/tauri.conf.json` 的 `plugins.updater.endpoints` 并重新发版**
     (endpoint 编进客户端二进制,改了要重新出包)。
5. **验证**:上传后浏览器访问
   `https://updates.nexthubx.com/darwin-aarch64/latest.json` 应返回 JSON。

> 安装包本体:本流程把 dmg/exe 放在 **GitHub Release**,latest.json 里的 `url`
> 指向 GitHub Release 下载地址。如需国内加速,可改为把安装包也 `aws s3 cp` 到 R2
> 并把 latest.json 的 `url` 改成 R2 自定义域(需扩展 publish job;当前未做)。

---

## 3. minisign 私钥配置(从 `nexthubx-updater.key` 取)

M4 的更新签名密钥对已用 `pnpm tauri signer generate` **以强密码重新生成**(强密码由 `openssl rand -base64 24` 产生):

- **公钥**:`src-tauri/nexthubx-updater.key.pub`(可公开,已入 git;其 base64 内容已填进
  `tauri.conf.json` 的 `plugins.updater.pubkey`)。
- **私钥**:`src-tauri/nexthubx-updater.key`(⚠️ **已加 `.gitignore`,绝不提交、绝不外泄**)。
- **密码**:生成时设置的强密码。
- **本地备份**:私钥内容 + 密码 + 公钥三项已写入 `nextHubx/.env.production`
  (`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` / `TAURI_UPDATER_PUBKEY`)。
  该文件**已 `.gitignore`,绝不入库**,作为密钥的唯一本地备份 —— 丢失即无法再签更新包,
  务必离线保管。CI 用的 GitHub secret 值即取自此文件。

配置到 CI(值取自 `.env.production`):

```bash
# 私钥内容(整文件)→ TAURI_SIGNING_PRIVATE_KEY
gh secret set TAURI_SIGNING_PRIVATE_KEY < src-tauri/nexthubx-updater.key
# 私钥密码 → TAURI_SIGNING_PRIVATE_KEY_PASSWORD(取 .env.production 中的同名值)
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --body '<.env.production 里的密码>'
```

**再次轮换 / 重新生成**(如密钥泄露需更换):

```bash
eval "$(fnm env)"; fnm use 22
PW="$(openssl rand -base64 24)"
node_modules/.bin/tauri signer generate -w src-tauri/nexthubx-updater.key -f -p "$PW" --ci
# 把新公钥内容填回 tauri.conf.json plugins.updater.pubkey + 更新 .env.production 三项,
# 再重配上面两个 gh secret。
cat src-tauri/nexthubx-updater.key.pub        # 直接复制该文件全部内容作为 pubkey 值
```

> ⚠️ 一旦有用户装了某公钥的版本,**更换公钥会导致旧用户无法验证新更新**
> (旧版本内嵌的是旧公钥)。轮换公钥须在「还没有外发任何版本」时做,或接受旧用户需手动重装。

---

## 4. 无签名分发 + 用户首次启动绕过系统拦截

**本项目沿用 Clash Verge 的做法:不做 Apple 公证、不做 Windows 代码签名。**
`tauri.macos.conf.json` 的 `signingIdentity: null` → macOS adhoc 签名;
`tauri.windows.conf.json` 的 `certificateThumbprint: null` → Windows 未签名。
代价是用户**首次启动**会遇到系统拦截,需手动绕过一次(之后正常)。

### 4.1 macOS(Gatekeeper)
adhoc 包未经 Apple 公证,首次双击会提示"无法打开/已损坏"。用户任选其一绕过:
- **右键打开**:Finder 里右键 App → `打开` → 弹窗再点 `打开`(仅首次)。
- 或终端清除隔离属性:`xattr -dr com.apple.quarantine /Applications/NextHubX.app`。

### 4.2 Windows(SmartScreen)
未签名 `-setup.exe` 首次运行弹 SmartScreen 蓝屏警告:
- 点 `更多信息` → `仍要运行`(仅首次)。

> 说明:无签名不影响功能(含 TUN);只是首次需用户确认。如未来要消除该提示,
> 可分别接入 Apple Developer ID 公证 / Windows 代码签名(Azure Trusted Signing 或 OV/EV 证书),
> 届时需在 release.yml 重新加回对应 step 与 secrets。
>
> ⚠️ 通用红线:若将来接入**后置**代码签名(如 Azure 对已构建 exe 签名),**必须在 minisign `.sig`
> 生成之前**完成,否则 `.sig` 摘要对不上签名后文件,应用端校验失败。Tauri 内置签名(证书指纹)天然满足。

---

## 5. 发版流程

```bash
# 1. 确保 package.json 的 version == 要发的版本(如 2.5.3),已合入 main。
# 2. 从 main 打 tag(必须 vX.Y.Z,且与 package.json 一致):
git checkout main && git pull
git tag v2.5.3
git push origin v2.5.3        # ← 推 tag 触发 CI

# 3. CI 自动:
#    check-version → 双平台 build(出包+.sig+建 draft release)
#    → publish(生成 latest.json → 上传 R2 → 发布 release)
# 4. 验证:
#    - GitHub Release vX.Y.Z 已发布,含 .dmg / -setup.exe / .sig
#    - https://updates.nexthubx.com/darwin-aarch64/latest.json 可访问
#    - 旧版本客户端在后台静默检查到更新(core/updater.rs 每 24h 一轮,启动后 10s 首查)
```

- **预发布**:tag 带 `-rc`(如 `v2.5.3-rc1`)→ Release 标记 prerelease。
  (注:当前 latest.json 仍会照常生成/上传;如需 rc 不影响正式更新源,需在 publish job 加分支判断。)
- **回滚**:删 Release / tag,并把 R2 上对应 `latest.json` 还原到上一版本(R2 无版本历史时,
  重新跑上一个 tag 的 publish 或手动 `aws s3 cp` 旧 json)。

---

## 6. latest.json 样例结构

Tauri updater v2 单平台格式(本流程**每个 target 一个文件**,只含该 target 一项)。

`darwin-aarch64/latest.json`:

```json
{
  "version": "2.5.3",
  "notes": "NextHubX v2.5.3",
  "pub_date": "2026-06-08T12:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "dW50cnVzdGVkIGNvbW1lbnQ6IC4uLg==  (minisign .sig 文件的全部内容)",
      "url": "https://github.com/<owner>/<repo>/releases/download/v2.5.3/NextHubX_2.5.3_aarch64.app.tar.gz"
    }
  }
}
```

`windows-x86_64/latest.json`:

```json
{
  "version": "2.5.3",
  "notes": "NextHubX v2.5.3",
  "pub_date": "2026-06-08T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "dW50cnVzdGVkIGNvbW1lbnQ6IC4uLg==",
      "url": "https://github.com/<owner>/<repo>/releases/download/v2.5.3/NextHubX_2.5.3_x64-setup.exe"
    }
  }
}
```

字段说明:
- `version`:语义版本(不带 `v`)。应用端用 `core/updater.rs` 的 `version_lte` 与本机版本比较。
- `signature`:对应安装/更新包 `.sig` 文件的**全部文本内容**(minisign 签名)。
- `url`:更新包下载地址。macOS 是 `.app.tar.gz`(updater 包,非 dmg),Windows 是 `-setup.exe`。
- `pub_date`:RFC3339 UTC。
- `notes`:更新说明,展示在应用内更新提示。

---

## 7. 待办 / 已知缺口

- [ ] 配齐 §1 所有 secrets(updater 私钥 + 密码 / R2;**无 Apple/Windows 签名 secret**)。
- [ ] R2 开通 + bucket + `updates.nexthubx.com` 自定义域(§2);确认 endpoint 域名最终值。
- [x] 用强密码重新生成 minisign 密钥对并同步 pubkey + `.env.production`(§3)。
- [ ] 如需安装包也走 R2 加速,扩展 publish job 把 dmg/exe 也上传 R2 并改 latest.json 的 url。
- [ ] rc 预发布是否应隔离更新源(当前 rc 也会更新 latest.json)。
- [ ] 未跑 `tauri build` 验证本框架(证书/secrets 未齐),首次真跑需关注:tauri-action 版本、
      sidecar prebuild 在 CI 的可用性(参考既有 autobuild.yml)。
