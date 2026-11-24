/**
 * 数据层回归测试：腾讯批量响应的按标的解析（v0.1.2 修复批量快照价格串号）。
 * 运行：node --test test/datasource.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTencent, normalizeSymbol } from '../lib/datasource.js'

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
