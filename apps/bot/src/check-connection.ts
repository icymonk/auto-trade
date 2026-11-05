/** Read-only connectivity check against the selected broker API (BROKER=meritz|toss). Never places orders. */
import { MERITZ_WS_URL, MeritzClient, settingsFromEnv, subscriptionOf, TossClient } from '@auto-trade/core'

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    const result = await fn()
    console.log(`[OK]   ${name}`)
    console.log(`       ${JSON.stringify(result).slice(0, 500)}`)
    return result
  }
  catch (e) {
    console.log(`[FAIL] ${name}: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

function create<T>(make: () => T): T {
  try {
    return make()
  }
  catch (e) {
    console.error(`${e instanceof Error ? e.message : e} (.env 를 확인하세요)`)
    process.exit(1)
  }
}

async function checkMeritz() {
  const client = create(() => new MeritzClient())
  console.log(`broker=meritz mac_address=${client.macAddress}`)
  const token = await step('토큰 발급', async () => ({ valid: Boolean((await client.issueToken()).accessToken) }))
  if (!token) process.exit(1)
  await step('현재가 005930', async () => (await client.getDomesticPrice('005930')).data.stck_prpr)
  await step('현재가 AAPL.OQ', async () => (await client.getOverseasPrice('AAPL', 'OQ')).data.prpr)
  await step('환율 USD/KRW', async () => (await client.getFxPrice()).data[0]?.prpr)
  await step('국내 영업일', async () => (await client.getMarketDays()).data)
  await step('미국 장운영', async () => (await client.getOverseasMarketHours('01')).data)
  await step('실시간 시세 구독 (WebSocket, 005930)', async () => wsSubscribe(await client.accessToken()))
  await step('보유 종목 수', async () => (await client.getHoldings()).data.length)
  await step('주문 가능 현금 (KRW)', async () => (await client.getDeposit()).data.oder_able_cash_amt)
}

/** Subscribes once and resolves on the server's ack; data ticks only arrive while the market trades. */
function wsSubscribe(accessToken: string) {
  return new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(process.env.MERITZ_WS_URL ?? MERITZ_WS_URL)
    const timer = setTimeout(() => { ws.close(); reject(new Error('no ack within 10s')) }, 10_000)
    ws.onopen = () => ws.send(JSON.stringify({ header: { token: `Bearer ${accessToken}`, tr_type: '1' }, body: subscriptionOf('005930') }))
    ws.onerror = () => { clearTimeout(timer); reject(new Error('websocket error')) }
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data))
      const code = msg?.header?.rsp_cd ?? msg?.rsp_cd
      if (code === undefined) return
      clearTimeout(timer)
      ws.close()
      if (code === '00000') resolve(`${code} ${msg.header?.rsp_msg ?? ''}`)
      else reject(new Error(`${code} ${msg?.header?.rsp_msg ?? msg?.rsp_msg ?? ''}`))
    }
  })
}

async function checkToss() {
  const client = create(() => new TossClient())
  console.log('broker=toss')
  const token = await step('토큰 발급', async () => ({ valid: Boolean((await client.issueToken()).accessToken) }))
  if (!token) process.exit(1)
  await step('종목 정보 (005930, AAPL)', () => client.getStocks(['005930', 'AAPL']))
  await step('현재가 (005930, AAPL)', () => client.getPrices(['005930', 'AAPL']))
  await step('환율 USD/KRW', () => client.getExchangeRate())
  await step('국내 장 운영 정보', () => client.getMarketCalendar('KR'))
  const accounts = await step('계좌 목록', () => client.getAccounts())
  if (client.accountSeq === undefined && accounts?.[0]) {
    client.accountSeq = accounts[0].accountSeq
    console.log(`       -> accountSeq=${client.accountSeq} 사용`)
  }
  if (client.accountSeq !== undefined) {
    await step('보유 주식', () => client.getHoldings())
    await step('매수 가능 금액 (KRW)', () => client.getBuyingPower())
  }
}

const { broker } = settingsFromEnv()
await (broker === 'meritz' ? checkMeritz() : checkToss())
