import { defineHandler, getQuery } from 'nitro/h3'
import { useLedger } from '../utils/ledger'

export default defineHandler((event) => {
  const limit = Math.min(Number(getQuery(event).limit ?? 50) || 50, 500)
  return useLedger().recentFills(limit).map(f => ({
    ...f,
    quantity: f.quantity.toString(),
    price: f.price.toString(),
    fxRate: f.fxRate.toString(),
    realizedPnlKrw: f.realizedPnlKrw.toString(),
    timestamp: f.timestamp.toISOString(),
  }))
})
