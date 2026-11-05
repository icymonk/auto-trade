import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Decimal } from 'decimal.js'
import { Bot } from './bot.ts'
import { DryRunBroker } from './broker.ts'
import type { PriceFeed } from './feed.ts'
import { Ledger } from './ledger.ts'
import { AlwaysOpen } from './market.ts'
import type { MeritzClient } from './meritz.ts'
import { parseMeritzSymbol } from './meritz.ts'
import type { Quote } from './models.ts'
import { marketOf } from './models.ts'
import { RiskManager } from './risk.ts'
import { buildStrategy } from './strategy.ts'

/** One trading day. `date` is YYYYMMDD. Prices are split-adjusted. */
export interface DailyBar {
  date: string
  open: Decimal
  high: Decimal
  low: Decimal
  close: Decimal
  volume: Decimal
}

export interface HistoryProvider {
  /** Bars between `from` and `to` (YYYYMMDD, inclusive), oldest first. */
  dailyBars(symbol: string, from: string, to: string): Promise<DailyBar[]>
}

/** Daily candles from Meritz. One request covers at most one year, so the range is split by calendar year. */
export class MeritzHistory implements HistoryProvider {
  constructor(private readonly client: MeritzClient) {}

  async dailyBars(symbol: string, from: string, to: string): Promise<DailyBar[]> {
    const s = parseMeritzSymbol(symbol)
    const bars: DailyBar[] = []
    for (const [f, t] of yearChunks(from, to)) {
      const rows = s.market === 'KR'
        ? (await this.client.get<{ data: any[] }>('/market/v1/candles/days', {
            mrkt_div_code: 'J', iscd: s.code, mod_stpr_cls_code: '0', from: f, to: t,
          })).data
        : (await this.client.get<{ data: any[] }>('/market/v1/overseas/candles/days', {
            mrkt_div_code: 'OV', mrkt_cls_code: s.exchange, iscd: s.code, dely_rltm_cls_code: '0', mod_stpr_cls_code: '0', from: f, to: t,
          })).data
      for (const r of rows ?? []) {
        const close = new Decimal(s.market === 'KR' ? r.stck_clpr : r.prpr)
        if (!close.isFinite() || close.lte(0)) continue
        bars.push({
          date: String(r.date),
          open: new Decimal(r.oprc || close),
          high: new Decimal(r.hprc || close),
          low: new Decimal(r.lprc || close),
          close,
          volume: new Decimal(r.acml_vol || 0),
        })
      }
    }
    return dedupeSorted(bars)
  }
}

export function yearChunks(from: string, to: string): [string, string][] {
  const out: [string, string][] = []
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
    const f = y === Number(from.slice(0, 4)) ? from : `${y}0101`
    const t = y === Number(to.slice(0, 4)) ? to : `${y}1231`
    out.push([f, t])
  }
  return out
}

function dedupeSorted(bars: DailyBar[]) {
  const byDate = new Map(bars.map(b => [b.date, b]))
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

const STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS daily_bars (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  open TEXT NOT NULL,
  high TEXT NOT NULL,
  low TEXT NOT NULL,
  close TEXT NOT NULL,
  volume TEXT NOT NULL,
  PRIMARY KEY (symbol, date)
);
CREATE TABLE IF NOT EXISTS bar_years (
  symbol TEXT NOT NULL,
  year TEXT NOT NULL,
  fetched_on TEXT NOT NULL,
  PRIMARY KEY (symbol, year)
);
CREATE TABLE IF NOT EXISTS backtest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  params TEXT NOT NULL,
  results TEXT NOT NULL
);
`

/** Cached daily bars and saved backtest runs (data/backtest.sqlite3, separate from the live ledger). */
export class BacktestStore {
  readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    this.db.exec(STORE_SCHEMA)
  }

  close() {
    this.db.close()
  }

  fetchedOn(symbol: string, year: string): string | undefined {
    return (this.db.prepare('SELECT fetched_on FROM bar_years WHERE symbol = ? AND year = ?').get(symbol, year) as any)?.fetched_on
  }

  saveBars(symbol: string, year: string, fetchedOn: string, bars: DailyBar[]) {
    this.db.exec('BEGIN')
    try {
      const stmt = this.db.prepare('INSERT OR REPLACE INTO daily_bars VALUES (?, ?, ?, ?, ?, ?, ?)')
      for (const b of bars) stmt.run(symbol, b.date, b.open.toString(), b.high.toString(), b.low.toString(), b.close.toString(), b.volume.toString())
      this.db.prepare('INSERT OR REPLACE INTO bar_years VALUES (?, ?, ?)').run(symbol, year, fetchedOn)
      this.db.exec('COMMIT')
    }
    catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  bars(symbol: string, from: string, to: string): DailyBar[] {
    const rows = this.db.prepare('SELECT * FROM daily_bars WHERE symbol = ? AND date BETWEEN ? AND ? ORDER BY date').all(symbol, from, to) as any[]
    return rows.map(r => ({
      date: r.date,
      open: new Decimal(r.open),
      high: new Decimal(r.high),
      low: new Decimal(r.low),
      close: new Decimal(r.close),
      volume: new Decimal(r.volume),
    }))
  }

  saveRun(params: BacktestParams, results: BacktestResult[], at = new Date()): number {
    const r = this.db.prepare('INSERT INTO backtest_runs (created_at, params, results) VALUES (?, ?, ?)')
      .run(at.toISOString(), JSON.stringify(params), JSON.stringify(results))
    return Number(r.lastInsertRowid)
  }

  runs(limit = 50): { id: number, createdAt: string, params: BacktestParams, results: BacktestResult[] }[] {
    return (this.db.prepare('SELECT * FROM backtest_runs ORDER BY id DESC LIMIT ?').all(limit) as any[]).map(toRun)
  }

  run(id: number) {
    const row = this.db.prepare('SELECT * FROM backtest_runs WHERE id = ?').get(id) as any
    return row ? toRun(row) : null
  }
}

function toRun(r: any) {
  return { id: Number(r.id), createdAt: String(r.created_at), params: JSON.parse(r.params) as BacktestParams, results: JSON.parse(r.results) as BacktestResult[] }
}

/**
 * Fetches whole calendar years once. Past years are cached permanently; the current year
 * is refetched once per day.
 */
export class CachedHistory implements HistoryProvider {
  constructor(private readonly inner: HistoryProvider, private readonly store: BacktestStore, private readonly today = () => yyyymmdd(new Date())) {}

  async dailyBars(symbol: string, from: string, to: string): Promise<DailyBar[]> {
    const today = this.today()
    for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
      const year = String(y)
      const fetched = this.store.fetchedOn(symbol, year)
      const complete = fetched !== undefined && (fetched > `${year}1231` || fetched === today)
      if (complete || `${year}0101` > today) continue
      const end = `${year}1231` < today ? `${year}1231` : today
      this.store.saveBars(symbol, year, today, await this.inner.dailyBars(symbol, `${year}0101`, end))
    }
    return this.store.bars(symbol, from, to)
  }
}

export function yyyymmdd(d: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d).replace(/-/g, '')
}

export interface BacktestParams {
  symbols: string[]
  from: string
  to: string
  strategy: string
  smaShort: number
  smaLong: number
  orderBudgetKrw: string
  maxOrderKrw: string
  maxDailyLossKrw: string
  maxOrdersPerDay: number
  /** Brokerage fee per side, e.g. 0.00015 = 0.015%. */
  feeRate: string
  /** KR securities transaction tax on sells. */
  krSellTaxRate: string
  /** Fixed USD/KRW used to size and value US trades. */
  usdKrw: string
}

export interface BacktestTrade {
  date: string
  side: 'BUY' | 'SELL'
  quantity: string
  price: string
  /** Net of fees/tax, on SELL only. */
  pnlKrw: string | null
  reason: string
}

export interface BacktestResult {
  symbol: string
  currency: 'KRW' | 'USD'
  firstDate: string | null
  lastDate: string | null
  bars: number
  metrics: {
    /** Strategy P&L after fees, including the open position at the last close. */
    pnlKrw: string
    returnPct: string
    buyHoldPnlKrw: string | null
    buyHoldReturnPct: string | null
    maxDrawdownPct: string
    trades: number
    winRatePct: string | null
    feesKrw: string
    exposurePct: string
  }
  /** Daily cumulative P&L (KRW) of the strategy and of buy & hold. */
  equity: { date: string, pnlKrw: number, buyHoldKrw: number | null }[]
  trades: BacktestTrade[]
  warnings: string[]
}

class ReplayFeed implements PriceFeed {
  quote?: Quote
  constructor(private readonly fx: Decimal) {}
  async quotes(): Promise<Quote[]> {
    return this.quote ? [this.quote] : []
  }

  async usdKrw() {
    return this.fx
  }
}

const silent = { info() {}, warn() {}, error() {} }

/** Bar close as a Date; 06:30 UTC keeps the KST trade date equal to the bar date. */
function barTime(date: string) {
  return new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T06:30:00Z`)
}

/**
 * Replays daily closes through the live Bot (same Strategy, RiskManager and DryRunBroker),
 * one symbol at a time with an in-memory ledger. Fills happen at the close of the signal day.
 */
export async function runBacktest(history: HistoryProvider, p: BacktestParams): Promise<BacktestResult[]> {
  const out: BacktestResult[] = []
  for (const symbol of p.symbols) out.push(await backtestSymbol(symbol, await history.dailyBars(symbol, p.from, p.to), p))
  return out
}

export async function backtestSymbol(symbol: string, bars: DailyBar[], p: BacktestParams): Promise<BacktestResult> {
  const usd = marketOf(symbol) === 'US'
  const fx = usd ? new Decimal(p.usdKrw) : new Decimal(1)
  const feeRate = new Decimal(p.feeRate)
  const taxRate = usd ? new Decimal(0) : new Decimal(p.krSellTaxRate)
  const budget = new Decimal(p.orderBudgetKrw)
  const ledger = new Ledger(':memory:')
  const feed = new ReplayFeed(fx)
  let now = new Date(0)
  const blocked: string[] = []
  const bot = new Bot({
    feed,
    clock: new AlwaysOpen(),
    strategy: buildStrategy(p.strategy, p.smaShort, p.smaLong),
    broker: new DryRunBroker(ledger),
    ledger,
    risk: new RiskManager(ledger, {
      maxOrderKrw: new Decimal(p.maxOrderKrw),
      maxDailyLossKrw: new Decimal(p.maxDailyLossKrw),
      maxOrdersPerDay: p.maxOrdersPerDay,
      killSwitchPath: join(tmpdir(), `auto-trade-backtest-${randomUUID()}`, 'KILL'),
    }),
    symbols: [symbol],
    orderBudgetKrw: budget,
    now: () => now,
    log: { ...silent, warn: m => blocked.push(m), info: m => m.startsWith('skip') && blocked.push(m) },
  })

  const trades: BacktestTrade[] = []
  const equity: BacktestResult['equity'] = []
  let realized = new Decimal(0)
  let fees = new Decimal(0)
  let buyFee = new Decimal(0)
  let wins = 0
  let roundTrips = 0
  let daysHeld = 0
  let peak = budget
  let maxDd = new Decimal(0)

  const first = bars[0]
  const bhQty = first ? budget.div(first.close.times(fx)).floor() : new Decimal(0)
  const bhCost = first ? bhQty.times(first.close).times(fx).times(feeRate) : new Decimal(0)

  for (const bar of bars) {
    now = barTime(bar.date)
    feed.quote = { symbol, price: bar.close, currency: usd ? 'USD' : 'KRW', timestamp: now }
    for (const f of await bot.step()) {
      const notional = f.quantity.times(f.price).times(fx)
      const fee = notional.times(feeRate).plus(f.side === 'SELL' ? notional.times(taxRate) : 0)
      fees = fees.plus(fee)
      let pnl: Decimal | null = null
      if (f.side === 'BUY') {
        buyFee = fee
      }
      else {
        pnl = f.realizedPnlKrw.minus(fee).minus(buyFee)
        realized = realized.plus(f.realizedPnlKrw)
        roundTrips++
        if (pnl.gt(0)) wins++
      }
      trades.push({ date: bar.date, side: f.side, quantity: f.quantity.toString(), price: f.price.toString(), pnlKrw: pnl?.toFixed(0) ?? null, reason: f.reason })
    }
    const pos = ledger.position(symbol)
    if (pos) daysHeld++
    const unrealized = pos ? bar.close.minus(pos.avgPrice).times(pos.quantity).times(fx) : new Decimal(0)
    const pnl = realized.plus(unrealized).minus(fees)
    const eq = budget.plus(pnl)
    if (eq.gt(peak)) peak = eq
    const dd = peak.minus(eq).div(peak)
    if (dd.gt(maxDd)) maxDd = dd
    const bh = bhQty.gt(0) && first ? bar.close.minus(first.close).times(bhQty).times(fx).minus(bhCost) : null
    equity.push({ date: bar.date, pnlKrw: pnl.round().toNumber(), buyHoldKrw: bh?.round().toNumber() ?? null })
  }
  ledger.close()

  const last = bars.at(-1)
  const finalPnl = new Decimal(equity.at(-1)?.pnlKrw ?? 0)
  const bhFinal = last && bhQty.gt(0)
    ? new Decimal(equity.at(-1)!.buyHoldKrw!).minus(bhQty.times(last.close).times(fx).times(feeRate.plus(taxRate)))
    : null
  const warnings: string[] = []
  if (bars.length === 0) warnings.push('기간 안에 시세가 없어요')
  else if (bars.length < p.smaLong) warnings.push(`봉이 ${bars.length}개라 SMA${p.smaLong} 신호가 나오지 않아요`)
  if (bhQty.isZero() && first) warnings.push(`주문 예산 ${budget.toFixed(0)}원으로 첫날 종가 기준 1주도 살 수 없어요`)
  const skippedQty = blocked.filter(m => m.startsWith('skip')).length
  const blockedRisk = blocked.length - skippedQty
  if (skippedQty) warnings.push(`예산 부족으로 건너뛴 매수 신호 ${skippedQty}건`)
  if (blockedRisk) warnings.push(`리스크 한도로 막힌 주문 ${blockedRisk}건 (예: ${blocked.find(m => !m.startsWith('skip'))})`)
  const pct = (v: Decimal) => v.div(budget).times(100).toFixed(2)
  return {
    symbol,
    currency: usd ? 'USD' : 'KRW',
    firstDate: first?.date ?? null,
    lastDate: last?.date ?? null,
    bars: bars.length,
    metrics: {
      pnlKrw: finalPnl.toFixed(0),
      returnPct: pct(finalPnl),
      buyHoldPnlKrw: bhFinal?.toFixed(0) ?? null,
      buyHoldReturnPct: bhFinal ? pct(bhFinal) : null,
      maxDrawdownPct: maxDd.times(100).toFixed(2),
      trades: roundTrips,
      winRatePct: roundTrips ? new Decimal(wins).div(roundTrips).times(100).toFixed(1) : null,
      feesKrw: fees.toFixed(0),
      exposurePct: bars.length ? new Decimal(daysHeld).div(bars.length).times(100).toFixed(1) : '0',
    },
    equity,
    trades,
    warnings,
  }
}
