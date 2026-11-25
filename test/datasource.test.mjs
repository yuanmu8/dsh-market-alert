/**
 * 数据层回归测试：腾讯批量响应的按标的解析（v0.1.2 修复批量快照价格串号）。
 * 运行：node --test test/datasource.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTencent, normalizeSymbol, barCloseTime, dropFormingBars } from '../lib/datasource.js'

test('ETF / LOF 号段归一化（v0.2.1）', () => {
  // 沪市基金：50 封基、51/56/58 ETF
  assert.deepEqual(normalizeSymbol('510300'), { kind: 'A', symbol: '510300.SH', lower: 'sh510300', tx: 'sh510300' })
  assert.deepEqual(normalizeSymbol('sh588000'), { kind: 'A', symbol: '588000.SH', lower: 'sh588000', tx: 'sh588000' })
  assert.deepEqual(normalizeSymbol('501000.SH'), { kind: 'A', symbol: '501000.SH', lower: 'sh501000', tx: 'sh501000' })
  // 深市 ETF/LOF：15/16
  assert.deepEqual(normalizeSymbol('159915'), { kind: 'A', symbol: '159915.SZ', lower: 'sz159915', tx: 'sz159915' })
  assert.deepEqual(normalizeSymbol('161725.SZ'), { kind: 'A', symbol: '161725.SZ', lower: 'sz161725', tx: 'sz161725' })
  // 带后缀 / 前缀的写法同样成立
  assert.equal(normalizeSymbol('SH510300').symbol, '510300.SH')
})

test('barCloseTime：分钟/日/周/月的收盘时刻（北京时间）', () => {
  // 60 分钟 bar：t 即收盘时刻
  assert.equal(barCloseTime('2026-11-25 11:30:00', '60m').toISOString(), '2026-11-25T03:30:00.000Z')
  // 日线：当日 15:00 北京
  assert.equal(barCloseTime('2026-11-25', '1d').toISOString(), '2026-11-25T07:00:00.000Z')
  // 周线：2026-11-25 是周三 → 该周周五 11-27 15:00
  assert.equal(barCloseTime('2026-11-25', '1w').toISOString(), '2026-11-27T07:00:00.000Z')
  // 周日落在下一段周一开局的周（ISO 周归属）
  assert.equal(barCloseTime('2026-11-22', '1w').toISOString(), '2026-11-20T07:00:00.000Z') // 11-22 是周日，属于 11-16 那周
  // 月线：11 月最后一天 15:00
  assert.equal(barCloseTime('2026-11-05', '1M').toISOString(), '2026-11-30T07:00:00.000Z')
})

test('dropFormingBars：只保留已收盘（含宽限）的 bar', () => {
  const bars = [
    { t: '2026-11-25 10:30:00' },
    { t: '2026-11-25 11:30:00' },
    { t: '2026-11-25 14:00:00' },
    { t: '2026-11-25 15:00:00' },
  ]
  // now = 14:00:05（收盘后 5 秒，宽限 10s 内）：14:00 与 15:00 都未结算 → 保留到 11:30
  const inGrace = dropFormingBars(bars, '60m', Date.parse('2026-11-25T06:00:05.000Z'))
  assert.deepEqual(inGrace.map((b) => b.t), bars.slice(0, 2).map((b) => b.t))
  // now = 14:00:15（宽限已过）：14:00 算收盘 → 保留到 14:00
  const pastGrace = dropFormingBars(bars, '60m', Date.parse('2026-11-25T06:00:15.000Z'))
  assert.deepEqual(pastGrace.map((b) => b.t), bars.slice(0, 3).map((b) => b.t))
  // now = 15:00:30：全部收盘
  assert.equal(dropFormingBars(bars, '60m', Date.parse('2026-11-25T07:00:30.000Z')).length, 4)
})

// 构造两段腾讯响应：sh601688（华泰证券 17.23）与 sz300006（莱美药业 9.0）
const body = '"1~华泰证券~601688~17.23~17.33~17.30~17.40~17.10~601688~..."'
const body2 = '"0~莱美药业~300006~9.00~8.74~8.80~9.10~8.70~300006~..."'
const multi = `v_sh601688=${body};v_sz300006=${body2};`

test('批量响应按 tx 精确定位，不同标的取到各自价格', () => {
  const a = parseTencent(multi, normalizeSymbol('601688'))
  const b = parseTencent(multi, normalizeSymbol('300006'))
  assert.ok(a && b)
  assert.equal(a.symbol, '601688.SH')
  assert.equal(a.price, 17.23)
  assert.equal(b.symbol, '300006.SZ')
  assert.equal(b.price, 9)
  assert.notEqual(a.price, b.price)
})

test('响应里没有该标的时返回 null，而不是套用第一个条目', () => {
  const gone = parseTencent(multi, normalizeSymbol('600519'))
  assert.equal(gone, null)
})

test('单条目响应允许回退（美股后缀等 id 不完全匹配场景）', () => {
  const single = `v_usAAPL.OQ=${body};`
  const norm = { kind: 'US', symbol: 'AAPL', tx: 'usAAPL' }
  const q = parseTencent(single, norm)
  assert.ok(q)
  assert.equal(q.symbol, 'AAPL')
  assert.equal(q.price, 17.23)
})

test('空响应返回 null', () => {
  assert.equal(parseTencent('', normalizeSymbol('600519')), null)
})
