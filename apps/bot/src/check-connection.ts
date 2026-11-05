/** Read-only connectivity check against the Toss Securities Open API. Never places orders. */
import { TossClient } from '@toss-autotrade/core'

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

let client: TossClient
try {
  client = new TossClient()
}
catch (e) {
  console.error(`${e instanceof Error ? e.message : e} (.env 를 확인하세요)`)
  process.exit(1)
}
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
