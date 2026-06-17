import { ContentCopyRounded } from '@mui/icons-material'
import {
  Box,
  CircularProgress,
  IconButton,
  InputAdornment,
  TextField,
  Typography,
} from '@mui/material'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { useLockFn } from 'ahooks'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  generateTotpCode,
  totpRemaining,
  type TotpConfig,
} from '@/services/nexthubx-totp'
import { showNotice } from '@/services/notice-service'

const PLACEHOLDER = '— — —'

/** 格式化:6 位码中间空一格便于读(287082 → 287 082);其余位数原样。 */
function formatCode(code: string): string {
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`
  return code
}

/**
 * 账号卡里的 2FA 动态码字段:用 sync 下发的 secret 在本机实时算 TOTP 码,
 * 像手机 authenticator 一样每 30s 滚动 + 倒计时,可一键复制。
 */
export const TotpField = ({ totp }: { totp: TotpConfig }) => {
  const { t } = useTranslation()
  const [code, setCode] = useState('')
  const [remaining, setRemaining] = useState(totp.period > 0 ? totp.period : 30)
  const period = totp.period > 0 ? totp.period : 30
  // 当前计数器窗口;跨窗口才重算码(每秒只更新倒计时,避免无谓的 crypto 调用)。
  const counterRef = useRef<number>(-1)

  useEffect(() => {
    let alive = true
    counterRef.current = -1
    const tick = async () => {
      const now = Math.floor(Date.now() / 1000)
      if (alive) setRemaining(totpRemaining(now, period))
      const counter = Math.floor(now / period)
      if (counter !== counterRef.current) {
        counterRef.current = counter
        try {
          const c = await generateTotpCode(totp, now)
          if (alive) setCode(c)
        } catch {
          if (alive) setCode('')
        }
      }
    }
    void tick()
    const id = setInterval(() => void tick(), 1000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [totp, period])

  const copy = useLockFn(async () => {
    if (!code) return
    try {
      await writeText(code)
      showNotice.success('nexthubx.account.copied')
    } catch (err) {
      console.error('[nexthubx] copy totp failed', err)
    }
  })

  return (
    <Box>
      <TextField
        fullWidth
        size="small"
        label={t('nexthubx.account.totp.title')}
        value={code ? formatCode(code) : PLACEHOLDER}
        slotProps={{
          input: {
            readOnly: true,
            sx: { fontFamily: 'monospace', letterSpacing: 2, fontSize: 18 },
            endAdornment: (
              <InputAdornment position="end">
                {/* 倒计时环:剩余/周期;到点自动滚动到下一个码。 */}
                <Box
                  sx={{ position: 'relative', display: 'inline-flex', mr: 0.5 }}
                >
                  <CircularProgress
                    variant="determinate"
                    value={(remaining / period) * 100}
                    size={22}
                    thickness={5}
                    color={remaining <= 5 ? 'warning' : 'primary'}
                  />
                  <Box
                    sx={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Typography variant="caption" sx={{ fontSize: 10 }}>
                      {remaining}
                    </Typography>
                  </Box>
                </Box>
                <IconButton
                  edge="end"
                  size="small"
                  disabled={!code}
                  onClick={() => void copy()}
                  title={t('nexthubx.account.copy')}
                >
                  <ContentCopyRounded fontSize="small" />
                </IconButton>
              </InputAdornment>
            ),
          },
        }}
      />
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ mt: 0.5, display: 'block' }}
      >
        {t('nexthubx.account.totp.hint')}
      </Typography>
    </Box>
  )
}
