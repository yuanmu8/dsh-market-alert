/**
 * dsh-market-alert — 告警评估引擎（Host 侧核心，docs/contract.md §4）。
 *
 * 语义：
 * 1. 穿越判定而非状态判定：阈值类规则只在 prev→now 跨越阈值的一刻触发；
 * 2. 指标类规则只在「新收盘 bar」出现时评估一次（state.lastBarT 防重放）；
 *    条件组（rule.extra）里的各条件共享同一份 bars，指标参数取自 rule.rsiPeriod / maFast / maSlow；
 * 3. once 触发后挂起 TRIGGERED 等确认（重新武装），every 触发后进 COOLING 冷却自动恢复；
 * 4. 休市休眠：标的不在交易时段则跳过，不拉行情、不更新 prev 值（N-05 防过期误触发）；
 * 5. 数据源失败：跳过该标的并记录原因，恢复后自动继续。
 */

import { randomBytes } from 'node:crypto'
import { evaluateRule, phaseAfterTrigger, coolingElapsed, ruleSummary } from './shared.js'
import { MarketDataProvider } from './datasource.js'

const newId = () => randomBytes(6).toString('hex')

const DEFAULT_PERIOD = '15m'
/** 价格 / 涨跌幅类条件吃 quote；其余（MACD / KDJ / RSI / BOLL / 均线 …）吃 bars。 */
const isQuoteKind = (kind) => kind === 'price_above' || kind === 'price_below' || String(kind).startsWith('pct_')

/** 规则的全部条件（主条件 + extra），统一成 { kind, period } 便于取数判断。 */
function conditionsOf(rule) {
  const period = rule.period || DEFAULT_PERIOD
  const main = { kind: rule.kind, period }
  const extra = Array.isArray(rule.extra) ? rule.extra : []
  return [main, ...extra.map((cond) => ({ kind: cond?.kind, period: cond?.period || period }))]
}

const ruleNeedsQuote = (rule) => conditionsOf(rule).some((cond) => isQuoteKind(cond.kind))
const ruleNeedsBars = (rule) => conditionsOf(rule).some((cond) => !isQuoteKind(cond.kind))

export class AlertEngine {
  constructor({ store, logger = console, intervalMs = 5_000 } = {}) {
    this.store = store
    this.logger = logger
    this.intervalMs = intervalMs
    this.provider = new MarketDataProvider({ logger })
    this.subscribers = new Set() // SSE 客户端
    this.timer = null
    this.cycle = 0
    this.lastError = ''
    this.lastRunAt = 0
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.runCycle().catch((error) => {
        this.lastError = String(error?.message ?? error)
        this.logger.warn?.(`[market-alert] cycle failed: ${this.lastError}`)
      })
    }, this.intervalMs)
    if (this.timer.unref) this.timer.unref()
    this.logger.info?.(`[market-alert] engine started (interval ${this.intervalMs}ms)`)
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    for (const send of this.subscribers) { try { send(null, true) } catch { /* 已断开 */ } }
    this.subscribers.clear()
  }

  /** SSE 订阅（告警流独立于行情广播，面板隐藏时保持连接）。 */
  subscribe(send) {
    this.subscribers.add(send)
    return () => this.subscribers.delete(send)
  }

  broadcast(event) {
    for (const send of this.subscribers) {
      try { send(event) } catch { this.subscribers.delete(send) }
    }
  }

  /** 某标本轮取数失败：记录原因并跳过，不中断其他标的。 */
  skipSymbol(symbol, error) {
    this.lastError = `${symbol}: ${error?.message ?? error}`
    this.logger.warn?.(`[market-alert] skip ${symbol} this cycle: ${this.lastError}`)
  }

  /** 单轮评估：只处理 ARMED 规则；休市/无数据静默跳过。 */
  async runCycle() {
    this.lastRunAt = Date.now()
    this.cycle += 1
    const snapshot = this.store.snapshot
    const armed = snapshot.rules.filter((rule) => {
      if (!rule.enabled) return false
      const st = this.store.stateOf(rule.id)
      return st && (st.phase === 'ARMED' || coolingElapsed(st))
    })
    if (!armed.length) return

    // 冷却到期的规则先恢复为 ARMED
    for (const rule of armed) {
      if (coolingElapsed(this.store.stateOf(rule.id))) {
        this.store.mutateState(rule.id, (s) => { s.phase = 'ARMED' })
      }
    }

    // 按标的分组，每标的只取一次快照；K 线按（标的, 周期）各取一次
    const bySymbol = new Map()
    for (const rule of armed) {
      if (!bySymbol.has(rule.symbol)) bySymbol.set(rule.symbol, [])
      bySymbol.get(rule.symbol).push(rule)
    }

    for (const [symbol, rules] of bySymbol) {
      if (!this.provider.inSession(symbol)) continue // 休市休眠（§4.3）
      let quote = null
      if (rules.some(ruleNeedsQuote)) {
        try {
          quote = await this.provider.quote(symbol)
        } catch (error) {
          this.skipSymbol(symbol, error)
          continue
        }
      }
      const barsByPeriod = new Map()
      const periods = [...new Set(rules.filter(ruleNeedsBars).map((rule) => rule.period || DEFAULT_PERIOD))]
      for (const period of periods) {
        try {
          barsByPeriod.set(period, await this.provider.bars(symbol, period, 240))
        } catch (error) {
          // K 线失败只跳过依赖 K 线的规则，价格类规则照常评估
          barsByPeriod.set(period, null)
          this.skipSymbol(symbol, error)
        }
      }
      for (const rule of rules) {
        this.evaluateOne(rule, quote, barsByPeriod.get(rule.period || DEFAULT_PERIOD) ?? null)
      }
    }
  }

  /**
   * 评估单条规则。quote / bars 由 runCycle 按（标的, 周期）取好后传入，
   * 条件组里的各条件共享同一份 bars；mixed periods 由 evaluateRule 返回 no，这里不报错。
   */
  evaluateOne(rule, quote, bars) {
    const st = this.store.stateOf(rule.id)
    if (!st || st.phase !== 'ARMED') return
    const needsQuote = ruleNeedsQuote(rule)
    const needsBars = ruleNeedsBars(rule)
    const input = {}
    if (needsQuote) {
      input.price = quote?.price
      input.changePercent = quote?.changePercent
    }
    if (needsBars) input.bars = bars
    const result = evaluateRule(rule, st, input, {
      rsiPeriod: rule.rsiPeriod,
      maFast: rule.maFast,
      maSlow: rule.maSlow,
    })

    // 无论是否触发都滚动基线：prev 值 / lastBarT（穿越判定的基准必须更新）
    const hasQuote = needsQuote && quote && Number.isFinite(quote.price)
    const lastBar = needsBars && Array.isArray(bars) && bars.length ? bars[bars.length - 1] : null
    if (hasQuote || lastBar) {
      this.store.mutateState(rule.id, (s) => {
        if (hasQuote) {
          s.lastPrice = quote.price
          s.lastPct = quote.changePercent
        }
        if (lastBar) s.lastBarT = lastBar.t
      })
    }

    if (!result.hit) return

    const now = Date.now()
    const event = {
      id: newId(),
      ruleId: rule.id,
      symbol: rule.symbol,
      name: rule.name || quote?.name || rule.symbol,
      summary: ruleSummary(rule),
      detail: result.detail,
      value: result.value,
      barT: needsBars ? (lastBar ? lastBar.t : null) : null,
      at: now,
      acked: false,
    }
    this.store.mutateState(rule.id, (s) => {
      s.phase = phaseAfterTrigger(rule.mode)
      s.lastTriggeredAt = now
    })
    this.store.pushEvent(event)
    this.broadcast({ t: 'alert', ...event })
    this.logger.info?.(`[market-alert] ALERT ${event.summary} — ${result.detail}`)
  }

  /** 拉取自选快照并广播（W-04；面板轮询与 SSE 共用）。 */
  async snapshotFor(symbols) {
    try {
      const quotes = await this.provider.quotes(symbols)
      const degraded = quotes.some((q) => q.degraded)
      this.broadcast({ t: 'quotes', quotes, degraded })
      return quotes
    } catch (error) {
      this.lastError = String(error?.message ?? error)
      return []
    }
  }
}
