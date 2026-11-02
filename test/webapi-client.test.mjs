import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClient } from '../backends/webapi/client.mjs'
import { reply } from './fakes.mjs'

// Auth stand-in: hands out numbered tokens; `force` gives the next one.
function fakeAuth() {
  let n = 1
  const auth = {
    expired: false,
    forced: 0,
    getAccessToken: async ({ force = false } = {}) => {
      if (force) auth.forced++, n++
      return `token-${n}`
    },
    expire: async () => {
      auth.expired = true
    }
  }
  return auth
}

// api.spotify.com stand-in: answers each request with the next queued reply.
function fakeFetch(...replies) {
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? 'GET', auth: init.headers?.authorization, body: init.body })
    const next = replies.shift() ?? reply(204)
    if (next instanceof Error) throw next
    return next
  }
  return { fetchImpl, requests }
}

function setup(replies, { now = () => 0 } = {}) {
  const auth = fakeAuth()
  const api = fakeFetch(...replies)
  const client = createClient({ auth, fetchImpl: api.fetchImpl, now })
  return { auth, api, client }
}

test('sends the bearer token and query, and reads JSON or no content', async () => {
  const { api, client } = setup([reply(200, { is_playing: true }), reply(204)])
  assert.deepEqual(await client.request('GET', '/me/player', { query: { additional_types: 'episode' } }), { is_playing: true })
  assert.equal(await client.request('PUT', '/me/player/play', { body: { uris: ['spotify:track:1'] } }), null)
  assert.equal(api.requests[0].url, 'https://api.spotify.com/v1/me/player?additional_types=episode')
  assert.equal(api.requests[0].auth, 'Bearer token-1')
  assert.equal(api.requests[1].method, 'PUT')
  assert.equal(api.requests[1].body, '{"uris":["spotify:track:1"]}')
})

test('a 401 refreshes the token and retries once', async () => {
  const { api, auth, client } = setup([reply(401, { error: { status: 401 } }), reply(200, { ok: 1 })])
  assert.deepEqual(await client.request('GET', '/me/player'), { ok: 1 })
  assert.equal(auth.forced, 1)
  assert.equal(api.requests[1].auth, 'Bearer token-2')
})

test('a second 401 ends the login', async () => {
  const { auth, client } = setup([reply(401), reply(401)])
  await assert.rejects(client.request('GET', '/me/player'), { kind: 'unauthenticated' })
  assert.equal(auth.expired, true)
})

test('a 429 blocks every request until Retry-After has passed', async () => {
  let time = 0
  const { api, client } = setup([reply(429, undefined, { 'retry-after': '7' }), reply(200, { back: true })], { now: () => time })
  await assert.rejects(client.request('GET', '/me/player'), { kind: 'rate-limited', retryAfterMs: 7000 })
  time = 3000
  await assert.rejects(client.request('GET', '/me/player'), { kind: 'rate-limited', retryAfterMs: 4000 })
  assert.equal(api.requests.length, 1, 'blocked requests never reach Spotify')
  time = 7000
  assert.deepEqual(await client.request('GET', '/me/player'), { back: true })
})

test('an exhausted app quota pauses for 5 minutes with its own message', async () => {
  const { client } = setup([reply(429, { error: { status: 429, message: 'Too many requests', reason: 'QUOTA_EXCEEDED' } })])
  const error = await client.request('GET', '/me/player').catch((e) => e)
  assert.equal(error.kind, 'rate-limited')
  assert.equal(error.retryAfterMs, 5 * 60_000)
  assert.match(error.message, /quota/)
  assert.equal(error.quota, true)
})

test('403 names Premium and the user list; 404 without a device is no-device', async () => {
  const { client } = setup([
    reply(403, { error: { status: 403, message: 'Player command failed: Premium required', reason: 'PREMIUM_REQUIRED' } }),
    reply(404, { error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' } })
  ])
  const forbidden = await client.request('PUT', '/me/player/play').catch((e) => e)
  assert.equal(forbidden.kind, 'forbidden')
  assert.match(forbidden.message, /Premium/)
  assert.match(forbidden.message, /user list/)
  await assert.rejects(client.request('PUT', '/me/player/play'), { kind: 'no-device' })
})

test('a refused action reports Spotify\'s reason', async () => {
  const { client } = setup([reply(403, { error: { status: 403, message: 'Player command failed: Restriction violated', reason: 'UNKNOWN' } })])
  await assert.rejects(client.request('POST', '/me/player/next'), { kind: 'error', message: /Restriction violated/ })
})

test('network failures and other statuses become explanations', async () => {
  const { client } = setup([new TypeError('fetch failed'), reply(500, { error: { status: 500, message: 'Server error' } })])
  await assert.rejects(client.request('GET', '/me/player'), { kind: 'error', message: /Could not reach Spotify/ })
  await assert.rejects(client.request('GET', '/me/player'), { kind: 'error', message: /500.*Server error/ })
})

test('a login without a permission Spotify needs asks for a reconnect', async () => {
  const { client } = setup([reply(403, { error: { status: 403, message: 'Insufficient client scope' } })])
  await assert.rejects(client.request('GET', '/me/tracks'), { kind: 'scope', message: /Reconnect/ })
})

test('something Spotify does not show this app is a not-found', async () => {
  const { client } = setup([reply(404, { error: { status: 404, message: 'Resource not found' } })])
  await assert.rejects(client.request('GET', '/playlists/37i9dQZF1DXcBWIGoYBM5M'), { kind: 'not-found' })
})
