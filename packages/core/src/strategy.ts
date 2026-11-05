import { Decimal } from 'decimal.js'
import type { Position, Quote, Signal } from './models.ts'

/** Returns a Signal to trade or null. Must not call the API or place orders. */
export interface Strategy {
  onQuote(quote: Quote, position: Position | null): Signal | null
}

export class NoopStrategy implements Strategy {
  onQuote() {
    return null
  }
}

/** Buy when the short SMA crosses above the long SMA; sell the whole position on the reverse cross. */
export class SmaCrossStrategy implements Strategy {
  private prices = new Map<string, Decimal[]>()
  private prevDiff = new Map<string, Decimal>()

  constructor(readonly short = 5, readonly long = 20) {
    if (!(short > 0 && short < long)) throw new Error('require 0 < short < long')
  }

  onQuote(quote: Quote, position: Position | null): Signal | null {
    const prices = this.prices.get(quote.symbol) ?? []
    prices.push(quote.price)
    if (prices.length > this.long) prices.shift()
    this.prices.set(quote.symbol, prices)
    if (prices.length < this.long) return null

    const avg = (xs: Decimal[]) => Decimal.sum(...xs).div(xs.length)
    const diff = avg(prices.slice(-this.short)).minus(avg(prices))
    const prev = this.prevDiff.get(quote.symbol)
    this.prevDiff.set(quote.symbol, diff)
    if (!prev) return null

    const holding = position !== null && position.quantity.gt(0)
    if (prev.lte(0) && diff.gt(0) && !holding)
      return { symbol: quote.symbol, side: 'BUY', reason: `SMA${this.short} crossed above SMA${this.long}` }
    if (prev.gte(0) && diff.lt(0) && holding)
      return { symbol: quote.symbol, side: 'SELL', reason: `SMA${this.short} crossed below SMA${this.long}` }
    return null
  }
}

export function buildStrategy(name: string, short = 5, long = 20): Strategy {
  if (name === 'sma') return new SmaCrossStrategy(short, long)
  if (name === 'noop') return new NoopStrategy()
  throw new Error(`unknown strategy: ${name}`)
}
