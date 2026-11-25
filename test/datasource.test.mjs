/**
 * 数据层回归测试：腾讯批量响应的按标的解析（v0.1.2 修复批量快照价格串号）。
 * 运行：node --test test/datasource.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTencent, normalizeSymbol } from '../lib/datasource.js'

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
