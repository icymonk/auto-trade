import { defineHandler, HTTPError, readBody } from 'nitro/h3'
import { useKillSwitch } from '../utils/ledger'

export default defineHandler(async (event) => {
  const body = await readBody<{ on?: unknown }>(event)
  if (typeof body?.on !== 'boolean') throw new HTTPError({ status: 400, message: '`on` must be a boolean' })
  const ks = useKillSwitch()
  ks.set(body.on, 'dashboard')
  return { killSwitch: ks.isOn() }
})
