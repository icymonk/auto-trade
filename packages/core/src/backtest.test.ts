import { Decimal } from 'decimal.js'
import { describe, expect, it } from 'vitest'
import type { BacktestParams, DailyBar, HistoryProvider } from './backtest.ts'
import { BacktestStore, backtestSymbol, CachedHistory, MeritzHistory, yearChunks } from './backtest.ts'
import { MeritzClient } from './meritz.ts'

const params: BacktestParams = {
  symbols: ['005930'],
  from: '20240101',
  to: '20241231',
  strategy: 'sma',
  smaShort: 2,
  smaLong: 4,
  orderBudgetKrw: '1000000',
  maxOrderKrw: '2000000',
  maxDailyLossKrw: '1000000',
  maxOrdersPerDay: 10,
  feeRate: '0',
  krSellTaxRate: '0',
  usdKrw: '1400',
}

const day = (i: number) => `202401${String(i + 1).padStart(2, '0')}`
const bars = (closes: number[]): DailyBar[] => closes.map((c, i) => {
  const d = new Decimal(c)
  return { date: day(i), open: d, high: d, low: d, close: d, volume: new Decimal(0) }
})

// Down, then up (SMA2 crosses above SMA4 on day 7 -> buy at 100), then down (cross below on day 11 -> sell at 105).
const CLOSES = [100, 98, 96, 94, 92, 95, 100, 110, 120, 115, 105, 95, 90]

describe('backtestSymbol', () => {
  it('replays closes through the bot and reports a round trip', async () => {
    const r = await backtestSymbol('005930', bars(CLOSES), params)
    expect(r.trades.map(t => [t.date, t.side, t.price])).toEqual([
      [day(6), 'BUY', '100'],
      [day(10), 'SELL', '105'],
    ])
    // 1,000,000 / 100 = 10000 shares, +5 each
    expect(r.trades[1]!.pnlKrw).toBe('50000')
    expect(r.metrics.trades).toBe(1)
    expect(r.metrics.winRatePct).toBe('100.0')
    expect(r.metrics.pnlKrw).toBe('50000')
    expect(r.metrics.returnPct).toBe('5.00')
    // buy & hold 10000 shares from 100 to 90
    expect(r.metrics.buyHoldPnlKrw).toBe('-100000')
    expect(r.equity).toHaveLength(CLOSES.length)
    expect(Number(r.metrics.maxDrawdownPct)).toBeGreaterThan(0)
  })

  it('deducts fees and KR sell tax', async () => {
    const r = await backtestSymbol('005930', bars(CLOSES), { ...params, feeRate: '0.001', krSellTaxRate: '0.002' })
    const buy = 10000 * 100 * 0.001
    const sell = 10000 * 105 * (0.001 + 0.002)
    expect(Number(r.metrics.feesKrw)).toBeCloseTo(buy + sell, 0)
    expect(Number(r.trades[1]!.pnlKrw)).toBeCloseTo(50000 - buy - sell, 0)
  })

  it('converts US trades with the fixed USD/KRW and skips sell tax', async () => {
    const r = await backtestSymbol('AAPL.OQ', bars(CLOSES), { ...params, krSellTaxRate: '0.5' })
    expect(r.currency).toBe('USD')
    // 1,000,000 / (100 * 1400) = 7 shares, +5 USD each
    expect(r.trades[1]!.pnlKrw).toBe(String(7 * 5 * 1400))
    expect(r.metrics.feesKrw).toBe('0')
  })

  it('warns when the budget cannot buy one share', async () => {
    const r = await backtestSymbol('005930', bars(CLOSES.map(c => c * 100_000)), params)
    expect(r.trades).toEqual([])
    expect(r.warnings.join('\n')).toMatch(/1주도 살 수 없어요/)
    expect(r.warnings.join('\n')).toMatch(/예산 부족/)
  })

  it('reports risk-blocked orders', async () => {
    const r = await backtestSymbol('005930', bars(CLOSES), { ...params, maxOrderKrw: '1000' })
    expect(r.trades).toEqual([])
    expect(r.warnings.join('\n')).toMatch(/리스크 한도/)
  })
})

describe('history', () => {
  it('splits ranges by calendar year', () => {
    expect(yearChunks('20230315', '20250110')).toEqual([
      ['20230315', '20231231'],
      ['20240101', '20241231'],
      ['20250101', '20250110'],
    ])
  })

  it('maps KR and US candles oldest first', async () => {
    const calls: URL[] = []
    const fetchFn = (async (input: string | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/oauth2/token') return Response.json({ access_token: 't', expires_in: 43200 })
      calls.push(url)
      const data = url.pathname.includes('overseas')
        ? [{ date: '20240103', prpr: '185.5', oprc: '184', hprc: '186', lprc: '183', acml_vol: '10' }]
        : [{ date: '20240103', stck_clpr: 70000 }, { date: '20240102', stck_clpr: 0 }, { date: '20240101', stck_clpr: 69000 }]
      return Response.json({ rsp_cd: '0000', data })
    }) as typeof fetch
    const h = new MeritzHistory(new MeritzClient({ appKey: 'k', appSecret: 's', macAddress: 'AABBCCDDEEFF', fetch: fetchFn }))
    const kr = await h.dailyBars('005930', '20240101', '20240131')
    expect(kr.map(b => [b.date, b.close.toString()])).toEqual([['20240101', '69000'], ['20240103', '70000']])
    expect(calls[0]!.searchParams.get('mrkt_div_code')).toBe('J')
    const us = await h.dailyBars('AAPL.OQ', '20240101', '20240131')
    expect(us[0]!.close.toString()).toBe('185.5')
    expect(calls[1]!.pathname).toBe('/market/v1/overseas/candles/days')
    expect(calls[1]!.searchParams.get('mrkt_cls_code')).toBe('OQ')
  })

  it('caches past years and refetches the current year once a day', async () => {
    const asked: string[] = []
    const inner: HistoryProvider = {
      async dailyBars(_s, from, to) {
        asked.push(`${from}-${to}`)
        return bars([1]).map(b => ({ ...b, date: from }))
      },
    }
    const store = new BacktestStore(':memory:')
    let today = '20250610'
    const h = new CachedHistory(inner, store, () => today)
    await h.dailyBars('005930', '20240101', '20250610')
    expect(asked).toEqual(['20240101-20241231', '20250101-20250610'])
    await h.dailyBars('005930', '20240101', '20250610')
    expect(asked).toHaveLength(2)
    today = '20250611'
    const got = await h.dailyBars('005930', '20240101', '20250611')
    expect(asked).toEqual(['20240101-20241231', '20250101-20250610', '20250101-20250611'])
    expect(got.map(b => b.date)).toEqual(['20240101', '20250101'])
  })

  it('saves and loads runs', () => {
    const store = new BacktestStore(':memory:')
    const id = store.saveRun(params, [])
    expect(store.run(id)?.params.smaLong).toBe(4)
    expect(store.runs().map(r => r.id)).toEqual([id])
  })
})
