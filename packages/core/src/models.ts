import type { Decimal } from 'decimal.js'

export type Side = 'BUY' | 'SELL'
export type Currency = 'KRW' | 'USD'

export interface Quote {
  symbol: string
  price: Decimal
  currency: Currency
  timestamp: Date
}

export interface Signal {
  symbol: string
  side: Side
  reason: string
  quantity?: Decimal
}

export interface Position {
  symbol: string
  quantity: Decimal
  avgPrice: Decimal
  currency: Currency
}

export interface Fill {
  clientOrderId: string
  symbol: string
  side: Side
  quantity: Decimal
  price: Decimal
  currency: Currency
  fxRate: Decimal
  mode: string
  realizedPnlKrw: Decimal
  timestamp: Date
  reason: string
}

export function marketOf(symbol: string): 'KR' | 'US' {
  return /^\d+$/.test(symbol) ? 'KR' : 'US'
}

/** YYYY-MM-DD of `d` in Asia/Seoul. */
export function kstDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d)
}
