/**
 * nextHubx 代理配置导入(M2)。
 *
 * 把后端下发的 Clash YAML 落地为本地 profile 并切换为当前配置,复用 CVR 现成链路
 * (`createProfile` / `saveProfileFile` / `patchProfilesConfig` / `enhanceProfiles`,见 `services/cmds.ts`)。
 *
 * 为避免每次同步都新建 profile 堆积:维护一个 nextHubx 托管 profile 的 uid——
 * 已存在则用 `saveProfileFile` 覆盖更新,不存在则 `createProfile` 后回查新 uid。
 */
import { refetchIpInfoNow } from '@/hooks/use-ip-info'
import {
  createProfile,
  enhanceProfiles,
  getProfiles,
  patchProfilesConfig,
  saveProfileFile,
} from '@/services/cmds'

const MANAGED_PROFILE_NAME = 'nextHubx'
// 临时引导用独立命名的 profile:不复用正式激活的托管配置,避免覆盖真实账号配置。
const BOOTSTRAP_PROFILE_NAME = 'nextHubx 临时引导'

/** 列出当前所有 profile item(含 type/name,用于精确识别我们托管的 local 主配置)。 */
async function listProfileItems(): Promise<IProfileItem[]> {
  const profiles = await getProfiles()
  return profiles.items ?? []
}

/**
 * 是否为 nextHubx 托管的 local 主配置。
 *
 * 关键:一次 `createProfile` 会同时落地 local 主配置 + 一组增强项
 * (merge/script/rules/proxies/groups);只有 `type==='local'` 且 name 匹配的才是主配置。
 * 若误把增强项(如 merge,文件仅几十字节的模板)当成 current,核心读它当主配置会抛
 * 「failed to read current profile / YAML 读取错误」——这正是历史激活报错的根因。
 */
function isManagedLocal(item: IProfileItem): boolean {
  return item.type === 'local' && item.name === MANAGED_PROFILE_NAME
}

/**
 * 导入 / 更新 nextHubx 代理配置并切换为当前 profile。
 *
 * @param yaml clash YAML 文本(proxyConfig.content)
 * @param existingUid 已托管的 profile uid(来自本地存储),复用以更新而非新建
 * @returns 实际托管的 profile uid(首次导入时为新建的 uid)
 */
export async function importAndActivateProfile(
  yaml: string,
  existingUid?: string,
): Promise<string> {
  let targetUid = existingUid

  // 复用已有托管 profile:必须确认它仍是我们的 local 主配置才覆盖内容。
  // 历史 bug 可能把 merge/script 等增强项的 uid 误存为 profileUid → 此处校验丢弃,走下面新建自愈。
  if (targetUid) {
    const item = (await listProfileItems()).find((p) => p.uid === targetUid)
    if (item && isManagedLocal(item)) {
      await saveProfileFile(targetUid, yaml)
    } else {
      targetUid = undefined
    }
  }

  // 首次 / 托管 profile 已失效 → 新建,并按 type+name 锁定新建的 local 主配置。
  // 不能取「第一个新 uid」:createProfile 会同时产生多个新 item,取错(merge 项)会让 current 设错。
  if (!targetUid) {
    const before = new Set((await listProfileItems()).map((p) => p.uid))
    await createProfile(
      {
        type: 'local',
        name: MANAGED_PROFILE_NAME,
        desc: 'Managed by nextHubx',
        url: '',
        option: { with_proxy: false, self_proxy: false },
      },
      yaml,
    )
    const created = (await listProfileItems()).find(
      (p) => !before.has(p.uid) && isManagedLocal(p),
    )
    if (!created) {
      throw new Error('Failed to locate newly created nextHubx profile')
    }
    targetUid = created.uid
  }

  await patchProfilesConfig({ current: targetUid })
  await enhanceProfiles()
  // 切换/更新了代理配置(可能换了出口)→ 立即重测出口 IP,不等倒计时。
  void refetchIpInfoNow()
  return targetUid
}

/**
 * 导入临时引导 clash 配置并切换为当前 profile(激活前无梯子过 CF 验证 / 试 TUN 用)。
 *
 * 用独立命名的 local profile(不复用正式激活的托管 profile),避免覆盖用户真实账号配置;
 * 按 type+name find-or-create(重复签发只更新同一个引导 profile,不堆积)。不写 clientState,
 * 故 app 仍处「未激活」态——用户完成验证后再走正式激活流程。
 */
export async function importBootstrapProfile(yaml: string): Promise<string> {
  const items = await listProfileItems()
  const existing = items.find(
    (p) => p.type === 'local' && p.name === BOOTSTRAP_PROFILE_NAME,
  )
  let targetUid = existing?.uid

  if (targetUid) {
    await saveProfileFile(targetUid, yaml)
  } else {
    const before = new Set(items.map((p) => p.uid))
    await createProfile(
      {
        type: 'local',
        name: BOOTSTRAP_PROFILE_NAME,
        desc: '临时引导访问(约 1 小时有效)',
        url: '',
        option: { with_proxy: false, self_proxy: false },
      },
      yaml,
    )
    const created = (await listProfileItems()).find(
      (p) =>
        !before.has(p.uid) &&
        p.type === 'local' &&
        p.name === BOOTSTRAP_PROFILE_NAME,
    )
    if (!created) {
      throw new Error('Failed to locate newly created bootstrap profile')
    }
    targetUid = created.uid
  }

  await patchProfilesConfig({ current: targetUid })
  await enhanceProfiles()
  // 切换/更新了代理配置(可能换了出口)→ 立即重测出口 IP,不等倒计时。
  void refetchIpInfoNow()
  return targetUid
}
