import {
  CheckCircleOutlined,
  LocationOnOutlined,
  RefreshOutlined,
  VisibilityOffOutlined,
  VisibilityOutlined,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Skeleton,
  Typography,
} from '@mui/material'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useEffect } from 'foxact/use-abortable-effect'
import { useIntersection } from 'foxact/use-intersection'
import type { XOR } from 'foxts/ts-xor'
import {
  forwardRef,
  memo,
  useCallback,
  useEffectEvent,
  useMemo,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

import { useClashVergeGate } from '@/hooks/use-clash-verge-gate'
import { useIpInfoQuery } from '@/hooks/use-ip-info'
import { useNexthubxExitGuard } from '@/hooks/use-nexthubx-exit-guard'
import { requestImmediateNexthubxSync } from '@/hooks/use-nexthubx-sync'

import { EnhancedCard } from './enhanced-card'

// 定义刷新时间（秒）
const IP_REFRESH_SECONDS = 300
const COUNTDOWN_TICK_INTERVAL = 1_000

const InfoItem = memo(({ label, value }: { label: string; value?: string }) => (
  <Box sx={{ mb: 0.7, display: 'flex', alignItems: 'flex-start' }}>
    <Typography
      variant="body2"
      color="text.secondary"
      sx={{ minwidth: 60, mr: 0.5, flexShrink: 0, textAlign: 'right' }}
    >
      {label}:
    </Typography>
    <Typography
      variant="body2"
      sx={{
        ml: 0.5,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        wordBreak: 'break-word',
        whiteSpace: 'normal',
        flexGrow: 1,
      }}
    >
      {value || 'Unknown'}
    </Typography>
  </Box>
))

type CountDownState = XOR<
  {
    type: 'countdown'
    remainingSeconds: number
  },
  {
    type: 'revalidating'
  }
>

const IPInfoCardContainer = forwardRef<
  HTMLElement,
  React.PropsWithChildren<{ onRefresh: () => void }>
>(({ children, onRefresh }, ref) => {
  const { t } = useTranslation()

  return (
    <EnhancedCard
      title={t('home.components.ipInfo.title')}
      icon={<LocationOnOutlined />}
      iconColor="info"
      ref={ref}
      action={
        <IconButton size="small" onClick={onRefresh}>
          <RefreshOutlined />
        </IconButton>
      }
    >
      {children}
    </EnhancedCard>
  )
})

// IP信息卡片组件
export const IpInfoCard = () => {
  const { t } = useTranslation()
  const [showIp, setShowIp] = useState(false)
  const appWindow = useMemo(() => getCurrentWebviewWindow(), [])

  // track ip info card has been in viewport or not
  // hasIntersected default to false, and will be true once the card is in viewport
  // and will never be false again afterwards (unless resetIntersected is called or
  // the component is unmounted)
  const [containerRef, hasIntersected, _resetIntersected] = useIntersection({
    rootMargin: '0px',
  })

  const [countdown, setCountdown] = useState<CountDownState>({
    type: 'countdown',
    remainingSeconds: IP_REFRESH_SECONDS,
  })

  // CV 冲突时停查 IP(避免在 CV 抢网时去查/卡住转圈);关停后自动恢复。与账号卡共用同一检测。
  const { cvBlock } = useClashVergeGate()
  const {
    data: ipInfo,
    error,
    isLoading,
    refetch: mutate,
  } = useIpInfoQuery({ enabled: !cvBlock })

  // 出口 IP 自动比对(无需用户确认),走共享守卫(防误报 5 条件 + 后台通知):
  // - 一致 → 绿色「出口匹配」标;
  // - 不一致 → 红色内联警示(不再全屏遮罩;后台被动通知由 ExitMismatchGuard 监测)。
  const {
    status: exitMatch,
    expectedExitIp,
    actualIp,
    setupInProgress,
  } = useNexthubxExitGuard({ actualIp: ipInfo?.ip })

  // IP 检测失败 → 很可能代理已被切断(含设备/订阅被重置导致)。立即请求一次直连同步,
  // 尽早拿到 401/revoked 感知重置并提示重激活,而非让用户干瞪「IP 检测失败」等下次心跳。
  // (去抖在 requestImmediateNexthubxSync 内;runSync 仅对确定的 401/revoked 动作,网络错误是 no-op,
  //  故对真·网络故障无副作用。)
  useEffect(() => {
    if (error) requestImmediateNexthubxSync()
  }, [error])

  // function useEffectEvent
  const onCountdownTick = useEffectEvent(async () => {
    const now = Date.now()
    const ts = ipInfo?.lastFetchTs
    if (!ts) {
      return
    }

    const elapsed = Math.floor((now - ts) / 1000)
    const remaining = IP_REFRESH_SECONDS - elapsed

    if (remaining <= 0) {
      if (
        // has intersected at least once
        // this avoids unncessary revalidation if user never scrolls down,
        // then we will only load initially once.
        hasIntersected &&
        // is online
        navigator.onLine &&
        // there is no ongoing revalidation already scheduled
        countdown.type !== 'revalidating' &&
        // window is visible
        (await appWindow.isVisible())
      ) {
        setCountdown({ type: 'revalidating' })
        // we do not care about the result of mutate here. after mutate is done,
        // simply wait for next interval tick with `setCountdown({ type: "countdown", ... })`
        try {
          await mutate()
        } finally {
          // in case mutate throws error, we still need to reset the countdown state
          setCountdown({
            type: 'countdown',
            remainingSeconds: IP_REFRESH_SECONDS,
          })
        }
      } else {
        // do nothing. we even skip "setCountdown" to reduce re-renders
        //
        // but the remaining time still <= 0, and setInterval is not stopped, this
        // callback will still be regularly triggered, as soon as the window is visible
        // or network online again, we mutate() immediately in the following tick.
      }
    } else {
      setCountdown({
        type: 'countdown',
        remainingSeconds: remaining,
      })
    }
  })

  // Countdown / refresh scheduler — updates UI every 1s and triggers immediate revalidation when expired
  useEffect(() => {
    let timer: number | null = null

    // Do not add document.hidden check here as it is not reliable in Tauri.
    //
    // Thank god IntersectionObserver is a DOM API that relies on DOM/webview
    // instead of Tauri, which is reliable enough.
    if (hasIntersected) {
      console.debug(
        'IP info card has entered the viewport, starting the countdown interval.',
      )
      timer = window.setInterval(onCountdownTick, COUNTDOWN_TICK_INTERVAL)
    } else {
      console.debug(
        'IP info card has not yet entered the viewport, no counting down.',
      )
    }

    // This will fire when the window is minimized or restored
    document.addEventListener('visibilitychange', onVisibilityChange)
    // Tauri's visibility change detection is actually broken on some platforms:
    // https://github.com/tauri-apps/tauri/issues/10592
    //
    // It is working on macOS though (tested).
    // So at least we should try to pause countdown on supported platforms to
    // reduce power consumption.
    function onVisibilityChange() {
      if (document.hidden) {
        console.debug('Document hidden, pause the interval')
        // Pause the timer
        if (timer != null) {
          clearInterval(timer)
          timer = null
        }
      } else if (hasIntersected) {
        console.debug('Document visible, resume the interval')
        // Resume the timer only when previous one is cleared
        if (timer == null) {
          timer = window.setInterval(onCountdownTick, COUNTDOWN_TICK_INTERVAL)
        }
      } else {
        console.debug(
          'Document visible, but IP info card has never entered the viewport, not even once, not starting the interval.',
        )
      }
    }

    return () => {
      if (timer != null) clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [hasIntersected])

  const toggleShowIp = useCallback(() => {
    setShowIp((prev) => !prev)
  }, [])

  // 手动刷新:强制重新请求(react-query refetch 绕过 staleTime: Infinity / dedupe),
  // 并立即把倒计时重置回 IP_REFRESH_SECONDS,不等下一个 tick。
  // 成功后 getIpInfo 写入新的 lastFetchTs,后续 tick 会基于新时间戳继续递减。
  const handleRefresh = useCallback(() => {
    setCountdown({ type: 'revalidating' })
    void mutate({ cancelRefetch: true }).finally(() => {
      setCountdown({
        type: 'countdown',
        remainingSeconds: IP_REFRESH_SECONDS,
      })
    })
  }, [mutate])

  let mainElement: React.ReactElement

  switch (true) {
    case !!cvBlock:
      // CV 冲突中:不查 IP,提示去账号卡「一键关停」(关停后 cvBlock 清空,IP 查询自动恢复)。
      mainElement = (
        <Alert
          severity="warning"
          variant="outlined"
          sx={{ fontSize: '0.8rem', alignItems: 'center' }}
        >
          {t('nexthubx.clashVergeConflict.title')}
        </Alert>
      )
      break
    case isLoading:
      mainElement = (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Skeleton variant="text" width="60%" height={30} />
          <Skeleton variant="text" width="80%" height={24} />
          <Skeleton variant="text" width="70%" height={24} />
          <Skeleton variant="text" width="50%" height={24} />
        </Box>
      )
      break
    case !!error:
      mainElement = (
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'error.main',
          }}
        >
          <Typography variant="body1" color="error">
            {error instanceof Error
              ? error.message
              : t('home.components.ipInfo.errors.load')}
          </Typography>
          <Button onClick={handleRefresh} sx={{ mt: 2 }}>
            {t('shared.actions.retry')}
          </Button>
        </Box>
      )
      break
    default: // Normal render — 仅展示 IP 地址 + ASN 两项
      mainElement = (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ flex: 1, overflow: 'hidden' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ flexShrink: 0 }}
              >
                {t('home.components.ipInfo.labels.ip')}:
              </Typography>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  ml: 1,
                  overflow: 'hidden',
                  maxWidth: 'calc(100% - 30px)',
                }}
              >
                <Typography
                  variant="body2"
                  sx={{
                    fontFamily: 'monospace',
                    fontSize: '0.75rem',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    wordBreak: 'break-all',
                  }}
                >
                  {showIp ? ipInfo?.ip : '••••••••••'}
                </Typography>
                <IconButton size="small" onClick={toggleShowIp}>
                  {showIp ? (
                    <VisibilityOffOutlined fontSize="small" />
                  ) : (
                    <VisibilityOutlined fontSize="small" />
                  )}
                </IconButton>
              </Box>
            </Box>

            <InfoItem
              label={t('home.components.ipInfo.labels.asn')}
              value={ipInfo?.asn ? `AS${ipInfo.asn}` : 'N/A'}
            />

            {/* 初始验证(激活后 TUN 切换)期间且尚未匹配:显示持续「校验中」加载态,
                不显示红色不一致(TUN 切换中 IP 短暂为旧出口属预期,十几秒内收敛)。 */}
            {setupInProgress && exitMatch !== 'match' && (
              <Chip
                size="small"
                color="info"
                variant="outlined"
                icon={<CircularProgress size={12} color="inherit" />}
                label={t('home.components.ipInfo.exitCheck.checking')}
                sx={{ mt: 0.5 }}
              />
            )}

            {exitMatch === 'match' && (
              <Chip
                size="small"
                color="success"
                variant="outlined"
                icon={<CheckCircleOutlined fontSize="small" />}
                label={t('home.components.ipInfo.exitCheck.match')}
                sx={{ mt: 0.5 }}
              />
            )}

            {!setupInProgress && exitMatch === 'mismatch' && (
              <Alert
                severity="error"
                variant="outlined"
                sx={{ mt: 1, py: 0, fontSize: '0.75rem', alignItems: 'center' }}
              >
                {t('home.components.ipInfo.exitCheck.mismatch', {
                  actual: actualIp,
                  expected: expectedExitIp,
                })}
              </Alert>
            )}
          </Box>

          <Box
            sx={{
              mt: 'auto',
              pt: 0.5,
              borderTop: 1,
              borderColor: 'divider',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              opacity: 0.7,
              fontSize: '0.7rem',
            }}
          >
            <Typography variant="caption">
              {t('home.components.ipInfo.labels.autoRefresh')}
              {countdown.type === 'countdown'
                ? `: ${countdown.remainingSeconds}s`
                : '...'}
            </Typography>
          </Box>
        </Box>
      )
  }

  return (
    <IPInfoCardContainer ref={containerRef} onRefresh={handleRefresh}>
      {mainElement}
    </IPInfoCardContainer>
  )
}
