import { describe, expect, it } from 'vitest'
import { BASE_URL, TossApiError, TossClient } from './client.ts'

type Handler = (url: URL, init: RequestInit) => Response
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

function client(handlers: Handler[]) {
  const calls: { url: URL, init: RequestInit }[] = []
  const fetchFn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    if (url.pathname === '/oauth2/token') return json({ access_token: 'tok', token_type: 'Bearer', expires_in: 86400 })
    const h = handlers.shift()
    if (!h) throw new Error(`unexpected ${url}`)
    return h(url, init)
  }) as typeof fetch
  return { c: new TossClient({ clientId: 'id', clientSecret: 'secret', fetch: fetchFn, sleep: async () => {} }), calls }
}

describe('TossClient', () => {
  it('sends the bearer token and unwraps result', async () => {
    const { c, calls } = client([() => json({ result: [{ symbol: '005930', lastPrice: '72000', currency: 'KRW' }] })])
    const prices = await c.getPrices(['005930'])
    expect(prices[0]!.lastPrice).toBe('72000')
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(calls[1]!.url.searchParams.get('symbols')).toBe('005930')
    expect(calls[1]!.url.origin).toBe(BASE_URL)
  })

  it('reuses the token', async () => {
    const { c, calls } = client([() => json({ result: [] }), () => json({ result: [] })])
    await c.getAccounts()
    await c.getAccounts()
    expect(calls.filter(x => x.url.pathname === '/oauth2/token')).toHaveLength(1)
  })

  it('requires accountSeq for account APIs and sends the header', async () => {
    const { c, calls } = client([() => json({ result: [] })])
    await expect(c.getHoldings()).rejects.toThrow('accountSeq')
    c.accountSeq = 3
    await c.getHoldings()
    expect((calls.at(-1)!.init.headers as Record<string, string>)['X-Tossinvest-Account']).toBe('3')
  })

  it('retries on 429', async () => {
    const { c } = client([() => json({}, 429, { 'Retry-After': '1' }), () => json({ result: [] })])
    expect(await c.getAccounts()).toEqual([])
  })

  it('raises TossApiError with the error code', async () => {
    const { c } = client([() => json({ error: { code: 'ip-not-allowed', message: '허용되지 않은 IP', requestId: 'r1' } }, 403)])
    const err = await c.getAccounts().catch(e => e)
    expect(err).toBeInstanceOf(TossApiError)
    expect(err.code).toBe('ip-not-allowed')
    expect(err.requestId).toBe('r1')
  })

  it('raises on a token error', async () => {
    const fetchFn = (async () => json({ error: 'invalid_client', error_description: 'bad' }, 401)) as unknown as typeof fetch
    const c = new TossClient({ clientId: 'id', clientSecret: 's', fetch: fetchFn })
    await expect(c.issueToken()).rejects.toMatchObject({ status: 401, code: 'invalid_client' })
  })
})
