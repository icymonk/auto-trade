import { describe, expect, it } from 'vitest'
import { MERITZ_BASE_URL, MeritzApiError, MeritzClient, MeritzFeed, MeritzMarketClock, parseMeritzSymbol } from './meritz.ts'

type Handler = (url: URL, init: RequestInit) => Response
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function client(handlers: Handler[]) {
  const calls: { url: URL, init: RequestInit }[] = []
  const fetchFn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    if (url.pathname === '/oauth2/token') return json({ access_token: 'tok', token_type: 'Bearer', expires_in: '43200', scope: 'login' })
    const h = handlers.shift()
    if (!h) throw new Error(`unexpected ${url}`)
    return h(url, init)
  }) as typeof fetch
  const c = new MeritzClient({ appKey: 'key', appSecret: 'secret', macAddress: 'aa:bb:cc:dd:ee:ff', fetch: fetchFn, sleep: async () => {} })
  return { c, calls }
}
const headers = (init: RequestInit) => init.headers as Record<string, string>

describe('MeritzClient', () => {
  it('issues a token with scope=login and sends bearer + mac_address headers', async () => {
    const { c, calls } = client([() => json({ data: { stck_prpr: 72000 }, rsp_cd: '0000' })])
    await c.getDomesticPrice('005930')
    const tokenBody = new URLSearchParams(String(calls[0]!.init.body))
    expect(tokenBody.get('scope')).toBe('login')
    expect(tokenBody.get('client_id')).toBe('key')
    expect(headers(calls[1]!.init).authorization).toBe('Bearer tok')
    expect(headers(calls[1]!.init).mac_address).toBe('AABBCCDDEEFF')
    expect(calls[1]!.url.origin).toBe(new URL(MERITZ_BASE_URL).origin)
    expect(calls[1]!.url.searchParams.get('mrkt_div_code')).toBe('J')
  })

  it('reuses the token', async () => {
    const { c, calls } = client([() => json({ data: [] }), () => json({ data: [] })])
    await c.getHoldings()
    await c.getHoldings()
    expect(calls.filter(x => x.url.pathname === '/oauth2/token')).toHaveLength(1)
  })

  it('retries on EGW00200 (rate limit)', async () => {
    const { c } = client([() => json({ rsp_cd: 'EGW00200', rsp_msg: '초당 거래건수 초과' }, 500), () => json({ data: [] })])
    expect(await c.getHoldings()).toEqual({ data: [] })
  })

  it('raises MeritzApiError with rsp_cd', async () => {
    const { c } = client([() => json({ rsp_cd: 'EGW00103', rsp_msg: '유효하지 않은 client_id입니다.' }, 500)])
    const err = await c.getHoldings().catch(e => e)
    expect(err).toBeInstanceOf(MeritzApiError)
    expect(err.code).toBe('EGW00103')
  })

  it('raises on a token error', async () => {
    const fetchFn = (async () => json({ rsp_cd: 'EGW00103', rsp_msg: 'bad' }, 403)) as unknown as typeof fetch
    const c = new MeritzClient({ appKey: 'k', appSecret: 's', macAddress: 'AABBCCDDEEFF', fetch: fetchFn })
    await expect(c.issueToken()).rejects.toThrow('EGW00103')
  })
})

describe('MeritzFeed', () => {
  it('maps KR and US quotes and USD/KRW', async () => {
    const { c, calls } = client([
      () => json({ data: { stck_prpr: 72000 } }),
      () => json({ data: { prpr: '326.5700', crnc_code: 'USD' } }),
      () => json({ data: [{ iscd: 'USDKRWSMBS', prpr: 1322.1 }] }),
    ])
    const feed = new MeritzFeed(c)
    const [kr, us] = await feed.quotes(['005930', 'AAPL.OQ'])
    expect(kr!.price.toString()).toBe('72000')
    expect(kr!.currency).toBe('KRW')
    expect(us!.symbol).toBe('AAPL.OQ')
    expect(us!.price.toString()).toBe('326.57')
    expect(us!.currency).toBe('USD')
    expect(calls[2]!.url.searchParams.get('mrkt_cls_code')).toBe('OQ')
    expect(calls[2]!.url.searchParams.get('iscd')).toBe('AAPL')
    expect((await feed.usdKrw()).toString()).toBe('1322.1')
  })

  it('rejects an empty price for an unknown symbol', async () => {
    const { c } = client([() => json({ data: { stck_prpr: 0 }, rsp_cd: '0000' })])
    await expect(new MeritzFeed(c).quotes(['999999'])).rejects.toThrow('no price')
  })

  it('requires an exchange suffix for US symbols', () => {
    expect(() => parseMeritzSymbol('AAPL')).toThrow('AAPL.OQ')
    expect(parseMeritzSymbol('TSLA.OQ')).toEqual({ market: 'US', code: 'TSLA', exchange: 'OQ' })
  })
})

describe('MeritzMarketClock', () => {
  const days = { data: { tday_bsdy: '20261105', sta_hour: '090000', fin_hour: '153000' } }

  it('KR is open only on a business day during regular hours (KST)', async () => {
    const { c, calls } = client([() => json(days)])
    const clock = new MeritzMarketClock(c)
    expect(await clock.isOpen('KR', new Date('2026-11-05T01:00:00Z'))).toBe(true) // 10:00 KST
    expect(await clock.isOpen('KR', new Date('2026-11-05T07:00:00Z'))).toBe(false) // 16:00 KST
    expect(calls.filter(x => x.url.pathname === '/reference/v1/market-days')).toHaveLength(1)
  })

  it('KR is closed when today is not the business day', async () => {
    const { c } = client([() => json({ data: { ...days.data, tday_bsdy: '20261109' } })])
    expect(await new MeritzMarketClock(c).isOpen('KR', new Date('2026-11-07T01:00:00Z'))).toBe(false)
  })

  it('US follows the live session code', async () => {
    const { c } = client([
      () => json({ data: { ovrs_mkop_cls_code: '004', mrkt_begn_time: '2330', mrkt_fin_time: '0600' } }),
      () => json({ data: { ovrs_mkop_cls_code: '012', mrkt_begn_time: '0000', mrkt_fin_time: '0000' } }),
    ])
    const clock = new MeritzMarketClock(c, 0)
    expect(await clock.isOpen('US', new Date())).toBe(true)
    expect(await clock.isOpen('US', new Date())).toBe(false)
  })
})
