/**
 * dsh-market-alert — Host 半。
 *
 * 职责：
 * 1. 装配 StateStore（~/.dsh/market-alert/state.json）与 AlertEngine 评估循环；
 * 2. POST /api/market-alert：面板 JSON-RPC（state/search/watch/rule/event）；
 * 3. GET  /api/market-alert/stream：SSE 告警流 + 自选快照广播（页面隐藏保持连接）。
 *
 * 告警评估全部在 Host 侧：浏览器关闭后规则照常触发，重开面板经 SSE 收到新告警。
 */

import { AlertEngine } from './lib/engine.js'
import { normalizeSymbol } from './lib/datasource.js'
import { StateStore, DATA_DIR, MAX_RULES } from './lib/store.js'

export const name = 'market-alert'

const ROUTE = '/api/market-alert'
const STREAM_ROUTE = '/api/market-alert/stream'

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
              rules: snapshot.rules.map((rule) => ({ ...rule, state: store.stateOf(rule.id) })),
              events: snapshot.events,
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

          if (method === 'watch.add') {
            const symbol = String(p.symbol ?? '').trim()
            const norm = normalizeSymbol(symbol)
            if (!norm) return send({ ok: false, error: `无法识别的标的：${symbol}` }, 400)
            let name = String(p.name ?? '').trim() || norm.symbol
            try { name = (await engine.provider.quote(norm.symbol)).name || name } catch { /* 搜索失败不阻塞 */ }
            const added = store.addWatch({ symbol: norm.symbol, name, market: norm.kind, group: String(p.group ?? '默认').slice(0, 16) })
            return send({ ok: true, added, watchlist: store.snapshot.watchlist })
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
            return send({ ok: true, watchlist: store.snapshot.watchlist })
          }

          if (method === 'rule.add') {
            const symbol = String(p.symbol ?? '').trim()
            const norm = normalizeSymbol(symbol)
            if (!norm) return send({ ok: false, error: `无法识别的标的：${symbol}` }, 400)
            const rule = {
              id: `rule_${Math.random().toString(16).slice(2, 10)}`,
              symbol: norm.symbol,
              name: String(p.name ?? '').trim() || norm.symbol,
              kind: String(p.kind ?? ''),
              threshold: Number(p.threshold),
              period: String(p.period ?? '15m'),
              mode: p.mode === 'every' ? 'every' : 'once',
              cooldownMin: Math.max(1, Math.min(1440, Number(p.cooldownMin) || 5)),
              enabled: p.enabled !== false,
              createdAt: Date.now(),
            }
            if (!rule.kind) return send({ ok: false, error: '缺少规则类型' }, 400)
            store.addRule(rule)
            return send({ ok: true, rule })
          }

          if (method === 'rule.update') {
            const rule = store.updateRule(String(p.id ?? ''), {
              ...(p.enabled !== undefined ? { enabled: Boolean(p.enabled) } : {}),
              ...(p.threshold !== undefined && Number.isFinite(Number(p.threshold)) ? { threshold: Number(p.threshold) } : {}),
              ...(p.mode !== undefined ? { mode: p.mode === 'every' ? 'every' : 'once' } : {}),
              ...(p.cooldownMin !== undefined ? { cooldownMin: Math.max(1, Math.min(1440, Number(p.cooldownMin) || 5)) } : {}),
            })
            return send({ ok: true, rule })
          }

          if (method === 'rule.delete') {
            store.deleteRule(String(p.id ?? ''))
            return send({ ok: true })
          }

          if (method === 'event.ack') {
            const saved = store.ackEvent(String(p.id ?? ''))
            return send({ ok: Boolean(saved) ? true : true, events: store.snapshot.events })
          }

          if (method === 'event.clear') {
            store.clearEvents()
            return send({ ok: true, events: [] })
          }

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
          return send({ ok: false, error: error?.message || String(error) }, 500)
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
