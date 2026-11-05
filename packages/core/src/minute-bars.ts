import type { Decimal } from 'decimal.js'

export interface Trade {
  symbol: string
  price: Decimal
  volume: Decimal
  at: Date
}

export interface MinuteBar {
  symbol: string
  /** Start of the minute. */
  minute: Date
  open: Decimal
  high: Decimal
  low: Decimal
  close: Decimal
  volume: Decimal
}

/** Aggregates streamed trades into 1-minute OHLCV bars; a bar is saved once its minute is over (or on flush). */
export class MinuteBarRecorder {
  private readonly current = new Map<string, MinuteBar>()

  constructor(private readonly save: (bars: MinuteBar[]) => void) {}

  onTrade(t: Trade) {
    const minute = new Date(Math.floor(t.at.getTime() / 60_000) * 60_000)
    const bar = this.current.get(t.symbol)
    if (bar && bar.minute.getTime() === minute.getTime()) {
      if (t.price.gt(bar.high)) bar.high = t.price
      if (t.price.lt(bar.low)) bar.low = t.price
      bar.close = t.price
      bar.volume = bar.volume.plus(t.volume)
      return
    }
    if (bar && minute < bar.minute) return
    if (bar) this.save([bar])
    this.current.set(t.symbol, { symbol: t.symbol, minute, open: t.price, high: t.price, low: t.price, close: t.price, volume: t.volume })
  }

  flush() {
    if (this.current.size) this.save([...this.current.values()])
    this.current.clear()
  }
}
