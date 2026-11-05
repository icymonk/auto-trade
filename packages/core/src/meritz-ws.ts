import { Decimal } from 'decimal.js'
import type { PriceFeed } from './feed.ts'
import type { MeritzClient } from './meritz.ts'
import { MeritzFeed, parseMeritzSymbol } from './meritz.ts'
import type { Quote } from './models.ts'

const SERVER_NOT_READY = 'WSC00113'

export const MERITZ_WS_URL = 'wss://openapi.imeritz.com:29443/websocket'

/** KRX trades for KR stocks, regular-session trades for US stocks. */
export function subscriptionOf(symbol: string): { tr_cd: string, tr_key: string } {
  const s = parseMeritzSymbol(symbol)
  return s.market === 'KR'
    ? { tr_cd: 'ohhts_stck_cntg', tr_key: s.code }
    : { tr_cd: 'ohhts_exst_cntg', tr_key: `${s.exchange}@${s.code}` }
}

type WebSocketLike = Pick<WebSocket, 'send' | 'close' | 'readyState'> & {
  onopen: ((ev: any) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: any) => void) | null
  onerror: ((ev: any) => void) | null
  binaryType?: string
}

export interface MeritzStreamOptions {
  url?: string
  /** Quotes older than this fall back to a REST price. */
  staleMs?: number
  createSocket?: (url: string) => WebSocketLike
  now?: () => number
  log?: (msg: string) => void
  reconnectDelayMs?: (attempt: number) => number
}

/**
 * Real-time prices over the Meritz WebSocket. Keeps the latest trade per symbol;
 * symbols with no fresh trade (quiet stock, disconnected) are priced via REST instead.
 * Reconnects with backoff and re-subscribes.
 */
export class MeritzStreamFeed implements PriceFeed {
  private readonly rest: MeritzFeed
  private readonly url: string
  private readonly staleMs: number
  private readonly createSocket: (url: string) => WebSocketLike
  private readonly now: () => number
  private readonly log: (msg: string) => void
  private readonly reconnectDelayMs: (attempt: number) => number
  private readonly latest = new Map<string, { price: Decimal, at: number }>()
  private readonly symbolByKey = new Map<string, string>()
  private ws?: WebSocketLike
  private attempt = 0
  private retries = 0
  private closed = false
  private timer?: ReturnType<typeof setTimeout>

  constructor(private readonly client: MeritzClient, opts: MeritzStreamOptions = {}) {
    this.rest = new MeritzFeed(client)
    this.url = opts.url ?? process.env.MERITZ_WS_URL ?? MERITZ_WS_URL
    this.staleMs = opts.staleMs ?? 60_000
    this.createSocket = opts.createSocket ?? (url => new WebSocket(url) as unknown as WebSocketLike)
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? (msg => console.log(`[meritz-ws] ${msg}`))
    this.reconnectDelayMs = opts.reconnectDelayMs ?? (n => Math.min(30_000, 1000 * 2 ** n))
  }

  get connected() {
    return this.ws?.readyState === 1
  }

  start(symbols: string[]) {
    for (const symbol of symbols) {
      const { tr_cd, tr_key } = subscriptionOf(symbol)
      this.symbolByKey.set(`${tr_cd}|${tr_key}`, symbol)
    }
    this.closed = false
    this.connect()
  }

  close() {
    this.closed = true
    clearTimeout(this.timer)
    this.ws?.close()
  }

  async quotes(symbols: string[]): Promise<Quote[]> {
    const now = this.now()
    const out: Quote[] = []
    const stale: string[] = []
    for (const symbol of symbols) {
      const hit = this.latest.get(symbol)
      if (hit && now - hit.at < this.staleMs) {
        out.push({ symbol, price: hit.price, currency: parseMeritzSymbol(symbol).market === 'KR' ? 'KRW' : 'USD', timestamp: new Date(hit.at) })
      }
      else {
        stale.push(symbol)
      }
    }
    if (stale.length) out.push(...await this.rest.quotes(stale))
    return symbols.map(s => out.find(q => q.symbol === s)!)
  }

  usdKrw() {
    return this.rest.usdKrw()
  }

  /** Feed a raw WebSocket message (exposed for tests). */
  handle(raw: string) {
    let msg: any
    try {
      msg = JSON.parse(raw)
    }
    catch {
      return
    }
    const code = msg?.header?.rsp_cd ?? msg?.rsp_cd
    if (code !== undefined) {
      if (code === '00000') return
      this.log(`subscription error ${code}: ${msg?.header?.rsp_msg ?? msg?.rsp_msg ?? ''}`)
      // WSC00113 "서버 연결 대기 중": the session was not ready yet; acks carry no tr_key, so resend all.
      if (code === SERVER_NOT_READY && this.retries++ < 5) {
        clearTimeout(this.timer)
        this.timer = setTimeout(() => this.subscribeAll(), 1000)
      }
      return
    }
    const { tr_cd, tr_key } = msg?.header ?? {}
    const symbol = this.symbolByKey.get(`${tr_cd}|${tr_key}`)
    const body = msg?.body
    if (!symbol || !body?.prpr) return
    // KR: hour_cls_code "0" is a real trade; other values are expected (indicative) prices.
    if (body.hour_cls_code !== undefined && body.hour_cls_code !== '0') return
    const price = new Decimal(body.prpr)
    if (price.isFinite() && price.gt(0)) this.latest.set(symbol, { price, at: this.now() })
  }

  private async subscribeAll() {
    const ws = this.ws
    if (!ws || this.closed) return
    try {
      const token = `Bearer ${await this.client.accessToken()}`
      for (const key of this.symbolByKey.keys()) {
        const [tr_cd, tr_key] = key.split('|')
        ws.send(JSON.stringify({ header: { token, tr_type: '1' }, body: { tr_cd, tr_key } }))
      }
      this.log(`connected, subscribed ${this.symbolByKey.size} symbol(s)`)
    }
    catch (e) {
      this.log(`subscribe failed: ${e instanceof Error ? e.message : String(e)}`)
      ws.close()
    }
  }

  private connect() {
    if (this.closed) return
    const ws = this.createSocket(this.url)
    this.ws = ws
    ws.binaryType = 'arraybuffer'
    ws.onopen = async () => {
      this.attempt = 0
      this.retries = 0
      await this.subscribeAll()
    }
    ws.onmessage = (ev) => {
      const data = ev.data
      this.handle(typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8'))
    }
    ws.onerror = () => {}
    ws.onclose = (ev) => {
      if (this.ws !== ws || this.closed) return
      const delay = this.reconnectDelayMs(this.attempt++)
      this.log(`closed (${ev?.code ?? '-'}), reconnecting in ${delay}ms`)
      this.timer = setTimeout(() => this.connect(), delay)
    }
  }
}
