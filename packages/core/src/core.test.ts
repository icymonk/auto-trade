import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Decimal } from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { Bot } from './bot.ts'
import { DryRunBroker, newClientOrderId } from './broker.ts'
import type { PriceFeed } from './feed.ts'
import { Ledger } from './ledger.ts'
import { AlwaysOpen, isRegularSession } from './market.ts'
import type { Quote, Side } from './models.ts'
import { RiskManager } from './risk.ts'
import { SmaCrossStrategy, type Strategy } from './strategy.ts'

const NOW = new Date('2026-03-25T10:00:00+09:00')
const quiet = { info() {}, warn() {}, error() {} }

class ListFeed implements PriceFeed {
  constructor(readonly prices: Record<string, string[]>) {}
  async quotes(symbols: string[]): Promise<Quote[]> {
    return symbols.map(s => ({
      symbol: s,
      price: new Decimal(this.prices[s]!.shift()!),
      currency: /^\d+$/.test(s) ? 'KRW' : 'USD',
      timestamp: NOW,
    }))
  }
  async usdKrw() {
    return new Decimal(1400)
  }
}

const scripted = (sides: (Side | null)[]): Strategy => ({
  onQuote: q => {
    const side = sides.shift()
    return side ? { symbol: q.symbol, side, reason: 'test' } : null
  },
})

function makeBot(prices: Record<string, string[]>, strategy: Strategy, limits: Partial<{ maxOrderKrw: number, maxOrdersPerDay: number }> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-'))
  const ledger = new Ledger(':memory:')
  const risk = new RiskManager(ledger, {
    maxOrderKrw: new Decimal(limits.maxOrderKrw ?? 200000),
    maxDailyLossKrw: new Decimal(50000),
    maxOrdersPerDay: limits.maxOrdersPerDay ?? 10,
    killSwitchPath: join(dir, 'KILL'),
  })
  const bot = new Bot({
    feed: new ListFeed(prices),
    clock: new AlwaysOpen(),
    strategy,
    broker: new DryRunBroker(ledger),
    ledger,
    risk,
    symbols: Object.keys(prices),
    orderBudgetKrw: new Decimal(100000),
    now: () => NOW,
    log: quiet,
  })
  return { bot, ledger, risk, dir }
}

describe('Bot (dry-run)', () => {
  it('buys then sells and records realized P&L', async () => {
    const { bot, ledger } = makeBot({ '005930': ['30000', '33000'] }, scripted(['BUY', 'SELL']))
    const [buy] = await bot.step()
    expect(buy!.quantity.toNumber()).toBe(3)
    expect(buy!.mode).toBe('dry-run')
    expect(ledger.position('005930')!.quantity.toNumber()).toBe(3)
    const [sell] = await bot.step()
    expect(sell!.realizedPnlKrw.toNumber()).toBe(9000)
    expect(ledger.position('005930')).toBeNull()
    expect(ledger.realizedPnlKrwOn('2026-03-25').toNumber()).toBe(9000)
    expect(ledger.quotes()[0]!.price).toBe('33000')
    expect(ledger.status()!.mode).toBe('dry-run')
  })

  it('sizes USD symbols in KRW', async () => {
    const { bot } = makeBot({ AAPL: ['20'] }, scripted(['BUY']))
    const [fill] = await bot.step()
    expect(fill!.quantity.toNumber()).toBe(3) // 100000 / (20 * 1400) = 3.57
    expect(fill!.fxRate.toNumber()).toBe(1400)
  })

  it('skips a sell without a position', async () => {
    const { bot } = makeBot({ '005930': ['30000'] }, scripted(['SELL']))
    expect(await bot.step()).toEqual([])
  })

  it('kill switch stops trading', async () => {
    const { bot, ledger, risk } = makeBot({ '005930': ['30000'] }, scripted(['BUY']))
    risk.killSwitch.set(true)
    expect(await bot.step()).toEqual([])
    expect(ledger.buysOn('2026-03-25')).toBe(0)
    risk.killSwitch.set(false)
    expect(risk.killSwitch.isOn()).toBe(false)
  })

  it('blocks a buy above the max order size', async () => {
    const { bot } = makeBot({ '005930': ['30000'] }, scripted(['BUY']), { maxOrderKrw: 50000 })
    expect(await bot.step()).toEqual([])
  })

  it('caps buys per day but still allows sells', async () => {
    const { bot } = makeBot({ '005930': ['30000', '30000', '30000'] }, scripted(['BUY', 'BUY', 'SELL']), { maxOrdersPerDay: 1 })
    expect(await bot.step()).toHaveLength(1)
    expect(await bot.step()).toEqual([])
    const [sell] = await bot.step()
    expect(sell!.side).toBe('SELL')
  })

  it('daily loss limit blocks buys but allows sells', async () => {
    const { bot } = makeBot({ '005930': ['30000', '10000', '10000', '10000'] }, scripted(['BUY', null, 'BUY', 'SELL']))
    await bot.step()
    await bot.step() // unrealized -60000 KRW
    expect(await bot.step()).toEqual([])
    const [sell] = await bot.step()
    expect(sell!.side).toBe('SELL')
  })
})

describe('Ledger', () => {
  const order = {
    clientOrderId: 'x',
    symbol: '005930',
    side: 'BUY' as const,
    quantity: new Decimal(2),
    price: new Decimal(100),
    currency: 'KRW' as const,
    fxRate: new Decimal(1),
    timestamp: NOW,
  }

  it('rejects a duplicate clientOrderId', async () => {
    const broker = new DryRunBroker(new Ledger(':memory:'))
    await broker.submit(order)
    await expect(broker.submit(order)).rejects.toThrow('duplicate')
  })

  it('persists across restarts', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'bot.sqlite3')
    const ledger = new Ledger(path)
    await new DryRunBroker(ledger).submit(order)
    ledger.close()
    expect(new Ledger(path).position('005930')!.quantity.toNumber()).toBe(2)
  })

  it('uses the KST trade date', () => {
    const ledger = new Ledger(':memory:')
    ledger.recordFill({ ...order, mode: 'dry-run', timestamp: new Date('2026-03-25T16:00:00Z') })
    expect(ledger.buysOn('2026-03-26')).toBe(1)
  })
})

it('generates valid clientOrderIds', () => {
  const id = newClientOrderId(NOW)
  expect(id.length).toBeLessThanOrEqual(36)
  expect(id).toMatch(/^[a-zA-Z0-9_-]+$/)
})

it('SMA cross emits a buy', () => {
  const strat = new SmaCrossStrategy(2, 3)
  const q = (p: string): Quote => ({ symbol: '005930', price: new Decimal(p), currency: 'KRW', timestamp: NOW })
  const signals = ['10', '9', '8', '7', '10'].map(p => strat.onQuote(q(p), null))
  expect(signals.slice(0, 4)).toEqual([null, null, null, null])
  expect(signals[4]!.side).toBe('BUY')
})

it('detects KR and US regular sessions', () => {
  const kr = {
    today: { date: '2026-03-25', integrated: { regularMarket: { startTime: '2026-03-25T09:00:00+09:00', endTime: '2026-03-25T15:30:00+09:00' } } },
    previousBusinessDay: { date: '2026-03-24', integrated: null },
  }
  expect(isRegularSession(kr, NOW)).toBe(true)
  expect(isRegularSession(kr, new Date('2026-03-25T16:00:00+09:00'))).toBe(false)
  expect(isRegularSession({ today: { date: '2026-05-05', integrated: null } }, NOW)).toBe(false)
  const us = {
    today: { regularMarket: { startTime: '2026-03-25T22:30:00+09:00', endTime: '2026-03-26T05:00:00+09:00' } },
    previousBusinessDay: { regularMarket: { startTime: '2026-03-24T22:30:00+09:00', endTime: '2026-03-25T05:00:00+09:00' } },
  }
  expect(isRegularSession(us, new Date('2026-03-25T01:00:00+09:00'))).toBe(true)
  expect(isRegularSession(us, NOW)).toBe(false)
})

