import { Decimal, kstDate } from '@auto-trade/core'
import { defineHandler } from 'nitro/h3'
import { useKillSwitch, useLedger } from '../utils/ledger'

export default defineHandler(() => {
  const ledger = useLedger()
  const today = kstDate(new Date())
  const quotes = new Map(ledger.quotes().map(q => [q.symbol, q]))
  const positions = ledger.positions().map((p) => {
    const q = quotes.get(p.symbol)
    const last = q ? new Decimal(q.price) : null
    return {
      symbol: p.symbol,
      quantity: p.quantity.toString(),
      avgPrice: p.avgPrice.toString(),
      currency: p.currency,
      lastPrice: last?.toString() ?? null,
      unrealizedPnl: last ? last.minus(p.avgPrice).times(p.quantity).toString() : null,
    }
  })
  return {
    today,
    status: ledger.status(),
    killSwitch: useKillSwitch().isOn(),
    realizedPnlKrwToday: ledger.realizedPnlKrwOn(today).toString(),
    buysToday: ledger.buysOn(today),
    positions,
    quotes: [...quotes.values()],
    minuteBars: ledger.minuteBarStats(),
  }
})
