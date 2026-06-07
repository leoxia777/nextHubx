import {
  ContentCopyRounded,
  RefreshRounded,
  VisibilityOffRounded,
  VisibilityRounded,
} from '@mui/icons-material'
import {
  Box,
  Button,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
} from '@mui/material'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { useLockFn } from 'ahooks'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'

import { BaseEmpty, BasePage } from '@/components/base'
import { useNexthubxClient } from '@/hooks/use-nexthubx-sync'
import { showNotice } from '@/services/notice-service'

/**
 * 账号信息页(M2):显示激活/同步下发的 identityEmail + identityPassword(可复制)。
 * 提供「重新激活」入口(跳激活页)。
 */
const NexthubxAccountPage = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { clientState, isActivated } = useNexthubxClient()
  const [showPassword, setShowPassword] = useState(false)

  const copy = useLockFn(async (value: string) => {
    try {
      await writeText(value)
      showNotice.success('nexthubx.account.copied')
    } catch (err) {
      console.error('[nexthubx] copy failed', err)
    }
  })

  if (!isActivated || !clientState) {
    return (
      <BasePage title={t('nexthubx.account.title')}>
        <Box sx={{ mt: 6 }}>
          <BaseEmpty text={t('nexthubx.account.empty')} />
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
            <Button
              variant="contained"
              onClick={() => navigate('/nexthubx/activate')}
            >
              {t('nexthubx.account.reactivate')}
            </Button>
          </Box>
        </Box>
      </BasePage>
    )
  }

  return (
    <BasePage title={t('nexthubx.account.title')}>
      <Box sx={{ maxWidth: 480, mx: 'auto', mt: 4 }}>
        <Stack spacing={2.5}>
          <TextField
            fullWidth
            label={t('nexthubx.account.email')}
            value={clientState.identityEmail}
            slotProps={{
              input: {
                readOnly: true,
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      edge="end"
                      onClick={() => void copy(clientState.identityEmail)}
                      title={t('nexthubx.account.copy')}
                    >
                      <ContentCopyRounded fontSize="small" />
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
          />

          <TextField
            fullWidth
            label={t('nexthubx.account.password')}
            type={showPassword ? 'text' : 'password'}
            value={clientState.identityPassword}
            slotProps={{
              input: {
                readOnly: true,
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      onClick={() => setShowPassword((v) => !v)}
                      title={t(
                        showPassword
                          ? 'nexthubx.account.hidePassword'
                          : 'nexthubx.account.showPassword',
                      )}
                    >
                      {showPassword ? (
                        <VisibilityOffRounded fontSize="small" />
                      ) : (
                        <VisibilityRounded fontSize="small" />
                      )}
                    </IconButton>
                    <IconButton
                      edge="end"
                      onClick={() => void copy(clientState.identityPassword)}
                      title={t('nexthubx.account.copy')}
                    >
                      <ContentCopyRounded fontSize="small" />
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
          />

          <Button
            variant="outlined"
            startIcon={<RefreshRounded />}
            onClick={() => navigate('/nexthubx/activate')}
          >
            {t('nexthubx.account.reactivate')}
          </Button>
        </Stack>
      </Box>
    </BasePage>
  )
}

export default NexthubxAccountPage
