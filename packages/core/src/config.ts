import { Decimal } from 'decimal.js'

function env(name: string, fallback: string): string {
  const v = process.env[name]?.trim()
  return v ? v : fallback
}

export type BrokerName = 'meritz' | 'toss'

export interface Settings {
  broker: BrokerName
  meritzFeed: 'ws' | 'rest'
  dryRun: boolean
  symbols: string[]
  pollSeconds: number
  orderBudgetKrw: Decimal
  maxOrderKrw: Decimal
  maxDailyLossKrw: Decimal
  maxOrdersPerDay: number
  dbPath: string
  killSwitchPath: string
  strategy: string
  smaShort: number
  smaLong: number
}

export function settingsFromEnv(): Settings {
  const broker = env('BROKER', 'meritz').toLowerCase()
  if (broker !== 'meritz' && broker !== 'toss') throw new Error(`BROKER must be meritz or toss: ${broker}`)
  const meritzFeed = env('MERITZ_FEED', 'ws').toLowerCase()
  if (meritzFeed !== 'ws' && meritzFeed !== 'rest') throw new Error(`MERITZ_FEED must be ws or rest: ${meritzFeed}`)
  return {
    broker,
    meritzFeed,
    dryRun: !['false', '0', 'no'].includes(env('DRY_RUN', 'true').toLowerCase()),
    symbols: env('SYMBOLS', '005930').split(',').map(s => s.trim()).filter(Boolean),
    pollSeconds: Number(env('POLL_SECONDS', '10')),
    orderBudgetKrw: new Decimal(env('ORDER_BUDGET_KRW', '100000')),
    maxOrderKrw: new Decimal(env('MAX_ORDER_KRW', '200000')),
    maxDailyLossKrw: new Decimal(env('MAX_DAILY_LOSS_KRW', '50000')),
    maxOrdersPerDay: Number(env('MAX_ORDERS_PER_DAY', '10')),
    dbPath: env('DB_PATH', 'data/bot.sqlite3'),
    killSwitchPath: env('KILL_SWITCH_PATH', 'data/KILL'),
    strategy: env('STRATEGY', 'sma'),
    smaShort: Number(env('SMA_SHORT', '5')),
    smaLong: Number(env('SMA_LONG', '20')),
  }
}
