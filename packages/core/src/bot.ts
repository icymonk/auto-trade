import { Decimal } from 'decimal.js'
import type { Broker } from './broker.ts'
import { newClientOrderId } from './broker.ts'
import type { PriceFeed } from './feed.ts'
import type { Ledger } from './ledger.ts'
import type { MarketClockLike } from './market.ts'
import type { Fill, Quote } from './models.ts'
import { kstDate, marketOf } from './models.ts'
import type { RiskManager } from './risk.ts'
import type { Strategy } from './strategy.ts'

export interface Logger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

export interface BotDeps {
  feed: PriceFeed
  clock: MarketClockLike
  strategy: Strategy
  broker: Broker
  ledger: Ledger
  risk: RiskManager
  symbols: string[]
  orderBudgetKrw: Decimal
  now?: () => Date
  log?: Logger
}

const consoleLogger: Logger = {
  info: m => console.log(`${new Date().toISOString()} INFO ${m}`),
  warn: m => console.warn(`${new Date().toISOString()} WARN ${m}`),
  error: m => console.error(`${new Date().toISOString()} ERROR ${m}`),
}

export class Bot {
  private readonly now: () => Date
  private readonly log: Logger
  private stopped = false

  constructor(private readonly d: BotDeps) {
    this.now = d.now ?? (() => new Date())
    this.log = d.log ?? consoleLogger
  }

  async step(): Promise<Fill[]> {
    const now = this.now()
    this.d.ledger.heartbeat(this.d.broker.mode, now)
    if (this.d.risk.killSwitch.isOn()) {
      this.log.warn(`kill switch on (${this.d.risk.killSwitch.path}); skipping`)
      return []
    }
    const symbols: string[] = []
    for (const s of this.d.symbols) if (await this.d.clock.isOpen(marketOf(s), now)) symbols.push(s)
    if (symbols.length === 0) return []

    const quotes = await this.d.feed.quotes(symbols)
    this.d.ledger.saveQuotes(quotes)
    const fx = quotes.some(q => q.currency === 'USD') ? await this.d.feed.usdKrw() : new Decimal(1)
    const unrealized = this.unrealizedKrw(quotes, fx)
    const fills: Fill[] = []
    for (const q of quotes) {
      const fill = await this.handle(q, q.currency === 'USD' ? fx : new Decimal(1), unrealized, now)
      if (fill) fills.push(fill)
    }
    return fills
  }

  private async handle(quote: Quote, fx: Decimal, unrealizedKrw: Decimal, now: Date): Promise<Fill | null> {
    const position = this.d.ledger.position(quote.symbol)
    const signal = this.d.strategy.onQuote(quote, position)
    if (!signal) return null

    let qty: Decimal
    if (signal.side === 'BUY') {
      qty = signal.quantity ?? this.d.orderBudgetKrw.div(quote.price.times(fx)).floor()
    }
    else {
      const held = position?.quantity ?? new Decimal(0)
      qty = Decimal.min(signal.quantity ?? held, held)
    }
    if (qty.lte(0)) {
      this.log.info(`skip ${signal.side} ${quote.symbol}: quantity 0 (${signal.reason})`)
      return null
    }
    const notionalKrw = qty.times(quote.price).times(fx)
    const decision = this.d.risk.check({ side: signal.side, notionalKrw, day: kstDate(now), unrealizedKrw })
    if (!decision.allowed) {
      this.log.warn(`blocked ${signal.side} ${quote.symbol} x${qty}: ${decision.reason}`)
      return null
    }
    const fill = await this.d.broker.submit({
      clientOrderId: newClientOrderId(now),
      symbol: quote.symbol,
      side: signal.side,
      quantity: qty,
      price: quote.price,
      currency: quote.currency,
      fxRate: fx,
      timestamp: now,
      reason: signal.reason,
    })
    this.log.info(
      `[${fill.mode}] ${fill.side} ${fill.symbol} x${fill.quantity} @ ${fill.price} ${fill.currency} `
      + `(${signal.reason}) pnl=${fill.realizedPnlKrw.toFixed(0)} KRW`,
    )
    return fill
  }

  private unrealizedKrw(quotes: Quote[], fx: Decimal): Decimal {
    const bySymbol = new Map(quotes.map(q => [q.symbol, q]))
    let total = new Decimal(0)
    for (const pos of this.d.ledger.positions()) {
      const q = bySymbol.get(pos.symbol)
      if (q) total = total.plus(q.price.minus(pos.avgPrice).times(pos.quantity).times(q.currency === 'USD' ? fx : 1))
    }
    return total
  }

  stop() {
    this.stopped = true
  }

  async run(pollSeconds: number, maxSteps?: number) {
    for (let steps = 0; !this.stopped && (maxSteps === undefined || steps < maxSteps); steps++) {
      try {
        await this.step()
      }
      catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        this.log.error(`step failed: ${msg}`)
        this.d.ledger.heartbeat(this.d.broker.mode, this.now(), msg)
      }
      if (maxSteps === undefined || steps + 1 < maxSteps) await new Promise(r => setTimeout(r, pollSeconds * 1000))
    }
  }
}
