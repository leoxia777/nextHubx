import { Alert, Stack, TextField } from '@mui/material'
import { useLockFn } from 'ahooks'
import { useImperativeHandle, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BaseDialog, DialogRef } from '@/components/base'
import { patchVergeConfig } from '@/services/cmds'
import {
  ActivationInvalidError,
  bootstrapActivate,
} from '@/services/nexthubx-api'
import { importBootstrapProfile } from '@/services/nexthubx-profile'
import { showNotice } from '@/services/notice-service'

/**
 * 临时引导访问弹窗(设置页入口)。
 *
 * 破解「激活正式账号前需过 CF 邮箱转发验证 / 试 TUN,但无梯子做不到」的死锁:
 * 用户输入运营签发的临时码 → POST /api/bootstrap/activate 拿临时 clash 配置(约 1h)→
 * 导入为独立 profile 并切换 → 开启系统代理(不依赖 TUN service,保证能上网完成验证)。
 * 不写 clientState,app 仍处「未激活」态,用户完成验证后再走正式激活。
 */
export function BootstrapViewer(props: { ref?: React.Ref<DialogRef> }) {
  const { ref } = props
  const { t } = useTranslation()

  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useImperativeHandle(ref, () => ({
    open: () => {
      setOpen(true)
      setCode('')
    },
    close: () => setOpen(false),
  }))

  const onSubmit = useLockFn(async () => {
    const trimmed = code.trim()
    if (!trimmed) {
      showNotice.error('nexthubx.bootstrap.feedback.empty')
      return
    }
    setSubmitting(true)
    try {
      const result = await bootstrapActivate(trimmed)
      await importBootstrapProfile(result.proxyConfig.content)
      // 开一个能上网的模式:优先系统代理(不依赖 TUN service),保证用户能上网完成 CF 邮箱验证。
      try {
        await patchVergeConfig({ enable_system_proxy: true })
      } catch (proxyErr) {
        console.error('[nexthubx] enable system proxy failed', proxyErr)
      }
      showNotice.success('nexthubx.bootstrap.feedback.success')
      setOpen(false)
    } catch (err) {
      if (err instanceof ActivationInvalidError) {
        showNotice.error('nexthubx.bootstrap.feedback.invalid')
      } else {
        console.error('[nexthubx] bootstrap activate failed', err)
        showNotice.error('nexthubx.bootstrap.feedback.networkError')
      }
    } finally {
      setSubmitting(false)
    }
  })

  return (
    <BaseDialog
      open={open}
      title={t('nexthubx.bootstrap.title')}
      okBtn={
        submitting
          ? t('nexthubx.bootstrap.submitting')
          : t('nexthubx.bootstrap.submit')
      }
      cancelBtn={t('shared.actions.cancel')}
      contentSx={{ width: 420 }}
      onClose={() => setOpen(false)}
      onCancel={() => setOpen(false)}
      onOk={onSubmit}
    >
      <Stack spacing={2}>
        <Alert severity="info">{t('nexthubx.bootstrap.hint')}</Alert>
        <TextField
          fullWidth
          size="small"
          label={t('nexthubx.bootstrap.codeLabel')}
          placeholder={t('nexthubx.bootstrap.codePlaceholder')}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !submitting) {
              void onSubmit()
            }
          }}
          disabled={submitting}
          autoFocus
        />
      </Stack>
    </BaseDialog>
  )
}
