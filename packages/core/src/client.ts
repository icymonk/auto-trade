export const BASE_URL = 'https://openapi.tossinvest.com'

export class TossApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly requestId?: string,
  ) {
    super(`[${status}] ${code}: ${detail} (requestId=${requestId ?? '-'})`)
  }
}

export interface TossClientOptions {
  clientId?: string
  clientSecret?: string
  accountSeq?: number
  baseUrl?: string
  timeoutMs?: number
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

type Query = Record<string, string | undefined>

export class TossClient {
  readonly clientId: string
  readonly clientSecret: string
  accountSeq?: number
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private token?: { accessToken: string, expiresAt: number }

  constructor(opts: TossClientOptions = {}) {
    const clientId = opts.clientId ?? process.env.TOSS_CLIENT_ID
    const clientSecret = opts.clientSecret ?? process.env.TOSS_CLIENT_SECRET
    if (!clientId || !clientSecret) throw new Error('TOSS_CLIENT_ID / TOSS_CLIENT_SECRET are required')
    this.clientId = clientId
    this.clientSecret = clientSecret
    const envSeq = process.env.TOSS_ACCOUNT_SEQ
    this.accountSeq = opts.accountSeq ?? (envSeq ? Number(envSeq) : undefined)
    this.baseUrl = (opts.baseUrl ?? BASE_URL).replace(/\/$/, '')
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
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const body = await readJson(resp)
    if (resp.status !== 200) {
      throw new TossApiError(
        resp.status,
        String(body.error ?? 'unknown'),
        String(body.error_description ?? ''),
        resp.headers.get('X-Request-Id') ?? undefined,
      )
    }
    this.token = {
      accessToken: String(body.access_token),
      expiresAt: Date.now() + Number(body.expires_in) * 1000,
    }
    return this.token
  }

  private async accessToken() {
    if (!this.token || Date.now() >= this.token.expiresAt - 60_000) await this.issueToken()
    return this.token!.accessToken
  }

  async request<T = any>(
    method: string,
    path: string,
    opts: { query?: Query, body?: unknown, account?: boolean, maxRetries?: number } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.accessToken()}` }
    if (opts.account) {
      if (this.accountSeq === undefined) throw new Error('accountSeq is required for account/order APIs')
      headers['X-Tossinvest-Account'] = String(this.accountSeq)
    }
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v)

    const maxRetries = opts.maxRetries ?? 3
    let resp: Response
    for (let attempt = 0; ; attempt++) {
      resp = await this.fetchFn(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (resp.status === 429 && attempt < maxRetries) {
        const retryAfter = Number(resp.headers.get('Retry-After'))
        await this.sleep((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2 ** attempt) * 1000)
        continue
      }
      break
    }

    const body = await readJson(resp)
    if (!resp.ok) {
      const err = typeof body.error === 'object' && body.error ? body.error : { code: body.error, message: body.error_description }
      throw new TossApiError(
        resp.status,
        String(err.code ?? 'unknown'),
        String(err.message ?? ''),
        err.requestId ?? resp.headers.get('X-Request-Id') ?? undefined,
      )
    }
    return ('result' in body ? body.result : body) as T
  }

  // Market data / info (token only)
  getStocks(symbols: string[]) {
    return this.request('GET', '/api/v1/stocks', { query: { symbols: symbols.join(',') } })
  }

  getPrices(symbols: string[]) {
    return this.request<PriceItem[]>('GET', '/api/v1/prices', { query: { symbols: symbols.join(',') } })
  }

  getMarketCalendar(market: 'KR' | 'US' = 'KR', date?: string) {
    return this.request('GET', `/api/v1/market-calendar/${market}`, { query: { date } })
  }

  getExchangeRate(base = 'USD', quote = 'KRW') {
    return this.request<{ rate: string }>('GET', '/api/v1/exchange-rate', {
      query: { baseCurrency: base, quoteCurrency: quote },
    })
  }

  // Account / asset (token + account header)
  getAccounts() {
    return this.request<{ accountSeq: number }[]>('GET', '/api/v1/accounts')
  }

  getHoldings(symbol?: string) {
    return this.request('GET', '/api/v1/holdings', { account: true, query: { symbol } })
  }

  getBuyingPower(currency = 'KRW') {
    return this.request('GET', '/api/v1/buying-power', { account: true, query: { currency } })
  }
}

export interface PriceItem {
  symbol: string
  lastPrice: string
  currency: 'KRW' | 'USD'
  timestamp?: string | null
}

async function readJson(resp: Response): Promise<Record<string, any>> {
  try {
    const data = await resp.json()
    return data && typeof data === 'object' && !Array.isArray(data) ? data : { result: data }
  }
  catch {
    return {}
  }
}
