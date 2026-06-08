import {
  AccountCircleOutlined,
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
  Tooltip,
  Typography,
} from '@mui/material'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { useLockFn } from 'ahooks'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useNexthubxClient } from '@/hooks/use-nexthubx-sync'
import { useSystemState } from '@/hooks/use-system-state'
import { isServiceAvailable } from '@/services/cmds'
import { ActivationInvalidError, activate } from '@/services/nexthubx-api'
import { importAndActivateProfile } from '@/services/nexthubx-profile'
import { loadClientState, saveClientState } from '@/services/nexthubx-store'
import { showNotice } from '@/services/notice-service'

import { EnhancedCard } from './enhanced-card'

/**
 * Home「账号」卡片(最终 spec ①)。
 *
 * - 未激活:输入激活码 + 激活 → POST /api/activate → 导入并切换 clash YAML profile
 *   + 存 clientToken(复用 nexthubx-store)→ 刷新为已激活态。
 * - 已激活:展示 identity(email/password 可复制)+ 使用说明 + 右上角「重新激活」按钮。
 *
 * 激活逻辑与原 nexthubx-activate 页一致(并入此卡片),依旧复用同一本地存储与同步链路。
 */
export const AccountCard = () => {
  const { t } = useTranslation()
  const { clientState, isActivated, refresh } = useNexthubxClient()
  const { mutateSystemState } = useSystemState()

  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [reactivating, setReactivating] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  const showForm = !isActivated || !clientState || reactivating

  const copy = useLockFn(async (value: string) => {
    try {
      await writeText(value)
      showNotice.success('nexthubx.account.copied')
    } catch (err) {
      console.error('[nexthubx] copy failed', err)
    }
  })

  /**
   * 激活成功后立即检测 TUN service 是否就绪;未就绪则刷新系统状态,
   * 触发全局 ServiceGate(`_layout` 顶层挂载)弹出授权安装引导,
   * 不等到连接时才发现。复用 ServiceGate 的安装/授权逻辑,避免重复实现 UAC 流程。
   */
  const ensureServiceReady = useCallback(async () => {
    try {
      const ok = await isServiceAvailable()
      if (!ok) {
        // 刷新系统状态 → ServiceGate 立即重新评估并弹出安装引导
        await mutateSystemState()
      }
    } catch (err) {
      console.error('[nexthubx] service readiness check failed', err)
      // 检测失败时也刷新一次,交由全局 gate 兜底判断
      await mutateSystemState()
    }
  }, [mutateSystemState])

  const onActivate = useLockFn(async () => {
    const trimmed = token.trim()
    if (!trimmed) {
      showNotice.error('nexthubx.activate.feedback.empty')
      return
    }

    setSubmitting(true)
    try {
      const result = await activate(trimmed)

      // 复用已有托管 profile uid(若之前激活过)以更新而非堆积
      const prev = await loadClientState()
      let profileUid: string
      try {
        profileUid = await importAndActivateProfile(
          result.proxyConfig.content,
          prev?.profileUid,
        )
      } catch (err) {
        console.error('[nexthubx] import profile failed', err)
        showNotice.error('nexthubx.activate.feedback.configError')
        return
      }

      await saveClientState({
        clientToken: result.clientToken,
        identityEmail: result.identityEmail,
        identityPassword: result.identityPassword,
        profileUid,
        // 激活响应不含 fingerprint;首次同步用 active 结果回填
        configFingerprint: prev?.configFingerprint,
        // 出口比对用:后端缺省时回退到上次值(老后端兼容)
        expectedExitIp: result.expectedExitIp ?? prev?.expectedExitIp,
      })

      // 激活成功后立即检测 TUN service 是否就绪;未就绪 → 引导安装
      void ensureServiceReady()

      showNotice.success('nexthubx.activate.feedback.success')
      setToken('')
      setReactivating(false)
      refresh()
    } catch (err) {
      if (err instanceof ActivationInvalidError) {
        showNotice.error('nexthubx.activate.feedback.invalid')
      } else {
        console.error('[nexthubx] activate failed', err)
        showNotice.error('nexthubx.activate.feedback.networkError')
      }
    } finally {
      setSubmitting(false)
    }
  })

  return (
    <EnhancedCard
      title={t('nexthubx.account.title')}
      icon={<AccountCircleOutlined />}
      iconColor="primary"
      action={
        isActivated && !reactivating ? (
          <Tooltip title={t('nexthubx.account.reactivate')} arrow>
            <IconButton
              size="small"
              color="inherit"
              onClick={() => {
                setReactivating(true)
                setToken('')
              }}
            >
              <RefreshRounded fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : null
      }
    >
      {showForm ? (
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            {t('nexthubx.activate.subtitle')}
          </Typography>
          <TextField
            fullWidth
            size="small"
            label={t('nexthubx.activate.tokenLabel')}
            placeholder={t('nexthubx.activate.tokenPlaceholder')}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !submitting) {
                void onActivate()
              }
            }}
            disabled={submitting}
          />
          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              onClick={() => void onActivate()}
              disabled={submitting}
            >
              {submitting
                ? t('nexthubx.activate.submitting')
                : t('nexthubx.activate.submit')}
            </Button>
            {isActivated && reactivating && (
              <Button
                variant="text"
                color="inherit"
                onClick={() => {
                  setReactivating(false)
                  setToken('')
                }}
                disabled={submitting}
              >
                {t('shared.actions.cancel')}
              </Button>
            )}
          </Stack>
        </Stack>
      ) : (
        <Stack spacing={2}>
          <TextField
            fullWidth
            size="small"
            label={t('nexthubx.account.email')}
            value={clientState.identityEmail}
            slotProps={{
              input: {
                readOnly: true,
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      edge="end"
                      size="small"
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
            size="small"
            label={t('nexthubx.account.password')}
            type={showPassword ? 'text' : 'password'}
            value={clientState.identityPassword}
            slotProps={{
              input: {
                readOnly: true,
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      size="small"
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
                      size="small"
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

          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              {t('nexthubx.account.usage.title')}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t('nexthubx.account.usage.body')}
            </Typography>
          </Box>
        </Stack>
      )}
    </EnhancedCard>
  )
}
