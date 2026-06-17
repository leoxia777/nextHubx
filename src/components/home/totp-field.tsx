import { ContentCopyRounded, ErrorOutlineRounded } from '@mui/icons-material'
import {
  Box,
  CircularProgress,
  IconButton,
  InputAdornment,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { useLockFn } from 'ahooks'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { fetchTotpCode } from '@/services/nexthubx-api'
import { showNotice } from '@/services/notice-service'

const PLACEHOLDER = '— — —'

/** 格式化:6 位码中间空一格便于读(287082 → 287 082);其余位数原样。 */
function formatCode(code: string): string {
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`
  return code
}

/**
 * 账号卡里的 2FA 动态码字段:**算法在服务端**,这里只从 /api/client/totp 拉算好的 6 位码,
 * 本地按返回的 remaining 倒计时,过期(归零)即重拉——像手机 authenticator 一样滚动,但密钥不出服务端。
 */
export const TotpField = ({ clientToken }: { clientToken: string }) => {
  const { t } = useTranslation()
  const [code, setCode] = useState('')
  const [remaining, setRemaining] = useState(0)
  const [period, setPeriod] = useState(30)
  const inFlightRef = useRef(false)

  const load = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    try {
      const r = await fetchTotpCode(clientToken)
      if (r) {
        setCode(r.code)
        setPeriod(r.period > 0 ? r.period : 30)
        setRemaining(r.remaining)
      } else {
        setCode('')
      }
    } catch {
      // 瞬时失败:保留旧码,下个 tick 到点会再拉
    } finally {
      inFlightRef.current = false
    }
  }, [clientToken])

  useEffect(() => {
    let alive = true
    void load()
    const id = setInterval(() => {
      if (!alive) return
      setRemaining((prev) => {
        if (prev <= 1) {
          void load() // 到点重拉:load 返回后会写入新码 + 新 remaining
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [load])

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
              {/* ❗紧跟在码后:hover 提示登录遇手机验证时怎么改用动态码。 */}
              <Tooltip
                title={t('nexthubx.account.totp.hint')}
                arrow
                enterTouchDelay={0}
              >
                <ErrorOutlineRounded
                  fontSize="small"
                  sx={{ color: 'text.secondary', mr: 0.5, cursor: 'help' }}
                />
              </Tooltip>
              {/* 倒计时环:剩余/周期;归零自动重拉下一个码。 */}
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
  )
}
