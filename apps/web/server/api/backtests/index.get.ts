import { defineHandler } from 'nitro/h3'
import { useBacktestStore } from '../../utils/backtests'

export default defineHandler(() =>
  useBacktestStore().runs(50).map(r => ({
    id: r.id,
    createdAt: r.createdAt,
    params: r.params,
    results: r.results.map(({ equity: _e, trades: _t, ...rest }) => rest),
  })),
)
