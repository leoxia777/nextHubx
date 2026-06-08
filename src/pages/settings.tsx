import { Box, Grid } from '@mui/material'
import { useTranslation } from 'react-i18next'

import { BasePage } from '@/components/base'
import SettingSystem from '@/components/setting/setting-system'
import SettingVergeBasic from '@/components/setting/setting-verge-basic'
import { showNotice } from '@/services/notice-service'
import { useThemeMode } from '@/services/states'

/**
 * Settings(最终 spec §3)。
 *
 * - 移除右上角三个按钮(导入/导出/外链)。
 * - 仅保留 System Setting + Basic Setting 两组(Clash Setting / Verge Advanced 整组移除,
 *   其项已并入 System / Basic)。
 */
const SettingPage = () => {
  const { t } = useTranslation()

  const onError = (err: any) => {
    showNotice.error(err)
  }

  const mode = useThemeMode()
  const isDark = mode === 'light' ? false : true

  return (
    <BasePage title={t('settings.page.title')}>
      <Grid container spacing={1.5} columns={{ xs: 6, sm: 6, md: 12 }}>
        <Grid size={6}>
          <Box
            sx={{
              borderRadius: 2,
              backgroundColor: isDark ? '#282a36' : '#ffffff',
            }}
          >
            <SettingSystem onError={onError} />
          </Box>
        </Grid>
        <Grid size={6}>
          <Box
            sx={{
              borderRadius: 2,
              backgroundColor: isDark ? '#282a36' : '#ffffff',
            }}
          >
            <SettingVergeBasic onError={onError} />
          </Box>
        </Grid>
      </Grid>
    </BasePage>
  )
}

export default SettingPage
