import { ShieldRounded, SupportAgentRounded } from '@mui/icons-material'
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useServiceInstaller } from '@/hooks/use-service-installer'
import { useSystemState } from '@/hooks/use-system-state'

/**
 * 全局 Service 强制引导(最终 spec §5 / A3)。
 *
 * - TUN 锁定常开,**无降级**:启动检测 Service 未就绪 → 强制弹 modal 引导安装(不可跳过)。
 * - 安装失败 / 被拒重试累计 > 3 次 → 切「请联系技术支持」态(仍允许「仍要重试」)。
 * - 仅当 Service 就绪后 modal 关闭、放行进入 app。
 *
 * 挂载于 _layout 顶层(全局 gate)。
 */
const MAX_RETRIES = 3

export const ServiceGate = () => {
  const { t } = useTranslation()
  const { isServiceOk, isLoading, mutateSystemState } = useSystemState()
  const { installServiceAndRestartCore } = useServiceInstaller()

  const [installing, setInstalling] = useState(false)
  const [failureCount, setFailureCount] = useState(0)

  // Service 未就绪(且非启动加载中)→ 打开强制引导
  const open = !isLoading && !isServiceOk

  const exhausted = failureCount > MAX_RETRIES

  const onInstall = useLockFn(async () => {
    setInstalling(true)
    try {
      await installServiceAndRestartCore()
      await mutateSystemState()
      setFailureCount(0)
    } catch (err) {
      console.error('[nexthubx] service install failed', err)
      setFailureCount((c) => c + 1)
    } finally {
      setInstalling(false)
    }
  })

  // 进入 gate 时立即触发一次状态刷新(缩短启动 grace 等待)
  useEffect(() => {
    if (open) void mutateSystemState()
  }, [open, mutateSystemState])

  if (!open) return null

  return (
    <Dialog
      open
      // 强制:不提供 onClose,点遮罩 / Esc 均不关闭
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        {exhausted ? (
          <SupportAgentRounded color="error" />
        ) : (
          <ShieldRounded color="primary" />
        )}
        {exhausted
          ? t('nexthubx.connect.gate.supportTitle')
          : t('nexthubx.connect.gate.title')}
      </DialogTitle>
      <DialogContent>
        <DialogContentText>
          {exhausted
            ? t('nexthubx.connect.gate.supportBody')
            : t('nexthubx.connect.gate.body')}
        </DialogContentText>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Stack direction="row" spacing={1} sx={{ width: '100%' }}>
          <Box sx={{ flex: 1 }} />
          <Button
            variant="contained"
            color={exhausted ? 'inherit' : 'primary'}
            disabled={installing}
            onClick={() => void onInstall()}
            startIcon={
              installing ? (
                <CircularProgress size={16} color="inherit" />
              ) : (
                <ShieldRounded />
              )
            }
          >
            {installing
              ? t('nexthubx.connect.gate.installing')
              : exhausted
                ? t('nexthubx.connect.gate.retryAnyway')
                : failureCount > 0
                  ? t('nexthubx.connect.gate.retry')
                  : t('nexthubx.connect.gate.install')}
          </Button>
        </Stack>
      </DialogActions>
    </Dialog>
  )
}
