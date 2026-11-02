// fetch wrapper for api.spotify.com: adds the bearer token, refreshes it once on a 401, and
// holds every request back after a 429 until Spotify's Retry-After has passed.
import { MESSAGES, SpotifyError } from '../../src/backend.mjs'

const API = 'https://api.spotify.com/v1'
const TIMEOUT_MS = 10_000
const QUOTA_PAUSE_MS = 5 * 60_000
const MAX_BACKOFF_MS = 60_000

export function createClient({ auth, fetchImpl = globalThis.fetch, now = Date.now }) {
  let blockedUntil = 0
  let blockedError = null
  let backoffMs = 1000 // doubles on each 429 that has no Retry-After

  const send = async (method, url, body, token) => {
    try {
      return await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch (error) {
      throw new SpotifyError('error', `Could not reach Spotify: ${error?.message ?? error}`)
    }
  }

  const readJson = async (response) => {
    const text = await response.text().catch(() => '')
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  const rateLimited = ({ message, quota }) =>
    new SpotifyError('rate-limited', message, { retryAfterMs: blockedUntil - now(), quota })

  // Holds every request back for `ms`; the error to throw now and for each held request.
  const block = (ms, reason) => {
    blockedUntil = now() + ms
    blockedError = reason
    return rateLimited(reason)
  }

  // Resolves to the parsed body, or null for 204 and empty answers.
  async function request(method, path, { query, body } = {}) {
    if (now() < blockedUntil) throw rateLimited(blockedError)
    const url = new URL(API + path)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    }

    let response = await send(method, url.toString(), body, await auth.getAccessToken())
    if (response.status === 401) {
      response = await send(method, url.toString(), body, await auth.getAccessToken({ force: true }))
      if (response.status === 401) {
        await auth.expire()
        throw new SpotifyError('unauthenticated', MESSAGES.unauthenticated)
      }
    }
    if (response.ok) {
      backoffMs = 1000
      return response.status === 204 ? null : readJson(response)
    }

    const error = (await readJson(response))?.error ?? {}
    const reason = typeof error === 'object' ? error.reason : undefined
    const detail = typeof error === 'object' ? error.message : String(error)

    if (response.status === 429) {
      if (reason === 'QUOTA_EXCEEDED') throw block(QUOTA_PAUSE_MS, { message: MESSAGES.quota, quota: true })
      const seconds = Number(response.headers?.get?.('retry-after'))
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
      const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : backoffMs
      throw block(ms, { message: MESSAGES.rateLimited })
    }
    if (response.status === 404 && (reason === 'NO_ACTIVE_DEVICE' || /no active device/i.test(detail ?? ''))) {
      throw new SpotifyError('no-device', MESSAGES.noDevice)
    }
    if (response.status === 403) {
      // Spotify also answers 403 for actions the current playback forbids (skipping an ad,
      // seeking a live stream). Those say so; everything else is Premium or the user list.
      if (/restriction/i.test(detail ?? '')) throw new SpotifyError('error', `Spotify refused: ${detail}`)
      throw new SpotifyError('forbidden', MESSAGES.premium)
    }
    throw new SpotifyError('error', `Spotify answered ${response.status}${detail ? `: ${detail}` : ''}`)
  }

  return { request }
}
