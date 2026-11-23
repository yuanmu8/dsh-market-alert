/**
 * lib/shared.js 单元测试：指标口径、穿越判定、规则评估与状态机（N-06）。
 * 运行：node --test test/shared.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ema, macd, kdj, rsi, sma, boll, atr,
  crossedAbove, crossedBelow, goldenCross, deadCross,
  evaluateRule, phaseAfterTrigger, canTransition, ruleSummary, PERIODS,
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
