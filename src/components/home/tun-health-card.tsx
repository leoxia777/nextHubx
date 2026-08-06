import {
  GppBadOutlined,
  GppGoodOutlined,
  GppMaybeOutlined,
  ShieldOutlined,
} from '@mui/icons-material'
import { Box, Button, Typography } from '@mui/material'
import { useQuery } from '@tanstack/react-query'
import { useLockFn } from 'ahooks'
import { memo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { useServiceInstaller } from '@/hooks/use-service-installer'
import { getTunRuntimeStatus } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'

import { EnhancedCard } from './enhanced-card'

// 诚实展示 TUN「真实运行态」(后端 get_tun_runtime_status:adapterUp 是 OS 实测网卡,
// 不是 flag)。专治"托盘 ✓ 却没真跑、用户以为受保护其实裸奔"。第一批:只显示 + 未就绪可装服务,
// 不改激活行为(激活后真关了再手动开属第二批)。
type TunState = 'running' | 'notReady' | 'leak' | 'off'

const STATUS_POLL_MS = 5_000

type IconColor = 'success' | 'warning' | 'error' | 'info'

const STATE_META: Record<TunState, { icon: ReactNode; color: IconColor }> = {
  running: { icon: <GppGoodOutlined />, color: 'success' },
  notReady: { icon: <GppMaybeOutlined />, color: 'warning' },
  leak: { icon: <GppBadOutlined />, color: 'error' },
  off: { icon: <ShieldOutlined />, color: 'info' },
}

export const TunHealthCard = memo(() => {
  const { t } = useTranslation()
  const { installServiceAndRestartCore } = useServiceInstaller()
  const [installing, setInstalling] = useState(false)

  const { data, refetch } = useQuery({
    queryKey: ['tunRuntimeStatus'],
    queryFn: getTunRuntimeStatus,
    refetchInterval: STATUS_POLL_MS,
  })

  // running 优先;否则按"能不能跑 / 想不想开"分流。data 未到先按 off(中性)。
  const state: TunState = !data
    ? 'off'
    : data.running
      ? 'running'
      : !data.availableCanRun
        ? 'notReady'
        : data.enabledFlag
          ? 'leak'
          : 'off'

  const { icon, color } = STATE_META[state]

  const onInstall = useLockFn(async () => {
    setInstalling(true)
    try {
      await installServiceAndRestartCore()
      await refetch()
    } catch (err) {
      showNotice.error(err)
    } finally {
      setInstalling(false)
    }
  })

  return (
    <EnhancedCard
      title={t('home.components.tunHealth.title')}
      icon={icon}
      iconColor={color}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <Typography
          variant="body1"
          color={`${color}.main`}
          sx={{ fontWeight: 600 }}
        >
          {t(`home.components.tunHealth.status.${state}`)}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t(`home.components.tunHealth.desc.${state}`)}
        </Typography>
        {state === 'notReady' && (
          <Box sx={{ mt: 1 }}>
            <Button
              variant="contained"
              size="small"
              color="warning"
              disabled={installing}
              onClick={onInstall}
            >
              {installing
                ? t('home.components.tunHealth.action.installing')
                : t('home.components.tunHealth.action.installService')}
            </Button>
          </Box>
        )}
      </Box>
    </EnhancedCard>
  )
})

TunHealthCard.displayName = 'TunHealthCard'
