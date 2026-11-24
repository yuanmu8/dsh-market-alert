/**
 * dsh-market-alert — Host 与测试共用的纯函数。
 *
 * 指标计算、穿越判定、规则评估与状态机迁移全部无副作用：
 * 输入数据 → 输出结果，不碰网络、文件或时钟。
 *
 * 全文统一命名（与 docs/contract.md 一致）：
 *   规则类型 RULE_KINDS：price_above | price_below | pct_above | pct_below
 *                     | macd_golden | macd_dead | kdj_j_above | kdj_j_below
 *                     | rsi_above | rsi_below
 *                     | boll_touch_upper | boll_touch_low | boll_break_upper | boll_break_low
 *                     | ma_cross_up | ma_cross_down
 *                     | price_cross_ma_up | price_cross_ma_down
 *   规则阶段 PHASES   ：ARMED | TRIGGERED | COOLING | DISABLED
 *   状态字段          ：lastPrice / lastPct / lastBarT / lastTriggeredAt / cooldownMin
 *   bar 字段          ：{ t, o, h, l, c, v }，t = 收盘时刻（北京时间字符串）
 *
 * 条件组（可选，向后兼容）：
 *   rule.logic  ：'AND' | 'OR'，缺省 'AND'
 *   rule.extra  ：Condition[]，附加条件，≤ 4 个（与主条件合计 ≤ 5）
 *   Condition   ：{ kind, threshold?, period?, fast?, slow? }
 *   没有 logic / extra 的旧规则即单条件规则，读取与评估行为不变。
 */

export const PERIODS = ['1m', '5m', '15m', '30m', '60m', '1d']

export const RULE_KINDS = [
  'price_above', 'price_below',
  'pct_above', 'pct_below',
  'macd_golden', 'macd_dead',
  'kdj_j_above', 'kdj_j_below',
  'rsi_above', 'rsi_below',
  'boll_touch_upper', 'boll_touch_low', 'boll_break_upper', 'boll_break_low',
  'ma_cross_up', 'ma_cross_down',
  'price_cross_ma_up', 'price_cross_ma_down',
]

/** 规则里允许的附加条件上限（不含主条件）。 */
export const MAX_EXTRA_CONDITIONS = 4

/** 条件组组合方式。 */
export const RULE_LOGICS = ['AND', 'OR']

/** 指标类条件：依赖已收盘 bar 序列，rule.period / cond.period 是其 K 线周期。 */
export const INDICATOR_KINDS = [
  'macd_golden', 'macd_dead', 'kdj_j_above', 'kdj_j_below',
  'rsi_above', 'rsi_below',
  'boll_touch_upper', 'boll_touch_low', 'boll_break_upper', 'boll_break_low',
  'ma_cross_up', 'ma_cross_down', 'price_cross_ma_up', 'price_cross_ma_down',
]

export const isIndicatorKind = (kind) => INDICATOR_KINDS.includes(kind)

/** 指标参数默认值（与历史实现一致；evaluateRule 的 opts 可逐项覆盖）。 */
export const DEFAULT_OPTS = {
  rsiPeriod: 14,
  maFast: 5,
  maSlow: 20,
  bollPeriod: 20,
  bollWidth: 2,
  kdjN: 9,
  kdjM1: 3,
  kdjM2: 3,
}

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
//   rule  — AlertRule（docs/contract.md §2）；主条件 = rule.kind/threshold/period
//           可选条件组：rule.logic（'AND'|'OR'，默认 AND）+ rule.extra（Condition[]，≤ 4）
//   state — AlertState（只读，docs/contract.md §3）
//   input — 价格/涨跌幅类：{ price, changePercent }
//           指标类：{ bars }（升序已收盘 bar 序列，≥ 40 根）
//   opts  — 可选指标参数 { rsiPeriod, maFast, maSlow, bollPeriod, bollWidth, kdjN, kdjM1, kdjM2 }
// 返回 { hit, value, detail }；hit=true 时评估者负责迁移与广播。
// 指标类只在最后一根已收盘 bar 未被评估过时给出非 no-new-bar 结果。
//
// 条件组语义：
//   - extra 为空 / 不存在 → 完全等于 evaluateSingle(主条件)，旧规则零迁移
//   - 指标类子条件共享 input.bars 这一份序列，因此周期必须一致；
//     周期不一致直接 no('mixed periods unsupported')，绝不静默算错
//   - 非指标类子条件（price_* / pct_*）不涉及周期，不参与周期一致性检查
// ---------------------------------------------------------------------------

const lastOf = (arr) => (arr.length ? arr[arr.length - 1] : null)
const secondLastOf = (arr) => (arr.length >= 2 ? arr[arr.length - 2] : null)
const no = (detail) => ({ hit: false, value: null, detail })

function resolveOpts(opts) {
  return { ...DEFAULT_OPTS, ...(opts && typeof opts === 'object' ? opts : {}) }
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/**
 * 单个条件的评估（主条件与 extra 里的附加条件共用）。
 * cond 形如 { kind, threshold?, period?, fast?, slow? }。
 * cache 供条件组内复算同一份指标序列（evaluateRule 内部传入，外部一般不用给）。
 */
export function evaluateSingle(cond, state, input, opts = {}, cache = null) {
  const o = resolveOpts(opts)

  if (cond.kind === 'price_above' || cond.kind === 'price_below') {
    const price = input.price
    if (!Number.isFinite(price)) return no('no price')
    const hit = cond.kind === 'price_above'
      ? crossedAbove(state.lastPrice, price, cond.threshold)
      : crossedBelow(state.lastPrice, price, cond.threshold)
    return { hit, value: price, detail: `现价 ${price} ${cond.kind === 'price_above' ? '≥' : '≤'} ${cond.threshold}` }
  }

  if (cond.kind === 'pct_above' || cond.kind === 'pct_below') {
    const pct = input.changePercent
    if (!Number.isFinite(pct)) return no('no change percent')
    const hit = cond.kind === 'pct_above'
      ? crossedAbove(state.lastPct, pct, cond.threshold)
      : crossedBelow(state.lastPct, pct, cond.threshold)
    return { hit, value: pct, detail: `涨跌幅 ${pct.toFixed(2)}% ${cond.kind === 'pct_above' ? '≥' : '≤'} ${cond.threshold}%` }
  }

  if (!isIndicatorKind(cond.kind)) return no('unknown kind')

  const bars = input.bars
  if (!Array.isArray(bars) || bars.length < 40) return no('insufficient bars')
  const lastBar = lastOf(bars)
  if (state.lastBarT === lastBar.t) return no('no new bar')

  // 指标序列按参数缓存：条件组内同类同参条件只算一次
  const c = cache || {}
  const memo = (key, make) => (Object.prototype.hasOwnProperty.call(c, key) ? c[key] : (c[key] = make()))
  const closes = memo('closes', () => bars.map((b) => b.c))
  const at = (t) => `@ ${lastBar.t}`

  if (cond.kind === 'macd_golden' || cond.kind === 'macd_dead') {
    const { dif, dea } = memo('macd', () => macd(closes))
    const f1 = secondLastOf(dif)
    const s1 = secondLastOf(dea)
    const f0 = lastOf(dif)
    const s0 = lastOf(dea)
    if (cond.kind === 'macd_golden') {
      const hit = goldenCross(f1, s1, f0, s0)
      return { hit, value: f0, detail: `MACD 金叉（DIF ${fmt(f0)} 上穿 DEA ${fmt(s0)}）${at()}` }
    }
    const hit = deadCross(f1, s1, f0, s0)
    return { hit, value: f0, detail: `MACD 死叉（DIF ${fmt(f0)} 下穿 DEA ${fmt(s0)}）${at()}` }
  }

  if (cond.kind === 'kdj_j_above' || cond.kind === 'kdj_j_below') {
    const { j } = memo(`kdj:${o.kdjN},${o.kdjM1},${o.kdjM2}`, () => kdj(bars, o.kdjN, o.kdjM1, o.kdjM2))
    const prevJ = secondLastOf(j)
    const nowJ = lastOf(j)
    if (cond.kind === 'kdj_j_above') {
      const hit = crossedAbove(prevJ, nowJ, cond.threshold)
      return { hit, value: nowJ, detail: `KDJ J=${fmt(nowJ)} 上穿 ${cond.threshold} ${at()}` }
    }
    const hit = crossedBelow(prevJ, nowJ, cond.threshold)
    return { hit, value: nowJ, detail: `KDJ J=${fmt(nowJ)} 下穿 ${cond.threshold} ${at()}` }
  }

  if (cond.kind === 'rsi_above' || cond.kind === 'rsi_below') {
    const p = positiveInt(o.rsiPeriod, DEFAULT_OPTS.rsiPeriod)
    const arr = memo(`rsi:${p}`, () => rsi(closes, p))
    const prev = secondLastOf(arr)
    const now = lastOf(arr)
    if (prev === null || now === null) return no('insufficient bars')
    if (cond.kind === 'rsi_above') {
      const hit = crossedAbove(prev, now, cond.threshold)
      return { hit, value: now, detail: `RSI(${p}) ${fmt(now)} 上穿 ${cond.threshold} ${at()}` }
    }
    const hit = crossedBelow(prev, now, cond.threshold)
    return { hit, value: now, detail: `RSI(${p}) ${fmt(now)} 下穿 ${cond.threshold} ${at()}` }
  }

  if (cond.kind.startsWith('boll_')) {
    // 参数：指标长度取 cond.period（若为正整数则视为 BOLL 的 N），否则取 opts.bollPeriod。
    // 注意：条件组周期一致性检查只看「周期字符串」，这里只在 cond.period 是数字时借用，不冲突。
    const p = Number.isInteger(cond.period) && cond.period > 0 ? cond.period : positiveInt(o.bollPeriod, DEFAULT_OPTS.bollPeriod)
    const w = Number.isFinite(o.bollWidth) ? o.bollWidth : DEFAULT_OPTS.bollWidth
    const { upper, lower } = memo(`boll:${p},${w}`, () => boll(closes, p, w))
    const prevClose = secondLastOf(closes)
    const nowClose = lastOf(closes)
    const up = cond.kind.endsWith('upper')
    const band = up ? upper : lower
    const prevBand = secondLastOf(band)
    const nowBand = lastOf(band)
    if (prevBand === null || nowBand === null) return no('insufficient bars')
    // touch：收盘价穿越轨道（prev.close 在轨道内侧 且 now.close 触到/越过轨道）
    // break：按定义应要求收盘「严格」站上/跌破超过带宽的一定比例。
    //        当前简化为与 touch 相同的穿越判定，差异（如 (close - upper) / (upper - lower) ≥ ratio）
    //        留给后续：加一个 cond.ratio / opts.breakRatio 再在此处分叉即可，无需改结构。
    const hit = up
      ? prevClose < prevBand && nowClose >= nowBand
      : prevClose > prevBand && nowClose <= nowBand
    const verb = cond.kind.startsWith('boll_break') ? (up ? '突破上轨' : '跌破下轨') : (up ? '触及上轨' : '触及下轨')
    return { hit, value: nowClose, detail: `收盘 ${fmt(nowClose)} ${verb} ${fmt(nowBand)}（BOLL ${p}）${at()}` }
  }

  if (cond.kind === 'ma_cross_up' || cond.kind === 'ma_cross_down') {
    const fast = positiveInt(cond.fast, positiveInt(o.maFast, DEFAULT_OPTS.maFast))
    const slow = positiveInt(cond.slow, positiveInt(o.slow ?? o.maSlow, DEFAULT_OPTS.maSlow))
    const fastArr = memo(`sma:${fast}`, () => sma(closes, fast))
    const slowArr = memo(`sma:${slow}`, () => sma(closes, slow))
    if (cond.kind === 'ma_cross_up') {
      const hit = goldenCross(secondLastOf(fastArr), secondLastOf(slowArr), lastOf(fastArr), lastOf(slowArr))
      return { hit, value: lastOf(fastArr), detail: `MA(${fast}) ${fmt(lastOf(fastArr))} 上穿 MA(${slow}) ${fmt(lastOf(slowArr))} ${at()}` }
    }
    const hit = deadCross(secondLastOf(fastArr), secondLastOf(slowArr), lastOf(fastArr), lastOf(slowArr))
    return { hit, value: lastOf(fastArr), detail: `MA(${fast}) ${fmt(lastOf(fastArr))} 下穿 MA(${slow}) ${fmt(lastOf(slowArr))} ${at()}` }
  }

  // price_cross_ma_up / price_cross_ma_down：threshold = 均线的 N
  {
    const n = positiveInt(cond.threshold, DEFAULT_OPTS.maSlow)
    const maArr = memo(`sma:${n}`, () => sma(closes, n))
    const prevClose = secondLastOf(closes)
    const nowClose = lastOf(closes)
    const prevMa = secondLastOf(maArr)
    const nowMa = lastOf(maArr)
    if (cond.kind === 'price_cross_ma_up') {
      const hit = prevMa !== null && nowMa !== null && prevClose < prevMa && nowClose >= nowMa
      return { hit, value: nowClose, detail: `收盘 ${fmt(nowClose)} 上穿 MA(${n}) ${fmt(nowMa)} ${at()}` }
    }
    const hit = prevMa !== null && nowMa !== null && prevClose > prevMa && nowClose <= nowMa
    return { hit, value: nowClose, detail: `收盘 ${fmt(nowClose)} 下穿 MA(${n}) ${fmt(nowMa)} ${at()}` }
  }
}

/** 条件组里的周期是否一致：所有指标类条件的周期字符串必须相同（缺省视为 null）。 */
function mixedPeriod(conditions) {
  let seen = false
  let period
  for (const cond of conditions) {
    if (!isIndicatorKind(cond.kind)) continue
    const p = typeof cond.period === 'string' && cond.period ? cond.period : null
    if (!seen) { seen = true; period = p; continue }
    if (p !== period) return true
  }
  return false
}

/**
 * 规则评估。签名：evaluateRule(rule, state, input, opts = {})
 *   - 无 extra → evaluateSingle(主条件)，与旧实现逐字一致
 *   - 有 extra → 先做结构校验（≤ 4 条、kind 合法、周期一致），再按 logic 合并
 */
export function evaluateRule(rule, state, input, opts = {}) {
  if (!rule || typeof rule !== 'object') return no('invalid rule')
  const extra = Array.isArray(rule.extra) ? rule.extra.filter((c) => c && typeof c === 'object') : []
  if (extra.length === 0) return evaluateSingle(rule, state, input, opts)

  if (extra.length > MAX_EXTRA_CONDITIONS) return no('too many conditions')
  if (rule.logic !== undefined && !RULE_LOGICS.includes(rule.logic)) return no('invalid logic')
  const conditions = [rule, ...extra]
  for (const cond of conditions) {
    if (typeof cond.kind !== 'string' || !RULE_KINDS.includes(cond.kind)) return no('unknown kind')
  }
  if (mixedPeriod(conditions)) return no('mixed periods unsupported')

  // 防重放与数据不足对整组生效：只要组里有指标类条件，就只在「新收盘 bar」上评估一次
  if (conditions.some((cond) => isIndicatorKind(cond.kind))) {
    const bars = input && input.bars
    if (!Array.isArray(bars) || bars.length < 40) return no('insufficient bars')
    if (state.lastBarT === lastOf(bars).t) return no('no new bar')
  }

  const logic = rule.logic === 'OR' ? 'OR' : 'AND'
  const cache = {}
  const results = conditions.map((cond) => evaluateSingle(cond, state, input, opts, cache))
  const hit = logic === 'OR'
    ? results.some((r) => r.hit)
    : results.every((r) => r.hit)
  const detail = results.map((r) => r.detail).join(logic === 'OR' ? ' 或 ' : ' 且 ')
  return { hit, value: results[0].value, detail }
}

function fmt(v) {
  return Number.isFinite(v) ? Number(v).toFixed(2) : String(v)
}

/** 单个条件的中文摘要（不含标的），供 ruleSummary 拼条件组。 */
function condSummary(cond) {
  switch (cond.kind) {
    case 'rsi_above': return `RSI 上穿 ${cond.threshold}`
    case 'rsi_below': return `RSI 下穿 ${cond.threshold}`
    case 'boll_touch_upper': return '触及 BOLL 上轨'
    case 'boll_touch_low': return '触及 BOLL 下轨'
    case 'boll_break_upper': return '突破 BOLL 上轨'
    case 'boll_break_low': return '跌破 BOLL 下轨'
    case 'ma_cross_up': return `MA(${cond.fast ?? DEFAULT_OPTS.maFast}) 上穿 MA(${cond.slow ?? DEFAULT_OPTS.maSlow})`
    case 'ma_cross_down': return `MA(${cond.fast ?? DEFAULT_OPTS.maFast}) 下穿 MA(${cond.slow ?? DEFAULT_OPTS.maSlow})`
    case 'price_cross_ma_up': return `价格上穿 MA(${cond.threshold ?? DEFAULT_OPTS.maSlow})`
    case 'price_cross_ma_down': return `价格下穿 MA(${cond.threshold ?? DEFAULT_OPTS.maSlow})`
    case 'price_above': return `价格 ≥ ${cond.threshold}`
    case 'price_below': return `价格 ≤ ${cond.threshold}`
    case 'pct_above': return `涨幅 ≥ ${cond.threshold}%`
    case 'pct_below': return `跌幅 ≤ ${cond.threshold}%`
    case 'macd_golden': return 'MACD 金叉'
    case 'macd_dead': return 'MACD 死叉'
    case 'kdj_j_above': return `KDJ J ≥ ${cond.threshold}`
    case 'kdj_j_below': return `KDJ J ≤ ${cond.threshold}`
    default: return '未知条件'
  }
}

/** 规则摘要（告警事件与规则列表共用）。有附加条件时追加「且/或 …」。 */
export function ruleSummary(rule) {
  const period = rule.period ? ` · ${rule.period}` : ''
  const label = rule.name || rule.symbol
  const base = (() => {
    switch (rule.kind) {
      case 'price_above': return `${label} 价格 ≥ ${rule.threshold}`
      case 'price_below': return `${label} 价格 ≤ ${rule.threshold}`
      case 'pct_above': return `${label} 涨幅 ≥ ${rule.threshold}%`
      case 'pct_below': return `${label} 跌幅 ≤ ${rule.threshold}%`
      case 'macd_golden': return `${label} MACD 金叉${period}`
      case 'macd_dead': return `${label} MACD 死叉${period}`
      case 'kdj_j_above': return `${label} KDJ J ≥ ${rule.threshold}${period}`
      case 'kdj_j_below': return `${label} KDJ J ≤ ${rule.threshold}${period}`
      case 'rsi_above': return `${label} RSI 上穿 ${rule.threshold}${period}`
      case 'rsi_below': return `${label} RSI 下穿 ${rule.threshold}${period}`
      case 'boll_touch_upper': return `${label} 触及 BOLL 上轨${period}`
      case 'boll_touch_low': return `${label} 触及 BOLL 下轨${period}`
      case 'boll_break_upper': return `${label} 突破 BOLL 上轨${period}`
      case 'boll_break_low': return `${label} 跌破 BOLL 下轨${period}`
      case 'ma_cross_up': return `${label} MA(${rule.fast ?? DEFAULT_OPTS.maFast}) 上穿 MA(${rule.slow ?? DEFAULT_OPTS.maSlow})${period}`
      case 'ma_cross_down': return `${label} MA(${rule.fast ?? DEFAULT_OPTS.maFast}) 下穿 MA(${rule.slow ?? DEFAULT_OPTS.maSlow})${period}`
      case 'price_cross_ma_up': return `${label} 价格上穿 MA(${rule.threshold ?? DEFAULT_OPTS.maSlow})${period}`
      case 'price_cross_ma_down': return `${label} 价格下穿 MA(${rule.threshold ?? DEFAULT_OPTS.maSlow})${period}`
      default: return `${rule.symbol} 未知规则`
    }
  })()
  const extra = Array.isArray(rule.extra) ? rule.extra.filter((c) => c && typeof c === 'object') : []
  if (extra.length === 0) return base
  const joiner = rule.logic === 'OR' ? ' 或 ' : ' 且 '
  const extraPeriod = (c) => (c.period && c.period !== rule.period ? ` · ${c.period}` : '')
  return base + extra.map((c) => joiner + condSummary(c) + extraPeriod(c)).join('')
}
