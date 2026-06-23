// 一键诊断:分析「只能上国外、国内/127 不通」这类分流失效问题。
// 核心判据(不依赖外网即可得):① 运行配置是否含本地私网/回环兜底直连(新模板);
// ② mihomo 规则集(rule-providers)是否真的加载成功。辅以可达性(国外/国内/skk.moe/出口 IP)。
import { fetch } from '@tauri-apps/plugin-http'

import { getClashInfo, getRuntimeYaml } from './cmds'

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip'

// 字面量联合(供动态 t() 键解析为合法 TranslationKey;与 home.json 的 diagnostics 子键一一对应)。
export type CheckKey =
  | 'lanFallback'
  | 'ruleProviders'
  | 'foreign'
  | 'domestic'
  | 'ruleSource'
  | 'exitIp'
export type SummaryKey =
  | 'allGood'
  | 'proxyDown'
  | 'rulesEmpty'
  | 'ruleSourceBlockedOldConfig'
  | 'oldConfig'
  | 'domesticFail'
  | 'exitMismatch'
export type AdviceKey =
  | 'none'
  | 'proxyDown'
  | 'resyncOnly'
  | 'ruleSourceBlocked'
  | 'exitMismatch'

export interface DiagCheck {
  /** i18n 子键(home.components.diagnostics.checks.<key>)。 */
  key: CheckKey
  status: CheckStatus
  /** 直接展示的补充说明(纯数据,如 IP/耗时/数量;或哨兵 'old-config' 由 UI 本地化)。 */
  detail: string
}

export interface DiagReport {
  checks: DiagCheck[]
  /** 结论级别 + i18n 结论键 + 建议键。 */
  level: 'ok' | 'warn' | 'fail'
  summaryKey: SummaryKey
  adviceKey: AdviceKey
  exitIp?: string
}

interface ProbeResult {
  ok: boolean
  status?: number
  ms: number
}

// 带超时的可达性探测(只关心能否连通 + 耗时;非 2xx 也算「连通但异常」)。
async function probe(url: string, timeoutMs = 6000): Promise<ProbeResult> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  const start = Date.now()
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      connectTimeout: timeoutMs,
    })
    return {
      ok: res.ok || res.status > 0,
      status: res.status,
      ms: Date.now() - start,
    }
  } catch {
    return { ok: false, ms: Date.now() - start }
  } finally {
    clearTimeout(t)
  }
}

// 把 external-controller 的 0.0.0.0 改成 127.0.0.1 以便本地访问。
function controllerBase(server?: string): string | null {
  if (!server) return null
  const s = server.replace('0.0.0.0', '127.0.0.1')
  return s.startsWith('http') ? s : `http://${s}`
}

// 查 mihomo 规则集加载状态(/providers/rules)。best-effort:拿不到返回 null(不阻塞诊断)。
async function ruleProvidersLoaded(): Promise<{
  total: number
  loaded: number
} | null> {
  try {
    const info = await getClashInfo()
    const base = controllerBase(info?.server)
    if (!base) return null
    const res = await fetch(`${base}/providers/rules`, {
      method: 'GET',
      connectTimeout: 4000,
      headers: info?.secret ? { Authorization: `Bearer ${info.secret}` } : {},
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      providers?: Record<string, { ruleCount?: number }>
    }
    const provs = Object.values(data.providers ?? {})
    if (provs.length === 0) return null
    const loaded = provs.filter((p) => (p.ruleCount ?? 0) > 0).length
    return { total: provs.length, loaded }
  } catch {
    return null
  }
}

/**
 * 运行一键诊断。expectedExitIp:该席位分配的出口(来自 sync/出口守卫),用于比对。
 */
export async function runDiagnostics(
  expectedExitIp?: string,
): Promise<DiagReport> {
  const checks: DiagCheck[] = []

  // ① 运行配置:是否含本地私网/回环兜底直连(新模板 v2 的标志)。
  const yaml = await getRuntimeYaml().catch(() => null)
  const hasLanFallback = !!yaml && yaml.includes('IP-CIDR,127.0.0.0/8')
  checks.push({
    key: 'lanFallback',
    status: hasLanFallback ? 'ok' : 'warn',
    detail: hasLanFallback ? '' : 'old-config',
  })

  // ② 规则集加载状态。
  const rp = await ruleProvidersLoaded()
  checks.push({
    key: 'ruleProviders',
    status:
      rp == null
        ? 'skip'
        : rp.loaded === 0
          ? 'fail'
          : rp.loaded < rp.total
            ? 'warn'
            : 'ok',
    detail: rp == null ? '' : `${rp.loaded}/${rp.total}`,
  })

  // ③ 可达性:并发探测。
  const [foreign, domestic, skk, exit] = await Promise.all([
    probe('http://www.gstatic.com/generate_204'),
    probe('https://www.baidu.com/favicon.ico'),
    probe('https://ruleset.skk.moe/Clash/ip/lan.txt'),
    probe('https://ip.nexthubx.io/raw'),
  ])
  checks.push({
    key: 'foreign',
    status: foreign.ok ? 'ok' : 'fail',
    detail: foreign.ok ? `${foreign.ms}ms` : '',
  })
  checks.push({
    key: 'domestic',
    status: domestic.ok ? 'ok' : 'fail',
    detail: domestic.ok ? `${domestic.ms}ms` : '',
  })
  checks.push({
    key: 'ruleSource',
    status: skk.ok ? 'ok' : 'fail',
    detail: skk.ok ? `${skk.ms}ms` : '',
  })

  // ④ 出口 IP:取 + 与分配比对。
  let exitIp: string | undefined
  try {
    if (exit.ok) {
      const res = await fetch('https://ip.nexthubx.io/raw', {
        method: 'GET',
        connectTimeout: 6000,
      })
      exitIp = (await res.text()).trim()
    }
  } catch {
    /* 忽略 */
  }
  const exitMatch = !!exitIp && !!expectedExitIp && exitIp === expectedExitIp
  checks.push({
    key: 'exitIp',
    status: !exitIp
      ? 'fail'
      : !expectedExitIp
        ? 'ok'
        : exitMatch
          ? 'ok'
          : 'warn',
    detail: exitIp ? exitIp : '',
  })

  // ⑤ 结论合成。
  let level: DiagReport['level'] = 'ok'
  let summaryKey: SummaryKey = 'allGood'
  let adviceKey: AdviceKey = 'none'

  if (!foreign.ok) {
    // 国外都不通 → 代理本身没起来(出口/TUN/CV 冲突)。
    level = 'fail'
    summaryKey = 'proxyDown'
    adviceKey = 'proxyDown'
  } else if (rp != null && rp.loaded === 0) {
    // 规则集一条都没加载 → 分流失效(国内/127 会走代理)。
    level = 'fail'
    summaryKey = 'rulesEmpty'
    adviceKey = skk.ok ? 'resyncOnly' : 'ruleSourceBlocked'
  } else if (!skk.ok && !hasLanFallback) {
    // 规则源拉不到 + 还是旧配置(无本地兜底)→ 国内/127 高危。
    level = 'fail'
    summaryKey = 'ruleSourceBlockedOldConfig'
    adviceKey = 'ruleSourceBlocked'
  } else if (!hasLanFallback) {
    // 旧订阅(无本地兜底)→ 建议重新同步拿新模板。
    level = 'warn'
    summaryKey = 'oldConfig'
    adviceKey = 'resyncOnly'
  } else if (!domestic.ok) {
    // 配置正常但国内不通 → 可能 DNS / 规则源临时问题。
    level = 'warn'
    summaryKey = 'domesticFail'
    adviceKey = 'resyncOnly'
  } else if (exitIp && expectedExitIp && !exitMatch) {
    // 出口与分配不一致。
    level = 'warn'
    summaryKey = 'exitMismatch'
    adviceKey = 'exitMismatch'
  }

  return { checks, level, summaryKey, adviceKey, exitIp }
}
