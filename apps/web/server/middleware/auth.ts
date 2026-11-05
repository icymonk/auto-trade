import { timingSafeEqual } from 'node:crypto'
import { defineHandler, HTTPError } from 'nitro/h3'
import { useRuntimeConfig } from 'nitro/runtime-config'

/** Optional HTTP Basic auth (any user name) when NUXT_DASHBOARD_PASSWORD is set. */
export default defineHandler((event) => {
  const password = useRuntimeConfig().dashboardPassword as string
  if (!password) return
  const header = event.req.headers.get('authorization') ?? ''
  const given = header.startsWith('Basic ')
    ? Buffer.from(header.slice(6), 'base64').toString().split(':').slice(1).join(':')
    : ''
  const a = Buffer.from(given)
  const b = Buffer.from(password)
  if (a.length === b.length && timingSafeEqual(a, b)) return
  throw new HTTPError({ status: 401, message: 'Unauthorized', headers: { 'WWW-Authenticate': 'Basic realm="auto-trade"' } })
})
