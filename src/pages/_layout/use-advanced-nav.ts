import { useCallback, useEffect, useState } from 'react'

/**
 * Hub4CC「高级 / 调试入口」开关(M1)。
 *
 * 控制原生 clash 页(proxies/profiles/connections/rules/logs/unlock/settings)是否出现在侧边栏。
 * 默认关闭——普通员工只看到 Hub4CC 定制页;开启后追加原生页,供排障用。
 *
 * 当前实现:常量默认值 + localStorage 持久化(本地配置),后续 M3 可接入设置页 / 远端下发。
 * 提供 window 级全局开关(`__hub4cc_setAdvancedNav(true)` / `localStorage`),
 * 方便在未做设置 UI 前从控制台或调试入口临时调出原生页。
 */

const STORAGE_KEY = 'hub4cc:advanced-nav'

/** 默认是否开启高级入口(M1 默认关闭)。 */
export const ADVANCED_NAV_DEFAULT = false

const STORAGE_EVENT = 'hub4cc:advanced-nav-changed'

const readStored = (): boolean => {
  if (typeof window === 'undefined') {
    return ADVANCED_NAV_DEFAULT
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) {
      return ADVANCED_NAV_DEFAULT
    }
    return raw === 'true'
  } catch {
    return ADVANCED_NAV_DEFAULT
  }
}

const writeStored = (value: boolean) => {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false')
  } catch {
    /* ignore storage failures */
  }
  window.dispatchEvent(new CustomEvent(STORAGE_EVENT, { detail: value }))
}

export interface UseAdvancedNavResult {
  advancedNav: boolean
  setAdvancedNav: (value: boolean) => void
  toggleAdvancedNav: () => void
}

export const useAdvancedNav = (): UseAdvancedNavResult => {
  const [advancedNav, setAdvancedNav] = useState<boolean>(readStored)

  const updateAdvancedNav = useCallback((value: boolean) => {
    setAdvancedNav(value)
    writeStored(value)
  }, [])

  const toggleAdvancedNav = useCallback(() => {
    setAdvancedNav((prev) => {
      const next = !prev
      writeStored(next)
      return next
    })
  }, [])

  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<boolean>).detail
      if (typeof detail === 'boolean') {
        setAdvancedNav(detail)
      } else {
        setAdvancedNav(readStored())
      }
    }
    window.addEventListener(STORAGE_EVENT, onChange)
    // 暴露给控制台 / 后续调试入口临时调出原生页
    ;(
      window as unknown as { __hub4cc_setAdvancedNav?: (v: boolean) => void }
    ).__hub4cc_setAdvancedNav = (v: boolean) => writeStored(Boolean(v))
    return () => {
      window.removeEventListener(STORAGE_EVENT, onChange)
    }
  }, [])

  return { advancedNav, setAdvancedNav: updateAdvancedNav, toggleAdvancedNav }
}
