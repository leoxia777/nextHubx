import { Switch as MuiSwitch } from '@mui/material'
import { invoke } from '@tauri-apps/api/core'
import React, { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { Switch, TooltipIcon } from '@/components/base'
import { useClash } from '@/hooks/use-clash'
import { useVerge } from '@/hooks/use-verge'

import { GuardState } from './mods/guard-state'
import { SettingList, SettingItem } from './mods/setting-comp'

interface Props {
  onError?: (err: Error) => void
}

/**
 * System Setting(最终 spec §3)。
 *
 * - 移除 System Proxy、Silent Start。
 * - TUN mode / Auto Launch / DNS Override / Unified Delay 四项**锁定为「开且不可关」**:
 *   渲染成 checked + disabled 的只读开关 + tooltip 说明原因;挂载时强制把底层值置为开。
 * - 新增 Allow LAN(正常切换,默认关;底层为 clash `allow-lan`)。
 */
const SettingSystem = ({ onError }: Props) => {
  const { t } = useTranslation()

  const { verge, patchVerge } = useVerge()
  const { clash, mutateClash, patchClash } = useClash()

  const { 'allow-lan': allowLan } = clash ?? {}

  const enforcedRef = useRef(false)
  const lockedTooltip = t('settings.sections.system.tooltips.locked')

  // 挂载时强制把锁定项置为开(保持 DB / 运行态一致,UI 同时只读展示为开)。
  // 注:**TUN(enable_tun_mode)不在此强制** —— 它的开关已收归后端单一权威 reconcile
  // (core::tun_guard:已激活 && 可用 才开)。早前这里 force-on TUN 会与 reconcile 双写打架:
  // 切到设置页强开 → 切回首页 🟢 → reconcile(未激活)~30s 关 → ⚪ 抖动。故移除 TUN 这条。
  useEffect(() => {
    if (enforcedRef.current) return
    if (!verge || !clash) return
    enforcedRef.current = true

    void (async () => {
      try {
        if (verge.enable_auto_launch !== true) {
          await patchVerge({ enable_auto_launch: true })
        }
        if (clash['unified-delay'] !== true) {
          await patchClash({ 'unified-delay': true })
        }
        if (verge.enable_dns_settings !== true) {
          await patchVerge({ enable_dns_settings: true })
          await invoke('apply_dns_config', { apply: true })
        }
      } catch (err) {
        console.error('[nexthubx] enforce locked system settings failed', err)
      }
    })()
  }, [verge, clash, patchVerge, patchClash])

  const onSwitchFormat = (
    _e: React.ChangeEvent<HTMLInputElement>,
    value: boolean,
  ) => value

  // 锁定项(auto-launch / dns / unified-delay):只读、强制 checked、disabled。
  const lockedSwitch = <MuiSwitch edge="end" checked disabled />
  // TUN 开关:只读(由后端 reconcile 按激活态驱动),但**反映真实值**(未激活=关),不硬编码开。
  const tunSwitch = (
    <MuiSwitch edge="end" checked={verge?.enable_tun_mode === true} disabled />
  )

  return (
    <SettingList title={t('settings.sections.system.title')}>
      <SettingItem
        label={t('settings.sections.system.toggles.tunMode')}
        extra={<TooltipIcon title={lockedTooltip} sx={{ opacity: '0.7' }} />}
      >
        {tunSwitch}
      </SettingItem>

      <SettingItem
        label={t('settings.sections.system.fields.autoLaunch')}
        extra={<TooltipIcon title={lockedTooltip} sx={{ opacity: '0.7' }} />}
      >
        {lockedSwitch}
      </SettingItem>

      <SettingItem
        label={t('settings.sections.system.fields.dnsOverride')}
        extra={<TooltipIcon title={lockedTooltip} sx={{ opacity: '0.7' }} />}
      >
        {lockedSwitch}
      </SettingItem>

      <SettingItem
        label={t('settings.sections.system.fields.unifiedDelay')}
        extra={<TooltipIcon title={lockedTooltip} sx={{ opacity: '0.7' }} />}
      >
        {lockedSwitch}
      </SettingItem>

      <SettingItem label={t('settings.sections.system.fields.allowLan')}>
        <GuardState
          value={allowLan ?? false}
          valueProps="checked"
          onCatch={onError}
          onFormat={onSwitchFormat}
          onChange={(e) =>
            mutateClash((old) => ({ ...old!, 'allow-lan': e }), false)
          }
          onGuard={(e) => patchClash({ 'allow-lan': e })}
        >
          <Switch edge="end" />
        </GuardState>
      </SettingItem>
    </SettingList>
  )
}

export default SettingSystem
