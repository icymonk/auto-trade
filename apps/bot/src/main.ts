/** Dry-run trading bot: orders are recorded in SQLite, never sent to the broker. */
import { parseArgs } from 'node:util'
import {
  AlwaysOpen,
  Bot,
  buildStrategy,
  DryRunBroker,
  Ledger,
  MarketClock,
  MeritzClient,
  MeritzFeed,
  MeritzMarketClock,
  MeritzStreamFeed,
  MinuteBarRecorder,
  RiskManager,
  SimulatedFeed,
  settingsFromEnv,
  TossClient,
  TossFeed,
} from '@auto-trade/core'

const { values: args } = parseArgs({
  options: {
    'simulate': { type: 'boolean', default: false },
    'ignore-market-hours': { type: 'boolean', default: false },
    'steps': { type: 'string' },
    'poll-seconds': { type: 'string' },
  },
})

const settings = settingsFromEnv()
if (!settings.dryRun) {
  console.error('DRY_RUN=false is not supported yet: live orders are not implemented. Refusing to start.')
  process.exit(2)
}

const ledger = new Ledger(settings.dbPath)
let feed, clock
let stream: MeritzStreamFeed | undefined
let recorder: MinuteBarRecorder | undefined
if (args.simulate) {
  feed = new SimulatedFeed()
  clock = new AlwaysOpen()
}
else if (settings.broker === 'meritz') {
  const client = new MeritzClient()
  if (settings.meritzFeed === 'ws') {
    if (settings.recordMinuteBars) recorder = new MinuteBarRecorder(bars => ledger.saveMinuteBars(bars))
    stream = new MeritzStreamFeed(client, { onTrade: recorder && (t => recorder!.onTrade(t)) })
    stream.start(settings.symbols)
    feed = stream
  }
  else {
    feed = new MeritzFeed(client)
  }
  clock = args['ignore-market-hours'] ? new AlwaysOpen() : new MeritzMarketClock(client)
}
else {
  const client = new TossClient()
  feed = new TossFeed(client)
  clock = args['ignore-market-hours'] ? new AlwaysOpen() : new MarketClock(client)
}

const bot = new Bot({
  feed,
  clock,
  strategy: buildStrategy(settings.strategy, settings.smaShort, settings.smaLong),
  broker: new DryRunBroker(ledger),
  ledger,
  risk: new RiskManager(ledger, settings),
  symbols: settings.symbols,
  orderBudgetKrw: settings.orderBudgetKrw,
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => bot.stop())

console.log(
  `starting dry-run bot: broker=${settings.broker}${settings.broker === 'meritz' && !args.simulate ? `/${settings.meritzFeed}` : ''} symbols=${settings.symbols.join(',')} strategy=${settings.strategy} `
  + `simulate=${args.simulate} db=${settings.dbPath} kill_switch=${settings.killSwitchPath}`,
)
await bot.run(
  args['poll-seconds'] !== undefined ? Number(args['poll-seconds']) : settings.pollSeconds,
  args.steps !== undefined ? Number(args.steps) : undefined,
)
stream?.close()
recorder?.flush()
ledger.close()
