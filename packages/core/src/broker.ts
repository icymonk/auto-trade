import { randomUUID } from 'node:crypto'
import type { FillInput, Ledger } from './ledger.ts'
import type { Fill } from './models.ts'

/** Valid Toss clientOrderId: <=36 chars of [A-Za-z0-9_-]. */
export function newClientOrderId(now: Date): string {
  const stamp = now.toISOString().replace(/\D/g, '').slice(0, 14)
  return `bot-${stamp}-${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export interface Broker {
  readonly mode: string
  submit(order: Omit<FillInput, 'mode'>): Promise<Fill>
}

/** Fills every order immediately at the given price and records it locally. Never calls the API. */
export class DryRunBroker implements Broker {
  readonly mode = 'dry-run'

  constructor(private readonly ledger: Ledger) {}

  async submit(order: Omit<FillInput, 'mode'>): Promise<Fill> {
    if (this.ledger.hasOrder(order.clientOrderId)) throw new Error(`duplicate clientOrderId ${order.clientOrderId}`)
    return this.ledger.recordFill({ ...order, mode: this.mode })
  }
}
