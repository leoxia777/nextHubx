import { HelpOutlineRounded, NetworkCheckRounded } from '@mui/icons-material'
import { Box, Grid, IconButton, Skeleton, Tooltip } from '@mui/material'
import { useLockFn } from 'ahooks'
import { Suspense, lazy, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BasePage } from '@/components/base'
import { AccountCard } from '@/components/home/account-card'
import { DiagnosticsModal } from '@/components/home/diagnostics-modal'
import { TunHealthCard } from '@/components/home/tun-health-card'
import { openWebUrl } from '@/services/cmds'

const LazyIpInfoCard = lazy(() =>
  import('@/components/home/ip-info-card').then((module) => ({
    default: module.IpInfoCard,
  })),
)

/**
 * Home(最终 spec §2):仅保留两张卡片——
 *   ① Account(激活 / identity 展示,见 account-card.tsx)
 *   ② IP Information(CVR 原生)
 *
 * 已移除:Website Tests / Profiles / Proxies / Proxy mode 卡片,以及系统代理 / TUN 开关卡
 *(proxy-tun-card)——连接控制不出现在 Home;首页设置弹窗一并移除。
 */
const HomePage = () => {
  const { t } = useTranslation()
  const [diagOpen, setDiagOpen] = useState(false)

  const toGithubDoc = useLockFn(() => {
    return openWebUrl('https://clash-verge-rev.github.io/index.html')
  })

  return (
    <BasePage
      title={t('home.page.title')}
      contentStyle={{ padding: 2 }}
      header={
        <Box sx={{ display: 'flex', alignItems: 'center' }}>
          <Tooltip title={t('home.components.diagnostics.title')} arrow>
            <IconButton
              onClick={() => setDiagOpen(true)}
              size="small"
              color="inherit"
            >
              <NetworkCheckRounded />
            </IconButton>
          </Tooltip>
          <Tooltip title={t('home.page.tooltips.manual')} arrow>
            <IconButton onClick={toGithubDoc} size="small" color="inherit">
              <HelpOutlineRounded />
            </IconButton>
          </Tooltip>
        </Box>
      }
    >
      <Grid container spacing={1.5} columns={{ xs: 6, sm: 6, md: 12 }}>
        <Grid size={12}>
          <TunHealthCard />
        </Grid>
        <Grid size={6}>
          <AccountCard />
        </Grid>
        <Grid size={6}>
          <Suspense fallback={<Skeleton variant="rectangular" height={200} />}>
            <LazyIpInfoCard />
          </Suspense>
        </Grid>
      </Grid>
      <DiagnosticsModal open={diagOpen} onClose={() => setDiagOpen(false)} />
    </BasePage>
  )
}

export default HomePage
