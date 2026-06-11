import { Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'

import { BaseDialog } from '@/components/base'
import { useClashVergeConflict } from '@/hooks/use-clash-verge-conflict'

/**
 * 「官方 Clash Verge 冲突」提醒弹窗。
 *
 * 启动检测到官方版正在运行,或运行期间官方版从无到有出现时弹出。
 * 仅展示提示,无破坏性操作;用户点「我知道了」或点遮罩关闭。
 * 在 _layout 顶层挂载一次即可全局生效。
 */
export const ClashVergeConflictDialog = () => {
  const { t } = useTranslation()
  const { open, mode, dismiss } = useClashVergeConflict()

  const lead =
    mode === 'appeared'
      ? t('nexthubx.clashVergeConflict.appearedBody')
      : t('nexthubx.clashVergeConflict.runningBody')
  // 引言 + 分步操作指引(关 TUN → 关开机自启 → 退出);steps 内含换行,pre-line 渲染。
  const body = `${lead}\n\n${t('nexthubx.clashVergeConflict.steps')}`

  return (
    <BaseDialog
      open={open}
      title={t('nexthubx.clashVergeConflict.title')}
      okBtn={t('nexthubx.clashVergeConflict.confirm')}
      disableCancel
      onOk={dismiss}
      onClose={dismiss}
    >
      <Typography sx={{ maxWidth: 440, whiteSpace: 'pre-line' }}>{body}</Typography>
    </BaseDialog>
  )
}
