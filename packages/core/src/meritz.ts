import { networkInterfaces } from 'node:os'
import { Decimal } from 'decimal.js'
import type { PriceFeed } from './feed.ts'
import type { MarketClockLike } from './market.ts'
import type { Quote } from './models.ts'
import { kstDate, marketOf } from './models.ts'

export const MERITZ_BASE_URL = 'https://openapi.imeritz.com:9443'

/** Meritz returns every error as HTTP 500 (or 403 for auth) with `rsp_cd` / `rsp_msg`. */
export class MeritzApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly detail: string) {
    super(`[${status}] ${code}: ${detail}`)
  }
}

export interface MeritzClientOptions {
  appKey?: string
  appSecret?: string
  macAddress?: string
  baseUrl?: string
  timeoutMs?: number
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

const RATE_LIMITED = 'EGW00200'
const US_EXCHANGES = ['OQ', 'NY', 'AX'] as const

/** First non-internal interface MAC as 12 uppercase hex chars (the API requires a `mac_address` header). */
export function detectMacAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list ?? []) {
      if (!nic.internal && nic.mac && nic.mac !== '00:00:00:00:00:00') return nic.mac.replaceAll(':', '').toUpperCase()
    }
  }
  return undefined
}

/** `005930` -> KR stock, `AAPL.OQ` -> US stock on an exchange (OQ Nasdaq, NY NYSE, AX Amex). */
export function parseMeritzSymbol(symbol: string): { market: 'KR', code: string } | { market: 'US', code: string, exchange: string } {
  if (marketOf(symbol) === 'KR') return { market: 'KR', code: symbol }
  const [code, exchange] = symbol.split('.')
  if (!code || !exchange || !(US_EXCHANGES as readonly string[]).includes(exchange)) {
    throw new Error(`메리츠 해외 종목은 거래소 코드를 붙여주세요 (예: AAPL.OQ, OQ 나스닥·NY 뉴욕·AX 아멕스): ${symbol}`)
  }
  return { market: 'US', code, exchange }
}

export class MeritzClient {
  readonly appKey: string
  readonly appSecret: string
  readonly macAddress: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private token?: { accessToken: string, expiresAt: number }

  constructor(opts: MeritzClientOptions = {}) {
    const appKey = opts.appKey ?? process.env.MERITZ_APP_KEY
    const appSecret = opts.appSecret ?? process.env.MERITZ_APP_SECRET
    if (!appKey || !appSecret) throw new Error('MERITZ_APP_KEY / MERITZ_APP_SECRET are required')
    const mac = opts.macAddress ?? (process.env.MERITZ_MAC_ADDRESS?.trim() || detectMacAddress())
    if (!mac) throw new Error('MERITZ_MAC_ADDRESS is required (could not detect a network MAC address)')
    this.appKey = appKey
    this.appSecret = appSecret
    this.macAddress = mac.replace(/[:-]/g, '').toUpperCase()
    this.baseUrl = (opts.baseUrl ?? process.env.MERITZ_BASE_URL ?? MERITZ_BASE_URL).replace(/\/$/, '')
    this.timeoutMs = opts.timeoutMs ?? 10_000
    this.fetchFn = opts.fetch ?? fetch
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  }

  async issueToken() {
    const resp = await this.fetchFn(`${this.baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.appKey,
        client_secret: this.appSecret,
        scope: 'login',
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const body = await readJson(resp)
    if (!resp.ok || !body.access_token) throw apiError(resp.status, body)
    this.token = {
      accessToken: String(body.access_token),
      expiresAt: Date.now() + Number(body.expires_in) * 1000,
    }
    return this.token
  }

  /** Current access token (issued or refreshed as needed); the WebSocket subscription also needs it. */
  async accessToken() {
    if (!this.token || Date.now() >= this.token.expiresAt - 60_000) await this.issueToken()
    return this.token!.accessToken
  }

  async get<T = any>(path: string, query: Record<string, string | undefined> = {}, maxRetries = 3): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v)
    for (let attempt = 0; ; attempt++) {
      const resp = await this.fetchFn(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${await this.accessToken()}`, mac_address: this.macAddress },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      const body = await readJson(resp)
      if (resp.ok) return body as T
      if (body.rsp_cd === RATE_LIMITED && attempt < maxRetries) {
        await this.sleep(2 ** attempt * 1000)
        continue
      }
      throw apiError(resp.status, body)
    }
  }

  getDomesticPrice(code: string) {
    return this.get<{ data: { stck_prpr: number } }>('/market/v1/prices', { mrkt_div_code: 'J', iscd: code })
  }

  getOverseasPrice(code: string, exchange: string) {
    return this.get<{ data: { prpr: string, crnc_code: string } }>('/market/v1/overseas/prices', {
      mrkt_div_code: 'OV',
      mrkt_cls_code: exchange,
      iscd: code,
      dely_rltm_cls_code: '0',
    })
  }

  getFxPrice(pair = 'USDKRWSMBS') {
    return this.get<{ data: { iscd: string, prpr: number }[] }>('/market/v1/overseas/fx/prices', { iscd: pair })
  }

  getMarketDays() {
    return this.get<{ data: { tday_bsdy: string, sta_hour: string, fin_hour: string } }>('/reference/v1/market-days')
  }

  /** `01` = US. `ovrs_mkop_cls_code` "004" means the regular session is open. */
  getOverseasMarketHours(marketCode = '01') {
    return this.get<{ data: { ovrs_mkop_cls_code: string, mrkt_begn_time: string, mrkt_fin_time: string } }>(
      '/reference/v1/overseas/market-hours',
      { ovrs_stck_mrkt_tr_cls_code: marketCode },
    )
  }

  // Account APIs: Meritz keys are issued per account, so no account header is needed.
  getHoldings() {
    return this.get<{ data: unknown[] }>('/accounts/v1/me/holdings')
  }

  getDeposit() {
    return this.get<{ data: { tfam: number, oder_able_cash_amt: number } }>('/accounts/v1/me/deposit')
  }
}

/** Polls current prices and USD/KRW from the Meritz API (read-only). */
export class MeritzFeed implements PriceFeed {
  constructor(private readonly client: MeritzClient) {}

  async quotes(symbols: string[]): Promise<Quote[]> {
    const out: Quote[] = []
    for (const symbol of symbols) {
      const s = parseMeritzSymbol(symbol)
      const price = s.market === 'KR'
        ? new Decimal((await this.client.getDomesticPrice(s.code)).data.stck_prpr)
        : new Decimal((await this.client.getOverseasPrice(s.code, s.exchange)).data.prpr)
      // Unknown codes come back as a "success" with an empty or zero price.
      if (!price.isFinite() || price.lte(0)) throw new Error(`no price for ${symbol} (unknown symbol?)`)
      out.push({ symbol, price, currency: s.market === 'KR' ? 'KRW' : 'USD', timestamp: new Date() })
    }
    return out
  }

  async usdKrw(): Promise<Decimal> {
    const row = (await this.client.getFxPrice('USDKRWSMBS')).data[0]
    if (!row) throw new Error('no USD/KRW rate')
    return new Decimal(row.prpr)
  }
}

const hhmmss = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .format(d)
    .replaceAll(':', '')

/** KR: today must be a business day and within the regular session. US: asks the live session status. */
export class MeritzMarketClock implements MarketClockLike {
  private kr?: { day: string, data: { tday_bsdy: string, sta_hour: string, fin_hour: string } }
  private us?: { at: number, open: boolean }

  constructor(private readonly client: MeritzClient, private readonly usCacheMs = 60_000) {}

  async isOpen(market: 'KR' | 'US', now: Date) {
    if (market === 'KR') {
      const day = kstDate(now)
      if (this.kr?.day !== day) this.kr = { day, data: (await this.client.getMarketDays()).data }
      const { tday_bsdy, sta_hour, fin_hour } = this.kr.data
      const t = hhmmss(now)
      return tday_bsdy === day.replaceAll('-', '') && sta_hour <= t && t < fin_hour
    }
    if (!this.us || now.getTime() - this.us.at >= this.usCacheMs) {
      const { data } = await this.client.getOverseasMarketHours('01')
      this.us = { at: now.getTime(), open: data.ovrs_mkop_cls_code === '004' }
    }
    return this.us.open
  }
}

function apiError(status: number, body: Record<string, any>) {
  const detail = [body.rsp_msg ?? body.error_description, body.rsp_sub_msg].filter(Boolean).join(' / ')
  return new MeritzApiError(status, String(body.rsp_cd ?? body.error ?? 'unknown'), detail)
}

async function readJson(resp: Response): Promise<Record<string, any>> {
  try {
    const data = await resp.json()
    return data && typeof data === 'object' && !Array.isArray(data) ? data : { data }
  }
  catch {
    return {}
  }
}
