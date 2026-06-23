// 一键诊断弹窗:运行 runDiagnostics,展示各项检查 + 结论 + 建议(+ 重新同步订阅)。
import {
  CheckCircleOutlined,
  ErrorOutlined,
  HelpOutlined,
  WarningAmberOutlined,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Typography,
} from '@mui/material'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  requestImmediateNexthubxSync,
  useNexthubxClient,
} from '@/hooks/use-nexthubx-sync'
import {
  runDiagnostics,
  type CheckStatus,
  type DiagReport,
} from '@/services/diagnostics'

const STATUS_ICON: Record<CheckStatus, React.ReactNode> = {
  ok: <CheckCircleOutlined color="success" fontSize="small" />,
  warn: <WarningAmberOutlined color="warning" fontSize="small" />,
  fail: <ErrorOutlined color="error" fontSize="small" />,
  skip: <HelpOutlined color="disabled" fontSize="small" />,
}

const LEVEL_SEVERITY: Record<
  DiagReport['level'],
  'success' | 'warning' | 'error'
> = {
  ok: 'success',
  warn: 'warning',
  fail: 'error',
}

export function DiagnosticsModal({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { clientState } = useNexthubxClient()
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState<DiagReport | null>(null)

  const run = useCallback(async () => {
    setLoading(true)
    setReport(null)
    try {
      setReport(
        await runDiagnostics(clientState?.expectedExitIp?.trim() || undefined),
      )
    } finally {
      setLoading(false)
    }
  }, [clientState?.expectedExitIp])

  // 打开即自动跑一次。
  useEffect(() => {
    if (open) void run()
  }, [open, run])

  const showResync =
    report?.adviceKey === 'resyncOnly' ||
    report?.adviceKey === 'ruleSourceBlocked'

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t('home.components.diagnostics.title')}</DialogTitle>
      <DialogContent dividers>
        {loading || !report ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 3 }}>
            <CircularProgress size={20} />
            <Typography variant="body2">
              {t('home.components.diagnostics.running')}
            </Typography>
          </Box>
        ) : (
          <>
            <Alert severity={LEVEL_SEVERITY[report.level]} sx={{ mb: 1.5 }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {t(`home.components.diagnostics.summary.${report.summaryKey}`)}
              </Typography>
              {report.adviceKey !== 'none' && (
                <Typography variant="body2" sx={{ mt: 0.5 }}>
                  {t(`home.components.diagnostics.advice.${report.adviceKey}`)}
                </Typography>
              )}
            </Alert>
            <List dense disablePadding>
              {report.checks.map((c) => (
                <ListItem key={c.key} disableGutters sx={{ py: 0.2 }}>
                  <ListItemIcon sx={{ minWidth: 32 }}>
                    {STATUS_ICON[c.status]}
                  </ListItemIcon>
                  <ListItemText
                    primary={t(`home.components.diagnostics.checks.${c.key}`)}
                    secondary={
                      c.detail === 'old-config'
                        ? t('home.components.diagnostics.detail.oldConfig')
                        : c.detail || undefined
                    }
                    slotProps={{
                      primary: { variant: 'body2' },
                      secondary: { variant: 'caption' },
                    }}
                  />
                </ListItem>
              ))}
            </List>
          </>
        )}
      </DialogContent>
      <DialogActions>
        {showResync && (
          <Button
            onClick={() => {
              requestImmediateNexthubxSync()
            }}
          >
            {t('home.components.diagnostics.resync')}
          </Button>
        )}
        <Button onClick={() => void run()} disabled={loading}>
          {t('home.components.diagnostics.rerun')}
        </Button>
        <Button onClick={onClose}>{t('shared.actions.close')}</Button>
      </DialogActions>
    </Dialog>
  )
}
