/**
 * dsh-market-alert — Client 半（面板 UI）。
 *
 * 三个标签页：自选 / 告警规则 / 告警记录。
 * 告警流走独立 SSE 连接（/api/market-alert/stream），页面隐藏也保持；
 * 自选快照由 Host 定期广播或手动刷新获取。
 */
window.__ModuleLoader__.load({
  id: 'dsh-market-alert',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ROUTE = '/api/market-alert'
    const STREAM = '/api/market-alert/stream'

    const T = {
      bg: 'var(--dsw-alias-bg-layer-1, transparent)',
      card: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))',
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.25))',
      brand: 'var(--dsw-alias-brand-primary, #4a7dff)',
      text: 'var(--dsw-alias-label-primary, inherit)',
      muted: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))',
      ok: 'var(--dsw-alias-state-success-primary, #2ea44f)',
      err: 'var(--dsw-alias-state-error-primary, #d1242f)',
      up: '#d1242f',
      down: '#2da44e',
    }

    const KIND_LABEL = {
      price_above: '价格 ≥',
      price_below: '价格 ≤',
      pct_above: '涨幅 ≥',
      pct_below: '跌幅 ≤',
      macd_golden: 'MACD 金叉',
      macd_dead: 'MACD 死叉',
      kdj_j_above: 'KDJ J ≥',
      kdj_j_below: 'KDJ J ≤',
    }
    const PERIODS = ['1m', '5m', '15m', '30m', '60m', '1d']
    const MARKET_TAG = { A: 'A股', HK: '港股', US: '美股', CNF: '期货' }

    async function call(method, payload = {}) {
      const res = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, payload }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || data.ok === false) {
        const error = new Error(data?.error || `HTTP ${res.status}`)
        if (data?.needConfirm) error.needConfirm = true
        throw error
      }
      return data
    }

    const S = {
      root: { padding: 16, overflow: 'auto', height: '100%', boxSizing: 'border-box', color: T.text },
      card: { background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: '10px 12px', marginBottom: 10 },
      title: { fontSize: 13, fontWeight: 600, margin: '0 0 8px' },
      muted: { fontSize: 12, color: T.muted },
      row: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12.5 },
      spread: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
      input: { width: '100%', boxSizing: 'border-box', border: `1px solid ${T.border}`, borderRadius: 7, background: 'transparent', color: T.text, padding: '5px 8px', font: 'inherit', fontSize: 12.5 },
      btn: { border: `1px solid ${T.border}`, borderRadius: 7, background: 'transparent', color: T.text, padding: '4px 10px', cursor: 'pointer', font: 'inherit', fontSize: 12 },
      btnBrand: { border: `1px solid ${T.brand}`, color: T.brand, borderRadius: 7, background: 'transparent', padding: '4px 12px', cursor: 'pointer', font: 'inherit', fontSize: 12, fontWeight: 500 },
      pill: { borderRadius: 99, padding: '1px 8px', fontSize: 11, border: `1px solid ${T.border}` },
      tab: (active) => ({
        border: 'none', background: 'transparent', cursor: 'pointer', font: 'inherit',
        fontSize: 13, padding: '6px 2px', marginRight: 18,
        color: active ? T.brand : T.muted, borderBottom: active ? `2px solid ${T.brand}` : '2px solid transparent',
      }),
    }

    function pctColor(v) {
      if (v === null || v === undefined || !Number.isFinite(v)) return T.muted
      return v >= 0 ? T.up : T.down
    }

    function fmtPct(v) {
      return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
    }

    function ruleText(rule) {
      const period = ['macd_golden', 'macd_dead', 'kdj_j_above', 'kdj_j_below'].includes(rule.kind) ? ` · ${rule.period}` : ''
      const thr = rule.threshold != null && rule.threshold !== 0 ? ` ${rule.threshold}` : ''
      return `${KIND_LABEL[rule.kind] ?? rule.kind}${thr}${period}`
    }

    function App() {
      const [tab, setTab] = React.useState('watch')
      const [data, setData] = React.useState(null)
      const [quotes, setQuotes] = React.useState({})
      const [degraded, setDegraded] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [searchKey, setSearchKey] = React.useState('')
      const [hits, setHits] = React.useState([])
      const [form, setForm] = React.useState(null) // 预填的规则表单
      const [chartSymbol, setChartSymbol] = React.useState(null) // K 线页当前标的

      const refresh = React.useCallback(async () => {
        try {
          const res = await call('state')
          setData(res)
        } catch (error) {
          setNotice({ tone: 'err', text: String(error.message || error) })
        }
      }, [])

      React.useEffect(() => { refresh() }, [refresh])

      // 告警流：独立 SSE 连接，页面隐藏时由浏览器保持
      React.useEffect(() => {
        const es = new EventSource(STREAM)
        es.onmessage = (msg) => {
          let event = null
          try { event = JSON.parse(msg.data) } catch { return }
          if (!event) return
          if (event.t === 'quotes') {
            setDegraded(Boolean(event.degraded))
            setQuotes((prev) => {
              const next = { ...prev }
              for (const q of event.quotes ?? []) next[q.symbol] = q
              return next
            })
          } else if (event.t === 'alert') {
            setData((prev) => (prev ? { ...prev, events: [event, ...(prev.events ?? [])] } : prev))
            setNotice({ tone: 'warn', text: `🔔 ${event.summary} — ${event.detail}` })
          }
        }
        return () => es.close()
      }, [])

      // 轮询兜底：即使 SSE 断开（代理/休眠），自选快照也每 4 秒拉一次（W-04 自动刷新）
      React.useEffect(() => {
        const tick = async () => {
          const symbols = (data?.watchlist ?? []).map((w) => w.symbol)
          if (!symbols.length) return
          try {
            const res = await call('quotes', { symbols })
            setQuotes((prev) => {
              const next = { ...prev }
              for (const q of res.quotes ?? []) next[q.symbol] = q
              return next
            })
          } catch { /* 静默：下个节拍重试 */ }
        }
        const timer = setInterval(tick, 4_000)
        tick()
        return () => clearInterval(timer)
      }, [data?.watchlist])

      const run = async (tag, fn) => {
        setBusy(tag)
        setNotice(null)
        try { await fn() } catch (error) {
          setNotice({ tone: 'err', text: String(error.message || error) })
        } finally { setBusy('') }
      }

      const doSearch = () => run('search', async () => {
        const res = await call('search', { keyword: searchKey })
        setHits(res.hits ?? [])
      })

      const addWatch = (hit) => run('watch', async () => {
        await call('watch.add', { symbol: hit.symbol, name: hit.name })
        setNotice({ tone: 'ok', text: `已加入自选：${hit.name}（${hit.symbol}）` })
        await refresh()
      })

      const removeWatch = async (w, confirmed) => {
        setBusy('rm')
        setNotice(null)
        try {
          await call('watch.remove', { symbol: w.symbol, confirm: Boolean(confirmed) })
          setNotice({ tone: 'ok', text: `已删除：${w.name}` })
          await refresh()
        } catch (error) {
          if (error.needConfirm && !confirmed) {
            if (window.confirm(`${w.name}：${error.message}，确定删除吗？`)) return removeWatch(w, true)
            return
          }
          setNotice({ tone: 'err', text: String(error.message || error) })
        } finally { setBusy('') }
      }

      const addRule = (payload) => run('rule', async () => {
        const res = await call('rule.add', payload)
        setNotice({ tone: 'ok', text: `规则已创建：${res.rule.name} ${ruleText(res.rule)}` })
        setForm(null)
        await refresh()
      })

      const toggleRule = (rule) => run('toggle', async () => {
        await call('rule.update', { id: rule.id, enabled: !rule.enabled })
        await refresh()
      })

      const deleteRule = (rule) => run('del', async () => {
        await call('rule.delete', { id: rule.id })
        await refresh()
      })

      const ackEvent = (event) => run('ack', async () => {
        await call('event.ack', { id: event.id })
        await refresh()
      })

      const clearEvents = () => run('clear', async () => {
        await call('event.clear')
        setNotice({ tone: 'ok', text: '已清空确认历史' })
        await refresh()
      })

      const startAlert = (w) => {
        setTab('rules')
        setForm({ symbol: w.symbol, name: w.name, kind: 'price_above', threshold: '', period: '15m', mode: 'once', cooldownMin: 5 })
      }

      const watchlist = data?.watchlist ?? []
      const rules = data?.rules ?? []
      const events = data?.events ?? []
      const unacked = events.filter((e) => !e.acked).length

      return h('div', { style: S.root },
        h('div', { style: { ...S.spread, marginBottom: 10 } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10 } },
            h('span', { style: { fontSize: 16, fontWeight: 600 } }, '行情告警'),
            degraded ? h('span', { style: { ...S.pill, color: T.muted, fontSize: 10 } }, '备源降级') : null),
          h('div', { style: S.muted, title: '告警引擎每 5 秒扫描一轮全部已武装规则；休市时段自动休眠不计入' },
            data?.engine?.running
              ? `引擎运行中 · 已扫描 ${data.engine.cycle} 轮 · 最近扫描 ${data.engine.lastRunAt ? new Date(data.engine.lastRunAt).toLocaleTimeString() : '—'}`
              : '引擎未运行')),

        h('div', { style: { borderBottom: `1px solid ${T.border}`, marginBottom: 12 } },
          h('button', { style: S.tab(tab === 'watch'), onClick: () => setTab('watch') }, `自选 ${watchlist.length}`),
          h('button', { style: S.tab(tab === 'chart'), onClick: () => setTab('chart') }, 'K 线'),
          h('button', { style: S.tab(tab === 'rules'), onClick: () => setTab('rules') }, `告警规则 ${rules.length}`),
          h('button', { style: S.tab(tab === 'events'), onClick: () => setTab('events') }, `告警记录 ${unacked ? `(${unacked} 未确认)` : ''}`)),

        notice ? h('div', { style: { border: `1px solid ${notice.tone === 'ok' ? T.ok : notice.tone === 'warn' ? T.brand : T.err}`, borderRadius: 8, padding: '7px 11px', marginBottom: 10, fontSize: 12.5, whiteSpace: 'pre-wrap' } }, notice.text) : null,

        tab === 'watch' ? h(WatchTab, {
          watchlist, quotes, data, busy, searchKey, setSearchKey, hits,
          doSearch, addWatch, removeWatch, startAlert, refresh,
        }) : null,

        tab === 'chart' ? h(ChartTab, {
          watchlist, quotes, events, defaultSymbol: chartSymbol ?? watchlist[0]?.symbol ?? '',
          onSymbolChange: setChartSymbol,
        }) : null,

        tab === 'rules' ? h(RulesTab, {
          rules, data, form, setForm, busy, addRule, toggleRule, deleteRule,
        }) : null,

        tab === 'events' ? h(EventsTab, {
          events, busy, ackEvent, clearEvents,
        }) : null,
      )
    }

    function WatchTab(props) {
      const { watchlist, quotes, busy, searchKey, setSearchKey, hits, doSearch, addWatch, removeWatch, startAlert, data } = props
      return h('div', null,
        h('div', { style: { ...S.card } },
          h('div', { style: S.row },
            h('input', {
              style: S.input, value: searchKey, placeholder: '代码 / 名称 / 拼音缩写，如 600519、茅台、RB2610、00700、AAPL',
              onChange: (e) => setSearchKey(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') doSearch() },
            }),
            h('button', { style: S.btnBrand, disabled: Boolean(busy), onClick: doSearch }, busy === 'search' ? '搜索中…' : '搜索')),
          hits.length
            ? h('div', { style: { marginTop: 8 } },
                ...hits.map((hit) => h('div', { key: hit.symbol, style: { ...S.row, justifyContent: 'space-between' } },
                  h('span', null, hit.name, h('span', { style: { ...S.muted, marginLeft: 8, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 } }, hit.symbol),
                    h('span', { style: { ...S.pill, marginLeft: 8, fontSize: 10 } }, MARKET_TAG[hit.market] ?? hit.market)),
                  h('button', { style: S.btn, disabled: Boolean(busy), onClick: () => addWatch(hit) }, '加自选'))))
            : (searchKey ? h('div', { style: { ...S.muted, marginTop: 6 } }, '无结果') : null)),

        h('div', { style: S.card },
          h('div', { style: { ...S.spread, marginBottom: 6 } },
            h('span', { style: S.title }, '自选列表'),
            h('span', { style: S.muted }, `${watchlist.length} 个标的 · 快照自动推送`)),
          watchlist.length === 0
            ? h('div', { style: S.muted }, '还没有自选标的，用上方搜索添加。')
            : h('div', null,
                ...watchlist.map((w) => {
                  const q = quotes[w.symbol]
                  return h('div', { key: w.symbol, style: { ...S.row, justifyContent: 'space-between', borderTop: `1px solid ${T.border}`, paddingTop: 6 } },
                    h('div', { style: { minWidth: 0 } },
                      h('span', { style: { fontWeight: 500 } }, w.name),
                      h('span', { style: { ...S.muted, marginLeft: 8, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 } }, w.symbol),
                      q?.degraded ? h('span', { style: { ...S.pill, marginLeft: 6, fontSize: 10, color: T.muted } }, '备源') : null),
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
                      h('span', { style: { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5 } },
                        q ? Number(q.price).toFixed(q.price > 100 ? 2 : 3) : '—'),
                      h('span', { style: { color: pctColor(q?.changePercent), fontSize: 12, minWidth: 52, textAlign: 'right' } },
                        fmtPct(q?.changePercent)),
                      h('button', { style: S.btn, onClick: () => startAlert(w) }, '设告警'),
                      h('button', {
                        style: { ...S.btn, color: T.err }, disabled: Boolean(busy),
                        onClick: () => {
                          const n = data?.rules?.filter((r) => r.symbol === w.symbol && r.enabled).length ?? 0
                          if (n > 0) {
                            if (!window.confirm(`${w.name} 存在 ${n} 条启用中的告警规则，删除后将一并失效，确定？`)) return
                          }
                          removeWatch(w, n > 0)
                        },
                      }, '删除')))
                }))))
    }

    function smaOf(closes, period) {
      return closes.map((_, i) => {
        if (i + 1 < period) return null
        let sum = 0
        for (let j = i - period + 1; j <= i; j += 1) sum += closes[j]
        return sum / period
      })
    }

    const MA_DEFS = [
      { n: 5, color: '#e6b422' },
      { n: 10, color: '#4a9eff' },
      { n: 20, color: '#c655e0' },
      { n: 60, color: '#8bc34a' },
    ]
    const PERIOD_BTNS = [
      ['1m', '1分'], ['5m', '5分'], ['15m', '15分'], ['30m', '30分'], ['60m', '60分'],
      ['1d', '日'], ['1w', '周'], ['1M', '月'],
    ]

    // 副图指标下拉选项
    const INDICATOR_OPTS = [
      ['macd', 'MACD'],
      ['kdj', 'KDJ'],
      ['rsi', 'RSI'],
      ['none', '隐藏副图'],
    ]

    function emaOf(values, n) {
      const out = new Array(values.length).fill(null)
      let sum = 0
      for (let i = 0; i < values.length; i += 1) {
        if (i < n) { sum += values[i]; if (i === n - 1) out[i] = sum / n; continue }
        out[i] = out[i - 1] + (2 / (n + 1)) * (values[i] - out[i - 1])
      }
      return out
    }

    // MACD(12,26,9)：返回 dif / dea / hist（hist = 2*(dif-dea)）
    function macdCalc(closes) {
      const ema12 = emaOf(closes, 12)
      const ema26 = emaOf(closes, 26)
      const dif = closes.map((_, i) => (ema12[i] !== null && ema26[i] !== null ? ema12[i] - ema26[i] : null))
      const valid = dif.map((v) => (v === null ? 0 : v))
      const deaRaw = emaOf(valid, 9)
      const dea = deaRaw.map((v, i) => (dif[i] === null ? null : v))
      const hist = dif.map((v, i) => (v !== null && dea[i] !== null ? 2 * (v - dea[i]) : null))
      return { dif, dea, hist }
    }

    // KDJ(9,3,3)：返回 k / d / j
    function kdjCalc(bars) {
      const n = 9
      const k = new Array(bars.length).fill(null)
      const d = new Array(bars.length).fill(null)
      const j = new Array(bars.length).fill(null)
      let pk = 50
      let pd = 50
      for (let i = 0; i < bars.length; i += 1) {
        const from = Math.max(0, i - n + 1)
        let hh = -Infinity
        let ll = Infinity
        for (let t = from; t <= i; t += 1) {
          if (bars[t].h > hh) hh = bars[t].h
          if (bars[t].l < ll) ll = bars[t].l
        }
        const rsv = hh === ll ? 50 : ((bars[i].c - ll) / (hh - ll)) * 100
        pk = (2 / 3) * pk + (1 / 3) * rsv
        pd = (2 / 3) * pd + (1 / 3) * pk
        k[i] = pk; d[i] = pd; j[i] = 3 * pk - 2 * pd
      }
      return { k, d, j }
    }

    // RSI(n)：Wilder 平滑，返回三条 {name, values}
    function rsiCalc(closes, periods = [6, 12, 24]) {
      return periods.map((n) => {
        const out = new Array(closes.length).fill(null)
        let avgUp = 0
        let avgDn = 0
        for (let i = 1; i < closes.length; i += 1) {
          const ch = closes[i] - closes[i - 1]
          const up = Math.max(ch, 0)
          const dn = Math.max(-ch, 0)
          if (i <= n) {
            avgUp += up / n
            avgDn += dn / n
            if (i === n) out[i] = avgDn === 0 ? 100 : 100 - 100 / (1 + avgUp / avgDn)
          } else {
            avgUp = (avgUp * (n - 1) + up) / n
            avgDn = (avgDn * (n - 1) + dn) / n
            out[i] = avgDn === 0 ? 100 : 100 - 100 / (1 + avgUp / avgDn)
          }
        }
        return { name: `RSI${n}`, values: out, color: '#4a9eff' }
      })
    }

    // 各副图指标的计算与绘制定义
    const IND_SERIES = {
      macd(bars) {
        const closes = bars.map((b) => b.c)
        const { dif, dea, hist } = macdCalc(closes)
        return {
          lines: [
            { name: 'DIF', values: dif, color: '#e6b422' },
            { name: 'DEA', values: dea, color: '#4a9eff' },
          ],
          hist: { values: hist, colorOf: (v) => (v >= 0 ? 'rgba(229,57,53,0.7)' : 'rgba(46,164,79,0.7)') },
          fixed: null,
        }
      },
      kdj(bars) {
        const { k, d, j } = kdjCalc(bars)
        return {
          lines: [
            { name: 'K', values: k, color: '#e6b422' },
            { name: 'D', values: d, color: '#4a9eff' },
            { name: 'J', values: j, color: '#c655e0' },
          ],
          hist: null,
          fixed: [-10, 110],
        }
      },
      rsi(bars) {
        return {
          lines: rsiCalc(bars.map((b) => b.c)),
          hist: null,
          fixed: [0, 100],
        }
      },
    }

    function ChartTab({ watchlist, events, defaultSymbol, onSymbolChange }) {
      const [symbol, setSymbol] = React.useState(defaultSymbol)
      const [period, setPeriod] = React.useState('15m')
      const [indicator, setIndicator] = React.useState('macd')
      const [bars, setBars] = React.useState(null)
      const [quote, setQuote] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      const [hover, setHover] = React.useState(null) // bar index
      const canvasRef = React.useRef(null)

      React.useEffect(() => { setSymbol(defaultSymbol) }, [defaultSymbol])

      const load = React.useCallback(async () => {
        if (!symbol) return
        setLoading(true)
        try {
          const res = await call('bars', { symbol, period, count: 180 })
          setBars(res.bars ?? [])
          setQuote(res.quote ?? null)
          setError('')
        } catch (e) {
          setError(String(e.message || e))
        } finally { setLoading(false) }
      }, [symbol, period])

      React.useEffect(() => { load() }, [load])
      // K 线自动刷新：活跃标的每 15 秒拉一次新 bar
      React.useEffect(() => {
        const timer = setInterval(load, 15_000)
        return () => clearInterval(timer)
      }, [load])

      // 告警标记：按 barT 定位；价格类告警定位到事件时刻所在的最后一根 bar
      const markers = React.useMemo(() => {
        if (!bars || !bars.length) return []
        const lastBar = bars[bars.length - 1]
        return (events ?? [])
          .filter((e) => e.symbol === symbol)
          .map((e) => {
            let idx = e.barT ? bars.findIndex((b) => b.t === e.barT) : -1
            if (idx < 0) {
              // 无 barT（价格类）：落在事件时刻之前最近的 bar
              const at = new Date(e.at + 8 * 3_600_000)
              const key = `${at.toISOString().slice(0, 10)} ${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`
              for (let i = bars.length - 1; i >= 0; i -= 1) {
                if (bars[i].t <= `${key}:59`) { idx = i; break }
              }
            }
            if (idx < 0 && bars.length) idx = bars.length - 1
            return idx >= 0 ? { idx, acked: e.acked } : null
          })
          .filter(Boolean)
      }, [bars, events, symbol])

      // 绘制
      React.useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas || !bars || !bars.length) return
        const dpr = window.devicePixelRatio || 1
        const width = canvas.clientWidth
        const height = canvas.clientHeight
        canvas.width = Math.round(width * dpr)
        canvas.height = Math.round(height * dpr)
        const g = canvas.getContext('2d')
        g.setTransform(dpr, 0, 0, dpr, 0, 0)
        g.clearRect(0, 0, width, height)

        const view = bars.slice(-Math.min(bars.length, 120))
        const off = bars.length - view.length
        const closes = view.map((b) => b.c)
        const maSeries = MA_DEFS.map((d) => smaOf(closes, d.n))
        const highs = view.map((b) => b.h)
        const lows = view.map((b) => b.l)
        const maxV = Math.max(...view.map((b) => b.v ?? 0), 1)
        const padR = 56
        const padB = 20
        const hasInd = indicator !== 'none' && IND_SERIES[indicator]
        const priceH = (hasInd ? height * 0.52 : height * 0.72) - 12
        const volTop = (hasInd ? height * 0.52 : height * 0.72) + 4
        const volH = hasInd ? height * 0.13 : height - volTop - padB
        const indTop = volTop + volH + 8
        const indH = height - indTop - padB
        const flatMas = maSeries.flat().filter((v) => v !== null && Number.isFinite(v))
        let hi = Math.max(...highs, ...flatMas)
        let lo = Math.min(...lows, ...flatMas)
        if (!Number.isFinite(hi) || !Number.isFinite(lo)) { hi = Math.max(...highs); lo = Math.min(...lows) }
        const span = (hi - lo) || 1
        hi += span * 0.05
        lo -= span * 0.05
        const step = (width - padR) / view.length
        const bw = Math.max(2, Math.min(11, step * 0.62))
        const yOf = (v) => 8 + (priceH - 8) * (1 - (v - lo) / (hi - lo))
        const xOf = (i) => (i + 0.5) * step

        // 网格与价格轴
        g.strokeStyle = 'rgba(127,127,127,0.18)'
        g.fillStyle = 'rgba(127,127,127,0.85)'
        g.font = '10px ui-monospace, Menlo, monospace'
        for (let k = 0; k <= 4; k += 1) {
          const v = lo + ((hi - lo) * k) / 4
          const y = yOf(v)
          g.beginPath(); g.moveTo(0, y); g.lineTo(width - padR, y); g.stroke()
          g.fillText(Number(v).toFixed(v > 500 ? 0 : 2), width - padR + 4, y + 3)
        }

        // 成交量（锚定成交量区底部，不与副图重叠）
        const volBottom = volTop + volH
        for (let i = 0; i < view.length; i += 1) {
          const vh = ((view[i].v ?? 0) / maxV) * volH
          g.fillStyle = view[i].c >= view[i].o ? 'rgba(229,57,53,0.55)' : 'rgba(46,164,79,0.55)'
          g.fillRect(xOf(i) - bw / 2, volBottom - vh, bw, vh)
        }

        // 副图指标窗格（MACD / KDJ / RSI）
        if (hasInd) {
          const def = IND_SERIES[indicator](view)
          // 面板底色与分隔线
          g.fillStyle = 'rgba(127,127,127,0.05)'
          g.fillRect(0, indTop, width - padR, indH)
          g.strokeStyle = 'rgba(127,127,127,0.25)'
          g.beginPath(); g.moveTo(0, indTop - 4); g.lineTo(width - padR, indTop - 4); g.stroke()

          let ihi = -Infinity
          let ilo = Infinity
          const all = def.lines.flatMap((l) => l.values).concat(def.hist ? def.hist.values : [])
          for (const v of all) {
            if (v !== null && Number.isFinite(v)) {
              if (v > ihi) ihi = v
              if (v < ilo) ilo = v
            }
          }
          if (def.fixed) { ilo = def.fixed[0]; ihi = def.fixed[1] }
          if (!Number.isFinite(ihi) || !Number.isFinite(ilo)) { ihi = 1; ilo = 0 }
          let ispan = ihi - ilo
          if (ispan <= 0) { ispan = Math.abs(ihi) * 0.1 || 1; ilo -= ispan / 2; ihi += ispan / 2 }
          const pad = ispan * 0.08
          ilo -= pad; ihi += pad
          const iyOf = (v) => indTop + indH * (1 - (v - ilo) / (ihi - ilo))

          // 副图数值轴
          g.strokeStyle = 'rgba(127,127,127,0.18)'
          g.fillStyle = 'rgba(127,127,127,0.85)'
          for (let k2 = 0; k2 <= 2; k2 += 1) {
            const v = ilo + ((ihi - ilo) * k2) / 2
            const y = iyOf(v)
            g.beginPath(); g.moveTo(0, y); g.lineTo(width - padR, y); g.stroke()
            g.fillText(Number(v).toFixed(Math.abs(ihi) < 10 ? 2 : 0), width - padR + 4, y + 3)
          }
          // 零轴
          if (ilo < 0 && ihi > 0) {
            g.strokeStyle = 'rgba(127,127,127,0.3)'
            g.beginPath(); g.moveTo(0, iyOf(0)); g.lineTo(width - padR, iyOf(0)); g.stroke()
          }

          // 柱状（MACD 红绿柱）
          if (def.hist) {
            const mh = Math.max(Math.abs(iyOf(0) - indTop), iyOf(0) - indTop, 1)
            for (let i = 0; i < view.length; i += 1) {
              const v = def.hist.values[i]
              if (v === null || !Number.isFinite(v)) continue
              const hgt = Math.abs(iyOf(v) - iyOf(0))
              g.fillStyle = def.hist.colorOf(v)
              g.fillRect(xOf(i) - bw / 2, v >= 0 ? iyOf(0) - hgt : iyOf(0), bw, hgt)
            }
          }

          // 指标线
          for (const line of def.lines) {
            g.strokeStyle = line.color
            g.lineWidth = 1
            g.beginPath()
            let started = false
            for (let i = 0; i < line.values.length; i += 1) {
              const v = line.values[i]
              if (v === null || !Number.isFinite(v)) { started = false; continue }
              if (!started) { g.moveTo(xOf(i), iyOf(v)); started = true } else g.lineTo(xOf(i), iyOf(v))
            }
            g.stroke()
          }

          // 面板标题与悬停值
          const hi = hover !== null && hover >= 0 && hover < view.length ? hover : view.length - 1
          const label = def.lines.map((l) => {
            const v = l.values[hi]
            return `${l.name} ${v !== null && v !== undefined && Number.isFinite(v) ? v.toFixed(2) : '—'}`
          }).join(' ')
          g.fillStyle = 'rgba(127,127,127,0.9)'
          g.fillText(`${indicator.toUpperCase()}  ${label}`, 4, indTop + 11)
        }

        // 蜡烛（红涨绿跌）
        for (let i = 0; i < view.length; i += 1) {
          const b = view[i]
          const up = b.c >= b.o
          const color = up ? '#e53935' : '#2ea44f'
          const cx = xOf(i)
          g.strokeStyle = color
          g.fillStyle = color
          g.beginPath(); g.moveTo(cx, yOf(b.h)); g.lineTo(cx, yOf(b.l)); g.stroke()
          const yo = yOf(b.o)
          const yc = yOf(b.c)
          const top = Math.min(yo, yc)
          const hgt = Math.max(1, Math.abs(yc - yo))
          if (up) {
            g.fillRect(cx - bw / 2, top, bw, hgt)
          } else {
            g.fillRect(cx - bw / 2, top, bw, hgt)
          }
        }

        // 均线
        for (const def of MA_DEFS) {
          const series = smaOf(closes, def.n)
          g.strokeStyle = def.color
          g.lineWidth = 1
          g.beginPath()
          let started = false
          for (let i = 0; i < series.length; i += 1) {
            if (series[i] === null) { started = false; continue }
            if (!started) { g.moveTo(xOf(i), yOf(series[i])); started = true }
            else g.lineTo(xOf(i), yOf(series[i]))
          }
          g.stroke()
        }

        // 告警标记（倒三角，未确认红色 / 已确认灰色）
        for (const mk of markers) {
          const i = mk.idx - off
          if (i < 0 || i >= view.length) continue
          const b = view[i]
          const x = xOf(i)
          const y = yOf(b.h) - 6
          g.fillStyle = mk.acked ? 'rgba(127,127,127,0.8)' : '#f5a623'
          g.beginPath()
          g.moveTo(x - 4, y - 7)
          g.lineTo(x + 4, y - 7)
          g.lineTo(x, y)
          g.closePath()
          g.fill()
        }

        // 十字光标
        if (hover !== null && hover >= 0 && hover < view.length) {
          g.strokeStyle = 'rgba(127,127,127,0.5)'
          g.setLineDash([4, 3])
          g.beginPath(); g.moveTo(xOf(hover), 0); g.lineTo(xOf(hover), height - padB); g.stroke()
          g.setLineDash([])
        }

        // 时间轴（首/中/尾）
        g.fillStyle = 'rgba(127,127,127,0.85)'
        const tAt = (i) => view[i]?.t.slice(5, 16) ?? ''
        g.fillText(tAt(0), 2, height - 6)
        g.fillText(tAt(Math.floor(view.length / 2)), width / 2 - 24, height - 6)
        g.fillText(tAt(view.length - 1), width - padR - 70, height - 6)
      }, [bars, hover, markers, indicator])

      // 头部信息行：悬停 bar 或最新 bar 的 OHLC + MA
      const viewNow = bars ? bars.slice(-120) : null
      const info = viewNow && viewNow.length
        ? (hover !== null && viewNow[hover] ? viewNow[hover] : viewNow[viewNow.length - 1])
        : null
      const maLine = info && viewNow
        ? MA_DEFS.map((d) => {
            const series = smaOf(viewNow.map((b) => b.c), d.n)
            const last = series[series.length - 1]
            return `MA${d.n}=${last !== null && last !== undefined ? last.toFixed(2) : '—'}`
          }).join(' ')
        : ''

      const onMouseMove = (e) => {
        const canvas = canvasRef.current
        if (!canvas || !bars || !bars.length) return
        const view = bars.slice(-120)
        const rect = canvas.getBoundingClientRect()
        const x = e.clientX - rect.left
        const step = (rect.width - 56) / view.length
        setHover(Math.max(0, Math.min(view.length - 1, Math.floor(x / step))))
      }

      const knownSymbols = [...new Set([...watchlist.map((w) => w.symbol), symbol].filter(Boolean))]

      return h('div', null,
        h('div', { style: { ...S.card } },
          h('div', { style: { ...S.row, flexWrap: 'wrap' } },
            h('select', {
              style: { ...S.input, appearance: 'auto', maxWidth: 220 },
              value: symbol,
              onChange: (e) => { setSymbol(e.target.value); onSymbolChange(e.target.value) },
            },
              ...knownSymbols.map((sym) => {
                const w = watchlist.find((x) => x.symbol === sym)
                return h('option', { key: sym, value: sym }, `${w ? w.name : sym}（${sym}）`)
              })),
            ...PERIOD_BTNS.map(([val, label]) => h('button', {
              key: val,
              style: { ...S.btn, ...(period === val ? { borderColor: T.brand, color: T.brand } : {}) },
              onClick: () => setPeriod(val),
            }, label)),
            h('select', {
              style: { ...S.input, appearance: 'auto', width: 96, maxWidth: 96 },
              value: indicator,
              onChange: (e) => setIndicator(e.target.value),
              title: 'K 线下方的副图指标',
            },
              ...INDICATOR_OPTS.map(([val, label]) => h('option', { key: val, value: val }, label))),
            h('button', { style: S.btn, onClick: load, disabled: loading }, loading ? '刷新中…' : '刷新'),
            quote ? h('span', { style: { marginLeft: 'auto', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 } },
              `${Number(quote.price).toFixed(2)} `,
              h('span', { style: { color: pctColor(quote.changePercent) } }, fmtPct(quote.changePercent))) : null),
          info
            ? h('div', { style: { ...S.muted, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11, marginTop: 4 } },
                `${info.t.slice(0, 16)}  开 ${info.o.toFixed(2)} 高 ${info.h.toFixed(2)} 低 ${info.l.toFixed(2)} 收 ${info.c.toFixed(2)} 量 ${info.v ?? '—'}   ${maLine}`)
            : null,
          error ? h('div', { style: { ...S.muted, color: T.err, marginTop: 6 } }, `K 线不可用：${error}`) : null,
          h('canvas', {
            ref: canvasRef,
            style: { width: '100%', height: 400, marginTop: 8, borderRadius: 8, cursor: 'crosshair' },
            onMouseMove,
            onMouseLeave: () => setHover(null),
          }),
          h('div', { style: { ...S.muted, marginTop: 6, fontSize: 11 } },
            `▲ 标记 = 告警触发位置（未确认橙色 / 已确认灰色）。当前周期 ${period}，每 15 秒自动刷新。`)))
    }

    function RulesTab({ rules, data, form, setForm, busy, addRule, toggleRule, deleteRule }) {
      const set = (k) => (e) => setForm((prev) => ({ ...prev, [k]: e.target.value }))
      const needsThreshold = !['macd_golden', 'macd_dead'].includes(form?.kind)
      const needsPeriod = ['macd_golden', 'macd_dead', 'kdj_j_above', 'kdj_j_below'].includes(form?.kind)
      return h('div', null,
        h('div', { style: S.card },
          h('div', { style: S.title }, '新建告警规则'),
          !form
            ? h('div', { style: S.muted }, '在自选页点「设告警」预填标的，或直接在下方输入。')
            : h('div', null,
                h('div', { style: S.row },
                  h('label', { style: { ...S.muted, minWidth: 52 } }, '标的'),
                  h('input', { style: S.input, value: form.symbol, onChange: set('symbol'), placeholder: '600519.SH / RB2610 / 00700 / AAPL' })),
                h('div', { style: S.row },
                  h('label', { style: { ...S.muted, minWidth: 52 } }, '条件'),
                  h('select', { style: { ...S.input, appearance: 'auto' }, value: form.kind, onChange: set('kind') },
                    ...Object.entries(KIND_LABEL).map(([k, label]) => h('option', { key: k, value: k }, label)))),
                needsThreshold
                  ? h('div', { style: S.row },
                      h('label', { style: { ...S.muted, minWidth: 52 } }, '阈值'),
                      h('input', { style: S.input, type: 'number', step: 'any', value: form.threshold, onChange: set('threshold'), placeholder: form.kind.startsWith('pct_') ? '如 5 表示 5%' : '价格阈值' }))
                  : null,
                needsPeriod
                  ? h('div', { style: S.row },
                      h('label', { style: { ...S.muted, minWidth: 52 } }, '周期'),
                      h('select', { style: { ...S.input, appearance: 'auto' }, value: form.period, onChange: set('period') },
                        ...PERIODS.map((p) => h('option', { key: p, value: p }, p))))
                  : null,
                h('div', { style: S.row },
                  h('label', { style: { ...S.muted, minWidth: 52 } }, '触发'),
                  h('select', { style: { ...S.input, appearance: 'auto' }, value: form.mode, onChange: set('mode') },
                    h('option', { value: 'once' }, '一次（确认后重新武装）'),
                    h('option', { value: 'every' }, '循环（冷却后自动重新武装）'))),
                form.mode === 'every'
                  ? h('div', { style: S.row },
                      h('label', { style: { ...S.muted, minWidth: 52 } }, '冷却'),
                      h('input', { style: S.input, type: 'number', value: form.cooldownMin, onChange: set('cooldownMin'), placeholder: '分钟' }),
                      h('span', { style: S.muted }, '分钟'))
                  : null,
                h('div', { style: { ...S.row, justifyContent: 'flex-end', marginTop: 6 } },
                  h('button', { style: S.btn, onClick: () => setForm(null) }, '取消'),
                  h('button', {
                    style: S.btnBrand, disabled: Boolean(busy),
                    onClick: () => addRule({
                      symbol: form.symbol, name: form.name, kind: form.kind,
                      threshold: needsThreshold ? Number(form.threshold) : 0,
                      period: form.period, mode: form.mode,
                      cooldownMin: Number(form.cooldownMin) || 5,
                    }),
                  }, busy === 'rule' ? '创建中…' : '创建规则')))),

        h('div', { style: S.card },
          h('div', { style: S.spread, marginBottom: 6 },
            h('span', { style: S.title }, '规则列表'),
            h('span', { style: S.muted }, `${rules.length}/${data?.maxRules ?? 500}`)),
          rules.length === 0
            ? h('div', { style: S.muted }, '暂无规则。')
            : h('div', null,
                ...rules.map((rule) => {
                  const st = rule.state ?? {}
                  return h('div', { key: rule.id, style: { ...S.row, justifyContent: 'space-between', borderTop: `1px solid ${T.border}`, paddingTop: 6 } },
                    h('div', null,
                      h('span', { style: { fontWeight: 500 } }, rule.name),
                      h('span', { style: { ...S.muted, marginLeft: 8, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 } }, rule.symbol),
                      h('span', { style: { marginLeft: 10, fontSize: 12 } }, ruleText(rule)),
                      h('span', { style: { ...S.pill, marginLeft: 10, fontSize: 10, color: st.phase === 'ARMED' ? T.ok : st.phase === 'TRIGGERED' ? T.err : T.muted } },
                        st.phase === 'ARMED' ? '监控中' : st.phase === 'TRIGGERED' ? '待确认' : st.phase === 'COOLING' ? '冷却中' : '已停用')),
                    h('div', { style: { display: 'flex', gap: 6 } },
                      h('button', { style: S.btn, disabled: Boolean(busy), onClick: () => toggleRule(rule) }, rule.enabled ? '停用' : '启用'),
                      h('button', { style: { ...S.btn, color: T.err }, disabled: Boolean(busy), onClick: () => deleteRule(rule) }, '删除')))
                }))))
    }

    function EventsTab({ events, busy, ackEvent, clearEvents }) {
      return h('div', { style: S.card },
        h('div', { style: S.spread, marginBottom: 6 },
          h('span', { style: S.title }, '告警记录'),
          h('button', { style: S.btn, disabled: Boolean(busy) || !events.length, onClick: clearEvents }, '清空历史')),
        events.length === 0
          ? h('div', { style: S.muted }, '暂无告警。规则触发后会在这里出现，同时面板顶部弹出提醒。')
          : h('div', null,
              ...events.map((e) => h('div', { key: e.id, style: { ...S.row, borderTop: `1px solid ${T.border}`, paddingTop: 6, alignItems: 'flex-start' } },
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', null,
                    h('span', { style: { fontWeight: e.acked ? 400 : 600, color: e.acked ? T.muted : T.text } }, e.summary),
                    !e.acked ? h('span', { style: { ...S.pill, marginLeft: 8, fontSize: 10, color: T.err, borderColor: T.err } }, '未确认') : null),
                  h('div', { style: { ...S.muted, marginTop: 2 } }, e.detail),
                  h('div', { style: { ...S.muted, marginTop: 2, fontSize: 11 } }, new Date(e.at).toLocaleString())),
                e.acked ? null : h('button', { style: S.btnBrand, disabled: Boolean(busy), onClick: () => ackEvent(e) }, '确认')))))
    }

    function PanelIcon({ size = 18, active = false }) {
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: active ? 'currentColor' : 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M3 17l4-6 4 3 5-8 5 5' }),
        h('circle', { cx: 19, cy: 5, r: 2.2 }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'market-alert',
        }, () => h(App)))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'market-alert', order: 70, label: '行情告警',
        }, (props) => h(PanelIcon, { size: props?.size ?? 18, active: props?.active === true })))
      },
    }
  },
})
