import { Decimal } from 'decimal.js'
import type { TossClient } from './client.ts'
import type { Quote } from './models.ts'
import { marketOf } from './models.ts'

export interface PriceFeed {
  quotes(symbols: string[]): Promise<Quote[]>
  usdKrw(): Promise<Decimal>
}

/** Polls current prices and USD/KRW from the Toss API (read-only). */
export class TossFeed implements PriceFeed {
  constructor(private readonly client: TossClient) {}

  async quotes(symbols: string[]): Promise<Quote[]> {
    const now = new Date()
    return (await this.client.getPrices(symbols)).map(item => ({
      symbol: item.symbol,
      price: new Decimal(item.lastPrice),
      currency: item.currency,
      timestamp: item.timestamp ? new Date(item.timestamp) : now,
    }))
  }

  async usdKrw(): Promise<Decimal> {
    return new Decimal((await this.client.getExchangeRate('USD', 'KRW')).rate)
  }
}

/** Random-walk prices for running the bot without API keys. */
export class SimulatedFeed implements PriceFeed {
  private prices = new Map<string, Decimal>()

  constructor(private readonly step = 0.004, private readonly random: () => number = Math.random) {}

  async quotes(symbols: string[]): Promise<Quote[]> {
    const now = new Date()
    return symbols.map((symbol) => {
      const kr = marketOf(symbol) === 'KR'
      const prev = this.prices.get(symbol) ?? new Decimal(kr ? 70000 : 200)
      const price = prev.times(1 + this.gauss() * this.step).toDecimalPlaces(kr ? 0 : 2)
      this.prices.set(symbol, price)
      return { symbol, price, currency: kr ? 'KRW' : 'USD', timestamp: now } as Quote
    })
  }

  async usdKrw() {
    return new Decimal(1400)
  }

  private gauss() {
    const u = 1 - this.random()
    const v = this.random()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
}
