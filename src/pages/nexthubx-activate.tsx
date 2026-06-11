import { Box, Button, Stack, TextField, Typography } from '@mui/material'
import { useLockFn } from 'ahooks'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'

import { BasePage } from '@/components/base'
import { useSystemState } from '@/hooks/use-system-state'
import { isServiceAvailable } from '@/services/cmds'
import { ActivationInvalidError, activate } from '@/services/nexthubx-api'
import { importAndActivateProfile } from '@/services/nexthubx-profile'
import {
  loadClientState,
  saveClientState,
} from '@/services/nexthubx-store'
import { showNotice } from '@/services/notice-service'

/**
 * 激活页(M2):输入 token → POST /api/activate → 导入 clash YAML + 切换 + 存凭证 → 进连接页。
 * 兼作「重新激活」入口(同一逻辑,成功后覆盖本地凭证)。
 */
const NexthubxActivatePage = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { mutateSystemState } = useSystemState()
  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const onSubmit = useLockFn(async () => {
    const trimmedEmail = email.trim()
    const trimmed = token.trim()
    if (!trimmedEmail || !trimmed) {
      showNotice.error('nexthubx.activate.feedback.empty')
      return
    }

    setSubmitting(true)
    try {
      const result = await activate(trimmedEmail, trimmed)

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

      // 激活成功后立即检测 TUN service 是否就绪;未就绪 → 刷新系统状态触发
      // 全局 ServiceGate 弹出授权安装引导(不等连接时才发现)
      try {
        if (!(await isServiceAvailable())) {
          await mutateSystemState()
        }
      } catch (svcErr) {
        console.error('[nexthubx] service readiness check failed', svcErr)
        await mutateSystemState()
      }

      showNotice.success('nexthubx.activate.feedback.success')
      navigate('/nexthubx/connect')
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
    <BasePage title={t('nexthubx.activate.title')}>
      <Box
        sx={{
          maxWidth: 480,
          mx: 'auto',
          mt: 6,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ mb: 3, textAlign: 'center' }}
        >
          {t('nexthubx.activate.subtitle')}
        </Typography>

        <Stack spacing={2}>
          <TextField
            fullWidth
            type="email"
            label={t('nexthubx.activate.emailLabel')}
            placeholder={t('nexthubx.activate.emailPlaceholder')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
            autoFocus
          />
          <TextField
            fullWidth
            label={t('nexthubx.activate.tokenLabel')}
            placeholder={t('nexthubx.activate.tokenPlaceholder')}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !submitting) {
                void onSubmit()
              }
            }}
            disabled={submitting}
          />
          <Button
            fullWidth
            variant="contained"
            size="large"
            onClick={() => void onSubmit()}
            disabled={submitting}
          >
            {submitting
              ? t('nexthubx.activate.submitting')
              : t('nexthubx.activate.submit')}
          </Button>
        </Stack>
      </Box>
    </BasePage>
  )
}

export default NexthubxActivatePage
