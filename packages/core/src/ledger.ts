import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Decimal } from 'decimal.js'
import type { MinuteBar } from './minute-bars.ts'
import type { Currency, Fill, Position, Side } from './models.ts'
import { kstDate } from './models.ts'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fills (
  client_order_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  quantity TEXT NOT NULL,
  price TEXT NOT NULL,
  currency TEXT NOT NULL,
  fx_rate TEXT NOT NULL,
  mode TEXT NOT NULL,
  realized_pnl_krw TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS fills_trade_date ON fills (trade_date);
CREATE TABLE IF NOT EXISTS positions (
  symbol TEXT PRIMARY KEY,
  quantity TEXT NOT NULL,
  avg_price TEXT NOT NULL,
  currency TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quotes (
  symbol TEXT PRIMARY KEY,
  price TEXT NOT NULL,
  currency TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS minute_bars (
  symbol TEXT NOT NULL,
  minute TEXT NOT NULL,
  open TEXT NOT NULL,
  high TEXT NOT NULL,
  low TEXT NOT NULL,
  close TEXT NOT NULL,
  volume TEXT NOT NULL,
  PRIMARY KEY (symbol, minute)
);
CREATE TABLE IF NOT EXISTS bot_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  last_error TEXT
);
`

export interface FillInput {
  clientOrderId: string
  symbol: string
  side: Side
  quantity: Decimal
  price: Decimal
  currency: Currency
  fxRate: Decimal
  mode: string
  timestamp: Date
  reason?: string
}

export interface BotStatus {
  mode: string
  heartbeatAt: string
  lastError: string | null
}

export interface StoredQuote {
  symbol: string
  price: string
  currency: Currency
  ts: string
}

/** Local record of fills, positions and bot status; shared by the bot (writer) and the dashboard (reader). */
export class Ledger {
  readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    this.db.exec(SCHEMA)
  }

  close() {
    this.db.close()
  }

  position(symbol: string): Position | null {
    const row = this.db.prepare('SELECT * FROM positions WHERE symbol = ?').get(symbol) as any
    if (!row || new Decimal(row.quantity).isZero()) return null
    return toPosition(row)
  }

  positions(): Position[] {
    return (this.db.prepare('SELECT * FROM positions ORDER BY symbol').all() as any[])
      .map(toPosition)
      .filter(p => !p.quantity.isZero())
  }

  hasOrder(clientOrderId: string): boolean {
    return this.db.prepare('SELECT 1 FROM fills WHERE client_order_id = ?').get(clientOrderId) !== undefined
  }

  recordFill(f: FillInput): Fill {
    const pos = this.position(f.symbol)
    const qty = pos?.quantity ?? new Decimal(0)
    let avg = pos?.avgPrice ?? new Decimal(0)
    let realized = new Decimal(0)
    let newQty: Decimal
    if (f.side === 'BUY') {
      newQty = qty.plus(f.quantity)
      avg = qty.times(avg).plus(f.quantity.times(f.price)).div(newQty)
    }
    else {
      if (f.quantity.gt(qty)) throw new Error(`cannot sell ${f.quantity} ${f.symbol}: holding ${qty}`)
      realized = f.price.minus(avg).times(f.quantity).times(f.fxRate)
      newQty = qty.minus(f.quantity)
      if (newQty.isZero()) avg = new Decimal(0)
    }
    const reason = f.reason ?? ''
    this.db.exec('BEGIN')
    try {
      this.db.prepare('INSERT INTO fills VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        f.clientOrderId,
        f.timestamp.toISOString(),
        kstDate(f.timestamp),
        f.symbol,
        f.side,
        f.quantity.toString(),
        f.price.toString(),
        f.currency,
        f.fxRate.toString(),
        f.mode,
        realized.toString(),
        reason,
      )
      this.db.prepare(
        'INSERT INTO positions VALUES (?, ?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET '
        + 'quantity = excluded.quantity, avg_price = excluded.avg_price, currency = excluded.currency',
      ).run(f.symbol, newQty.toString(), avg.toString(), f.currency)
      this.db.exec('COMMIT')
    }
    catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return { ...f, reason, realizedPnlKrw: realized }
  }

  /** Buy fills on a KST trade date (YYYY-MM-DD). */
  buysOn(day: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM fills WHERE trade_date = ? AND side = \'BUY\'').get(day) as any
    return Number(row.n)
  }

  realizedPnlKrwOn(day: string): Decimal {
    const rows = this.db.prepare('SELECT realized_pnl_krw AS v FROM fills WHERE trade_date = ?').all(day) as any[]
    return rows.reduce((sum, r) => sum.plus(r.v), new Decimal(0))
  }

  recentFills(limit = 50): Fill[] {
    const rows = this.db.prepare('SELECT * FROM fills ORDER BY ts DESC LIMIT ?').all(limit) as any[]
    return rows.map(r => ({
      clientOrderId: r.client_order_id,
      symbol: r.symbol,
      side: r.side,
      quantity: new Decimal(r.quantity),
      price: new Decimal(r.price),
      currency: r.currency,
      fxRate: new Decimal(r.fx_rate),
      mode: r.mode,
      realizedPnlKrw: new Decimal(r.realized_pnl_krw),
      timestamp: new Date(r.ts),
      reason: r.reason,
    }))
  }

  saveQuotes(quotes: { symbol: string, price: Decimal, currency: Currency, timestamp: Date }[]) {
    const stmt = this.db.prepare(
      'INSERT INTO quotes VALUES (?, ?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET '
      + 'price = excluded.price, currency = excluded.currency, ts = excluded.ts',
    )
    for (const q of quotes) stmt.run(q.symbol, q.price.toString(), q.currency, q.timestamp.toISOString())
  }

  quotes(): StoredQuote[] {
    return this.db.prepare('SELECT * FROM quotes ORDER BY symbol').all() as any[]
  }

  saveMinuteBars(bars: MinuteBar[]) {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO minute_bars VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const b of bars) {
      stmt.run(b.symbol, b.minute.toISOString(), b.open.toString(), b.high.toString(), b.low.toString(), b.close.toString(), b.volume.toString())
    }
  }

  minuteBars(symbol: string, from = '', to = '9999'): MinuteBar[] {
    const rows = this.db.prepare('SELECT * FROM minute_bars WHERE symbol = ? AND minute >= ? AND minute < ? ORDER BY minute').all(symbol, from, to) as any[]
    return rows.map(r => ({
      symbol: r.symbol,
      minute: new Date(r.minute),
      open: new Decimal(r.open),
      high: new Decimal(r.high),
      low: new Decimal(r.low),
      close: new Decimal(r.close),
      volume: new Decimal(r.volume),
    }))
  }

  minuteBarStats(): { symbol: string, count: number, first: string, last: string }[] {
    return (this.db.prepare('SELECT symbol, COUNT(*) AS count, MIN(minute) AS first, MAX(minute) AS last FROM minute_bars GROUP BY symbol ORDER BY symbol').all() as any[])
      .map(r => ({ symbol: r.symbol, count: Number(r.count), first: r.first, last: r.last }))
  }

  heartbeat(mode: string, at: Date, lastError: string | null = null) {
    this.db.prepare(
      'INSERT INTO bot_status VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET '
      + 'mode = excluded.mode, heartbeat_at = excluded.heartbeat_at, last_error = excluded.last_error',
    ).run(mode, at.toISOString(), lastError)
  }

  status(): BotStatus | null {
    const row = this.db.prepare('SELECT * FROM bot_status WHERE id = 1').get() as any
    return row ? { mode: row.mode, heartbeatAt: row.heartbeat_at, lastError: row.last_error } : null
  }
}

function toPosition(row: any): Position {
  return {
    symbol: row.symbol,
    quantity: new Decimal(row.quantity),
    avgPrice: new Decimal(row.avg_price),
    currency: row.currency,
  }
}
