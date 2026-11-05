import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Decimal } from 'decimal.js'
import type { Ledger } from './ledger.ts'
import type { Side } from './models.ts'

export interface RiskLimits {
  maxOrderKrw: Decimal
  maxDailyLossKrw: Decimal
  maxOrdersPerDay: number
  killSwitchPath: string
}

export interface RiskDecision {
  allowed: boolean
  reason?: string
}

export class KillSwitch {
  constructor(readonly path: string) {}

  isOn() {
    return existsSync(this.path)
  }

  set(on: boolean, note = '') {
    if (on) {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, `${new Date().toISOString()} ${note}\n`)
    }
    else {
      rmSync(this.path, { force: true })
    }
  }
}

/**
 * Kill switch blocks everything. Sells (reducing exposure) are otherwise always allowed;
 * buys are capped per order, per day (count) and stop once today's P&L hits the loss limit.
 */
export class RiskManager {
  readonly killSwitch: KillSwitch

  constructor(readonly ledger: Ledger, readonly limits: RiskLimits) {
    this.killSwitch = new KillSwitch(limits.killSwitchPath)
  }

  dailyPnlKrw(day: string, unrealizedKrw: Decimal): Decimal {
    return this.ledger.realizedPnlKrwOn(day).plus(unrealizedKrw)
  }

  check(o: { side: Side, notionalKrw: Decimal, day: string, unrealizedKrw: Decimal }): RiskDecision {
    if (this.killSwitch.isOn()) return { allowed: false, reason: `kill switch on (${this.limits.killSwitchPath})` }
    if (o.side === 'SELL') return { allowed: true }
    if (this.ledger.buysOn(o.day) >= this.limits.maxOrdersPerDay)
      return { allowed: false, reason: `daily buy limit ${this.limits.maxOrdersPerDay} reached` }
    if (o.notionalKrw.gt(this.limits.maxOrderKrw))
      return { allowed: false, reason: `order ${o.notionalKrw.toFixed(0)} KRW > max ${this.limits.maxOrderKrw} KRW` }
    const pnl = this.dailyPnlKrw(o.day, o.unrealizedKrw)
    if (pnl.lte(this.limits.maxDailyLossKrw.neg()))
      return { allowed: false, reason: `daily P&L ${pnl.toFixed(0)} KRW hit limit -${this.limits.maxDailyLossKrw} KRW` }
    return { allowed: true }
  }
}
