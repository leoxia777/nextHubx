import {
  PowerSettingsNewRounded,
  ShieldRounded,
  WarningAmberRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BasePage } from '@/components/base'
import { useServiceInstaller } from '@/hooks/use-service-installer'
import { useSystemProxyState } from '@/hooks/use-system-proxy-state'
import { useSystemState } from '@/hooks/use-system-state'
import { useVerge } from '@/hooks/use-verge'
import { showNotice } from '@/services/notice-service'

/**
 * 连接页(M2)。
 *
 * 体验(§3.5):
 * - 首次进入即检测 Service 是否就绪(`isServiceOk` / `isTunModeAvailable`);未就绪先引导授权装 Service。
 * - 一键连接 = 开 TUN(全局接管)。底层 Service/TUN/提权沿用上游,这里只包引导 UX。
 * - 用户拒绝授权 / Service 不可用 → 降级系统代理模式 + 明确提示。
 */
const NexthubxConnectPage = () => {
  const { t } = useTranslation()
  const { verge, mutateVerge, patchVerge } = useVerge()
  const { installServiceAndRestartCore } = useServiceInstaller()
  const { isServiceOk, isTunModeAvailable, isLoading, mutateSystemState } =
    useSystemState()
  const { indicator: systemProxyOn, toggleSystemProxy } = useSystemProxyState()

  const [installing, setInstalling] = useState(false)
  const [fallbackMode, setFallbackMode] = useState(false)

  const tunOn = verge?.enable_tun_mode ?? false
  const connected = tunOn || (fallbackMode && systemProxyOn)

  const enableTun = async (value: boolean) => {
    mutateVerge({ ...verge, enable_tun_mode: value }, false)
    await patchVerge({ enable_tun_mode: value })
  }

  // 引导安装 Service(首次启动 / 连接前)
  const onInstallService = useLockFn(async () => {
    setInstalling(true)
    try {
      await installServiceAndRestartCore()
      await mutateSystemState()
    } catch (err) {
      // 用户拒绝授权 / 安装失败 → 降级系统代理
      console.error('[nexthubx] install service failed', err)
      setFallbackMode(true)
    } finally {
      setInstalling(false)
    }
  })

  // 一键连接
  const onConnect = useLockFn(async () => {
    try {
      if (isTunModeAvailable) {
        await enableTun(true)
        setFallbackMode(false)
      } else {
        // 服务不可用 → 降级系统代理
        setFallbackMode(true)
        await toggleSystemProxy(true)
        showNotice.info('nexthubx.connect.fallback.title')
      }
    } catch (err) {
      console.error('[nexthubx] connect failed', err)
      showNotice.error('nexthubx.connect.feedback.connectFailed')
    }
  })

  const onDisconnect = useLockFn(async () => {
    try {
      if (tunOn) await enableTun(false)
      if (fallbackMode && systemProxyOn) await toggleSystemProxy(false)
    } catch (err) {
      console.error('[nexthubx] disconnect failed', err)
    }
  })

  // Service 未就绪且非降级模式 → 优先展示安装引导
  const needServiceGuide = !isLoading && !isServiceOk && !fallbackMode

  return (
    <BasePage title={t('nexthubx.connect.title')}>
      <Box
        sx={{
          maxWidth: 520,
          mx: 'auto',
          mt: 4,
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
        }}
      >
        {needServiceGuide ? (
          <Paper variant="outlined" sx={{ p: 3 }}>
            <Stack spacing={2} sx={{ alignItems: 'flex-start' }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <ShieldRounded color="primary" />
                <Typography variant="h6">
                  {t('nexthubx.connect.service.guideTitle')}
                </Typography>
              </Box>
              <Typography variant="body2" color="text.secondary">
                {t('nexthubx.connect.service.guideBody')}
              </Typography>
              <Stack direction="row" spacing={1} sx={{ width: '100%' }}>
                <Button
                  variant="contained"
                  onClick={() => void onInstallService()}
                  disabled={installing}
                  startIcon={
                    installing ? (
                      <CircularProgress size={16} color="inherit" />
                    ) : (
                      <ShieldRounded />
                    )
                  }
                >
                  {installing
                    ? t('nexthubx.connect.service.installing')
                    : t('nexthubx.connect.service.install')}
                </Button>
                <Button
                  variant="text"
                  color="inherit"
                  onClick={() => setFallbackMode(true)}
                  disabled={installing}
                >
                  {t('nexthubx.connect.service.skip')}
                </Button>
              </Stack>
            </Stack>
          </Paper>
        ) : (
          <Paper
            variant="outlined"
            sx={{
              p: 4,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 2,
            }}
          >
            <Chip
              label={
                connected
                  ? t('nexthubx.connect.status.connected')
                  : t('nexthubx.connect.status.disconnected')
              }
              color={connected ? 'success' : 'default'}
              variant={connected ? 'filled' : 'outlined'}
            />

            <Button
              variant="contained"
              size="large"
              color={connected ? 'error' : 'primary'}
              startIcon={<PowerSettingsNewRounded />}
              onClick={() =>
                connected ? void onDisconnect() : void onConnect()
              }
              sx={{ minWidth: 220, py: 1.5 }}
            >
              {connected
                ? t('nexthubx.connect.disconnectButton')
                : t('nexthubx.connect.connectButton')}
            </Button>

            <Typography variant="caption" color="text.secondary">
              {fallbackMode
                ? t('nexthubx.connect.systemProxyMode')
                : t('nexthubx.connect.tunMode')}
            </Typography>
          </Paper>
        )}

        {fallbackMode && (
          <Alert severity="warning" icon={<WarningAmberRounded />}>
            <Typography variant="subtitle2">
              {t('nexthubx.connect.fallback.title')}
            </Typography>
            <Typography variant="body2">
              {t('nexthubx.connect.fallback.body')}
            </Typography>
          </Alert>
        )}
      </Box>
    </BasePage>
  )
}

export default NexthubxConnectPage
