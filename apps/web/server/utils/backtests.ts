import { resolve } from 'node:path'
import { BacktestStore } from '@auto-trade/core'
import { useRuntimeConfig } from 'nitro/runtime-config'

let store: BacktestStore | undefined

export function useBacktestStore() {
  store ??= new BacktestStore(resolve(useRuntimeConfig().backtestDbPath as string))
  return store
}
