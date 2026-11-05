import { describe, expect, it } from 'vitest'
import { MeritzClient } from './meritz.ts'
import { MeritzStreamFeed, subscriptionOf } from './meritz-ws.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

class FakeSocket {
  readyState = 0
  sent: any[] = []
  onopen: ((ev: any) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: any) => void) | null = null
  onerror: ((ev: any) => void) | null = null
  binaryType?: string
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }) }
  open() { this.readyState = 1; this.onopen?.({}) }
  push(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }) }
}

function setup(restPrices: Record<string, number> = {}) {
  const rest: string[] = []
  const fetchFn = (async (input: string | URL) => {
    const url = new URL(String(input))
    if (url.pathname === '/oauth2/token') return json({ access_token: 'tok', expires_in: 43200 })
    const code = url.searchParams.get('iscd')!
    rest.push(code)
    return json({ data: { stck_prpr: restPrices[code] ?? 0 } })
  }) as typeof fetch
  const client = new MeritzClient({ appKey: 'k', appSecret: 's', macAddress: 'AABBCCDDEEFF', fetch: fetchFn })
  const sockets: FakeSocket[] = []
  let now = 1_000_000
  const feed = new MeritzStreamFeed(client, {
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s as any },
    now: () => now,
    log: () => {},
    reconnectDelayMs: () => 0,
  })
  return { feed, sockets, rest, tick: (ms: number) => { now += ms } }
}

const tick = (tr_key: string, prpr: string, hour_cls_code = '0') =>
  ({ header: { tr_cd: 'ohhts_stck_cntg', tr_key }, body: { shrn_iscd: tr_key, hour_cls_code, prpr } })

describe('MeritzStreamFeed', () => {
  it('maps symbols to subscription codes', () => {
    expect(subscriptionOf('005930')).toEqual({ tr_cd: 'ohhts_stck_cntg', tr_key: '005930' })
    expect(subscriptionOf('AAPL.OQ')).toEqual({ tr_cd: 'ohhts_exst_cntg', tr_key: 'OQ@AAPL' })
  })

  it('subscribes every symbol with the bearer token on open', async () => {
    const { feed, sockets } = setup()
    feed.start(['005930', 'AAPL.OQ'])
    sockets[0]!.open()
    await new Promise(r => setTimeout(r, 0))
    expect(sockets[0]!.sent).toEqual([
      { header: { token: 'Bearer tok', tr_type: '1' }, body: { tr_cd: 'ohhts_stck_cntg', tr_key: '005930' } },
      { header: { token: 'Bearer tok', tr_type: '1' }, body: { tr_cd: 'ohhts_exst_cntg', tr_key: 'OQ@AAPL' } },
    ])
  })

  it('serves the latest streamed trade and ignores acks and expected prices', async () => {
    const { feed, sockets, rest } = setup()
    feed.start(['005930'])
    sockets[0]!.push({ header: { tr_type: '1', tr_cd: 'ohhts_stck_cntg', rsp_cd: '00000', rsp_msg: '정상처리되었습니다' }, body: {} })
    sockets[0]!.push(tick('005930', '203500'))
    sockets[0]!.push(tick('005930', '210000', 'B'))
    const [q] = await feed.quotes(['005930'])
    expect(q!.price.toString()).toBe('203500')
    expect(q!.currency).toBe('KRW')
    expect(rest).toEqual([])
  })

  it('falls back to REST when the streamed price is stale or missing', async () => {
    const { feed, sockets, rest, tick: advance } = setup({ '005930': 204000, '000660': 150000 })
    feed.start(['005930', '000660'])
    sockets[0]!.push(tick('005930', '203500'))
    advance(61_000)
    const quotes = await feed.quotes(['005930', '000660'])
    expect(quotes.map(q => q.price.toString())).toEqual(['204000', '150000'])
    expect(rest).toEqual(['005930', '000660'])
  })

  it('resubscribes when the server is not ready yet (WSC00113)', async () => {
    const { feed, sockets } = setup()
    feed.start(['005930'])
    sockets[0]!.open()
    await new Promise(r => setTimeout(r, 0))
    sockets[0]!.push({ header: { tr_type: '1', tr_cd: 'ohhts_stck_cntg', rsp_cd: 'WSC00113', rsp_msg: '서버 연결 대기 중입니다.' }, body: {} })
    await new Promise(r => setTimeout(r, 1100))
    expect(sockets[0]!.sent).toHaveLength(2)
    feed.close()
  })

  it('reconnects after the socket drops, and stops after close()', async () => {
    const { feed, sockets } = setup()
    feed.start(['005930'])
    sockets[0]!.readyState = 3
    sockets[0]!.onclose?.({ code: 1006 })
    await new Promise(r => setTimeout(r, 5))
    expect(sockets).toHaveLength(2)
    feed.close()
    await new Promise(r => setTimeout(r, 5))
    expect(sockets).toHaveLength(2)
  })
})
