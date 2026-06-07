/**
 * nextHubx 代理配置导入(M2)。
 *
 * 把后端下发的 Clash YAML 落地为本地 profile 并切换为当前配置,复用 CVR 现成链路
 * (`createProfile` / `saveProfileFile` / `patchProfilesConfig` / `enhanceProfiles`,见 `services/cmds.ts`)。
 *
 * 为避免每次同步都新建 profile 堆积:维护一个 nextHubx 托管 profile 的 uid——
 * 已存在则用 `saveProfileFile` 覆盖更新,不存在则 `createProfile` 后回查新 uid。
 */
import {
  createProfile,
  enhanceProfiles,
  getProfiles,
  patchProfilesConfig,
  saveProfileFile,
} from '@/services/cmds'

const MANAGED_PROFILE_NAME = 'nextHubx'

async function findExistingUids(): Promise<Set<string>> {
  const profiles = await getProfiles()
  return new Set((profiles.items ?? []).map((item) => item.uid))
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

  // 复用已有托管 profile:确认仍存在 → 覆盖文件内容
  if (targetUid) {
    const uids = await findExistingUids()
    if (uids.has(targetUid)) {
      await saveProfileFile(targetUid, yaml)
    } else {
      targetUid = undefined
    }
  }

  // 首次 / 托管 profile 已被删除 → 新建并回查新 uid
  if (!targetUid) {
    const before = await findExistingUids()
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
    const after = await getProfiles()
    const created = (after.items ?? []).find(
      (item) => !before.has(item.uid),
    )
    if (!created) {
      throw new Error('Failed to locate newly created nextHubx profile')
    }
    targetUid = created.uid
  }

  await patchProfilesConfig({ current: targetUid })
  await enhanceProfiles()
  return targetUid
}
