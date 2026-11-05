import { resolve } from 'node:path'
import { KillSwitch, Ledger } from '@toss-autotrade/core'
import { useRuntimeConfig } from 'nitro/runtime-config'

let ledger: Ledger | undefined

export function useLedger() {
  ledger ??= new Ledger(resolve(useRuntimeConfig().dbPath as string))
  return ledger
}

export function useKillSwitch() {
  return new KillSwitch(resolve(useRuntimeConfig().killSwitchPath as string))
}
