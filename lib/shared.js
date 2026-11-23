/**
 * dsh-market-alert — Host 与测试共用的纯函数。
 *
 * 指标计算、穿越判定、规则评估与状态机迁移全部无副作用：
 * 输入数据 → 输出结果，不碰网络、文件或时钟。
 *
 * 全文统一命名（与 docs/contract.md 一致）：
 *   规则类型 RULE_KINDS：price_above | price_below | pct_above | pct_below
 *                     | macd_golden | macd_dead | kdj_j_above | kdj_j_below
 *   规则阶段 PHASES   ：ARMED | TRIGGERED | COOLING | DISABLED
 *   状态字段          ：lastPrice / lastPct / lastBarT / lastTriggeredAt / cooldownMin
 *   bar 字段          ：{ t, o, h, l, c, v }，t = 收盘时刻（北京时间字符串）
 */

export const PERIODS = ['1m', '5m', '15m', '30m', '60m', '1d']

export const RULE_KINDS = [
  'price_above', 'price_below',
  'pct_above', 'pct_below',
  'macd_golden', 'macd_dead',
  'kdj_j_above', 'kdj_j_below',
]

export const PHASES = ['ARMED', 'TRIGGERED', 'COOLING', 'DISABLED']

// ---------------------------------------------------------------------------
// 指标（纯函数：输入序列 → 与输入等长的输出序列，不足处为 null）
// ---------------------------------------------------------------------------

/** EMA 序列。 */
export function ema(values, period) {
  const k = 2 / (period + 1)
  const out = []
  let prev = null
  for (const v of values) {
    if (v === null || v === undefined || !Number.isFinite(v)) { out.push(null); continue }
    prev = prev === null ? v : v * k + prev * (1 - k)
    out.push(prev)
  }
  return out
}

/** MACD（标准 12/26/9）：{ dif, dea, hist }，hist = DIF - DEA。 */
export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast)
  const emaSlow = ema(closes, slow)
  const dif = closes.map((_, i) =>
    (emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null))
  const firstValid = dif.findIndex((v) => v !== null)
  const dea = new Array(closes.length).fill(null)
  if (firstValid >= 0) {
    const deaRaw = ema(dif.slice(firstValid), signal)
    for (let i = 0; i < deaRaw.length; i += 1) dea[firstValid + i] = deaRaw[i]
  }
  const hist = dif.map((v, i) => (v !== null && dea[i] !== null ? v - dea[i] : null))
  return { dif, dea, hist }
}

/** KDJ（标准口径 9,3,3）：RSV=(C-Ln)/(Hn-Ln)×100；K=2/3K'+1/3RSV；D=2/3D'+1/3K；J=3K-2D。 */
export function kdj(bars, n = 9, m1 = 3, m2 = 3) {
  const kArr = []
  const dArr = []
  const jArr = []
  let kPrev = 50
  let dPrev = 50
  for (let i = 0; i < bars.length; i += 1) {
    const start = Math.max(0, i - n + 1)
    let hh = -Infinity
    let ll = Infinity
    for (let j = start; j <= i; j += 1) {
      hh = Math.max(hh, bars[j].h)
      ll = Math.min(ll, bars[j].l)
    }
    const rsv = hh === ll ? 50 : ((bars[i].c - ll) / (hh - ll)) * 100
    kPrev = ((m1 - 1) / m1) * kPrev + (1 / m1) * rsv
    dPrev = ((m2 - 1) / m2) * dPrev + (1 / m2) * kPrev
    kArr.push(kPrev)
    dArr.push(dPrev)
    jArr.push(3 * kPrev - 2 * dPrev)
  }
  return { k: kArr, d: dArr, j: jArr }
}

/** RSI（Wilder 平滑，默认 14）。 */
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null)
  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i < closes.length; i += 1) {
    const chg = closes[i] - closes[i - 1]
    const gain = Math.max(chg, 0)
    const loss = Math.max(-chg, 0)
    if (i <= period) {
      avgGain += gain / period
      avgLoss += loss / period
      if (i === period) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period
      avgLoss = (avgLoss * (period - 1) + loss) / period
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
    }
  }
  return out
}

/** 简单均线。 */
export function sma(closes, period) {
  return closes.map((_, i) => {
    if (i + 1 < period) return null
    let sum = 0
    for (let j = i - period + 1; j <= i; j += 1) sum += closes[j]
    return sum / period
  })
}

/** 布林带（中轨 MA(n)，上下轨 ±k·σ）。 */
export function boll(closes, period = 20, width = 2) {
  const mid = sma(closes, period)
  const upper = []
  const lower = []
  for (let i = 0; i < closes.length; i += 1) {
    if (mid[i] === null) { upper.push(null); lower.push(null); continue }
    let variance = 0
    for (let j = i - period + 1; j <= i; j += 1) variance += (closes[j] - mid[i]) ** 2
    const sd = Math.sqrt(variance / period)
    upper.push(mid[i] + width * sd)
    lower.push(mid[i] - width * sd)
  }
  return { mid, upper, lower }
}

/** ATR（Wilder，默认 14）。 */
export function atr(bars, period = 14) {
  const out = new Array(bars.length).fill(null)
  let prevAtr = null
  let sum = 0
  for (let i = 0; i < bars.length; i += 1) {
    const prevClose = i > 0 ? bars[i - 1].c : bars[i].o
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - prevClose),
      Math.abs(bars[i].l - prevClose),
    )
    if (i < period) {
      sum += tr
      if (i === period - 1) { prevAtr = sum / period; out[i] = prevAtr }
    } else {
      prevAtr = (prevAtr * (period - 1) + tr) / period
      out[i] = prevAtr
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 穿越判定（阈值防抖的核心语义，见 docs/contract.md §4）
// ---------------------------------------------------------------------------

export function crossedAbove(prev, now, threshold) {
  return prev !== null && prev !== undefined
    && now !== null && now !== undefined
    && prev < threshold && now >= threshold
}

export function crossedBelow(prev, now, threshold) {
  return prev !== null && prev !== undefined
    && now !== null && now !== undefined
    && prev > threshold && now <= threshold
}

/** 金叉 / 死叉：两个等长序列的最后一对值。 */
export function goldenCross(prevFast, prevSlow, nowFast, nowSlow) {
  return prevFast != null && prevSlow != null && nowFast != null && nowSlow != null
    && prevFast <= prevSlow && nowFast > nowSlow
}

export function deadCross(prevFast, prevSlow, nowFast, nowSlow) {
  return prevFast != null && prevSlow != null && nowFast != null && nowSlow != null
    && prevFast >= prevSlow && nowFast < nowSlow
}

// ---------------------------------------------------------------------------
// 状态机：ARMED / TRIGGERED / COOLING / DISABLED
// ---------------------------------------------------------------------------

const TRANSITIONS = {
  ARMED: { TRIGGERED: true, DISABLED: true },
  TRIGGERED: { ARMED: true, COOLING: true, DISABLED: true },
  COOLING: { ARMED: true, DISABLED: true },
  DISABLED: { ARMED: true },
}

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.[to])
}

/** 触发后的自动迁移：once 保持 TRIGGERED 等确认；every 进 COOLING。 */
export function phaseAfterTrigger(mode) {
  return mode === 'every' ? 'COOLING' : 'TRIGGERED'
}

/** COOLING 是否已到冷却期满。 */
export function coolingElapsed(state, now = Date.now()) {
  return state.phase === 'COOLING'
    && state.lastTriggeredAt !== null
    && now - state.lastTriggeredAt >= state.cooldownMin * 60_000
}

// ---------------------------------------------------------------------------
// 规则评估（纯函数）
//
// 输入：
//   rule  — AlertRule（docs/contract.md §2）
//   state — AlertState（只读，docs/contract.md §3）
//   input — 价格/涨跌幅类：{ price, changePercent }
//           指标类：{ bars }（升序已收盘 bar 序列，≥ 40 根）
// 返回 { hit, value, detail }；hit=true 时评估者负责迁移与广播。
// 指标类只在最后一根已收盘 bar 未被评估过时给出非 no-new-bar 结果。
// ---------------------------------------------------------------------------

export function evaluateRule(rule, state, input) {
  const lastOf = (arr) => (arr.length ? arr[arr.length - 1] : null)
  const secondLastOf = (arr) => (arr.length >= 2 ? arr[arr.length - 2] : null)
  const no = (detail) => ({ hit: false, value: null, detail })

  if (rule.kind === 'price_above' || rule.kind === 'price_below') {
    const price = input.price
    if (!Number.isFinite(price)) return no('no price')
    const hit = rule.kind === 'price_above'
      ? crossedAbove(state.lastPrice, price, rule.threshold)
      : crossedBelow(state.lastPrice, price, rule.threshold)
    return { hit, value: price, detail: `现价 ${price} ${rule.kind === 'price_above' ? '≥' : '≤'} ${rule.threshold}` }
  }

  if (rule.kind === 'pct_above' || rule.kind === 'pct_below') {
    const pct = input.changePercent
    if (!Number.isFinite(pct)) return no('no change percent')
    const hit = rule.kind === 'pct_above'
      ? crossedAbove(state.lastPct, pct, rule.threshold)
      : crossedBelow(state.lastPct, pct, rule.threshold)
    return { hit, value: pct, detail: `涨跌幅 ${pct.toFixed(2)}% ${rule.kind === 'pct_above' ? '≥' : '≤'} ${rule.threshold}%` }
  }

  const bars = input.bars
  if (!Array.isArray(bars) || bars.length < 40) return no('insufficient bars')
  const lastBar = lastOf(bars)
  if (state.lastBarT === lastBar.t) return no('no new bar')
  const closes = bars.map((b) => b.c)

  if (rule.kind === 'macd_golden' || rule.kind === 'macd_dead') {
    const { dif, dea } = macd(closes)
    const f1 = secondLastOf(dif)
    const s1 = secondLastOf(dea)
    const f0 = lastOf(dif)
    const s0 = lastOf(dea)
    if (rule.kind === 'macd_golden') {
      const hit = goldenCross(f1, s1, f0, s0)
      return { hit, value: f0, detail: `MACD 金叉（DIF ${fmt(f0)} 上穿 DEA ${fmt(s0)}）@ ${lastBar.t}` }
    }
    const hit = deadCross(f1, s1, f0, s0)
    return { hit, value: f0, detail: `MACD 死叉（DIF ${fmt(f0)} 下穿 DEA ${fmt(s0)}）@ ${lastBar.t}` }
  }

  if (rule.kind === 'kdj_j_above' || rule.kind === 'kdj_j_below') {
    const { j } = kdj(bars)
    const prevJ = secondLastOf(j)
    const nowJ = lastOf(j)
    if (rule.kind === 'kdj_j_above') {
      const hit = crossedAbove(prevJ, nowJ, rule.threshold)
      return { hit, value: nowJ, detail: `KDJ J=${fmt(nowJ)} 上穿 ${rule.threshold} @ ${lastBar.t}` }
    }
    const hit = crossedBelow(prevJ, nowJ, rule.threshold)
    return { hit, value: nowJ, detail: `KDJ J=${fmt(nowJ)} 下穿 ${rule.threshold} @ ${lastBar.t}` }
  }

  return no('unknown kind')
}

function fmt(v) {
  return Number.isFinite(v) ? Number(v).toFixed(2) : String(v)
}

/** 规则摘要（告警事件与规则列表共用）。 */
export function ruleSummary(rule) {
  const period = rule.period ? ` · ${rule.period}` : ''
  const label = rule.name || rule.symbol
  switch (rule.kind) {
    case 'price_above': return `${label} 价格 ≥ ${rule.threshold}`
    case 'price_below': return `${label} 价格 ≤ ${rule.threshold}`
    case 'pct_above': return `${label} 涨幅 ≥ ${rule.threshold}%`
    case 'pct_below': return `${label} 跌幅 ≤ ${rule.threshold}%`
    case 'macd_golden': return `${label} MACD 金叉${period}`
    case 'macd_dead': return `${label} MACD 死叉${period}`
    case 'kdj_j_above': return `${label} KDJ J ≥ ${rule.threshold}${period}`
    case 'kdj_j_below': return `${label} KDJ J ≤ ${rule.threshold}${period}`
    default: return `${rule.symbol} 未知规则`
  }
}
