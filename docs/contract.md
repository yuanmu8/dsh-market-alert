# dsh-market-alert 契约设计

页面层（client.js）、引擎层（lib/engine.js）与数据层（lib/datasource.js）之间只通过本文件的
Schema 与接口通信。`lib/shared.js` 中的纯函数（指标、穿越判定、规则评估）被 Host 与单元测试共用。

## 1. MarketDataProvider（数据层契约）

```ts
interface MarketDataProvider {
  /** 关键词/代码搜索：代码、名称、拼音缩写。返回 SearchHit[] */
  search(keyword: string): Promise<SearchHit[]>

  /** 最新快照（单只）。 */
  quote(symbol: string): Promise<Quote>

  /** 批量快照（一次网络请求）。 */
  quotes(symbols: string[]): Promise<Quote[]>

  /** K 线序列（升序、只含已收盘 bar），period ∈ PERIODS。 */
  bars(symbol: string, period: Period, count?: number): Promise<Bar[]>

  /** 该标的所属市场在指定时刻是否在交易时段内。 */
  inSession(symbol: string, at?: Date): boolean
}

interface SearchHit  { symbol: string; name: string; market: 'SH'|'SZ'|'BJ'|'HK'|'US'|'CNF' }
interface Quote {
  symbol: string; name: string; price: number; prevClose: number|null
  changePercent: number|null; volume: number|null; openInterest: number|null  // 期货持仓量
  at: number; source: 'tencent'|'sina'|'sina-futures'|'tencent-hk'|'tencent-us'; degraded: boolean
}
interface Bar { t: string; o: number; h: number; l: number; c: number; v: number } // t = 收盘时刻 'YYYY-MM-DD HH:mm:ss'（北京时间）

type Period = '1m'|'5m'|'15m'|'30m'|'60m'|'1d'
```

实现要点：

- 主源腾讯 `qt.gtimg.cn`，备源新浪 `hq.sinajs.cn`，逐标的按优先级尝试；备源命中时
  `degraded: true`（面板 W-06 降级标识的数据来源）。
- A 股 `600519.SH`、港股 `00700`、美股 `AAPL`、国内期货 `RB2601` / `AU2606` 统一归一化为
  `SearchHit.symbol` 后再进入告警规则与自选。
- 期权链（P2）扩展 `getOptionChain(underlying, expiry)` 与 `getContractMeta(symbol)`，
  本期不实现，接口位保留。

## 2. AlertRule（规则定义，持久化）

```ts
interface AlertRule {
  id: string                       // nanoid 风格随机 id
  symbol: string                   // 归一化标的
  name: string                     // 展示名（创建时快照）
  kind:
    | 'price_above' | 'price_below'          // 最新价 ≥ / ≤ threshold
    | 'pct_above'   | 'pct_below'            // 涨跌幅 ≥ / ≤ threshold（%）
    | 'macd_golden' | 'macd_dead'            // DIF 上穿/下穿 DEA（period 周期）
    | 'kdj_j_above' | 'kdj_j_below'          // J ≥ / ≤ threshold，穿越判定
  threshold: number                // kind 需要数值阈值时使用（MACD 交叉类忽略）
  period: Period                   // 指标类规则的 K 线周期；价格类忽略
  mode: 'once' | 'every'           // once：触发一次后等确认重新武装；every：冷却后自动重新武装
  cooldownMin: number              // 默认 5，every 模式再次触发的最短间隔
  enabled: boolean
  createdAt: number
}
```

## 3. AlertState（运行态，与规则定义同文件持久化）

```ts
interface AlertState {
  ruleId: string
  phase: 'ARMED'|'TRIGGERED'|'COOLING'|'DISABLED'
  lastPrice: number|null     // 穿越判定的上一值（价格/涨跌幅类）
  lastBarT: string|null      // 指标类规则已评估到的最后一根已收盘 bar
  lastTriggeredAt: number|null
  updatedAt: number
}
```

状态机迁移（`lib/shared.js: nextPhase()`）：

- `ARMED → TRIGGERED`：穿越判定命中（见 §4）。
- `TRIGGERED → ARMED`：`mode: once` 时用户在告警页点「确认」重新武装。
- `TRIGGERED → COOLING`：`mode: every` 时自动进入。
- `COOLING → ARMED`：`now - lastTriggeredAt ≥ cooldownMin * 60_000`。
- `ARMED ↔ DISABLED`：手动启停。
- 引擎重启对账：持久化文件加载后，`COOLING` 按时间恢复，`TRIGGERED` 保持等待确认。

## 4. 穿越判定语义（防抖动核心）

所有阈值类规则**只在跨越事件发生的那一刻触发一次**：

```js
// price_above：上一值 < thr 且 当前值 ≥ thr 才触发
crossedAbove(prev, now, thr) => prev !== null && prev < thr && now >= thr
crossedBelow(prev, now, thr) => prev !== null && prev > thr && now <= thr
// 金叉：prev DIF ≤ prev DEA 且 now DIF > now DEA（死叉反之）
```

指标类规则只在**新收盘 bar**出现时评估一次（`state.lastBarT` 防重放）；重启后 `lastBarT`
保证不会对同一根 bar 重复触发。休市期间评估循环直接跳过（N-05），不更新 `lastPrice`，
因此恢复后不会基于过期数据产生错误穿越。

## 5. AlertEvent（触发历史，独立于规则状态）

```ts
interface AlertEvent {
  id: string; ruleId: string; symbol: string; name: string
  summary: string          // 人读摘要，如 "沪金2606 ≥ 480 触发（现价 481.2）"
  value: number            // 触发时的指标值/价格
  at: number; ack: boolean
}
```

历史保留最近 200 条（环形）；规则状态与历史同写 `~/.dsh/market-alert/state.json`，
重启对账只读规则状态。

## 6. Host ↔ Client 通道

- `POST /api/market-alert`：`{ method, payload }` JSON-RPC 风格。
  method ∈ `state | search | watch.add | watch.remove | rule.add | rule.update |
  rule.delete | rule.ack | event.clear`。
- `GET /api/market-alert/stream`：SSE。事件 `data: {"t":"alert",...}`（告警）、
  `{"t":"quotes", quotes:[...]}`（自选快照广播）、`{"t":"hello",...}`。页面隐藏时面板保持
  该连接，告警不依赖行情标签页可见。
- 全局规则上限 500（N-02），超出返回明确错误而非静默失败。
