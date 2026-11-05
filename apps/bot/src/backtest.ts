/** Daily-candle backtest: replays past closes through the live strategy and risk limits. Read-only API calls. */
import { parseArgs } from 'node:util'
import type { BacktestParams } from '@auto-trade/core'
import { BacktestStore, CachedHistory, Decimal, MeritzClient, MeritzFeed, MeritzHistory, marketOf, runBacktest, settingsFromEnv, yyyymmdd } from '@auto-trade/core'

const { values: a } = parseArgs({
  options: {
    'symbols': { type: 'string' },
    'from': { type: 'string' },
    'to': { type: 'string' },
    'strategy': { type: 'string' },
    'sma-short': { type: 'string' },
    'sma-long': { type: 'string' },
    'budget': { type: 'string' },
    'max-order': { type: 'string' },
    'max-daily-loss': { type: 'string' },
    'max-orders-per-day': { type: 'string' },
    'fee-rate': { type: 'string' },
    'kr-sell-tax-rate': { type: 'string' },
    'fx': { type: 'string' },
  },
})

const s = settingsFromEnv()
const ymd = (v: string) => {
  const d = v.replace(/-/g, '')
  if (!/^\d{8}$/.test(d)) throw new Error(`date must be YYYY-MM-DD or YYYYMMDD: ${v}`)
  return d
}
const symbols = (a.symbols ?? s.symbols.join(',')).split(',').map(x => x.trim()).filter(Boolean)
const to = ymd(a.to ?? yyyymmdd(new Date()))
const from = ymd(a.from ?? `${Number(to.slice(0, 4)) - 3}${to.slice(4)}`)
const client = new MeritzClient()
const fx = a.fx ?? (symbols.some(x => marketOf(x) === 'US') ? (await new MeritzFeed(client).usdKrw()).toString() : '1')

const params: BacktestParams = {
  symbols,
  from,
  to,
  strategy: a.strategy ?? s.strategy,
  smaShort: Number(a['sma-short'] ?? s.smaShort),
  smaLong: Number(a['sma-long'] ?? s.smaLong),
  orderBudgetKrw: a.budget ?? s.orderBudgetKrw.toString(),
  maxOrderKrw: a['max-order'] ?? s.maxOrderKrw.toString(),
  maxDailyLossKrw: a['max-daily-loss'] ?? s.maxDailyLossKrw.toString(),
  maxOrdersPerDay: Number(a['max-orders-per-day'] ?? s.maxOrdersPerDay),
  feeRate: a['fee-rate'] ?? s.feeRate.toString(),
  krSellTaxRate: a['kr-sell-tax-rate'] ?? s.krSellTaxRate.toString(),
  usdKrw: new Decimal(fx).toString(),
}

const store = new BacktestStore(s.backtestDbPath)
console.log(`backtest ${params.strategy}(${params.smaShort},${params.smaLong}) ${from}~${to} budget=${params.orderBudgetKrw} fee=${params.feeRate} tax=${params.krSellTaxRate} usdkrw=${params.usdKrw}`)
const results = await runBacktest(new CachedHistory(new MeritzHistory(client), store), params)
const id = store.saveRun(params, results)
store.close()

const pad = (v: unknown, n: number) => String(v ?? '-').padStart(n)
console.log(`\n${'symbol'.padEnd(10)}${pad('bars', 6)}${pad('return%', 10)}${pad('B&H%', 10)}${pad('MDD%', 8)}${pad('trades', 8)}${pad('win%', 7)}${pad('pnl KRW', 14)}`)
for (const r of results) {
  const m = r.metrics
  console.log(`${r.symbol.padEnd(10)}${pad(r.bars, 6)}${pad(m.returnPct, 10)}${pad(m.buyHoldReturnPct, 10)}${pad(m.maxDrawdownPct, 8)}${pad(m.trades, 8)}${pad(m.winRatePct, 7)}${pad(m.pnlKrw, 14)}`)
  for (const w of r.warnings) console.log(`  ! ${w}`)
}
console.log(`\nsaved run #${id} to ${s.backtestDbPath} (dashboard: /backtests/${id})`)
