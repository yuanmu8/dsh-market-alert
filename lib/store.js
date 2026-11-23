/**
 * dsh-market-alert — 状态持久化（N-03）。
 *
 * 规则定义、自选、告警历史与各规则运行态统一写入宿主文件系统：
 *   ~/.dsh/market-alert/state.json
 * 重启后加载即恢复；写入采用原子替换（tmp + rename）防止半截文件。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DATA_DIR = join(homedir(), '.dsh', 'market-alert')
const STATE_FILE = join(DATA_DIR, 'state.json')
const MAX_EVENTS = 200
const MAX_RULES = 500

function emptyState() {
  return {
    version: 1,
    watchlist: [],   // [{ symbol, name, market, group, addedAt }]
    rules: [],       // AlertRule[]
    states: {},      // ruleId → AlertState
    events: [],      // AlertEvent[]（新的在前，环形上限 MAX_EVENTS）
    savedAt: 0,
  }
}

export class StateStore {
  constructor({ logger = console } = {}) {
    this.logger = logger
    this.state = this.#load()
  }

  #load() {
    try {
      const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
      if (raw && typeof raw === 'object' && Array.isArray(raw.rules)) {
        return { ...emptyState(), ...raw }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn?.(`[market-alert] state load failed, starting fresh: ${error.message ?? error}`)
      }
    }
    return emptyState()
  }

  /** 原子写入（N-03）。失败只告警，不打断评估循环。 */
  save() {
    try {
      mkdirSync(DATA_DIR, { recursive: true })
      const tmp = `${STATE_FILE}.tmp`
      writeFileSync(tmp, JSON.stringify({ ...this.state, savedAt: Date.now() }), 'utf8')
      renameSync(tmp, STATE_FILE)
      return true
    } catch (error) {
      this.logger.warn?.(`[market-alert] state save failed: ${error.message ?? error}`)
      return false
    }
  }

  get snapshot() {
    return this.state
  }

  // ---- 自选 ------------------------------------------------------------

  addWatch(entry) {
    if (this.state.watchlist.some((w) => w.symbol === entry.symbol)) return false
    this.state.watchlist.push({ ...entry, addedAt: Date.now() })
    return this.save()
  }

  removeWatch(symbol) {
    const before = this.state.watchlist.length
    this.state.watchlist = this.state.watchlist.filter((w) => w.symbol !== symbol)
    return this.state.watchlist.length !== before ? this.save() : false
  }

  watchEnabledRuleCount(symbol) {
    return this.state.rules.filter((r) => r.symbol === symbol && r.enabled).length
  }

  // ---- 规则 ------------------------------------------------------------

  addRule(rule) {
    if (this.state.rules.length >= MAX_RULES) {
      throw new Error(`规则数已达上限 ${MAX_RULES} 条，请先清理失效规则（N-02 上限保护）`)
    }
    this.state.rules.push(rule)
    this.state.states[rule.id] = {
      ruleId: rule.id,
      phase: rule.enabled ? 'ARMED' : 'DISABLED',
      lastPrice: null,
      lastPct: null,
      lastBarT: null,
      lastTriggeredAt: null,
      cooldownMin: rule.cooldownMin ?? 5,
      updatedAt: Date.now(),
    }
    this.save()
    return rule
  }

  updateRule(id, patch) {
    const rule = this.state.rules.find((r) => r.id === id)
    if (!rule) throw new Error(`规则不存在：${id}`)
    Object.assign(rule, patch)
    const st = this.state.states[id]
    if (st) {
      if (patch.enabled !== undefined) st.phase = patch.enabled ? 'ARMED' : 'DISABLED'
      if (patch.cooldownMin !== undefined) st.cooldownMin = patch.cooldownMin
      st.updatedAt = Date.now()
    }
    this.save()
    return rule
  }

  deleteRule(id) {
    this.state.rules = this.state.rules.filter((r) => r.id !== id)
    delete this.state.states[id]
    return this.save()
  }

  // ---- 运行态与告警事件 ---------------------------------------------------

  stateOf(ruleId) {
    return this.state.states[ruleId] ?? null
  }

  mutateState(ruleId, fn) {
    const st = this.state.states[ruleId]
    if (!st) return
    fn(st)
    st.updatedAt = Date.now()
  }

  pushEvent(event) {
    this.state.events.unshift(event)
    if (this.state.events.length > MAX_EVENTS) this.state.events.length = MAX_EVENTS
    return this.save()
  }

  ackEvent(id) {
    const event = this.state.events.find((e) => e.id === id)
    if (!event || event.acked) return null
    event.acked = true
    // 确认即重新武装（A-02）：该规则若处于 TRIGGERED 且为 once，回到 ARMED。
    const st = this.state.states[event.ruleId]
    const rule = this.state.rules.find((r) => r.id === event.ruleId)
    if (st && rule && st.phase === 'TRIGGERED' && rule.mode === 'once') {
      st.phase = 'ARMED'
      st.updatedAt = Date.now()
    }
    return this.save()
  }

  clearEvents() {
    this.state.events = []
    return this.save()
  }
}

export { DATA_DIR, STATE_FILE, MAX_RULES, MAX_EVENTS }
