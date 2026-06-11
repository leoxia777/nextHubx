import { WarningAmberRounded } from '@mui/icons-material'
import {
  Backdrop,
  Box,
  Paper,
  Stack,
  Typography,
} from '@mui/material'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { useIpInfoQuery } from '@/hooks/use-ip-info'
import { useNexthubxExitGuard } from '@/hooks/use-nexthubx-exit-guard'
import { useNexthubxClient } from '@/hooks/use-nexthubx-sync'

/**
 * 全局出口 IP 不一致警示(最终 spec §3)。
 *
 * 挂载于 _layout 顶层,与 IP Info 卡片共用同一 IP 查询缓存。职责:
 * - 持续监测(主动轮询,不依赖卡片是否在视口),命中 mismatch → **全窗口醒目遮罩**盖住主内容;
 * - 后台 / 最小化下的系统通知 + 唤起主窗口由 `useNexthubxExitGuard` 负责。
 *
 * 防误报 5 条件全部在 `useNexthubxExitGuard` 内实现,这里仅消费其 status。
 */
/** 后台监测轮询间隔(ms):比卡片倒计时更短,保证最小化时也能尽快发现。 */
const GUARD_POLL_MS = 60_000

export const ExitMismatchGuard = () => {
  const { t } = useTranslation()
  const { isActivated } = useNexthubxClient()
  const { data: ipInfo, refetch } = useIpInfoQuery()

  const { status, expectedExitIp, actualIp, setupInProgress } =
    useNexthubxExitGuard({
      actualIp: ipInfo?.ip,
    })

  // 主动轮询:即使 IP 卡片未挂载 / 不在视口,也持续刷新实际 IP 以便后台检测。
  useEffect(() => {
    if (!isActivated) return
    const timer = setInterval(() => {
      void refetch()
    }, GUARD_POLL_MS)
    return () => clearInterval(timer)
  }, [isActivated, refetch])

  // 初始验证(激活后 TUN 切换)期间的 mismatch 大概率是瞬态(IP 检测尚未走新出口),
  // 不弹全屏警示——账号卡片/IP 卡片此时呈现「校验中」(UX:不吓用户)。
  if (status !== 'mismatch' || setupInProgress) return null

  return (
    <Backdrop
      open
      sx={{
        zIndex: (theme) => theme.zIndex.modal + 10,
        bgcolor: 'rgba(0,0,0,0.72)',
        p: 2,
      }}
    >
      <Paper
        elevation={6}
        sx={{
          maxWidth: 440,
          width: '100%',
          p: 3,
          borderTop: 4,
          borderColor: 'error.main',
        }}
      >
        <Stack spacing={2}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <WarningAmberRounded color="error" sx={{ fontSize: 32 }} />
            <Typography variant="h6" color="error">
              {t('nexthubx.exitGuard.title')}
            </Typography>
          </Box>
          <Typography variant="body2" color="text.secondary">
            {t('nexthubx.exitGuard.body', {
              actual: actualIp ?? '',
              expected: expectedExitIp ?? '',
            })}
          </Typography>
        </Stack>
      </Paper>
    </Backdrop>
  )
}
