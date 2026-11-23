/**
 * dsh-market-alert — 行情数据层（MarketDataProvider 实现）。
 *
 * 多市场统一符号（docs/contract.md §1）：
 *   A 股  600519.SH / 000001.SZ / 899050.BJ
 *   港股  00700
 *   美股  AAPL
 *   国内期货  RB2601 / AU2606 / IF2601（商品 + 金融）
 *
 * 源策略：腾讯 qt.gtimg.cn 为主源，新浪 hq.sinajs.cn 为备源；
 * 备源命中时 quote.degraded = true（面板降级标识 W-06）。
 * K 线：新浪 CN_MarketDataService（分钟级）+ 腾讯前复权日线，主源失败自动切换。
 */

const TX_QUOTE = 'https://qt.gtimg.cn/q='
const SINA_QUOTE = 'https://hq.sinajs.cn/list='
const SINA_KLINE = [
  'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData',
  'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketDataService.getKLineData',
]
const TX_DAY = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param='
const SINA_SUGGEST = 'https://suggest3.sinajs.cn/suggest/type=11,12,13,14,15,21,22&key='

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

const SINA_MINUTE_SCALE = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '60m': 60 }

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

const A_PREFIX = [
  [/^6/, 'SH'],
  [/^(0|3)/, 'SZ'],
  [/^(4|8|9)/, 'BJ'],
]

/** '600519.SH' / 'sh600519' / '600519' → { kind:'A', symbol:'600519.SH', sina:'sh600519', tx:'sh600519' } */
function normalizeA(raw) {
  const upper = raw.toUpperCase()
  let digits = null
  let market = null
  let m = /^(\d{6})\.(SH|SZ|BJ)$/.exec(upper)
  if (m) { digits = m[1]; market = m[2] }
  if (!m) {
    m = /^(SH|SZ|BJ)(\d{6})$/.exec(upper)
    if (m) { market = m[1]; digits = m[2] }
  }
  if (!m) {
    m = /^(\d{6})$/.exec(upper)
    if (m) {
      digits = m[1]
      for (const [re, mk] of A_PREFIX) if (re.test(digits)) { market = mk; break }
    }
  }
  if (!digits || !market) return null
  return { kind: 'A', symbol: `${digits}.${market}`, lower: `${market.toLowerCase()}${digits}`, tx: `${market.toLowerCase()}${digits}` }
}

/** '00700' / 'hk00700' → 港股（腾讯前缀 hk）。 */
function normalizeHK(raw) {
  const upper = raw.toUpperCase()
  const m = /^(?:HK)?(\d{4,5})$/.exec(upper)
  if (!m) return null
  return { kind: 'HK', symbol: m[1].padStart(5, '0'), tx: `hk${m[1].padStart(5, '0')}` }
}

/** 'AAPL' / 'usAAPL' → 美股（腾讯前缀 us，后缀交易所猜测）。 */
function normalizeUS(raw) {
  const m = /^(?:US:)?([A-Z.]{1,6})$/.exec(raw.toUpperCase())
  if (!m) return null
  return { kind: 'US', symbol: m[1], tx: `us${m[1]}` }
}

/** 'RB2601' / 'nf_RB2601' → 国内期货（新浪前缀 nf）。 */
function normalizeFutures(raw) {
  const upper = raw.toUpperCase()
  const m = /^(?:NF_)?([A-Z]{1,2})(\d{3,4})$/.exec(upper)
  if (!m) return null
  return { kind: 'CNF', symbol: `${m[1]}${m[2]}`, sina: `nf_${m[1]}${m[2]}` }
}

export function normalizeSymbol(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  return normalizeFutures(text) ?? normalizeA(text) ?? normalizeHK(text) ?? normalizeUS(text)
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function decodeGbk(buffer) {
  try {
    return new TextDecoder('gbk').decode(buffer)
  } catch {
    return Buffer.from(buffer).toString('utf8')
  }
}

async function httpText(url, { timeout = 10_000, headers = {}, retries = 1 } = {}) {
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: '*/*', ...headers },
        signal: controller.signal,
        redirect: 'follow',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return decodeGbk(new Uint8Array(await res.arrayBuffer()))
    } catch (error) {
      lastError = error
      if (attempt < retries) await new Promise((r) => setTimeout(r, 300))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError
}

// ---------------------------------------------------------------------------
// 行情解析
// ---------------------------------------------------------------------------

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function parseTencent(text, norm) {
  const m = /v_[a-z]+[a-z0-9]*="([^"]*)"/.exec(text)
  if (!m) return null
  const f = m[1].split('~')
  if (f.length < 6) return null
  const price = num(f[3])
  if (price === null) return null
  const prevClose = num(f[4])
  return {
    symbol: norm.symbol,
    name: f[1] || norm.symbol,
    price,
    prevClose,
    changePercent: price !== null && prevClose ? ((price - prevClose) / prevClose) * 100 : null,
    volume: num(f[36]),
    openInterest: null,
    at: Date.now(),
    source: norm.kind === 'HK' ? 'tencent-hk' : norm.kind === 'US' ? 'tencent-us' : 'tencent',
    degraded: false,
  }
}

function parseSina(text, norm) {
  const m = /"([^"]*)"/.exec(text)
  if (!m) return null
  const f = m[1].split(',')
  if (norm.kind === 'CNF') {
    // 新浪国内期货：0 名称 1 开 2 高 3 低 4 昨收 5 买 6 卖 7 最新 8 持仓 9 成交 10 昨结 …
    if (f.length < 11) return null
    const price = num(f[7]) ?? num(f[5]) ?? num(f[6])
    if (price === null) return null
    const prevClose = num(f[10]) ?? num(f[4])
    return {
      symbol: norm.symbol,
      name: f[0] || norm.symbol,
      price,
      prevClose,
      changePercent: prevClose ? ((price - prevClose) / prevClose) * 100 : null,
      volume: num(f[9]),
      openInterest: num(f[8]),
      at: Date.now(),
      source: 'sina-futures',
      degraded: true,
    }
  }
  if (f.length < 32) return null
  const price = num(f[3])
  if (price === null) return null
  const prevClose = num(f[2])
  return {
    symbol: norm.symbol,
    name: f[0] || norm.symbol,
    price,
    prevClose,
    changePercent: prevClose ? ((price - prevClose) / prevClose) * 100 : null,
    volume: num(f[8]),
    openInterest: null,
    at: Date.now(),
    source: 'sina',
    degraded: true,
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const QUOTE_TTL = 2_500
const BARS_TTL = 20_000

export class MarketDataProvider {
  constructor({ logger = console } = {}) {
    this.logger = logger
    this.quoteCache = new Map()
    this.barsCache = new Map()
    this.batchCache = { at: 0, value: [] }
  }

  /** 搜索：精确归一化直查 + 新浪 suggest（代码/名称/拼音缩写）。 */
  async search(keyword) {
    const key = String(keyword ?? '').trim()
    if (!key) return []
    const direct = normalizeSymbol(key)
    const out = []
    if (direct) {
      out.push({ symbol: direct.symbol, name: direct.symbol, market: direct.kind })
    }
    try {
      const text = await httpText(`${SINA_SUGGEST}${encodeURIComponent(key)}`, {
        headers: { referer: 'https://finance.sina.com.cn' },
        timeout: 8_000,
      })
      const body = /"([^"]*)"/.exec(text)?.[1] ?? ''
      for (const row of body.split(';')) {
        const parts = row.split(',').map((p) => p.trim())
        const txSymbol = parts.find((p) => /^(sh|sz|bj)\d{6}$/i.test(p))
        if (!txSymbol) continue
        const digits = txSymbol.replace(/^\D+/i, '')
        const market = txSymbol.slice(0, 2).toUpperCase()
        const symbol = `${digits}.${market}`
        if (out.some((o) => o.symbol === symbol)) continue
        const name = parts.find((p) => p && !/^(sh|sz|bj)\d{6}$/i.test(p) && p !== digits) ?? symbol
        out.push({ symbol, name, market: market === 'BJ' ? 'BJ' : market })
        if (out.length >= 12) break
      }
    } catch (error) {
      this.logger.warn?.(`[market-alert] search failed: ${error.message ?? error}`)
    }
    return out
  }

  /** 单只快照：腾讯主源 → 新浪备源（degraded）。 */
  async quote(rawSymbol) {
    const norm = normalizeSymbol(rawSymbol)
    if (!norm) throw new Error(`无法识别的标的：${rawSymbol}`)
    const hit = this.quoteCache.get(norm.symbol)
    if (hit && Date.now() - hit.at < QUOTE_TTL) return hit.value

    let value = null
    if (norm.tx) {
      try {
        value = parseTencent(await httpText(`${TX_QUOTE}${norm.tx}`, { timeout: 8_000 }), norm)
      } catch (error) {
        this.logger.warn?.(`[market-alert] tencent quote failed ${norm.symbol}: ${error.message ?? error}`)
      }
    }
    if (!value && (norm.sina || norm.lower)) {
      const sinaSymbol = norm.sina ?? norm.lower
      try {
        value = parseSina(
          await httpText(`${SINA_QUOTE}${sinaSymbol}`, {
            timeout: 8_000,
            headers: { referer: 'https://finance.sina.com.cn' },
          }),
          norm,
        )
      } catch (error) {
        this.logger.warn?.(`[market-alert] sina quote failed ${norm.symbol}: ${error.message ?? error}`)
      }
    }
    if (!value) throw new Error(`${norm.symbol} 行情不可用`)
    this.quoteCache.set(norm.symbol, { at: Date.now(), value })
    return value
  }

  /** 批量快照（一次腾讯请求；期货走新浪逐只）。 */
  async quotes(rawSymbols) {
    const norms = rawSymbols.map((s) => normalizeSymbol(s)).filter(Boolean)
    const txList = norms.filter((n) => n.tx)
    const cnfList = norms.filter((n) => n.kind === 'CNF')
    const out = []
    if (txList.length) {
      try {
        const text = await httpText(`${TX_QUOTE}${txList.map((n) => n.tx).join(',')}`, { timeout: 9_000 })
        for (const norm of txList) {
          const parsed = parseTencent(text, norm)
          if (parsed) { out.push(parsed); this.quoteCache.set(norm.symbol, { at: Date.now(), value: parsed }) }
        }
      } catch (error) {
        this.logger.warn?.(`[market-alert] batch quote failed: ${error.message ?? error}`)
      }
    }
    for (const norm of cnfList) {
      try {
        out.push(await this.quote(norm.symbol))
      } catch { /* 单只失败不拖垮整批 */ }
    }
    // txList 中未命中的（如美股后缀不对）也逐只重试一次备源
    const got = new Set(out.map((q) => q.symbol))
    for (const norm of norms) {
      if (got.has(norm.symbol)) continue
      try { out.push(await this.quote(norm.symbol)) } catch { /* 保留缺口 */ }
    }
    return out
  }

  /** K 线（升序、已收盘）。支持 1m–60m、1d，及由日线聚合的 1w / 1M；期货走新浪期货接口。 */
  async bars(rawSymbol, period, count = 240) {
    const norm = normalizeSymbol(rawSymbol)
    if (!norm) throw new Error(`无法识别的标的：${rawSymbol}`)
    const cacheKey = `${norm.symbol}|${period}|${count}`
    const hit = this.barsCache.get(cacheKey)
    if (hit && Date.now() - hit.at < BARS_TTL) return hit.value

    let bars = null
    let source = ''

    // 周线 / 月线：先取日线再聚合
    if (period === '1w' || period === '1M') {
      const daily = await this.bars(norm.symbol, '1d', Math.min(800, count * (period === '1w' ? 5 : 22) + 40))
      bars = aggregateCalendar(daily, period)
      source = `1d→${period}`
    } else if (norm.kind === 'CNF') {
      // 国内期货：新浪期货专用接口（通用接口不覆盖 nf_ 符号）
      if (SINA_MINUTE_SCALE[period]) {
        for (const type of [period, '5m', '15m']) {
          try {
            const arr = await sinaFuturesJson('getFewMinLine', norm.symbol, `type=${type}`)
            if (Array.isArray(arr) && arr.length) {
              bars = arr.map(parseFuturesBar).filter(Boolean).slice(-count)
              source = `sina-futures:${type}`
              break
            }
          } catch { /* 尝试降级周期 */ }
        }
      } else if (period === '1d') {
        const arr = await sinaFuturesJson('getDailyKLine', norm.symbol)
        if (Array.isArray(arr) && arr.length) {
          bars = arr.slice(-count).map(parseFuturesBar).filter(Boolean)
          source = 'sina-futures:day'
        }
      }
    } else if (SINA_MINUTE_SCALE[period] && (norm.lower || norm.sina)) {
      const sinaScale = SINA_MINUTE_SCALE[period]
      for (const base of SINA_KLINE) {
        try {
          const text = await httpText(
            `${base}?symbol=${norm.lower ?? norm.sina}&scale=${sinaScale}&ma=no&datalen=${count}`,
            { timeout: 12_000, headers: { referer: 'https://finance.sina.com.cn' } },
          )
          const arr = JSON.parse(text)
          if (Array.isArray(arr) && arr.length) {
            bars = arr.map(parseSinaBar).filter(Boolean)
            source = `sina:${period}`
            break
          }
        } catch { /* 尝试下一镜像 */ }
      }
    } else if (period === '1d' && norm.tx) {
      try {
        const text = await httpText(`${TX_DAY}${norm.tx},day,,,${count},qfq`, { timeout: 12_000 })
        const data = JSON.parse(text)?.data?.[norm.tx] ?? {}
        const rows = data.qfqday ?? data.day ?? []
        bars = rows.map((row) => ({
          t: `${row[0]} 15:00:00`,
          o: num(row[1]), h: num(row[3]), l: num(row[4]), c: num(row[2]), v: num(row[5]),
        })).filter((b) => b.c !== null)
        source = 'tencent:day'
      } catch { /* 落到新浪日线 */ }
      if (!bars && norm.lower) {
        const text = await httpText(
          `${SINA_KLINE[0]}?symbol=${norm.lower}&scale=240&ma=no&datalen=${count * 4}`,
          { timeout: 12_000, headers: { referer: 'https://finance.sina.com.cn' } },
        )
        const arr = JSON.parse(text)
        if (Array.isArray(arr)) {
          bars = aggregateDaily(arr.map(parseSinaBar).filter(Boolean))
          source = 'sina:240m→1d'
        }
      }
    }
    if (!bars || !bars.length) throw new Error(`${norm.symbol} ${period} K 线不可用`)
    this.barsCache.set(cacheKey, { at: Date.now(), value: bars })
    return bars
  }

  /**
   * 交易时段判断（周一至周五；A 股 9:30–11:30 / 13:00–15:00，
   * 港股 9:30–12:00 / 13:00–16:00，美股按北京时间 21:30–04:00（近似，含冬令时误差），
   * 期货 9:00–10:15 / 10:30–11:30 / 13:30–15:00 + 夜盘 21:00–23:00（近似）。
   * 法定节假日未纳入（P0 近似，N-03 的日历可配置留给 P1）。
   */
  inSession(rawSymbol, at = new Date()) {
    const norm = normalizeSymbol(rawSymbol)
    if (!norm) return true
    const bj = new Date(at.getTime() + 8 * 3_600_000)
    const day = bj.getUTCDay()
    const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()
    const mm = dateOfDay(bj)
    const inRanges = (ranges) => day >= 1 && day <= 5 && ranges.some(([a, b]) => minutes >= a && minutes < b)
    switch (norm.kind) {
      case 'A': return inRanges([[570, 690], [780, 900]]) && !isHolidayDate(mm)
      case 'HK': return inRanges([[570, 720], [780, 960]])
      case 'US': return inRanges([[1290, 1440], [0, 240]])
      case 'CNF': return inRanges([[540, 615], [630, 690], [810, 900], [1260, 1380]])
      default: return true
    }
  }
}

function dateOfDay(bj) {
  const y = bj.getUTCFullYear()
  const mo = bj.getUTCMonth() + 1
  const d = bj.getUTCDate()
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** A 股休市日近似：仅固定假期窗口（元旦/春节/五一/国庆），P1 再接交易日历。 */
function isHolidayDate(date) {
  const [, mo, d] = date.split('-').map(Number)
  if (mo === 1 && d <= 1) return true
  if (mo === 5 && d <= 5) return true
  if (mo === 10 && d <= 7) return true
  if (mo === 2 && d <= 4) return true // 春节窗口的粗略近似
  return false
}

function parseSinaBar(row) {
  const day = String(row.day ?? '')
  // 分钟接口把时间并进 day（'2026-11-23 14:30:00'），日线只有日期；两种都兼容。
  const time = String(row.time ?? (day.includes(' ') ? day.slice(11) : ''))
  if (!day || !time) return null
  const bar = {
    t: `${day.slice(0, 10)} ${time.slice(0, 5)}:00`,
    o: num(row.open), h: num(row.high), l: num(row.low), c: num(row.close), v: num(row.volume),
  }
  return bar.o !== null && bar.c !== null && bar.c > 0 ? bar : null
}

const SINA_FUTURES_API = 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_FMA=/InnerFuturesNewService.'

/** 新浪国内期货接口（jsonp 包裹的 JSON 数组）。 */
async function sinaFuturesJson(method, symbol, query = '') {
  const url = `${SINA_FUTURES_API}${method}?symbol=${symbol}${query ? `&${query}` : ''}`
  const text = await httpText(url, {
    timeout: 12_000,
    headers: { referer: 'https://finance.sina.com.cn' },
  })
  const m = /\[(?:[\s\S])*\]/.exec(text)
  if (!m) return null
  return JSON.parse(m[0])
}

/** 新浪期货 bar：{ d, o, h, l, c, v }；分钟接口 d 含时刻，日线只有日期。 */
function parseFuturesBar(row) {
  const d = String(row.d ?? '')
  if (!d) return null
  const t = d.length <= 10 ? `${d} 15:00:00` : d.slice(0, 19)
  const bar = { t, o: num(row.o), h: num(row.h), l: num(row.l), c: num(row.c), v: num(row.v) }
  return bar.o !== null && bar.c !== null && bar.c > 0 ? bar : null
}

/** ISO 周标签（周一为一周起点，跨年归属按 ISO 8601）。 */
function isoWeekKey(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** 日线聚合为周线 / 月线（mode: '1w' | '1M'）。 */
function aggregateCalendar(daily, mode) {
  const groups = new Map()
  for (const bar of daily) {
    const date = bar.t.slice(0, 10)
    const key = mode === '1w' ? isoWeekKey(date) : date.slice(0, 7)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(bar)
  }
  const out = []
  for (const group of groups.values()) {
    group.sort((a, b) => (a.t < b.t ? -1 : 1))
    out.push({
      t: `${group[group.length - 1].t.slice(0, 10)} 15:00:00`,
      o: group[0].o,
      h: Math.max(...group.map((b) => b.h)),
      l: Math.min(...group.map((b) => b.l)),
      c: group[group.length - 1].c,
      v: group.reduce((sum, b) => sum + (b.v ?? 0), 0),
    })
  }
  return out.sort((a, b) => (a.t < b.t ? -1 : 1))
}

/** 240 分钟 bar 聚合成日线（按自然日分组）。 */
function aggregateDaily(bars) {
  const byDate = new Map()
  for (const bar of bars) {
    const date = bar.t.slice(0, 10)
    if (!byDate.has(date)) byDate.set(date, [])
    byDate.get(date).push(bar)
  }
  const out = []
  for (const [date, group] of byDate) {
    group.sort((a, b) => (a.t < b.t ? -1 : 1))
    out.push({
      t: `${date} 15:00:00`,
      o: group[0].o,
      h: Math.max(...group.map((g) => g.h)),
      l: Math.min(...group.map((g) => g.l)),
      c: group[group.length - 1].c,
      v: group.reduce((sum, g) => sum + (g.v ?? 0), 0),
    })
  }
  return out.sort((a, b) => (a.t < b.t ? -1 : 1))
}
