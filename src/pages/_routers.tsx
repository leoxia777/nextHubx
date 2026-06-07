import AccountCircleRoundedIcon from '@mui/icons-material/AccountCircleRounded'
import DnsRoundedIcon from '@mui/icons-material/DnsRounded'
import ForkRightRoundedIcon from '@mui/icons-material/ForkRightRounded'
import HomeRoundedIcon from '@mui/icons-material/HomeRounded'
import LanguageRoundedIcon from '@mui/icons-material/LanguageRounded'
import LockOpenRoundedIcon from '@mui/icons-material/LockOpenRounded'
import PowerRoundedIcon from '@mui/icons-material/PowerRounded'
import SettingsRoundedIcon from '@mui/icons-material/SettingsRounded'
import SubjectRoundedIcon from '@mui/icons-material/SubjectRounded'
import VpnKeyRoundedIcon from '@mui/icons-material/VpnKeyRounded'
import WifiRoundedIcon from '@mui/icons-material/WifiRounded'
import { createBrowserRouter, Navigate, RouteObject } from 'react-router'

import ConnectionsSvg from '@/assets/image/itemicon/connections.svg?react'
import HomeSvg from '@/assets/image/itemicon/home.svg?react'
import LogsSvg from '@/assets/image/itemicon/logs.svg?react'
import ProfilesSvg from '@/assets/image/itemicon/profiles.svg?react'
import ProxiesSvg from '@/assets/image/itemicon/proxies.svg?react'
import RulesSvg from '@/assets/image/itemicon/rules.svg?react'
import SettingsSvg from '@/assets/image/itemicon/settings.svg?react'
import UnlockSvg from '@/assets/image/itemicon/unlock.svg?react'

import Layout from './_layout'
import ConnectionsPage from './connections'
import HomePage from './home'
import NexthubxAccountPage from './nexthubx-account'
import NexthubxActivatePage from './nexthubx-activate'
import NexthubxConnectPage from './nexthubx-connect'
import ProfilesPage from './profiles'
import ProxiesPage from './proxies'
import RulesPage from './rules'
import SettingsPage from './settings'
import UnlockPage from './unlock'

/**
 * nextHubx 导航裁剪(M1 + M2):
 * - `defaultNavItems`:默认导航 = nextHubx 三个定制页(连接 / 激活 / 账号)。
 * - `advancedNavItems`:原生页(home/proxies/profiles/connections/rules/logs/unlock/settings),
 *   默认从侧边栏隐藏,仅当「高级/调试入口」开启时才追加到导航中(排障用)。
 * - `navItems`:全量项,**仅用于注册路由**——所有原生页路由始终可达(直接输 URL / 程序跳转),
 *   只是默认不在侧边栏出现。
 * - 根路径 `/` 重定向到连接页(`/nexthubx/connect`)。
 *
 * `getNavItems(advanced)` 返回当前应显示在侧边栏的导航项,供 `_layout.tsx` 按 flag 过滤。
 */
export const defaultNavItems = [
  {
    label: 'nexthubx.nav.connect',
    path: '/nexthubx/connect',
    icon: [<PowerRoundedIcon key="mui" />, <HomeSvg key="svg" />],
    Component: NexthubxConnectPage,
  },
  {
    label: 'nexthubx.nav.activate',
    path: '/nexthubx/activate',
    icon: [<VpnKeyRoundedIcon key="mui" />, <UnlockSvg key="svg" />],
    Component: NexthubxActivatePage,
  },
  {
    label: 'nexthubx.nav.account',
    path: '/nexthubx/account',
    icon: [<AccountCircleRoundedIcon key="mui" />, <ProfilesSvg key="svg" />],
    Component: NexthubxAccountPage,
  },
]

export const advancedNavItems = [
  {
    label: 'layout.components.navigation.tabs.home',
    path: '/home',
    icon: [<HomeRoundedIcon key="mui" />, <HomeSvg key="svg" />],
    Component: HomePage,
  },
  {
    label: 'layout.components.navigation.tabs.proxies',
    path: '/proxies',
    icon: [<WifiRoundedIcon key="mui" />, <ProxiesSvg key="svg" />],
    Component: ProxiesPage,
  },
  {
    label: 'layout.components.navigation.tabs.profiles',
    path: '/profile',
    icon: [<DnsRoundedIcon key="mui" />, <ProfilesSvg key="svg" />],
    Component: ProfilesPage,
  },
  {
    label: 'layout.components.navigation.tabs.connections',
    path: '/connections',
    icon: [<LanguageRoundedIcon key="mui" />, <ConnectionsSvg key="svg" />],
    Component: ConnectionsPage,
  },
  {
    label: 'layout.components.navigation.tabs.rules',
    path: '/rules',
    icon: [<ForkRightRoundedIcon key="mui" />, <RulesSvg key="svg" />],
    Component: RulesPage,
  },
  {
    label: 'layout.components.navigation.tabs.logs',
    path: '/logs',
    icon: [<SubjectRoundedIcon key="mui" />, <LogsSvg key="svg" />],
    Component: () => null /* LogsPage rendered in Layout only on /logs route */,
  },
  {
    label: 'layout.components.navigation.tabs.unlock',
    path: '/unlock',
    icon: [<LockOpenRoundedIcon key="mui" />, <UnlockSvg key="svg" />],
    Component: UnlockPage,
  },
  {
    label: 'layout.components.navigation.tabs.settings',
    path: '/settings',
    icon: [<SettingsRoundedIcon key="mui" />, <SettingsSvg key="svg" />],
    Component: SettingsPage,
  },
]

/** 全量导航项(home + 原生页),仅用于注册路由,保证所有页面路由可达。 */
export const navItems = [...defaultNavItems, ...advancedNavItems]

/** 按「高级入口」flag 返回侧边栏应显示的导航项。 */
export const getNavItems = (advanced: boolean) =>
  advanced ? navItems : defaultNavItems

export const router = createBrowserRouter([
  {
    path: '/',
    Component: Layout,
    children: [
      // 根路径重定向到连接页(nextHubx 默认落地页)
      {
        index: true,
        Component: () => <Navigate to="/nexthubx/connect" replace />,
      } as RouteObject,
      ...navItems.map(
        (item) =>
          ({
            path: item.path,
            Component: item.Component,
          }) as RouteObject,
      ),
    ],
  },
])
