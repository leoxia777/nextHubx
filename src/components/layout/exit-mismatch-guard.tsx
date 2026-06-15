import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { useIpInfoQuery } from '@/hooks/use-ip-info'
import { useNexthubxExitGuard } from '@/hooks/use-nexthubx-exit-guard'
import { useNexthubxClient } from '@/hooks/use-nexthubx-sync'

/**
 * 出口 IP 不一致后台监测(不渲染任何 UI)。
 *
 * 挂载于 _layout 顶层,与 IP Info 卡片共用同一 IP 查询缓存。职责:
 * - 持续主动轮询实际出口 IP(不依赖卡片是否在视口),保证最小化 / 后台也能尽快发现不一致;
 * - 持续不一致达阈值(prolonged)→ 发**被动系统通知**,提醒用户回来查看。
 *
 * 注:**不再**渲染全屏遮罩、**不再**强制唤起 / 置顶窗口(spec 已改为:账号卡先隐藏账号 +
 * 账号卡 / IP 卡内联提示,持续过久才升级「联系技术支持」)。通知放在此处单点发出,避免
 * `useNexthubxExitGuard` 被多卡片调用时重复通知。比对与防误报逻辑见该 hook。
 */
/** 后台监测轮询间隔(ms):比卡片倒计时更短,保证最小化时也能尽快发现。 */
const GUARD_POLL_MS = 60_000

const normIp = (ip: string | undefined): string =>
  (ip ?? '').trim().toLowerCase()

export const ExitMismatchGuard = () => {
  const { t } = useTranslation()
  const { isActivated } = useNexthubxClient()
  const { data: ipInfo, refetch } = useIpInfoQuery()

  const { status, expectedExitIp, actualIp, setupInProgress, prolonged } =
    useNexthubxExitGuard({ actualIp: ipInfo?.ip })

  // 主动轮询:即使 IP 卡片未挂载 / 不在视口,也持续刷新实际 IP 以便后台检测。
  useEffect(() => {
    if (!isActivated) return
    const timer = setInterval(() => {
      void refetch()
    }, GUARD_POLL_MS)
    return () => clearInterval(timer)
  }, [isActivated, refetch])

  // 被动系统通知:持续不一致(prolonged)且非初始验证期才发;同一 (expected, actual)
  // 组合只通知一次,恢复一致后才允许再次通知。**不**唤起 / 置顶窗口(被动,不打扰)。
  const lastNotifiedRef = useRef<string>('')
  useEffect(() => {
    if (status === 'match') lastNotifiedRef.current = ''
    if (status !== 'mismatch' || setupInProgress || !prolonged) return

    const key = `${normIp(expectedExitIp)}=>${normIp(actualIp)}`
    if (lastNotifiedRef.current === key) return
    lastNotifiedRef.current = key

    void (async () => {
      try {
        let granted = await isPermissionGranted()
        if (!granted) {
          const perm = await requestPermission()
          granted = perm === 'granted'
        }
        if (granted) {
          sendNotification({
            title: t('nexthubx.exitGuard.notifyTitle'),
            body: t('nexthubx.exitGuard.notifyBody', {
              actual: normIp(actualIp),
              expected: normIp(expectedExitIp),
            }),
          })
        }
      } catch (err) {
        console.error('[nexthubx] exit-guard notification failed', err)
      }
    })()
  }, [status, setupInProgress, prolonged, expectedExitIp, actualIp, t])

  // 不渲染任何 UI:不一致提示改由账号卡 / IP 卡内联呈现,本组件仅做后台监测 + 被动通知。
  return null
}
