/**
 * dsh-market-alert — Host 半。
 *
 * 职责：
 * 1. 装配 StateStore（~/.dsh/market-alert/state.json）与 AlertEngine 评估循环；
 * 2. POST /api/market-alert：面板 JSON-RPC
 *      state / search / watch.* / rule.* / group.* / event.* / bars / quotes；
 * 3. GET  /api/market-alert/stream：SSE 告警流 + 自选快照广播（页面隐藏保持连接）。
 *
 * 告警评估全部在 Host 侧：浏览器关闭后规则照常触发，重开面板经 SSE 收到新告警。
 *
 * 输入校验约定：所有写接口先校验再落库，校验失败返回 400 + 中文错误；
 * 上限冲突 409；目标不存在 404；只有未预期的异常才是 500。
 */

import { AlertEngine } from './lib/engine.js'
import { normalizeSymbol } from './lib/datasource.js'
import { RULE_KINDS, ruleSummary } from './lib/shared.js'
import { StateStore, DATA_DIR, MAX_RULES } from './lib/store.js'

export const name = 'market-alert'

const ROUTE = '/api/market-alert'
const STREAM_ROUTE = '/api/market-alert/stream'

/** 面板可选周期（指标类条件用；价格 / 涨跌幅类忽略）。 */
const PERIODS_ALLOWED = new Set(['1m', '5m', '15m', '30m', '60m', '1d', '1w', '1M'])
const LOGICS = new Set(['AND', 'OR'])
const MAX_EXTRA = 4
const DEFAULT_PERIOD = '15m'
const DEFAULT_GROUP = '默认'
const SYMBOL_MAX = 32
const NAME_MAX = 32
const GROUP_MAX = 16
/** 指标参数的合法范围（RSI 周期 / MA 快慢线）。 */
const PARAM_MIN = 2
const PARAM_MAX = 250
const PARAM_LABELS = { rsiPeriod: 'RSI 周期', maFast: 'MA 快线', maSlow: 'MA 慢线' }

/** 带业务状态码的错误：catch 统一按 error.status 回给前端。 */
class RpcError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'RpcError'
    this.status = status
  }
}

/** 价格 / 涨跌幅类条件吃 quote，其余（指标类）吃 bars。 */
const isQuoteKind = (kind) => kind === 'price_above' || kind === 'price_below' || String(kind).startsWith('pct_')
/** 需要阈值的条件：价格、涨跌幅、KDJ、RSI、价格穿越 MA（阈值 = MA 的 N）。 */
const needsThreshold = (kind) => /^(price_|pct_|kdj_|rsi_)/.test(String(kind))

/** 去控制字符 + trim + 截断。 */
function cleanText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max)
}

function assertKind(kind) {
  if (!RULE_KINDS.includes(kind)) throw new RpcError(`不支持的规则类型：${kind || '（空）'}`)
}

function assertPeriod(period) {
  if (!PERIODS_ALLOWED.has(period)) {
    throw new RpcError(`不支持的周期：${period || '（空）'}，可选 ${[...PERIODS_ALLOWED].join(' / ')}`)
  }
}

function assertLogic(logic) {
  const value = String(logic ?? 'AND').toUpperCase()
  if (!LOGICS.has(value)) throw new RpcError('logic 只能是 AND 或 OR')
  return value
}

function toThreshold(value, label) {
  if (value === undefined || value === null || value === '' || !Number.isFinite(Number(value))) {
    throw new RpcError(`${label}阈值必须是数字`)
  }
  return Number(value)
}

function toParam(value, label) {
  const n = Math.floor(Number(value))
  if (!Number.isInteger(n) || n < PARAM_MIN || n > PARAM_MAX) {
    throw new RpcError(`${label}必须是 ${PARAM_MIN}–${PARAM_MAX} 的整数`)
  }
  return n
}

/**
 * 校验并归一化单个条件（主条件或附加条件）。
 * 输出只保留有意义的字段：{ kind, period, threshold?, fast?, slow? }
 */
function normalizeCondition(raw, basePeriod, label) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const kind = String(src.kind ?? '')
  assertKind(kind)
  const period = src.period === undefined || src.period === null || src.period === '' ? basePeriod : String(src.period)
  assertPeriod(period)
  const cond = { kind, period }
  if (needsThreshold(kind)) {
    cond.threshold = toThreshold(src.threshold, label)
  } else if (src.threshold !== undefined && src.threshold !== null && Number.isFinite(Number(src.threshold))) {
    cond.threshold = Number(src.threshold)
  }
  for (const key of ['fast', 'slow']) {
    if (src[key] !== undefined && src[key] !== null && src[key] !== '') {
      cond[key] = toParam(src[key], `${label}${key === 'fast' ? '快线' : '慢线'}`)
    }
  }
  return cond
}

/**
 * 校验附加条件：数组、≤ 4 条、每条 kind 合法、周期与主条件一致。
 * 返回归一化后的数组（未传 → []）。
 */
function normalizeExtra(rawExtra, basePeriod) {
  if (rawExtra === undefined || rawExtra === null) return []
  if (!Array.isArray(rawExtra)) throw new RpcError('extra 必须是数组')
  if (rawExtra.length > MAX_EXTRA) throw new RpcError(`附加条件最多 ${MAX_EXTRA} 条（含主条件共 ${MAX_EXTRA + 1} 条）`)
  const extra = rawExtra.map((item, index) => normalizeCondition(item, basePeriod, `第 ${index + 1} 条附加条件`))
  const mixed = extra.find((cond) => cond.period !== basePeriod)
  if (mixed) {
    throw new RpcError(`条件组内周期必须一致：主条件 ${basePeriod}，附加条件 ${mixed.period}`)
  }
  return extra
}

/** 规则指标参数（rsiPeriod / maFast / maSlow），只在 payload 显式给出时校验并写入 patch。 */
function normalizeParams(payload) {
  const patch = {}
  for (const key of Object.keys(PARAM_LABELS)) {
    if (payload[key] !== undefined && payload[key] !== null && payload[key] !== '') {
      patch[key] = toParam(payload[key], PARAM_LABELS[key])
    }
  }
  if (patch.maFast !== undefined && patch.maSlow !== undefined && patch.maFast >= patch.maSlow) {
    throw new RpcError('MA 快线周期必须小于慢线周期')
  }
  return patch
}

const extraKey = (extra) => JSON.stringify(Array.isArray(extra) && extra.length ? extra : [])

/**
 * 分组统计（group.list / state.groups 共用）：
 * [{ group, symbols, rules, enabledRules }]，规则按其标的所在分组归属；
 * 标的不在自选里的规则归入「未分组」。
 */
export function groupList(store) {
  const { watchlist, rules } = store.snapshot
  const rows = new Map()
  const rowOf = (group) => {
    if (!rows.has(group)) rows.set(group, { group, symbols: 0, rules: 0, enabledRules: 0, symbolsSet: new Set() })
    return rows.get(group)
  }
  const groupOfSymbol = new Map()
  for (const w of watchlist) {
    const group = w.group || DEFAULT_GROUP
    groupOfSymbol.set(w.symbol, group)
    const row = rowOf(group)
    row.symbols += 1
    row.symbolsSet.add(w.symbol)
  }
  for (const rule of rules) {
    const group = groupOfSymbol.get(rule.symbol) || '未分组'
    const row = rowOf(group)
    if (!groupOfSymbol.has(rule.symbol) && !row.symbolsSet.has(rule.symbol)) {
      row.symbols += 1
      row.symbolsSet.add(rule.symbol)
    }
    row.rules += 1
    if (rule.enabled) row.enabledRules += 1
  }
  return [...rows.values()].map(({ symbolsSet, ...rest }) => rest)
}

export function apply(ctx, config) {
  const logger = {
    info: (msg) => { try { ctx.logger?.info?.(msg) } catch { console.log(msg) } },
    warn: (msg) => { try { ctx.logger?.warn?.(msg) } catch { console.warn(msg) } },
  }
  const intervalMs = Math.max(1_000, Number(config?.pollIntervalMs) || 5_000)
  const refreshMs = Math.max(2_000, Number(config?.quoteRefreshMs) || 4_000)

  const store = new StateStore({ logger })
  const engine = new AlertEngine({ store, logger, intervalMs })
  engine.start()
  ctx.effect(() => () => engine.stop())

  // 自选快照广播节拍：有自选时定期向所有面板推 quotes（W-04）
  const quoteTimer = setInterval(() => {
    const symbols = store.snapshot.watchlist.map((w) => w.symbol)
    if (symbols.length) engine.snapshotFor(symbols).catch(() => {})
  }, refreshMs)
  if (quoteTimer.unref) quoteTimer.unref()
  ctx.effect(() => () => clearInterval(quoteTimer))

  const ruleWithState = (rule) => ({ ...rule, state: store.stateOf(rule.id), summary: ruleSummary(rule) })
  // 列表视图复用 ruleWithState：state 接口也必须带 summary（页面优先显示 Host 生成的条件组摘要）
  const rulesView = () => store.snapshot.rules.map(ruleWithState)
  const findRule = (id) => store.snapshot.rules.find((r) => r.id === id)
  const watchOf = (symbol) => store.snapshot.watchlist.find((w) => w.symbol === symbol)

  /** 批量启停：只处理存在的规则，返回实际改动的条数。 */
  const setRulesEnabled = (rules, enabled) => {
    let updated = 0
    for (const rule of rules) {
      if (Boolean(rule.enabled) === enabled) continue
      store.updateRule(rule.id, { enabled })
      updated += 1
    }
    return updated
  }

  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.connection.fetch.register({
      path: ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const send = (value, status = 200) => new Response(JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
        let body
        try { body = await request.json() } catch { return send({ ok: false, error: 'invalid JSON body' }, 400) }
        const method = String(body?.method ?? '')
        const p = body?.payload ?? {}
        try {
          if (method === 'state') {
            const snapshot = store.snapshot
            return send({
              ok: true,
              dataDir: DATA_DIR,
              maxRules: MAX_RULES,
              watchlist: snapshot.watchlist,
              rules: rulesView(),
              events: snapshot.events,
              groups: groupList(store),
              engine: {
                running: engine.timer !== null,
                cycle: engine.cycle,
                lastRunAt: engine.lastRunAt,
                lastError: engine.lastError,
              },
            })
          }

          if (method === 'search') {
            const hits = await engine.provider.search(String(p.keyword ?? '').slice(0, 40))
            return send({ ok: true, hits })
          }

          // ---- 自选 ---------------------------------------------------------

          if (method === 'watch.add') {
            const symbol = cleanText(p.symbol, SYMBOL_MAX)
            const norm = normalizeSymbol(symbol)
            if (!norm) return send({ ok: false, error: `无法识别的标的：${symbol}` }, 400)
            let name = cleanText(p.name, NAME_MAX) || norm.symbol
            try { name = cleanText(await engine.provider.quote(norm.symbol).name, NAME_MAX) || name } catch { /* 搜索失败不阻塞 */ }
            const added = store.addWatch({
              symbol: norm.symbol,
              name,
              market: norm.kind,
              group: cleanText(p.group, GROUP_MAX) || DEFAULT_GROUP,
            })
            return send({ ok: true, added, watchlist: store.snapshot.watchlist, groups: groupList(store) })
          }

          if (method === 'watch.remove') {
            const symbol = String(p.symbol ?? '').trim()
            const enabled = store.watchEnabledRuleCount(symbol)
            if (enabled > 0 && p.confirm !== true) {
              return send({ ok: false, needConfirm: true, error: `该标的存在 ${enabled} 条启用中的告警规则，删除将一并失效` }, 409)
            }
            if (enabled > 0) {
              for (const rule of store.snapshot.rules.filter((r) => r.symbol === symbol)) store.deleteRule(rule.id)
            }
            store.removeWatch(symbol)
            return send({ ok: true, watchlist: store.snapshot.watchlist, groups: groupList(store) })
          }

          // payload { symbol, group }：改自选所属分组（空 → 默认），该标的下的规则分组同步
          if (method === 'watch.setGroup') {
            const symbol = String(p.symbol ?? '').trim()
            const entry = watchOf(symbol)
            if (!entry) throw new RpcError(`自选不存在：${symbol}`, 404)
            entry.group = cleanText(p.group, GROUP_MAX) || DEFAULT_GROUP
            for (const rule of store.snapshot.rules) {
              if (rule.symbol === symbol) rule.group = entry.group
            }
            store.save()
            return send({ ok: true, symbol, group: entry.group, watchlist: store.snapshot.watchlist, groups: groupList(store) })
          }

          // ---- 规则 ---------------------------------------------------------

          // payload { symbol, kind, threshold, period, name?, logic?, extra?, rsiPeriod?, maFast?, maSlow?, mode?, cooldownMin?, enabled?, group? }
          if (method === 'rule.add') {
            const rawSymbol = cleanText(p.symbol, SYMBOL_MAX)
            const norm = normalizeSymbol(rawSymbol)
            if (!norm) return send({ ok: false, error: `无法识别的标的：${rawSymbol}` }, 400)
            const period = String(p.period ?? DEFAULT_PERIOD)
            assertPeriod(period)
            const main = normalizeCondition({ kind: p.kind, threshold: p.threshold, period }, period, '')
            const extra = normalizeExtra(p.extra, period)
            const params = normalizeParams(p)
            if (store.snapshot.rules.length >= MAX_RULES) {
              throw new RpcError(`规则数已达上限 ${MAX_RULES} 条，请先清理失效规则`, 409)
            }
            const rule = {
              id: `rule_${Math.random().toString(16).slice(2, 10)}`,
              symbol: norm.symbol,
              name: cleanText(p.name, NAME_MAX) || norm.symbol,
              kind: main.kind,
              threshold: main.threshold ?? null,
              period: main.period,
              mode: p.mode === 'every' ? 'every' : 'once',
              cooldownMin: Math.max(1, Math.min(1440, Number(p.cooldownMin) || 5)),
              enabled: p.enabled !== false,
              group: cleanText(p.group, GROUP_MAX) || watchOf(norm.symbol)?.group || '',
              ...params,
              createdAt: Date.now(),
            }
            if (extra.length) {
              rule.logic = assertLogic(p.logic)
              rule.extra = extra
            } else if (p.logic !== undefined) {
              rule.logic = assertLogic(p.logic)
            }
            try { store.addRule(rule) } catch (error) { throw new RpcError(error?.message || String(error), 409) }
            return send({ ok: true, rule: ruleWithState(rule) })
          }

          // payload { id, ...要改的字段 }，未给出的字段保持不变
          if (method === 'rule.update') {
            const id = String(p.id ?? '')
            const existing = findRule(id)
            if (!existing) throw new RpcError(`规则不存在：${id}`, 404)

            const patch = {}
            if (p.symbol !== undefined) {
              const norm = normalizeSymbol(cleanText(p.symbol, SYMBOL_MAX))
              if (!norm) throw new RpcError(`无法识别的标的：${String(p.symbol)}`)
              patch.symbol = norm.symbol
            }
            if (p.name !== undefined) patch.name = cleanText(p.name, NAME_MAX) || patch.symbol || existing.symbol
            if (p.kind !== undefined) { patch.kind = String(p.kind); assertKind(patch.kind) }
            if (p.period !== undefined) { patch.period = String(p.period); assertPeriod(patch.period) }
            if (p.threshold !== undefined) patch.threshold = toThreshold(p.threshold, '')
            if (p.logic !== undefined) patch.logic = assertLogic(p.logic)
            if (p.mode !== undefined) patch.mode = p.mode === 'every' ? 'every' : 'once'
            if (p.cooldownMin !== undefined) patch.cooldownMin = Math.max(1, Math.min(1440, Number(p.cooldownMin) || 5))
            if (p.enabled !== undefined) patch.enabled = Boolean(p.enabled)
            Object.assign(patch, normalizeParams(p))

            // 改周期而未带 extra：附加条件整体跟随新周期（条件组共用一个周期）
            const basePeriod = patch.period ?? existing.period ?? DEFAULT_PERIOD
            if (p.extra !== undefined) {
              patch.extra = normalizeExtra(p.extra, basePeriod)
            } else if (patch.period !== undefined && Array.isArray(existing.extra) && existing.extra.length) {
              patch.extra = existing.extra.map((cond) => ({ ...cond, period: patch.period }))
            }

            const merged = { ...existing, ...patch }
            if (needsThreshold(merged.kind)
              && (merged.threshold === null || merged.threshold === undefined || merged.threshold === '' || !Number.isFinite(Number(merged.threshold)))) {
              throw new RpcError('该规则类型需要阈值，请填写数字')
            }
            const baselineChanged = merged.symbol !== existing.symbol
              || merged.kind !== existing.kind
              || merged.period !== existing.period
              || (merged.logic ?? 'AND') !== (existing.logic ?? 'AND')
              || extraKey(merged.extra) !== extraKey(existing.extra)

            const rule = store.updateRule(id, patch)
            // 条件变了就重置穿越基线，否则会用旧 kind / 旧周期的 prev 值误判
            if (baselineChanged) {
              store.mutateState(id, (s) => {
                s.lastPrice = null
                s.lastPct = null
                s.lastBarT = null
                s.phase = rule.enabled ? 'ARMED' : 'DISABLED'
              })
            }
            return send({ ok: true, rule: ruleWithState(rule), baselineReset: baselineChanged })
          }

          // payload { id } → { rule, state, summary }，供编辑弹窗回填
          if (method === 'rule.get') {
            const rule = findRule(String(p.id ?? ''))
            if (!rule) throw new RpcError(`规则不存在：${String(p.id ?? '')}`, 404)
            return send({ ok: true, rule: ruleWithState(rule) })
          }

          // payload { ids: string[], enabled }：多选批量启停，忽略不存在的 id
          if (method === 'rule.toggleMany') {
            if (!Array.isArray(p.ids)) throw new RpcError('ids 必须是数组')
            const ids = new Set(p.ids.slice(0, MAX_RULES).map(String))
            if (p.enabled === undefined || p.enabled === null) throw new RpcError('缺少 enabled')
            const enabled = Boolean(p.enabled)
            const updated = setRulesEnabled(store.snapshot.rules.filter((r) => ids.has(r.id)), enabled)
            return send({ ok: true, updated, rules: rulesView(), groups: groupList(store) })
          }

          if (method === 'rule.delete') {
            store.deleteRule(String(p.id ?? ''))
            return send({ ok: true, groups: groupList(store) })
          }

          // ---- 分组 ---------------------------------------------------------

          // payload { group, enabled }：该分组下所有自选标的的规则批量启停
          if (method === 'group.toggle') {
            const group = cleanText(p.group, GROUP_MAX) || DEFAULT_GROUP
            if (p.enabled === undefined || p.enabled === null) throw new RpcError('缺少 enabled')
            const enabled = Boolean(p.enabled)
            const symbols = new Set(
              store.snapshot.watchlist.filter((w) => (w.group || DEFAULT_GROUP) === group).map((w) => w.symbol),
            )
            const updated = setRulesEnabled(store.snapshot.rules.filter((r) => symbols.has(r.symbol)), enabled)
            return send({ ok: true, group, symbols: symbols.size, updated, groups: groupList(store) })
          }

          // payload {} → [{ group, symbols, rules, enabledRules }]
          if (method === 'group.list') {
            return send({ ok: true, groups: groupList(store) })
          }

          // ---- 告警事件 -------------------------------------------------------

          if (method === 'event.ack') {
            const saved = store.ackEvent(String(p.id ?? ''))
            return send({ ok: true, events: store.snapshot.events })
          }

          if (method === 'event.clear') {
            store.clearEvents()
            return send({ ok: true, events: [] })
          }

          // ---- 行情 -----------------------------------------------------------

          if (method === 'bars') {
            const symbol = String(p.symbol ?? '').trim()
            const period = String(p.period ?? '15m')
            const count = Math.max(30, Math.min(500, Number(p.count) || 180))
            if (!normalizeSymbol(symbol)) return send({ ok: false, error: `无法识别的标的：${symbol}` }, 400)
            const bars = await engine.provider.bars(symbol, period, count)
            let quote = null
            try { quote = await engine.provider.quote(symbol) } catch { /* 快照失败不影响 K 线 */ }
            return send({ ok: true, symbol, period, bars, quote })
          }

          if (method === 'quotes') {
            const quotes = await engine.snapshotFor((Array.isArray(p.symbols) ? p.symbols : []).slice(0, 100))
            return send({ ok: true, quotes })
          }

          return send({ ok: false, error: `unknown method: ${method}` }, 404)
        } catch (error) {
          const status = error instanceof RpcError ? error.status : 500
          if (status === 500) logger.warn?.(`[market-alert] ${method} failed: ${error?.message ?? error}`)
          return send({ ok: false, error: error?.message || String(error) }, status)
        }
      },
    })

    connectionCtx.connection.fetch.register({
      path: STREAM_ROUTE,
      methods: ['GET'],
      async fetch() {
        const encoder = new TextEncoder()
        let closed = false
        const stream = new ReadableStream({
          start(controller) {
            const push = (event, closing = false) => {
              if (closed) return
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
                if (closing) {
                  closed = true
                  controller.close()
                }
              } catch {
                closed = true
              }
            }
            push({ t: 'hello', at: Date.now() })
            const unsubscribe = engine.subscribe(push)
            // 保活：每 25 秒一个注释帧，防代理掐断空闲连接
            const keepAlive = setInterval(() => {
              if (closed) return
              try { controller.enqueue(encoder.encode(': keep-alive\n\n')) } catch { closed = true }
            }, 25_000)
            if (keepAlive.unref) keepAlive.unref()
            return () => {
              clearInterval(keepAlive)
              unsubscribe()
              closed = true
            }
          },
          cancel() { closed = true },
        })
        return new Response(stream, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
          },
        })
      },
    })
  })

  logger.info?.(`[market-alert] ready — state at ${DATA_DIR}, ${store.snapshot.rules.length} rules`)
}
