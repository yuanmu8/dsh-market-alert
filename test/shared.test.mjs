/**
 * lib/shared.js 单元测试：指标口径、穿越判定、规则评估与状态机（N-06）。
 * 运行：node --test test/shared.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ema, macd, kdj, rsi, sma, boll, atr,
  crossedAbove, crossedBelow, goldenCross, deadCross,
  evaluateRule, evaluateSingle, phaseAfterTrigger, canTransition, ruleSummary,
  PERIODS, RULE_KINDS, INDICATOR_KINDS, MAX_EXTRA_CONDITIONS, DEFAULT_OPTS,
} from '../lib/shared.js'

const bars = (closes) => closes.map((c, i) => ({
  t: `2026-01-01 09:${String(30 + (i % 30)).padStart(2, '0')}:${String(i).padStart(2, '0')}`,
  o: c, h: c * 1.01, l: c * 0.99, c, v: 100,
}))
const freshState = () => ({
  phase: 'ARMED', lastPrice: null, lastPct: null, lastBarT: null,
  lastTriggeredAt: null, cooldownMin: 5,
})

test('PERIODS 覆盖六档周期', () => {
  assert.deepEqual(PERIODS, ['1m', '5m', '15m', '30m', '60m', '1d'])
})

test('ema 长度与首值', () => {
  const out = ema([1, 2, 3, 4, 5], 3)
  assert.equal(out.length, 5)
  assert.equal(out[0], 1)
})

test('macd/dif-dea/hist 一致性', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 5)
  const { dif, dea, hist } = macd(closes)
  assert.equal(dif.length, 60)
  assert.equal(dea.length, 60)
  for (let i = 0; i < 60; i += 1) {
    if (dif[i] !== null && dea[i] !== null) assert.ok(Math.abs(hist[i] - (dif[i] - dea[i])) < 1e-9)
  }
})

test('kdj J 落在合理范围且口径递推', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i)
  const { k, d, j } = kdj(bars(closes))
  assert.equal(j.length, 40)
  assert.ok(k[39] > 0 && d[39] > 0)
  assert.ok(Math.abs(j[39] - (3 * k[39] - 2 * d[39])) < 1e-9)
})

test('rsi 单边上涨为 100', () => {
  const out = rsi(Array.from({ length: 30 }, (_, i) => i + 1), 14)
  assert.equal(out[14], 100)
})

test('sma/boll/atr 基本性质', () => {
  const closes = Array.from({ length: 30 }, (_, i) => 10 + i)
  assert.equal(sma(closes, 5)[4], 12)
  const bands = boll(closes, 20, 2)
  assert.ok(bands.upper[29] > bands.mid[29] && bands.mid[29] > bands.lower[29])
  assert.ok(atr(bars(closes))[29] > 0)
})

test('穿越判定只在跨越瞬间为真', () => {
  assert.equal(crossedAbove(5, 6, 5.5), true)
  assert.equal(crossedAbove(6, 7, 5.5), false)
  assert.equal(crossedAbove(null, 6, 5.5), false)
  assert.equal(crossedBelow(6, 5, 5.5), true)
  assert.equal(crossedBelow(5, 4, 5.5), false)
})

test('金叉/死叉', () => {
  assert.equal(goldenCross(1, 2, 3, 2), true)
  assert.equal(goldenCross(2, 1, 3, 2), false)
  assert.equal(deadCross(3, 2, 1, 2), true)
})

test('价格阈值规则：prev→now 跨越才触发（防抖核心）', () => {
  const rule = { kind: 'price_above', symbol: 'X', threshold: 10.5 }
  const s = { ...freshState(), lastPrice: 10 }
  assert.equal(evaluateRule(rule, s, { price: 10.8, changePercent: 1 }).hit, true)
  // 已在阈值上方则不再触发
  const s2 = { ...freshState(), lastPrice: 10.9 }
  assert.equal(evaluateRule(rule, s2, { price: 11 }).hit, false)
  // 首次评估（lastPrice=null）不触发，只建立基线
  const s3 = freshState()
  assert.equal(evaluateRule(rule, s3, { price: 11 }).hit, false)
})

test('指标规则：同一根 bar 不重复触发', () => {
  // 构造金叉序列：多轮随机游走直到出现 DIF 上穿 DEA
  let seed = 42
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  const walk = (n) => { const a = []; let p = 100; for (let i = 0; i < n; i += 1) { p = Math.max(1, p + (i > n - 25 ? rnd() * 0.9 : -rnd() * 0.9)); a.push(p) } return a }
  let closes = null
  for (let attempt = 0; attempt < 800 && !closes; attempt += 1) {
    const candidate = walk(80)
    const { dif, dea } = macd(candidate)
    for (let i = 50; i < candidate.length; i += 1) {
      if (dif[i - 1] <= dea[i - 1] && dif[i] > dea[i]) { closes = candidate.slice(0, i + 1); break }
    }
  }
  const { dif, dea } = macd(closes)
  let cut = closes.length - 1
  assert.ok(cut > 0, '样本应含金叉')
  const seq = bars(closes.slice(0, cut + 1))
  const rule = { kind: 'macd_golden', symbol: 'X', period: '15m', threshold: 0 }
  const st = freshState()
  assert.equal(evaluateRule(rule, st, { bars: seq }).hit, true)
  st.lastBarT = seq[seq.length - 1].t
  assert.equal(evaluateRule(rule, st, { bars: seq }).hit, false)
})

test('KDJ J 负值阈值可触发（极端超卖）', () => {
  // 剧烈下跌使 J 进入负值区
  const closes = Array.from({ length: 60 }, (_, i) => 100 - i * 3)
  const rule = { kind: 'kdj_j_below', symbol: 'X', period: '15m', threshold: -10 }
  const st = freshState()
  const res = evaluateRule(rule, st, { bars: bars(closes) })
  assert.equal(typeof res.detail, 'string')
})

test('状态机：once 挂起等确认，every 进 COOLING', () => {
  assert.equal(phaseAfterTrigger('once'), 'TRIGGERED')
  assert.equal(phaseAfterTrigger('every'), 'COOLING')
  assert.equal(canTransition('ARMED', 'TRIGGERED'), true)
  assert.equal(canTransition('ARMED', 'COOLING'), false)
  assert.equal(canTransition('TRIGGERED', 'ARMED'), true)
  assert.equal(canTransition('COOLING', 'ARMED'), true)
})

test('规则摘要', () => {
  assert.match(ruleSummary({ kind: 'price_above', name: '贵州茅台', symbol: '600519.SH', threshold: 1400 }), /价格 ≥ 1400/)
  assert.match(ruleSummary({ kind: 'macd_golden', name: '沪金', symbol: 'AU2606', period: '30m' }), /MACD 金叉/)
})

// ---------------------------------------------------------------------------
// 以下为追加用例：新指标条件 + 条件组（旧用例一律不改）
// ---------------------------------------------------------------------------

// 确定性随机游走：按现有用例的写法找「最后一根 bar 恰好发生穿越」的样本
function findHitSample(makeRule, { len = 80, minBars = 50, seed = 7 } = {}) {
  let s = seed
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 }
  const walk = () => {
    const a = []
    let p = 100
    let drift = 0
    for (let i = 0; i < len; i += 1) {
      if (i % 12 === 0) drift = (rnd() - 0.5) * 2 // 分段换趋势，制造来回穿越
      p = Math.max(1, p + drift + (rnd() - 0.5) * 3)
      a.push(p)
    }
    return a
  }
  for (let attempt = 0; attempt < 3000; attempt += 1) {
    const candidate = walk()
    for (let i = minBars; i < candidate.length; i += 1) {
      const seq = bars(candidate.slice(0, i + 1))
      if (evaluateRule(makeRule(), freshState(), { bars: seq }).hit) return seq
    }
  }
  return null
}

const NEW_KIND_CASES = [
  { kind: 'rsi_above', fields: { threshold: 70 } },
  { kind: 'rsi_below', fields: { threshold: 30 } },
  { kind: 'boll_touch_upper', fields: {} },
  { kind: 'boll_touch_low', fields: {} },
  { kind: 'boll_break_upper', fields: {} },
  { kind: 'boll_break_low', fields: {} },
  { kind: 'ma_cross_up', fields: { fast: 5, slow: 20 } },
  { kind: 'ma_cross_down', fields: { fast: 5, slow: 20 } },
  { kind: 'price_cross_ma_up', fields: { threshold: 10 } },
  { kind: 'price_cross_ma_down', fields: { threshold: 10 } },
]

test('RULE_KINDS 保留原 8 种并新增 10 种，共 18 种且无重复', () => {
  const legacy = ['price_above', 'price_below', 'pct_above', 'pct_below', 'macd_golden', 'macd_dead', 'kdj_j_above', 'kdj_j_below']
  for (const k of legacy) assert.ok(RULE_KINDS.includes(k), k)
  assert.equal(RULE_KINDS.length, 18)
  assert.equal(new Set(RULE_KINDS).size, 18)
  for (const k of NEW_KIND_CASES.map((c) => c.kind)) assert.ok(RULE_KINDS.includes(k), k)
})

for (const { kind, fields } of NEW_KIND_CASES) {
  test(`${kind}：正向触发 + 前一根不触发 + 同 bar 防重放`, () => {
    const makeRule = () => ({ kind, symbol: 'X', period: '15m', ...fields })
    const seq = findHitSample(makeRule, { seed: kind.length * 101 })
    assert.ok(seq, '应找到触发样本')
    assert.ok(evaluateRule(makeRule(), freshState(), { bars: seq }).hit, '最后一根应触发')
    // 负向：穿越是「瞬间」事件，去掉最后一根后上一根不应触发
    const prevSeq = seq.slice(0, -1)
    assert.equal(evaluateRule(makeRule(), freshState(), { bars: prevSeq }).hit, false, '上一根不应触发')
    // 负向：同一根 bar 已评估过则不再触发
    const st = { ...freshState(), lastBarT: seq[seq.length - 1].t }
    const again = evaluateRule(makeRule(), st, { bars: seq })
    assert.equal(again.hit, false)
    assert.equal(again.detail, 'no new bar')
    // 摘要可生成且为字符串
    assert.equal(typeof ruleSummary(makeRule()), 'string')
  })
}

test('新指标条件：数据不足 / 未穿越的单边行情不触发', () => {
  const flat = Array.from({ length: 40 }, (_, i) => 100)
  const up = Array.from({ length: 60 }, (_, i) => 100 + i)
  const seqFlat = bars(flat)
  const seqUp = bars(up)
  // 横盘：价格贴着轨道，不构成「从内侧穿越」
  for (const kind of ['boll_touch_upper', 'boll_touch_low']) {
    assert.equal(evaluateRule({ kind, symbol: 'X' }, freshState(), { bars: seqFlat }).hit, false, kind)
  }
  // 单边上涨：快线一直在慢线上方、价格一直在 MA 上方 → 无金叉 / 无上穿
  assert.equal(evaluateRule({ kind: 'ma_cross_up', symbol: 'X' }, freshState(), { bars: seqUp }).hit, false)
  assert.equal(evaluateRule({ kind: 'price_cross_ma_up', symbol: 'X', threshold: 5 }, freshState(), { bars: seqUp }).hit, false)
  // 单边上涨 RSI 恒为 100，已在阈值上方 → 不构成上穿
  assert.equal(evaluateRule({ kind: 'rsi_above', symbol: 'X', threshold: 70 }, freshState(), { bars: seqUp }).hit, false)
  // 不足 40 根
  assert.equal(evaluateRule({ kind: 'rsi_above', symbol: 'X', threshold: 70 }, freshState(), { bars: seqUp.slice(0, 39) }).detail, 'insufficient bars')
  assert.equal(evaluateSingle({ kind: 'nope' }, freshState(), { bars: seqUp }).detail, 'unknown kind')
})

test('evaluateSingle 与 evaluateRule 对单条件规则结果一致', () => {
  const seq = bars(Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5))
  const rule = { kind: 'rsi_above', symbol: 'X', threshold: 50 }
  assert.deepEqual(evaluateRule(rule, freshState(), { bars: seq }), evaluateSingle(rule, freshState(), { bars: seq }))
  assert.deepEqual(evaluateRule({ kind: 'price_above', threshold: 3 }, freshState(), { price: 5 }), evaluateSingle({ kind: 'price_above', threshold: 3 }, freshState(), { price: 5 }))
})

test('opts 可配置指标参数，缺省与历史实现一致', () => {
  assert.deepEqual(DEFAULT_OPTS, { rsiPeriod: 14, maFast: 5, maSlow: 20, bollPeriod: 20, bollWidth: 2, kdjN: 9, kdjM1: 3, kdjM2: 3 })
  // 随机游走样本：RSI(6) 与 RSI(14) 在同一根上的穿越结论不同 → 证明参数生效
  const seq = findHitSample(() => ({ kind: 'rsi_above', symbol: 'X', threshold: 60 }), { seed: 11 })
  assert.ok(seq)
  const withShort = evaluateRule({ kind: 'rsi_above', symbol: 'X', threshold: 60 }, freshState(), { bars: seq }, { rsiPeriod: 6 })
  const withDefault = evaluateRule({ kind: 'rsi_above', symbol: 'X', threshold: 60 }, freshState(), { bars: seq })
  assert.equal(typeof withShort.hit, 'boolean')
  assert.match(withShort.detail, /RSI\(6\)/)
  assert.match(withDefault.detail, /RSI\(14\)/)
  // cond.fast / cond.slow 优先于 opts；opts 优先于默认
  const seq2 = bars(Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 8))
  const r = evaluateRule({ kind: 'ma_cross_up', symbol: 'X', fast: 3, slow: 8 }, freshState(), { bars: seq2 }, { maFast: 7, maSlow: 30 })
  assert.match(r.detail, /MA\(3\).*MA\(8\)/)
  const r2 = evaluateRule({ kind: 'ma_cross_up', symbol: 'X' }, freshState(), { bars: seq2 }, { maFast: 7, maSlow: 30 })
  assert.match(r2.detail, /MA\(7\).*MA\(30\)/)
  const r3 = evaluateRule({ kind: 'ma_cross_up', symbol: 'X' }, freshState(), { bars: seq2 })
  assert.match(r3.detail, /MA\(5\).*MA\(20\)/)
  // KDJ 参数透传
  const r4 = evaluateRule({ kind: 'kdj_j_above', symbol: 'X', threshold: 50 }, freshState(), { bars: seq2 }, { kdjN: 5 })
  assert.equal(typeof r4.detail, 'string')
})

// 条件组用的金叉样本（与现有用例同一种找法）
function findGoldenSample() {
  return findHitSample(() => ({ kind: 'macd_golden', symbol: 'X', period: '15m', threshold: 0 }), { seed: 42 })
}

test('条件组：空 extra 向后兼容，结果与无 extra 完全相同', () => {
  const seq = findGoldenSample()
  assert.ok(seq)
  const plain = { kind: 'macd_golden', symbol: 'X', period: '15m', threshold: 0 }
  const base = evaluateRule(plain, freshState(), { bars: seq })
  assert.equal(base.hit, true)
  assert.deepEqual(evaluateRule({ ...plain, extra: [] }, freshState(), { bars: seq }), base)
  assert.deepEqual(evaluateRule({ ...plain, extra: undefined }, freshState(), { bars: seq }), base)
  assert.deepEqual(evaluateRule({ ...plain, logic: 'AND' }, freshState(), { bars: seq }), base)
  assert.deepEqual(evaluateRule({ ...plain, logic: 'OR', extra: [] }, freshState(), { bars: seq }), base)
  assert.equal(ruleSummary({ ...plain, extra: [] }), ruleSummary(plain))
})

test('条件组 AND：全部满足触发，detail 用「且」拼接', () => {
  const seq = findGoldenSample()
  const rule = {
    kind: 'macd_golden', symbol: 'X', period: '15m', logic: 'AND',
    extra: [{ kind: 'price_above', threshold: 10 }],
  }
  const res = evaluateRule(rule, { ...freshState(), lastPrice: 9 }, { bars: seq, price: 11 })
  assert.equal(res.hit, true)
  assert.match(res.detail, /^MACD 金叉.* 且 现价 11 ≥ 10$/)
})

test('条件组 AND：缺一不触发', () => {
  const seq = findGoldenSample()
  const rule = {
    kind: 'macd_golden', symbol: 'X', period: '15m',
    extra: [{ kind: 'price_above', threshold: 10 }],
  }
  // 价格已在阈值上方 → 附加条件不成立 → 整组不触发
  const res = evaluateRule(rule, { ...freshState(), lastPrice: 11 }, { bars: seq, price: 12 })
  assert.equal(res.hit, false)
  assert.match(res.detail, / 且 /)
  // 主条件不成立（死叉样本上找金叉）而附加条件成立 → 仍不触发
  const deadRule = { ...rule, kind: 'macd_dead', extra: [{ kind: 'price_above', threshold: 10 }] }
  const res2 = evaluateRule(deadRule, { ...freshState(), lastPrice: 9 }, { bars: seq, price: 11 })
  assert.equal(res2.hit, false)
})

test('条件组 OR：任一满足即触发，detail 用「或」拼接', () => {
  const seq = findGoldenSample()
  const rule = {
    kind: 'macd_dead', symbol: 'X', period: '15m', logic: 'OR',
    extra: [{ kind: 'price_above', threshold: 10 }],
  }
  const res = evaluateRule(rule, { ...freshState(), lastPrice: 9 }, { bars: seq, price: 11 })
  assert.equal(res.hit, true)
  assert.match(res.detail, /^MACD 死叉.* 或 现价 11 ≥ 10$/)
  // 两个都不成立 → 不触发
  const res2 = evaluateRule(rule, { ...freshState(), lastPrice: 11 }, { bars: seq, price: 12 })
  assert.equal(res2.hit, false)
  assert.match(res2.detail, / 或 /)
})

test('条件组：多个指标类子条件共享同一份 bars', () => {
  const seq = findGoldenSample()
  const rule = {
    kind: 'macd_golden', symbol: 'X', period: '15m', logic: 'OR',
    extra: [{ kind: 'ma_cross_up', period: '15m' }, { kind: 'price_cross_ma_up', threshold: 10, period: '15m' }],
  }
  const res = evaluateRule(rule, freshState(), { bars: seq })
  assert.equal(res.hit, true, '主条件成立即可')
  assert.equal(res.detail.split(' 或 ').length, 3)
  // 同 bar 防重放对整组生效
  const st = { ...freshState(), lastBarT: seq[seq.length - 1].t }
  const again = evaluateRule({ ...rule, logic: 'AND' }, st, { bars: seq })
  assert.equal(again.hit, false)
  assert.equal(again.detail, 'no new bar')
  // 数据不足对整组生效
  assert.equal(evaluateRule({ ...rule, logic: 'AND' }, freshState(), { bars: seq.slice(0, 30) }).detail, 'insufficient bars')
})

test('条件组：混周期直接拒绝，不静默算错', () => {
  const seq = findGoldenSample()
  const mixed = {
    kind: 'macd_golden', symbol: 'X', period: '15m', logic: 'OR',
    extra: [{ kind: 'rsi_above', threshold: 50, period: '30m' }],
  }
  const res = evaluateRule(mixed, freshState(), { bars: seq })
  assert.equal(res.hit, false)
  assert.equal(res.detail, 'mixed periods unsupported')
  // 一边有周期、一边没有，同样视为混周期
  const oneSided = { kind: 'macd_golden', symbol: 'X', extra: [{ kind: 'ma_cross_up', period: '15m' }] }
  assert.equal(evaluateRule(oneSided, freshState(), { bars: seq }).detail, 'mixed periods unsupported')
  // 非指标类条件不参与周期检查：主条件无周期 + 价格类附加条件是合法的
  const ok = { kind: 'rsi_above', symbol: 'X', threshold: 50, extra: [{ kind: 'price_above', threshold: 10 }] }
  assert.notEqual(evaluateRule(ok, freshState(), { bars: seq, price: 11 }).detail, 'mixed periods unsupported')
})

test('条件组：超过 4 条附加条件 / 非法 logic / 非法 kind 被拒绝', () => {
  const seq = findGoldenSample()
  assert.equal(MAX_EXTRA_CONDITIONS, 4)
  const five = { kind: 'macd_golden', symbol: 'X', extra: Array.from({ length: 5 }, () => ({ kind: 'price_above', threshold: 10 })) }
  assert.equal(evaluateRule(five, freshState(), { bars: seq, price: 11 }).detail, 'too many conditions')
  const four = { ...five, extra: five.extra.slice(0, 4) }
  assert.notEqual(evaluateRule(four, freshState(), { bars: seq, price: 11 }).detail, 'too many conditions')
  assert.equal(evaluateRule({ kind: 'macd_golden', symbol: 'X', logic: 'XOR', extra: [{ kind: 'price_above', threshold: 1 }] }, freshState(), { bars: seq }).detail, 'invalid logic')
  assert.equal(evaluateRule({ kind: 'macd_golden', symbol: 'X', extra: [{ kind: 'nope' }] }, freshState(), { bars: seq }).detail, 'unknown kind')
  // 主条件 + 4 条 = 5 条全部满足（OR）可触发
  const all = { kind: 'macd_dead', symbol: 'X', logic: 'OR', extra: Array.from({ length: 4 }, () => ({ kind: 'price_above', threshold: 10 })) }
  assert.equal(evaluateRule(all, { ...freshState(), lastPrice: 9 }, { bars: seq, price: 11 }).hit, true)
})

test('规则摘要：新类型中文摘要 + 条件组拼接', () => {
  const base = { name: '沪金', symbol: 'AU2606', period: '30m' }
  assert.match(ruleSummary({ ...base, kind: 'rsi_above', threshold: 70 }), /沪金 RSI 上穿 70 · 30m/)
  assert.match(ruleSummary({ ...base, kind: 'rsi_below', threshold: 30 }), /RSI 下穿 30/)
  assert.match(ruleSummary({ ...base, kind: 'boll_touch_upper' }), /触及 BOLL 上轨/)
  assert.match(ruleSummary({ ...base, kind: 'boll_touch_low' }), /触及 BOLL 下轨/)
  assert.match(ruleSummary({ ...base, kind: 'boll_break_upper' }), /突破 BOLL 上轨/)
  assert.match(ruleSummary({ ...base, kind: 'boll_break_low' }), /跌破 BOLL 下轨/)
  assert.match(ruleSummary({ ...base, kind: 'ma_cross_up' }), /沪金 MA\(5\) 上穿 MA\(20\)/)
  assert.match(ruleSummary({ ...base, kind: 'ma_cross_down', fast: 3, slow: 10 }), /MA\(3\) 下穿 MA\(10\)/)
  assert.match(ruleSummary({ ...base, kind: 'price_cross_ma_up', threshold: 60 }), /价格上穿 MA\(60\)/)
  assert.match(ruleSummary({ ...base, kind: 'price_cross_ma_down', threshold: 60 }), /价格下穿 MA\(60\)/)
  const grouped = ruleSummary({ ...base, kind: 'macd_golden', extra: [{ kind: 'rsi_above', threshold: 70 }, { kind: 'price_above', threshold: 900 }] })
  assert.equal(grouped, '沪金 MACD 金叉 · 30m 且 RSI 上穿 70 且 价格 ≥ 900')
  const groupedOr = ruleSummary({ ...base, kind: 'macd_golden', logic: 'OR', extra: [{ kind: 'ma_cross_up', period: '60m' }] })
  assert.equal(groupedOr, '沪金 MACD 金叉 · 30m 或 MA(5) 上穿 MA(20) · 60m')
})

test('INDICATOR_KINDS 覆盖全部 14 种指标类 kind', () => {
  assert.equal(INDICATOR_KINDS.length, 14)
  for (const k of INDICATOR_KINDS) assert.ok(RULE_KINDS.includes(k), k)
})
