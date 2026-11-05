import { defineHandler, getRouterParam, HTTPError } from 'nitro/h3'
import { useBacktestStore } from '../../utils/backtests'

export default defineHandler((event) => {
  const run = useBacktestStore().run(Number(getRouterParam(event, 'id')))
  if (!run) throw new HTTPError({ status: 404, message: 'backtest run not found' })
  return run
})
