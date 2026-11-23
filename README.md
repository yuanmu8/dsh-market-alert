# dsh-market-alert

股票 / 期货 / 期权告警系统 DSH 插件（P0 最小可用闭环）。

## 安装（DeepSeek Harness）

**方式一：从源码安装（推荐）**

```powershell
git clone https://github.com/yuanmu8/dsh-market-alert.git
```

克隆后在任意 DSH 会话里对 Agent 说：

> 帮我安装插件：`<克隆路径>/dsh-market-alert`（plugin_manager install_bundle）

安装返回 `applied` 后，**刷新一次 Web 页面**，侧栏出现「行情告警」图标即完成。

**方式二：从 Release zip 安装**

到 [Releases](https://github.com/yuanmu8/dsh-market-alert/releases) 下载
`dsh-market-alert-vX.Y.Z.zip`，解压到任意目录（路径不要含空格更稳妥），
再按方式一第 2 步对 Agent 说该解压目录即可。

**说明**

- 插件无运行时依赖，Node 版随 DSH 宿主。
- 规则与自选持久化在宿主侧 `~/.dsh/market-alert/state.json`，换浏览器、重启 DSH 不丢失；删除该文件即重置。
- 行情数据来自腾讯 / 新浪公开接口，免 token；期货 K 线走新浪期货接口。
- 卸载：DSH 插件管理里移除 `dsh-market-alert` bundle 即可。

## 能力

- **多市场自选**：A 股（沪深北）、港股、美股、国内期货（商品 + 金融），代码/名称/拼音搜索添加（W-01）。
- **告警规则**：价格 ≥/≤、涨跌幅 ≥/≤、MACD 金叉/死叉、KDJ J 值 ≥/≤（支持负值阈值），
  按周期（1m–60m、日线）独立求值（P0 范围）。
- **穿越判定防抖**（§4.1）：所有阈值类规则只在 prev→now 跨越阈值的一刻触发；
  指标类规则只在「新收盘 bar」评估一次（`state.lastBarT` 防重放）。
- **状态机**：`ARMED → TRIGGERED → (确认后 ARMED)`（once）或 `→ COOLING → 自动 ARMED`（every + 冷却时间）。
- **Host 侧评估**：告警循环与规则状态都在宿主进程运行，浏览器关闭后规则照常触发；
  规则/自选/事件持久化到 `~/.dsh/market-alert/state.json`（原子写入，重启对账恢复）。
- **SSE 推送**：`/api/market-alert/stream` 告警流独立于行情快照广播，面板隐藏时保持连接。
- **休市休眠**：非交易时段跳过评估、不更新基线（N-05）；数据源失败跳过并记录原因，恢复自动继续。
- **降级标识**：腾讯主源失败切新浪备源时，行情与面板显示「备源」标记（W-06）。

## 面板

侧栏「行情告警」图标进入，三个标签页：自选 / 告警规则 / 告警记录。
删除启用中的自选标的需二次确认（W-02）；未确认告警高亮并可一键确认重新武装（A-02）。

## 契约与架构

见 [docs/contract.md](docs/contract.md)：`MarketDataProvider` 接口、`AlertRule` / `AlertState`
Schema、穿越判定语义与 Host↔Client 通道定义。

## 测试

```
node --test test/shared.test.mjs
```

覆盖指标口径（MACD/KDJ/RSI/SMA/BOLL/ATR）、穿越判定、规则评估防重放与状态机迁移。

## 后续（P1+）

RSI/BOLL/均线规则、多条件组合、期货持仓量/成交量异动、期权链（权利金/IV/Greeks）、
K 线页与画线转告警（TradeCanvas/HQChart 选型见需求规格 §3.4）。
