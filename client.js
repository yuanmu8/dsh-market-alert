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

    // 条件下拉的分组（optgroup）：[组名, [[kind, 中文label], ...]]
    const KIND_GROUPS = [
      ['价格类', [['price_above', '价格 ≥'], ['price_below', '价格 ≤'], ['pct_above', '涨幅 ≥'], ['pct_below', '跌幅 ≤']]],
      ['MACD', [['macd_golden', 'MACD 金叉'], ['macd_dead', 'MACD 死叉']]],
      ['KDJ', [['kdj_j_above', 'KDJ J ≥'], ['kdj_j_below', 'KDJ J ≤']]],
      ['RSI', [['rsi_above', 'RSI 上穿'], ['rsi_below', 'RSI 下穿']]],
      ['BOLL', [['boll_touch_upper', 'BOLL 触及上轨'], ['boll_touch_low', 'BOLL 触及下轨'], ['boll_break_upper', 'BOLL 突破上轨'], ['boll_break_low', 'BOLL 跌破下轨']]],
      ['均线', [['ma_cross_up', 'MA 金叉'], ['ma_cross_down', 'MA 死叉'], ['price_cross_ma_up', '价格上穿 MA'], ['price_cross_ma_down', '价格下穿 MA']]],
    ]
    const KIND_LABEL = Object.fromEntries(KIND_GROUPS.flatMap(([, items]) => items))
    // 不需要周期的只有纯报价类条件；其余（MACD/KDJ/RSI/BOLL/均线）都要 K 线周期
    const NO_PERIOD_KINDS = new Set(['price_above', 'price_below', 'pct_above', 'pct_below'])
    // 价格上穿/下穿 MA 的阈值就是 MA 的 N
    const MA_THRESHOLD_KINDS = new Set(['price_cross_ma_up', 'price_cross_ma_down'])
    const needsThreshold = (kind) => MA_THRESHOLD_KINDS.has(kind) || /^(price_|pct_|kdj_|rsi_)/.test(kind)
    const needsPeriod = (kind) => !NO_PERIOD_KINDS.has(kind)
    const DEFAULT_GROUP = '默认'
    // 周期统一定义见下方 PERIOD_BTNS（1分–月），规则页与 K 线页共用
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

    // 单个条件的可读文本；fast/slow/rsiPeriod 取规则级参数
    function condText(cond, owner) {
      const kind = cond?.kind ?? ''
      let text = KIND_LABEL[kind] ?? kind
      if (kind.startsWith('ma_cross')) text += `(${owner?.maFast ?? 5}/${owner?.maSlow ?? 20})`
      if (kind.startsWith('rsi_')) text += `(${owner?.rsiPeriod ?? 14})`
      if (needsThreshold(kind) && cond.threshold != null && cond.threshold !== 0) text += ` ${cond.threshold}`
      if (needsPeriod(kind) && cond.period) text += ` · ${cond.period}`
      return text
    }

    // 规则全文：主条件 + 附加条件，按 AND / OR 拼接
    function ruleText(rule) {
      const extra = Array.isArray(rule.extra) ? rule.extra : []
      const parts = [condText(rule, rule), ...extra.map((c) => condText(c, rule))]
      return parts.join(rule.logic === 'OR' ? ' 或 ' : ' 且 ')
    }

    // 相对时间：如「3 分钟前」；空值显示「未触发过」
    function relTime(ts) {
      if (!ts) return '未触发过'
      const diff = Date.now() - new Date(ts).getTime()
      if (!Number.isFinite(diff)) return '未触发过'
      if (diff < 60_000) return '刚刚'
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
      if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
      return new Date(ts).toLocaleDateString()
    }

    const PHASE_LABEL = { ARMED: '监控中', TRIGGERED: '待确认', COOLING: '冷却中', DISABLED: '已停用' }
    function phaseOf(rule) {
      if (rule.enabled === false) return 'DISABLED'
      const phase = rule.state?.phase
      return phase && PHASE_LABEL[phase] ? phase : 'ARMED'
    }
    const phaseColor = (phase) => (phase === 'ARMED' ? T.ok : phase === 'TRIGGERED' ? T.err : T.muted)

    // 选中态样式：只有当前项有边框，其余透明（同 ChartTab 周期按钮）
    const selStyle = (active) => (active
      ? { borderColor: T.brand, color: T.brand, fontWeight: 500 }
      : { borderColor: 'transparent', color: T.muted })

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
      const [editing, setEditing] = React.useState(null) // 正在编辑的规则（null 表示未编辑）
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

      // 成功提示不常驻：3 秒后自动消失（错误 / 告警提示保留）
      React.useEffect(() => {
        if (!notice || notice.tone !== 'ok') return undefined
        const timer = setTimeout(() => setNotice(null), 3000)
        return () => clearTimeout(timer)
      }, [notice])

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
        // 添加成功后收起搜索结果与搜索词：入口自动隐藏，反馈由自选列表本身承担
        setHits([])
        setSearchKey('')
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
        setNotice({ tone: 'ok', text: `已删除规则：${rule.name}` })
        if (editing?.id === rule.id) setEditing(null)
        await refresh()
      })

      // 保存编辑：payload = { id, ...fields }，由 RuleForm 组装
      const updateRule = (payload) => run('rule', async () => {
        const res = await call('rule.update', payload)
        setNotice({ tone: 'ok', text: `规则已更新：${(res.rule ?? payload).name ?? ''} ${res.rule ? ruleText(res.rule) : ''}`.trim() })
        setEditing(null)
        await refresh()
      })

      // 编辑入口：优先用 rule.get 回填（含 state），接口不可用时退回 state 里的规则对象
      const openEdit = (rule) => run('get', async () => {
        let full = rule
        try {
          const res = await call('rule.get', { id: rule.id })
          if (res.rule) full = { ...rule, ...res.rule, state: res.state ?? res.rule.state ?? rule.state }
        } catch { /* 接口未就绪：用列表数据回填 */ }
        setForm(null)
        setEditing(full)
      })

      const toggleMany = (ids, enabled) => run('many', async () => {
        await call('rule.toggleMany', { ids, enabled })
        setNotice({ tone: 'ok', text: `已批量${enabled ? '启用' : '停用'} ${ids.length} 条规则` })
        await refresh()
      })

      const deleteMany = (ids) => run('many', async () => {
        const results = await Promise.allSettled(ids.map((id) => call('rule.delete', { id })))
        const failed = results.filter((r) => r.status === 'rejected').length
        if (failed) setNotice({ tone: 'err', text: `批量删除：成功 ${ids.length - failed} 条，失败 ${failed} 条` })
        else setNotice({ tone: 'ok', text: `已批量删除 ${ids.length} 条规则` })
        if (editing && ids.includes(editing.id)) setEditing(null)
        await refresh()
      })

      const setWatchGroup = async (symbol, group) => call('watch.setGroup', { symbol, group })

      const groupToggle = (group, enabled) => run('group', async () => {
        await call('group.toggle', { group, enabled })
        setNotice({ tone: 'ok', text: `分组「${group}」的规则已批量${enabled ? '启用' : '停用'}` })
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
        setEditing(null)
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
          watchlist, quotes, data, groups: data?.groups, busy, searchKey, setSearchKey, hits,
          doSearch, addWatch, removeWatch, startAlert, refresh, setWatchGroup, groupToggle,
        }) : null,

        tab === 'chart' ? h(ChartTab, {
          watchlist, quotes, events, defaultSymbol: chartSymbol ?? watchlist[0]?.symbol ?? '',
          onSymbolChange: setChartSymbol,
        }) : null,

        tab === 'rules' ? h(RulesTab, {
          rules, data, watchlist, form, setForm, editing, setEditing, openEdit, busy,
          addRule, updateRule, toggleRule, deleteRule, toggleMany, deleteMany,
        }) : null,

        tab === 'events' ? h(EventsTab, {
          events, busy, ackEvent, clearEvents,
        }) : null,
      )
    }

    function WatchTab(props) {
      const {
        watchlist, quotes, busy, searchKey, setSearchKey, hits, doSearch, addWatch, removeWatch, startAlert, data,
        groups, setWatchGroup, groupToggle,
      } = props
      const [groupFilter, setGroupFilter] = React.useState('') // '' = 全部
      const [manageOpen, setManageOpen] = React.useState(false)
      const [picked, setPicked] = React.useState([]) // 选中的自选 symbol
      const [groupPick, setGroupPick] = React.useState('')
      const [newGroup, setNewGroup] = React.useState('')
      const [groupErr, setGroupErr] = React.useState('')
      // 分组列表由 Host 的 state.groups 提供；未上线（undefined / 空）时从自选的 group 字段兜底推导
      const safeGroups = React.useMemo(() => {
        if (Array.isArray(groups) && groups.length) return groups
        const acc = new Map()
        for (const w of watchlist) {
          const g = w.group || DEFAULT_GROUP
          const item = acc.get(g) ?? { group: g, symbols: 0, rules: 0, enabledRules: 0 }
          item.symbols += 1
          const own = (data?.rules ?? []).filter((r) => r.symbol === w.symbol)
          item.rules += own.length
          item.enabledRules += own.filter((r) => r.enabled).length
          acc.set(g, item)
        }
        return [...acc.values()]
      }, [groups, watchlist, data?.rules])

      const togglePick = (sym) => setPicked((prev) => (prev.includes(sym) ? prev.filter((s) => s !== sym) : [...prev, sym]))
      const shown = watchlist.filter((w) => !groupFilter || (w.group || DEFAULT_GROUP) === groupFilter)
      const shownPicked = picked.filter((s) => shown.some((w) => w.symbol === s))

      // 给选中标的设置分组：新分组名优先，否则用下拉里选的现有分组
      const applyGroup = async () => {
        const target = newGroup.trim().slice(0, 16) || groupPick
        if (!target) { setGroupErr('请选择现有分组或输入新分组名'); return }
        if (!shownPicked.length) { setGroupErr('请先勾选标的'); return }
        setGroupErr('')
        const results = await Promise.allSettled(shownPicked.map((sym) => setWatchGroup(sym, target)))
        const failed = results.filter((r) => r.status === 'rejected')
        if (failed.length) setGroupErr(`设置失败 ${failed.length} 个：${failed[0].reason?.message ?? failed[0].reason}`)
        else { setNewGroup(''); setPicked([]) }
        await props.refresh()
      }

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

          // 分组标签行：「全部」+ 各分组；只有当前分组有边框
          h('div', { style: { ...S.row, flexWrap: 'wrap', marginBottom: 4 } },
            h('button', {
              key: '__all',
              style: { ...S.btn, ...selStyle(!groupFilter) },
              onClick: () => setGroupFilter(''),
            }, `全部 ${watchlist.length}`),
            ...safeGroups.map((g) => h('button', {
              key: g.group,
              style: { ...S.btn, ...selStyle(groupFilter === g.group) },
              onClick: () => setGroupFilter(g.group),
              title: `${g.symbols ?? 0} 个标的 · ${g.enabledRules ?? 0}/${g.rules ?? 0} 条规则启用`,
            }, `${g.group} ${g.symbols ?? ''}`)),
            h('button', {
              style: { ...S.btn, marginLeft: 'auto', ...selStyle(manageOpen) },
              onClick: () => setManageOpen((v) => !v),
            }, manageOpen ? '收起分组管理 ▴' : '管理分组 ▾')),

          manageOpen
            ? h('div', { style: { border: `1px dashed ${T.border}`, borderRadius: 8, padding: '6px 10px', marginBottom: 8 } },
                h('div', { style: { ...S.row, flexWrap: 'wrap' } },
                  h('span', { style: S.muted }, `已勾选 ${shownPicked.length} 个标的`),
                  h('select', {
                    style: { ...S.input, appearance: 'auto', width: 140, maxWidth: 140 },
                    value: groupPick, onChange: (e) => setGroupPick(e.target.value),
                    title: '选择现有分组',
                  },
                    h('option', { value: '' }, '选择现有分组…'),
                    ...safeGroups.map((g) => h('option', { key: g.group, value: g.group }, g.group))),
                  h('span', { style: S.muted }, '或'),
                  h('input', {
                    style: { ...S.input, width: 140, maxWidth: 140 }, value: newGroup, maxLength: 16,
                    placeholder: '输入新分组名', onChange: (e) => setNewGroup(e.target.value),
                  }),
                  h('button', {
                    style: S.btnBrand, disabled: Boolean(busy) || !shownPicked.length,
                    onClick: applyGroup,
                  }, '设置分组')),
                groupErr ? h('div', { style: { ...S.muted, color: T.err, marginTop: 4 } }, groupErr) : null,
                h('div', { style: { ...S.muted, marginTop: 6, marginBottom: 2 } }, '整组批量启停（作用于该分组下所有标的的规则）：'),
                ...safeGroups.map((g) => h('div', { key: `mg-${g.group}`, style: { ...S.row, justifyContent: 'space-between' } },
                  h('span', null, g.group, h('span', { style: { ...S.muted, marginLeft: 8 } }, `${g.symbols ?? 0} 标的 · ${g.enabledRules ?? 0}/${g.rules ?? 0} 启用`)),
                  h('div', { style: { display: 'flex', gap: 6 } },
                    h('button', { style: S.btn, disabled: Boolean(busy), onClick: () => groupToggle(g.group, true) }, '批量启用规则'),
                    h('button', { style: S.btn, disabled: Boolean(busy), onClick: () => groupToggle(g.group, false) }, '批量停用规则')))))
            : null,

          watchlist.length === 0
            ? h('div', { style: S.muted }, '还没有自选标的，用上方搜索添加。')
            : (shown.length === 0
              ? h('div', { style: S.muted }, `分组「${groupFilter}」下没有标的。`)
              : h('div', null,
                ...shown.map((w) => {
                  const q = quotes[w.symbol]
                  const groupName = w.group || DEFAULT_GROUP
                  return h('div', { key: w.symbol, style: { ...S.row, justifyContent: 'space-between', borderTop: `1px solid ${T.border}`, paddingTop: 6 } },
                    h('div', { style: { minWidth: 0, display: 'flex', alignItems: 'center' } },
                      h('input', {
                        type: 'checkbox', checked: picked.includes(w.symbol), title: '勾选后可在「管理分组」里设置分组',
                        onChange: () => togglePick(w.symbol),
                      }),
                      h('span', { style: { fontWeight: 500, marginLeft: 6 } }, w.name),
                      h('span', { style: { ...S.muted, marginLeft: 8, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 } }, w.symbol),
                      // 「默认」分组不显示胶囊，避免满屏噪音
                      groupName !== DEFAULT_GROUP
                        ? h('span', { style: { ...S.pill, marginLeft: 6, fontSize: 10, color: T.brand, borderColor: T.brand }, title: '分组' }, groupName)
                        : null,
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
                })))))
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
              style: {
                ...S.btn,
                // 只有当前周期显示边框，其余按钮无框（避免一排都像被选中）
                ...(period === val
                  ? { borderColor: T.brand, color: T.brand, fontWeight: 500 }
                  : { borderColor: 'transparent', color: T.muted }),
              },
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

    // 标的选择：默认从自选列表搜索选择（文本框过滤 + 列表），「手动输入」切换后直接填 symbol
    function SymbolPicker({ watchlist, value, name, onChange }) {
      const [manual, setManual] = React.useState(() => !watchlist.some((w) => w.symbol === value))
      const [query, setQuery] = React.useState('')
      const [open, setOpen] = React.useState(false)
      const current = watchlist.find((w) => w.symbol === value)
      const labelOf = (w) => `${w.name}（${w.symbol}）`
      const kw = query.trim().toLowerCase()
      const list = kw
        ? watchlist.filter((w) => w.symbol.toLowerCase().includes(kw) || (w.name ?? '').toLowerCase().includes(kw)).slice(0, 8)
        : watchlist.slice(0, 8)
      const inputText = query || (current ? labelOf(current) : '')
      if (manual) {
        return h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flex: 1 } },
          h('input', {
            style: S.input, value, placeholder: '600519.SH / RB2610 / 00700 / AAPL',
            onChange: (e) => onChange(e.target.value.trim(), ''),
          }),
          h('button', { style: S.btn, onClick: () => setManual(false) }, '从自选选择'))
      }
      return h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flex: 1, position: 'relative' } },
        h('input', {
          style: S.input, value: inputText, placeholder: '输入名称 / 代码过滤自选…', autoComplete: 'off',
          onFocus: () => setOpen(true),
          onBlur: () => setTimeout(() => { setOpen(false); setQuery('') }, 150),
          onChange: (e) => {
            setQuery(e.target.value)
            // 文本不再是当前选中项的标签 → 视为未选择
            if (!(current && labelOf(current) === e.target.value)) onChange('', '')
          },
        }),
        h('button', { style: S.btn, onClick: () => setManual(true) }, '手动输入'),
        open
          ? h('div', {
              style: {
                position: 'absolute', top: '100%', left: 0, right: 72, zIndex: 10, marginTop: 2, maxHeight: 220, overflow: 'auto',
                background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: 4,
              },
            },
              list.length
                ? list.map((w) => h('div', {
                    key: w.symbol,
                    style: {
                      ...S.row, padding: '4px 8px', borderRadius: 6, cursor: 'pointer',
                      color: w.symbol === value ? T.brand : T.text,
                      fontWeight: w.symbol === value ? 500 : 400,
                    },
                    onMouseDown: (e) => { e.preventDefault(); onChange(w.symbol, w.name) },
                  },
                  w.name,
                  h('span', { style: { ...S.muted, marginLeft: 8, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 } }, w.symbol),
                  w.group && w.group !== DEFAULT_GROUP ? h('span', { style: { ...S.pill, marginLeft: 8, fontSize: 10 } }, w.group) : null))
                : h('div', { style: { ...S.muted, padding: '4px 8px' } }, '无匹配的自选标的，可切换「手动输入」'))
          : null)
    }

    // 新建 / 编辑共用的规则表单；initial 为字段初值，onSubmit(payload) 由调用方决定走 rule.add 还是 rule.update
    function RuleForm({ initial, watchlist, busy, busyTag, submitLabel, onSubmit, onCancel }) {
      const [f, setF] = React.useState(initial)
      const [error, setError] = React.useState('')
      const [advOpen, setAdvOpen] = React.useState(false)
      const set = (k) => (e) => setF((prev) => ({ ...prev, [k]: e.target.value }))
      const setExtra = (i, k) => (e) => setF((prev) => ({ ...prev, extra: prev.extra.map((c, j) => (j === i ? { ...c, [k]: e.target.value } : c)) }))
      const addExtra = () => setF((prev) => ((prev.extra ?? []).length >= 4
        ? prev
        : { ...prev, extra: [...(prev.extra ?? []), { kind: 'price_above', threshold: '', period: '15m' }] }))
      const removeExtra = (i) => setF((prev) => ({ ...prev, extra: (prev.extra ?? []).filter((_, j) => j !== i) }))

      const conds = [{ kind: f.kind, threshold: f.threshold, period: f.period }, ...(f.extra ?? [])]
      const hasRsi = conds.some((c) => c.kind.startsWith('rsi_'))
      const hasMa = conds.some((c) => c.kind.startsWith('ma_cross') || c.kind.startsWith('price_cross_ma'))

      const kindSelect = (value, handler, width) => h('select', { style: { ...S.input, appearance: 'auto', width, maxWidth: width }, value, onChange: handler },
        ...KIND_GROUPS.map(([group, items]) => h('optgroup', { key: group, label: group },
          ...items.map(([k, label]) => h('option', { key: k, value: k }, label)))))
      const thresholdInput = (kind, value, handler, width) => h('input', {
        style: { ...S.input, width, maxWidth: width }, type: 'number', step: 'any', value, onChange: handler,
        placeholder: kind.startsWith('pct_') ? '如 5 表示 5%'
          : kind.startsWith('rsi_') ? '0–100，如 70'
            : MA_THRESHOLD_KINDS.has(kind) ? 'MA 的 N，如 20'
              : kind.startsWith('kdj_') ? 'J 值，可为负' : '价格阈值',
      })
      const periodSelect = (value, handler, width) => h('select', { style: { ...S.input, appearance: 'auto', width, maxWidth: width }, value, onChange: handler },
        ...PERIOD_BTNS.map(([val, label]) => h('option', { key: val, value: val }, label)))

      const submit = () => {
        const symbol = (f.symbol ?? '').trim()
        if (!symbol) { setError('请选择或输入标的'); return }
        for (let i = 0; i < conds.length; i += 1) {
          const c = conds[i]
          const tag = i === 0 ? '主条件' : `附加条件 ${i}`
          if (needsPeriod(c.kind) && !c.period) { setError(`${tag}：请选择周期`); return }
          if (needsThreshold(c.kind)) {
            const raw = String(c.threshold ?? '').trim()
            // 只要求是有限数字；KDJ J 值允许负数，不做正负限制
            if (raw === '' || !Number.isFinite(Number(raw))) { setError(`${tag}：阈值必须是数字`); return }
          }
        }
        if (hasMa) {
          const fast = Number(f.maFast)
          const slow = Number(f.maSlow)
          if (!(Number.isInteger(fast) && fast >= 2) || !(Number.isInteger(slow) && slow >= 3) || fast >= slow) {
            setError('高级：MA 快线 / 慢线需为整数，且 快线 < 慢线'); return
          }
        }
        if (hasRsi && !(Number.isInteger(Number(f.rsiPeriod)) && Number(f.rsiPeriod) >= 2)) { setError('高级：RSI 周期需为 ≥ 2 的整数'); return }
        const extra = (f.extra ?? []).map((c) => ({
          kind: c.kind,
          threshold: needsThreshold(c.kind) ? Number(c.threshold) : 0,
          // 周期始终上送（Host 会校验取值），非指标类条件下引擎不使用它
          period: c.period || '15m',
          fast: Number(f.maFast), slow: Number(f.maSlow),
        }))
        const payload = {
          symbol, kind: f.kind,
          threshold: needsThreshold(f.kind) ? Number(f.threshold) : 0,
          period: f.period || '15m',
          mode: f.mode, cooldownMin: Number(f.cooldownMin) || 5,
        }
        const nm = (f.name ?? '').trim()
        if (nm) payload.name = nm
        if (extra.length) { payload.logic = f.logic; payload.extra = extra }
        if (hasRsi) payload.rsiPeriod = Number(f.rsiPeriod) || 14
        if (hasMa) { payload.maFast = Number(f.maFast) || 5; payload.maSlow = Number(f.maSlow) || 20 }
        setError('')
        onSubmit(payload)
      }

      const label = (text) => h('label', { style: { ...S.muted, minWidth: 52 } }, text)
      return h('div', null,
        h('div', { style: S.row }, label('标的'),
          h(SymbolPicker, {
            watchlist, value: f.symbol ?? '', name: f.name,
            onChange: (symbol, name) => setF((prev) => ({ ...prev, symbol, name: name || '' })),
          })),
        h('div', { style: S.row }, label('名称'),
          h('input', { style: S.input, value: f.name ?? '', onChange: set('name'), placeholder: '留空则用标的代码' })),

        // 条件组头部：AND / OR 切换（只在有附加条件时有意义）
        h('div', { style: { ...S.spread, marginTop: 6 } },
          h('span', { style: S.muted }, `条件组（${conds.length}/5）`),
          h('div', { style: { display: 'flex', gap: 4 } },
            ...['AND', 'OR'].map((op) => h('button', {
              key: op,
              style: { ...S.btn, ...selStyle(f.logic === op) },
              title: op === 'AND' ? '全部条件满足才触发' : '任一条件满足即触发',
              onClick: () => setF((prev) => ({ ...prev, logic: op })),
            }, op === 'AND' ? '且 AND' : '或 OR')))),
        h('div', { style: S.row }, label('主条件'),
          kindSelect(f.kind, set('kind'), 170),
          needsThreshold(f.kind) ? thresholdInput(f.kind, f.threshold, set('threshold'), 110) : null,
          needsPeriod(f.kind) ? periodSelect(f.period, set('period'), 80) : null,
          h('span', { style: { ...S.pill, fontSize: 10, color: T.muted } }, `${f.logic ?? 'AND'} 逻辑`)),
        ...((f.extra ?? []).map((c, i) => h('div', { key: `extra-${i}`, style: { ...S.row, paddingLeft: 12 } },
          label(`条件 ${i + 2}`),
          kindSelect(c.kind, setExtra(i, 'kind'), 170),
          needsThreshold(c.kind) ? thresholdInput(c.kind, c.threshold, setExtra(i, 'threshold'), 110) : null,
          needsPeriod(c.kind) ? periodSelect(c.period, setExtra(i, 'period'), 80) : null,
          h('button', { style: { ...S.btn, color: T.err }, title: '删除此条件', onClick: () => removeExtra(i) }, '×')))),
        (f.extra ?? []).length < 4
          ? h('div', { style: { ...S.row, paddingLeft: 64 } },
              h('button', { style: { ...S.btn, color: T.brand, borderColor: 'transparent' }, onClick: addExtra }, '+ 添加条件'))
          : null,

        h('div', { style: S.row }, label('触发'),
          h('select', { style: { ...S.input, appearance: 'auto', width: 220, maxWidth: 220 }, value: f.mode, onChange: set('mode') },
            h('option', { value: 'once' }, '一次（确认后重新武装）'),
            h('option', { value: 'every' }, '循环（冷却后自动重新武装）'))),
        f.mode === 'every'
          ? h('div', { style: S.row }, label('冷却'),
              h('input', { style: { ...S.input, width: 90, maxWidth: 90 }, type: 'number', min: 1, value: f.cooldownMin, onChange: set('cooldownMin') }),
              h('span', { style: S.muted }, '分钟'))
          : null,

        // 高级：指标参数，仅在对应 kind 出现时显示对应项
        h('div', { style: { ...S.row } }, label('高级'),
          h('button', { style: { ...S.btn, ...selStyle(advOpen) }, onClick: () => setAdvOpen((v) => !v) },
            advOpen ? '收起指标参数 ▴' : '展开指标参数 ▾')),
        advOpen
          ? h('div', { style: { ...S.row, paddingLeft: 64, flexWrap: 'wrap', gap: 12 } },
              hasRsi
                ? h('span', { style: { ...S.row, padding: 0 } }, 'RSI 周期',
                    h('input', { style: { ...S.input, width: 64, maxWidth: 64 }, type: 'number', min: 2, value: f.rsiPeriod, onChange: set('rsiPeriod') }))
                : null,
              hasMa
                ? h('span', { style: { ...S.row, padding: 0 } }, 'MA 快线',
                    h('input', { style: { ...S.input, width: 64, maxWidth: 64 }, type: 'number', min: 2, value: f.maFast, onChange: set('maFast') }),
                    '慢线',
                    h('input', { style: { ...S.input, width: 64, maxWidth: 64 }, type: 'number', min: 3, value: f.maSlow, onChange: set('maSlow') }))
                : null,
              !hasRsi && !hasMa ? h('span', { style: S.muted }, '当前条件没有可调的指标参数（RSI / MA 类条件才有）') : null)
          : null,

        error ? h('div', { style: { ...S.muted, color: T.err, marginTop: 6 } }, error) : null,
        h('div', { style: { ...S.row, justifyContent: 'flex-end', marginTop: 6 } },
          h('button', { style: S.btn, onClick: onCancel }, '取消'),
          h('button', { style: S.btnBrand, disabled: Boolean(busy), onClick: submit }, busy === busyTag ? '保存中…' : submitLabel)))
    }

    const EMPTY_FORM = {
      symbol: '', name: '', kind: 'price_above', threshold: '', period: '15m', mode: 'once', cooldownMin: 5,
      logic: 'AND', extra: [], rsiPeriod: 14, maFast: 5, maSlow: 20,
    }
    // 把已有规则转成表单初值（字符串化以便受控输入）
    function formFromRule(rule) {
      const extra = Array.isArray(rule.extra) ? rule.extra : []
      return {
        ...EMPTY_FORM,
        symbol: rule.symbol ?? '', name: rule.name ?? '', kind: rule.kind ?? 'price_above',
        threshold: rule.threshold != null && rule.threshold !== 0 ? String(rule.threshold) : '',
        period: rule.period || '15m', mode: rule.mode ?? 'once', cooldownMin: rule.cooldownMin ?? 5,
        logic: rule.logic === 'OR' ? 'OR' : 'AND',
        extra: extra.map((c) => ({
          kind: c?.kind ?? 'price_above',
          threshold: c?.threshold != null && c.threshold !== 0 ? String(c.threshold) : '',
          period: c?.period || rule.period || '15m',
        })),
        rsiPeriod: rule.rsiPeriod ?? 14, maFast: rule.maFast ?? 5, maSlow: rule.maSlow ?? 20,
      }
    }

    const STATUS_FILTERS = [['', '全部状态'], ['ARMED', '监控中'], ['TRIGGERED', '待确认'], ['COOLING', '冷却中'], ['DISABLED', '已停用']]

    function RulesTab({
      rules, data, watchlist, form, setForm, editing, setEditing, openEdit, busy,
      addRule, updateRule, toggleRule, deleteRule, toggleMany, deleteMany,
    }) {
      const [fSymbol, setFSymbol] = React.useState('')
      const [fStatus, setFStatus] = React.useState('')
      const [kw, setKw] = React.useState('')
      const [picked, setPicked] = React.useState([]) // 选中的规则 id

      const livePicked = picked.filter((id) => rules.some((r) => r.id === id))
      const word = kw.trim().toLowerCase()
      const filtered = rules.filter((r) => {
        if (fSymbol && r.symbol !== fSymbol) return false
        if (fStatus && phaseOf(r) !== fStatus) return false
        if (word && !`${r.name ?? ''} ${r.symbol ?? ''}`.toLowerCase().includes(word)) return false
        return true
      })
      const filteredIds = filtered.map((r) => r.id)
      const allPicked = filteredIds.length > 0 && filteredIds.every((id) => livePicked.includes(id))
      const togglePick = (id) => setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
      const toggleAll = () => setPicked((prev) => (allPicked ? prev.filter((id) => !filteredIds.includes(id)) : [...new Set([...prev, ...filteredIds])]))

      const confirmDeleteMany = () => {
        if (!livePicked.length) return
        if (!window.confirm(`确定删除选中的 ${livePicked.length} 条规则？此操作不可撤销。`)) return
        setPicked([])
        deleteMany(livePicked)
      }
      const confirmDelete = (rule) => {
        if (!window.confirm(`确定删除规则「${rule.name}」（${ruleText(rule)}）？`)) return
        deleteRule(rule)
      }

      const symbolOptions = () => {
        const symbols = [...new Set([...watchlist.map((w) => w.symbol), ...rules.map((r) => r.symbol)])]
        return symbols.map((sym) => {
          const w = watchlist.find((x) => x.symbol === sym)
          return h('option', { key: sym, value: sym }, w ? `${w.name}（${sym}）` : sym)
        })
      }

      const editingRule = editing ? rules.find((r) => r.id === editing.id) ?? editing : null
      const showCreate = Boolean(form) && !editingRule

      return h('div', null,
        // 表单卡片：编辑优先，其次新建（自选页「设告警」预填）
        editingRule
          ? h('div', { style: S.card },
              h('div', { style: S.spread, marginBottom: 6 },
                h('span', { style: S.title }, `编辑规则：${editingRule.name}`),
                h('span', { style: { ...S.pill, fontSize: 10, color: T.muted } }, editingRule.symbol)),
              h(RuleForm, {
                key: editingRule.id, initial: formFromRule(editingRule), watchlist, busy, busyTag: 'rule',
                submitLabel: '保存修改', onSubmit: (payload) => updateRule({ id: editingRule.id, ...payload }),
                onCancel: () => setEditing(null),
              }))
          : h('div', { style: S.card },
              h('div', { style: S.title }, '新建告警规则'),
              !showCreate
                ? h('div', { style: { ...S.spread } },
                    h('span', { style: S.muted }, '在自选页点「设告警」预填标的，或点此处直接新建。'),
                    h('button', { style: S.btn, onClick: () => setForm({ ...EMPTY_FORM }) }, '＋ 新建规则'))
                : h(RuleForm, {
                    key: `new-${form.symbol ?? ''}`, initial: { ...EMPTY_FORM, ...form, extra: [...(form.extra ?? [])] }, watchlist, busy, busyTag: 'rule',
                    submitLabel: '创建规则', onSubmit: addRule, onCancel: () => setForm(null),
                  })),

        h('div', { style: S.card },
          h('div', { style: S.spread, marginBottom: 6 },
            h('span', { style: S.title }, '规则列表'),
            h('span', { style: S.muted }, `${rules.length}/${data?.maxRules ?? 500}${filtered.length !== rules.length ? ` · 筛选出 ${filtered.length}` : ''}`)),

          // 筛选行：标的 / 状态 / 关键词（纯客户端过滤）
          h('div', { style: { ...S.row, flexWrap: 'wrap' } },
            h('select', {
              style: { ...S.input, appearance: 'auto', width: 170, maxWidth: 170 }, value: fSymbol,
              onChange: (e) => setFSymbol(e.target.value),
            }, h('option', { value: '' }, '全部标的'), ...symbolOptions()),
            ...STATUS_FILTERS.map(([val, label]) => h('button', {
              key: val || '__all',
              style: { ...S.btn, ...selStyle(fStatus === val) },
              onClick: () => setFStatus(val),
            }, label)),
            h('input', {
              style: { ...S.input, width: 160, maxWidth: 160 }, value: kw, placeholder: '搜索名称 / 代码',
              onChange: (e) => setKw(e.target.value),
            })),

          // 批量操作条：有选中项时出现
          livePicked.length
            ? h('div', { style: { ...S.row, marginTop: 6, padding: '4px 8px', background: T.card, border: `1px solid ${T.brand}`, borderRadius: 8 } },
                h('span', { style: { color: T.brand, fontSize: 12 } }, `已选 ${livePicked.length} 条`),
                h('button', { style: S.btnBrand, disabled: Boolean(busy), onClick: () => { toggleMany(livePicked, true); setPicked([]) } }, '批量启用'),
                h('button', { style: S.btn, disabled: Boolean(busy), onClick: () => { toggleMany(livePicked, false); setPicked([]) } }, '批量停用'),
                h('button', { style: { ...S.btn, color: T.err }, disabled: Boolean(busy), onClick: confirmDeleteMany }, `批量删除（${livePicked.length} 条）`),
                h('button', { style: { ...S.btn, borderColor: 'transparent', color: T.muted }, onClick: () => setPicked([]) }, '取消选择'))
            : null,

          // 表头：全选
          rules.length === 0
            ? h('div', { style: S.muted }, '暂无规则。')
            : h('div', { style: { ...S.row, ...S.muted, marginTop: 4 } },
                h('input', { type: 'checkbox', checked: allPicked, disabled: !filteredIds.length, title: '全选（当前筛选结果）', onChange: toggleAll }),
                h('span', null, filtered.length ? `${filtered.length} 条` : '无匹配规则（调整筛选条件试试）')),

          filtered.length
            ? h('div', null,
                ...filtered.map((rule) => {
                  const st = rule.state ?? {}
                  const phase = phaseOf(rule)
                  const titleRow = h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 } },
                    h('span', { style: { fontWeight: 500 } }, rule.name),
                    h('span', { style: { ...S.muted, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 } }, rule.symbol),
                    h('span', { style: { ...S.pill, fontSize: 10, color: phaseColor(phase) } }, PHASE_LABEL[phase]))
                  // 条件组完整摘要：优先 Host 的 ruleSummary，缺省用本地 ruleText
                  const meta = [
                    `周期 ${needsPeriod(rule.kind) ? rule.period : '—'}`,
                    rule.mode === 'every' ? `循环 / 冷却 ${rule.cooldownMin ?? 5} 分` : '单次',
                    `最近触发 ${relTime(st.lastTriggeredAt)}`,
                    Array.isArray(rule.extra) && rule.extra.length ? `${rule.extra.length + 1} 个条件（${rule.logic ?? 'AND'}）` : '',
                  ].filter(Boolean).join(' · ')
                  const body = h('div', { style: { minWidth: 0 } },
                    titleRow,
                    h('div', { style: { fontSize: 12, marginTop: 2 } }, rule.summary || ruleText(rule)),
                    h('div', { style: { ...S.muted, marginTop: 2, fontSize: 11 } }, meta))
                  const main = h('div', { style: { display: 'flex', alignItems: 'flex-start', minWidth: 0, flex: 1, gap: 6 } },
                    h('input', { type: 'checkbox', checked: livePicked.includes(rule.id), style: { marginTop: 3 }, onChange: () => togglePick(rule.id) }),
                    body)
                  const actions = h('div', { style: { display: 'flex', gap: 6 } },
                    h('button', { style: S.btn, disabled: Boolean(busy), onClick: () => openEdit(rule) }, busy === 'get' ? '读取中…' : '编辑'),
                    h('button', { style: S.btn, disabled: Boolean(busy), onClick: () => toggleRule(rule) }, rule.enabled ? '停用' : '启用'),
                    h('button', { style: { ...S.btn, color: T.err }, disabled: Boolean(busy), onClick: () => confirmDelete(rule) }, '删除'))
                  return h('div', { key: rule.id, style: { ...S.row, justifyContent: 'space-between', borderTop: `1px solid ${T.border}`, paddingTop: 6 } }, main, actions)
                }))
            : null))
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
