import { MenuItem, Select, Typography } from '@mui/material'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'

import { DialogRef, Switch } from '@/components/base'
import { updateLastCheckTime } from '@/hooks/use-update'
import { useVerge } from '@/hooks/use-verge'
import { exportDiagnosticInfo, openLogsDir } from '@/services/cmds'
import { supportedLanguages } from '@/services/i18n'
import { showNotice } from '@/services/notice-service'
import { ensureDeviceId } from '@/services/nexthubx-api'
import { checkUpdateSafe as checkUpdate } from '@/services/update'
import { version } from '@root/package.json'

import { GuardState } from './mods/guard-state'
import { SettingItem, SettingList } from './mods/setting-comp'
import { ThemeModeSwitch } from './mods/theme-mode-switch'
import { ThemeViewer } from './mods/theme-viewer'
import { UpdateViewer } from './mods/update-viewer'

interface Props {
  onError?: (err: Error) => void
}

const languageOptions = supportedLanguages.map((code) => {
  const labels: { [key: string]: string } = {
    en: 'English',
    ru: 'Русский',
    zh: '中文',
    fa: 'فارسی',
    tt: 'Татар',
    id: 'Bahasa Indonesia',
    ar: 'العربية',
    ko: '한국어',
    tr: 'Türkçe',
    de: 'Deutsch',
    es: 'Español',
    jp: '日本語',
    zhtw: '繁體中文',
  }
  const label = labels[code] || code
  return { code, label }
})

/**
 * Basic Setting(最终 spec §3,原「Verge Basic Setting」改名为「Basic Setting」)。
 *
 * - 保留:Language、Theme Mode、Theme Settings。
 * - 新增(原属 Verge Advanced):Open Logs Dir、Check for Updates、Show in Menu Bar。
 */
const SettingVergeBasic = ({ onError }: Props) => {
  const { t } = useTranslation()

  const { verge, patchVerge, mutateVerge } = useVerge()
  const { theme_mode, language } = verge ?? {}
  const themeRef = useRef<DialogRef>(null)
  const updateRef = useRef<DialogRef>(null)

  const onChangeData = (patch: Partial<IVergeConfig>) => {
    mutateVerge({ ...verge, ...patch }, false)
  }

  const onSwitchFormat = (_e: any, value: boolean) => value

  const onCheckUpdate = async () => {
    try {
      const info = await checkUpdate()
      updateLastCheckTime()
      if (!info?.available) {
        showNotice.success(
          'settings.components.verge.advanced.notifications.latestVersion',
        )
      } else {
        updateRef.current?.open()
      }
    } catch (err: any) {
      showNotice.error(err)
    }
  }

  const onExportDiagnosticInfo = useCallback(async () => {
    await exportDiagnosticInfo()
    showNotice.success('shared.feedback.notifications.common.copySuccess', 1000)
  }, [])

  const [deviceId, setDeviceId] = useState('')
  useEffect(() => {
    ensureDeviceId()
      .then(setDeviceId)
      .catch(() => {})
  }, [])
  const onCopyDeviceId = useCallback(async () => {
    if (!deviceId) return
    await writeText(deviceId)
    showNotice.success('shared.feedback.notifications.common.copySuccess', 1000)
  }, [deviceId])

  return (
    <SettingList title={t('settings.components.verge.basic.title')}>
      <ThemeViewer ref={themeRef} />
      <UpdateViewer ref={updateRef} />

      <SettingItem label={t('settings.components.verge.basic.fields.language')}>
        <GuardState
          value={language ?? 'en'}
          onCatch={onError}
          onFormat={(e: any) => e.target.value}
          onChange={(e) => onChangeData({ language: e })}
          onGuard={(e) => patchVerge({ language: e })}
        >
          <Select size="small" sx={{ width: 110, '> div': { py: '7.5px' } }}>
            {languageOptions.map(({ code, label }) => (
              <MenuItem key={code} value={code}>
                {label}
              </MenuItem>
            ))}
          </Select>
        </GuardState>
      </SettingItem>

      <SettingItem
        label={t('settings.components.verge.basic.fields.themeMode')}
      >
        <GuardState
          value={theme_mode}
          onCatch={onError}
          onChange={(e) => onChangeData({ theme_mode: e })}
          onGuard={(e) => patchVerge({ theme_mode: e })}
        >
          <ThemeModeSwitch />
        </GuardState>
      </SettingItem>

      <SettingItem
        label={t('settings.components.verge.basic.fields.showInMenuBar')}
      >
        <GuardState
          value={(verge?.menu_icon ?? 'monochrome') !== 'disable'}
          valueProps="checked"
          onCatch={onError}
          onFormat={onSwitchFormat}
          onChange={(e) =>
            onChangeData({ menu_icon: e ? 'monochrome' : 'disable' })
          }
          onGuard={(e) =>
            patchVerge({ menu_icon: e ? 'monochrome' : 'disable' })
          }
        >
          <Switch edge="end" />
        </GuardState>
      </SettingItem>

      <SettingItem
        onClick={() => themeRef.current?.open()}
        label={t('settings.components.verge.basic.fields.themeSetting')}
      />

      <SettingItem
        onClick={openLogsDir}
        label={t('settings.components.verge.basic.fields.openLogsDir')}
      />

      <SettingItem
        onClick={onCheckUpdate}
        label={t('settings.components.verge.basic.fields.checkUpdates')}
      />

      <SettingItem
        onClick={onExportDiagnosticInfo}
        label={t('settings.components.verge.basic.fields.exportDiagnostics')}
      />

      <SettingItem label="设备 ID">
        <Typography
          onClick={onCopyDeviceId}
          title="点击复制"
          sx={{ py: '7px', pr: 1, fontFamily: 'monospace', fontSize: 12, cursor: 'pointer' }}
        >
          {deviceId}
        </Typography>
      </SettingItem>

      <SettingItem label={t('settings.components.verge.basic.fields.version')}>
        <Typography sx={{ py: '7px', pr: 1 }}>v{version}</Typography>
      </SettingItem>
    </SettingList>
  )
}

export default SettingVergeBasic
