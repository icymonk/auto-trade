import type { TossClient } from './client.ts'
import { kstDate } from './models.ts'

type Window = { startTime: string, endTime: string } | null | undefined

function regularWindow(day: any): [Date, Date] | null {
  const sessions = day && 'integrated' in day ? day.integrated : day
  const regular: Window = sessions?.regularMarket
  if (!regular) return null
  return [new Date(regular.startTime), new Date(regular.endTime)]
}

/** True if `now` is in the regular session of today or the previous business day (US crosses midnight KST). */
export function isRegularSession(calendar: any, now: Date): boolean {
  for (const key of ['today', 'previousBusinessDay']) {
    const w = regularWindow(calendar?.[key])
    if (w && w[0] <= now && now < w[1]) return true
  }
  return false
}

export interface MarketClockLike {
  isOpen(market: 'KR' | 'US', now: Date): Promise<boolean>
}

export class MarketClock implements MarketClockLike {
  private cache = new Map<string, unknown>()

  constructor(private readonly client: TossClient) {}

  async isOpen(market: 'KR' | 'US', now: Date) {
    const key = `${market}:${kstDate(now)}`
    if (!this.cache.has(key)) {
      for (const k of this.cache.keys()) if (k.startsWith(`${market}:`)) this.cache.delete(k)
      this.cache.set(key, await this.client.getMarketCalendar(market))
    }
    return isRegularSession(this.cache.get(key), now)
  }
}

export class AlwaysOpen implements MarketClockLike {
  async isOpen() {
    return true
  }
}
