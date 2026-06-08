# NextHubX 发布 Runbook(M4 自动更新 + M5 CI 打包/签名/发布)

> 本文档描述 nextHubx 客户端从「打 tag」到「用户应用内自动升级」的完整发布链路,
> 以及尚未配置的 secrets / Cloudflare R2 / 证书清单。
>
> 现状(框架阶段):代码与 CI 框架已就位,但**证书 / R2 / secrets 未配齐**,
> 故 CI 在缺失这些时会**降级为 adhoc/无签名出包、跳过 R2 上传**,仍能产出可安装包。
> 配齐下列各项后即转为正式签名发布。

---

## 0. 链路总览

```
打 tag vX.Y.Z (从 main)
  → .github/workflows/release.yml 触发
    ├─ check-version : 校验 tag 在 main 上 且 == v<package.json.version>
    ├─ build (matrix): macOS(aarch64) + Windows(x64)
    │     tauri-action → 出 .dmg / -setup.exe + updater 包(.app.tar.gz / .nsis.zip)+ .sig
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

### 1.1 Updater 签名(minisign)——M4 必需

| Secret | 来源 | 缺失时行为 |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `src-tauri/nexthubx-updater.key` 文件**全部内容**(见 §3) | 不产 `.sig` → 应用端无法校验更新 → 自动更新失效(但 dmg/exe 仍出) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成密钥时设置的密码 | 同上 |

### 1.2 Apple 代码签名 + 公证(macOS)——证书后补

| Secret | 说明 | 缺失时行为 |
|---|---|---|
| `APPLE_CERTIFICATE` | Developer ID Application 证书导出的 `.p12`,base64 编码后的字符串 | macOS 走 **adhoc 签名**,用户首次需手动绕 Gatekeeper(右键打开),TUN 仍可用(见 HUB4CC-PLAN §3.5) |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` 导出密码 | 同上 |
| `APPLE_SIGNING_IDENTITY` | 形如 `Developer ID Application: Your Name (TEAMID)` | 同上 |
| `APPLE_ID` | 公证用 Apple 账号邮箱 | 不公证(adhoc) |
| `APPLE_APP_PASSWORD` | App-specific password(account.apple.com 生成)。⚠️ workflow env 名为 `APPLE_PASSWORD`,值取此 secret | 不公证 |
| `APPLE_TEAM_ID` | Apple 开发者 Team ID(10 位) | 不公证 |

> Apple Developer:**个人账号 $99/年**即可(Developer ID + 公证,非 $299 Enterprise)。

### 1.3 Windows 代码签名——证书后补

当前 `tauri.windows.conf.json` 的 `certificateThumbprint: null` → 默认**不签名**(仅 SmartScreen 警告,可安装运行)。
正式签名两条路任选:

| 方案 | 需要的 secret / 配置 | 说明 |
|---|---|---|
| **Azure Trusted Signing**(推荐,云签名免硬件 token,~$10/月) | `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` + Trusted Signing account/endpoint | 需在 build job 后加一步 `azure/trusted-signing-action` 对 `-setup.exe` 签名,再补签 `.sig` |
| **OV/EV 证书**(~$200-400/年,需硬件 token) | 证书指纹填入 `tauri.windows.conf.json.bundle.windows.certificateThumbprint`(或经 env) + `timestampUrl` | Tauri 构建时自动签 |

> 缺失时行为:Windows 包不签名,安装有 SmartScreen 警告,功能正常。
> 接入签名时,务必在 **生成 `.sig` 之前** 完成 exe 签名(签名会改变文件 → 影响 minisign 摘要)。

### 1.4 Cloudflare R2 上传(更新源)——M5 必需

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

M4 的更新签名密钥对已用 `pnpm tauri signer generate` 生成:

- **公钥**:`src-tauri/nexthubx-updater.key.pub`(可公开,已入 git;其 base64 内容已填进
  `tauri.conf.json` 的 `plugins.updater.pubkey`)。
- **私钥**:`src-tauri/nexthubx-updater.key`(⚠️ **已加 `.gitignore`,绝不提交、绝不外泄**)。
- **密码**:生成时设置的密码。⚠️ **当前用的是占位密码 `CHANGE_ME_nexthubx_placeholder_pw`**,
  正式发布前**强烈建议重新生成密钥对并用强密码**(见下「轮换」)。

配置到 CI:

```bash
# 私钥内容(整文件)→ TAURI_SIGNING_PRIVATE_KEY
gh secret set TAURI_SIGNING_PRIVATE_KEY < src-tauri/nexthubx-updater.key
# 私钥密码 → TAURI_SIGNING_PRIVATE_KEY_PASSWORD
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --body 'your-key-password'
```

**轮换 / 用强密码重新生成**(推荐在正式发布前做一次):

```bash
eval "$(fnm env)"; fnm use 22
pnpm tauri signer generate -w src-tauri/nexthubx-updater.key -f -p '强密码'
# 把新公钥 base64 内容填回 tauri.conf.json plugins.updater.pubkey:
cat src-tauri/nexthubx-updater.key.pub        # 直接复制该文件全部内容作为 pubkey 值
# 重新配 secret(同上两条 gh secret set)
```

> ⚠️ 一旦有用户装了某公钥的版本,**更换公钥会导致旧用户无法验证新更新**
> (旧版本内嵌的是旧公钥)。轮换公钥须在「还没有外发任何版本」时做,或接受旧用户需手动重装。

---

## 4. Apple / Windows 证书后补步骤

### 4.1 Apple(macOS)
1. Apple Developer Program 注册($99/年,个人即可)。
2. Xcode 或开发者后台生成 **Developer ID Application** 证书,导出 `.p12`。
3. `base64 -i cert.p12 | pbcopy` → 填 `APPLE_CERTIFICATE`;`.p12` 密码填 `APPLE_CERTIFICATE_PASSWORD`。
4. `APPLE_SIGNING_IDENTITY` = `security find-identity -v -p codesigning` 里那条 `Developer ID Application: ...`。
5. 公证:`APPLE_ID`(账号邮箱)、`APPLE_APP_PASSWORD`(App-specific password)、`APPLE_TEAM_ID`。
6. 配齐后下次发版 tauri-action 自动签名 + 公证,用户无需绕 Gatekeeper。

### 4.2 Windows
- 选 **Azure Trusted Signing**:在 release.yml 的 `build` job、`Tauri build` 步**之后**、
  生成 `.sig` **之前**插入 `azure/trusted-signing-action@v0` 对 `target/.../bundle/nsis/*-setup.exe` 签名;
  配 `AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET`。因签名改变文件,签完需重新生成该 exe 的 `.sig`
  (`pnpm tauri signer sign` 或重跑 bundler 的签名步)。
- 或 **OV/EV 证书**:把指纹填 `tauri.windows.conf.json.bundle.windows.certificateThumbprint`,
  Tauri 构建时即签(此时 `.sig` 在签名后生成,无重签问题)。

> ⚠️ 通用红线:**代码签名必须发生在 minisign `.sig` 生成之前**,否则 `.sig` 摘要对不上签名后的文件,
> 应用端校验失败。OV/EV 走 Tauri 内置签名天然满足;Azure 后置签名需手动补签 `.sig`。

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

- [ ] 配齐 §1 所有 secrets(updater 私钥 / Apple / Windows / R2)。
- [ ] R2 开通 + bucket + `updates.nexthubx.com` 自定义域(§2);确认 endpoint 域名最终值。
- [ ] **正式发布前用强密码重新生成 minisign 密钥对**(当前为占位密码),并同步 pubkey + secret(§3)。
- [ ] Windows 签名方案落地(Azure Trusted Signing / OV 证书),注意签名须先于 `.sig` 生成(§4.2)。
- [ ] 如需安装包也走 R2 加速,扩展 publish job 把 dmg/exe 也上传 R2 并改 latest.json 的 url。
- [ ] rc 预发布是否应隔离更新源(当前 rc 也会更新 latest.json)。
- [ ] 未跑 `tauri build` 验证本框架(证书/secrets 未齐),首次真跑需关注:tauri-action 版本、
      sidecar prebuild 在 CI 的可用性(参考既有 autobuild.yml)。
