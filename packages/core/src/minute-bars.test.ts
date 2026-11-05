import { Decimal } from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { Ledger } from './ledger.ts'
import type { MinuteBar } from './minute-bars.ts'
import { MinuteBarRecorder } from './minute-bars.ts'
import { tradeTime } from './meritz-ws.ts'

const t = (sec: number, price: number, volume = 1) =>
  ({ symbol: '005930', price: new Decimal(price), volume: new Decimal(volume), at: new Date(Date.UTC(2026, 10, 5, 0, 0, sec)) })

describe('MinuteBarRecorder', () => {
  it('builds OHLCV per minute and saves a bar when the minute rolls over', () => {
    const saved: MinuteBar[] = []
    const rec = new MinuteBarRecorder(b => saved.push(...b))
    rec.onTrade(t(1, 100, 2))
    rec.onTrade(t(20, 105, 3))
    rec.onTrade(t(40, 98, 1))
    rec.onTrade(t(59, 101, 4))
    expect(saved).toEqual([])
    rec.onTrade(t(61, 102))
    expect(saved).toHaveLength(1)
    const b = saved[0]!
    expect([b.open, b.high, b.low, b.close, b.volume].map(String)).toEqual(['100', '105', '98', '101', '10'])
    expect(b.minute.toISOString()).toBe('2026-11-05T00:00:00.000Z')
    rec.flush()
    expect(saved).toHaveLength(2)
  })

  it('persists bars in the ledger', () => {
    const ledger = new Ledger(':memory:')
    const rec = new MinuteBarRecorder(b => ledger.saveMinuteBars(b))
    rec.onTrade(t(1, 100))
    rec.onTrade(t(65, 101))
    rec.flush()
    expect(ledger.minuteBars('005930').map(b => b.close.toString())).toEqual(['100', '101'])
    expect(ledger.minuteBarStats()).toEqual([{ symbol: '005930', count: 2, first: '2026-11-05T00:00:00.000Z', last: '2026-11-05T00:01:00.000Z' }])
  })
})

describe('tradeTime', () => {
  const now = Date.parse('2026-11-05T07:00:00Z')
  it('uses korea_date/korea_hour for US ticks and today + bsop_hour for KR ticks', () => {
    expect(tradeTime({ korea_date: '20261106', korea_hour: '003001' }, now).toISOString()).toBe('2026-11-05T15:30:01.000Z')
    expect(tradeTime({ bsop_hour: '153000' }, now).toISOString()).toBe('2026-11-05T06:30:00.000Z')
    expect(tradeTime({}, now).getTime()).toBe(now)
  })
})
