import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { SCOPES, createAuth, listenLoopback } from '../backends/webapi/auth.mjs'
import { fakeSecrets, fakeSettings } from './fakes.mjs'

const CLIENT_ID = '0123456789abcdef0123456789abcdef'
const HOUR = 3600_000

// Token endpoint stand-in: answers each POST with the next queued reply and records the form.
function fakeTokenFetch(...replies) {
  const forms = []
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://accounts.spotify.com/api/token')
    forms.push(Object.fromEntries(new URLSearchParams(String(init.body))))
    const { status = 200, body } = replies.shift() ?? {}
    return { ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }
  }
  return { fetchImpl, forms }
}

const storedTokens = (overrides = {}) =>
  JSON.stringify({
    access_token: 'old-access',
    refresh_token: 'refresh-1',
    expires_at: 10 * HOUR,
    authorized_at: 0,
    scopes: 'user-read-playback-state',
    ...overrides
  })

function setup({ settings = { clientId: CLIENT_ID }, secrets = fakeSecrets(), replies = [], now = () => HOUR, protection = 'os-keyring' } = {}) {
  const token = fakeTokenFetch(...replies)
  const auth = createAuth({
    settings: fakeSettings(settings),
    secrets,
    protection: async () => protection,
    fetchImpl: token.fetchImpl,
    now,
    // An ephemeral port, so tests never clash with a real login on 43117.
    listen: (_port, handle) => listenLoopback(0, handle)
  })
  return { auth, secrets, token }
}

const base64url = (buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

test('login: the authorize URL carries a S256 challenge for the verifier sent with the code', async (t) => {
  const { auth, secrets, token } = setup({
    replies: [{ body: { access_token: 'a1', refresh_token: 'r1', expires_in: 3600, scope: 'user-read-playback-state' } }]
  })
  t.after(() => auth.close())
  const url = new URL((await auth.start()).url)
  assert.equal(url.origin + url.pathname, 'https://accounts.spotify.com/authorize')
  const params = url.searchParams
  assert.equal(params.get('client_id'), CLIENT_ID)
  assert.equal(params.get('response_type'), 'code')
  assert.equal(params.get('code_challenge_method'), 'S256')
  assert.match(params.get('scope'), /user-modify-playback-state/)
  const redirect = new URL(params.get('redirect_uri'))
  assert.equal(redirect.hostname, '127.0.0.1')
  assert.equal(redirect.pathname, '/callback')

  const reply = await fetch(`${redirect}?code=the-code&state=${params.get('state')}`)
  assert.equal(reply.status, 200)
  assert.match(await reply.text(), /Connected/)

  const [form] = token.forms
  assert.equal(form.grant_type, 'authorization_code')
  assert.equal(form.code, 'the-code')
  assert.equal(form.redirect_uri, params.get('redirect_uri'))
  assert.equal(form.client_id, CLIENT_ID)
  assert.equal(base64url(createHash('sha256').update(form.code_verifier).digest()), params.get('code_challenge'))

  assert.equal((await auth.status()).status, 'connected')
  const saved = JSON.parse(secrets.values['spotify.tokens'])
  assert.equal(saved.access_token, 'a1')
  assert.equal(saved.refresh_token, 'r1')
  assert.equal(saved.expires_at, HOUR + 3600_000)
  assert.equal(saved.authorized_at, HOUR)
  assert.equal(await auth.getAccessToken(), 'a1')
  await assert.rejects(fetch(redirect), 'the loopback server closes after the first valid callback')
})

test('login: a callback with the wrong state is refused and the login keeps waiting', async (t) => {
  const { auth, token } = setup()
  t.after(() => auth.close())
  const redirect = new URL(new URL((await auth.start()).url).searchParams.get('redirect_uri'))
  const reply = await fetch(`${redirect}?code=x&state=forged`)
  assert.equal(reply.status, 400)
  assert.equal(token.forms.length, 0)
  assert.equal((await auth.status()).status, 'pending')
})

test('login: the person declining in the browser fails the login', async (t) => {
  const { auth } = setup()
  t.after(() => auth.close())
  const params = new URL((await auth.start()).url).searchParams
  await fetch(`${params.get('redirect_uri')}?error=access_denied&state=${params.get('state')}`)
  const status = await auth.status()
  assert.equal(status.status, 'failed')
  assert.match(status.message, /declined|denied/i)
})

test('login: starting twice reuses the same pending login', async (t) => {
  const { auth } = setup()
  t.after(() => auth.close())
  assert.equal((await auth.start()).url, (await auth.start()).url)
})

test('login needs a Client ID; a new one is saved, a malformed one refused', async (t) => {
  const settings = {}
  const { auth } = setup({ settings })
  t.after(() => auth.close())
  await assert.rejects(auth.start(), { kind: 'needs-setup' })
  await assert.rejects(auth.start({ clientId: 'not a client id!' }), { kind: 'invalid' })
  await auth.start({ clientId: ` ${CLIENT_ID} ` })
  assert.equal(settings.clientId, CLIENT_ID)
})

test('tokens refresh a minute before they expire, once for concurrent callers', async () => {
  const secrets = fakeSecrets({ 'spotify.tokens': storedTokens({ expires_at: HOUR + 30_000 }) })
  const { auth, token } = setup({ secrets, replies: [{ body: { access_token: 'new-access', expires_in: 3600 } }] })
  const [a, b] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()])
  assert.equal(a, 'new-access')
  assert.equal(b, 'new-access')
  assert.equal(token.forms.length, 1)
  assert.deepEqual(token.forms[0], { grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: CLIENT_ID })
  const saved = JSON.parse(secrets.values['spotify.tokens'])
  assert.equal(saved.refresh_token, 'refresh-1', 'keeps the old refresh token when none comes back')
  assert.equal(saved.authorized_at, 0, 'a refresh is not a new login')
})

test('a still-valid token is used as is', async () => {
  const secrets = fakeSecrets({ 'spotify.tokens': storedTokens() })
  const { auth, token } = setup({ secrets })
  assert.equal(await auth.getAccessToken(), 'old-access')
  assert.equal(token.forms.length, 0)
})

test('invalid_grant on refresh (the 6-month expiry) deletes the tokens for good', async () => {
  const secrets = fakeSecrets({ 'spotify.tokens': storedTokens({ expires_at: 0 }) })
  const { auth, token } = setup({ secrets, replies: [{ status: 400, body: { error: 'invalid_grant' } }] })
  await assert.rejects(auth.getAccessToken(), { kind: 'unauthenticated' })
  assert.equal(secrets.values['spotify.tokens'], undefined)
  await assert.rejects(auth.getAccessToken(), { kind: 'unauthenticated' })
  assert.equal(token.forms.length, 1, 'never retried')
})

test('no Client ID means setup; no tokens means not connected', async () => {
  await assert.rejects(setup({ settings: {} }).auth.getAccessToken(), { kind: 'needs-setup' })
  await assert.rejects(setup().auth.getAccessToken(), { kind: 'unauthenticated' })
})

test('disconnect deletes the tokens', async () => {
  const secrets = fakeSecrets({ 'spotify.tokens': storedTokens() })
  const { auth } = setup({ secrets })
  assert.equal((await auth.connection()).connected, true)
  await auth.disconnect()
  assert.equal(secrets.values['spotify.tokens'], undefined)
  assert.equal((await auth.connection()).connected, false)
  await assert.rejects(auth.getAccessToken(), { kind: 'unauthenticated' })
})

test('without an OS keyring the login is kept in memory only', async (t) => {
  const secrets = fakeSecrets({}, { failSet: true })
  const { auth } = setup({
    secrets,
    protection: 'unavailable',
    replies: [{ body: { access_token: 'mem', refresh_token: 'r', expires_in: 3600 } }]
  })
  t.after(() => auth.close())
  const params = new URL((await auth.start()).url).searchParams
  await fetch(`${params.get('redirect_uri')}?code=c&state=${params.get('state')}`)
  assert.equal((await auth.status()).status, 'connected')
  assert.equal(await auth.getAccessToken(), 'mem')
  const connection = await auth.connection()
  assert.equal(connection.protection, 'unavailable')
  assert.equal(connection.connected, true)
})

test('the connection warns from month 5 of the 6-month login', async () => {
  const day = 24 * HOUR
  const secrets = fakeSecrets({ 'spotify.tokens': storedTokens({ authorized_at: 0, expires_at: 200 * day }) })
  assert.equal((await setup({ secrets, now: () => 100 * day }).auth.connection()).expiresSoon, false)
  assert.equal((await setup({ secrets, now: () => 155 * day }).auth.connection()).expiresSoon, true)
  assert.equal(await setup({ secrets, now: () => 155 * day }).auth.expiresSoon(), true)
  assert.equal(await setup({ now: () => 155 * day }).auth.expiresSoon(), false, 'not connected')
})

test('a redirect port outside 1024–65535 falls back to 43117', async () => {
  const ports = []
  const auth = createAuth({
    settings: fakeSettings({ clientId: CLIENT_ID, redirectPort: 80 }),
    secrets: fakeSecrets(),
    listen: async (port) => (ports.push(port), { port, close() {} })
  })
  const redirect = new URL((await auth.start()).url).searchParams.get('redirect_uri')
  assert.deepEqual(ports, [43117])
  assert.equal(redirect, 'http://127.0.0.1:43117/callback')
  assert.equal((await auth.connection()).redirectUri, redirect)
})

test('a login from before Home and the library existed is flagged for a reconnect', async () => {
  const old = fakeSecrets({ 'spotify.tokens': storedTokens({ scopes: 'user-read-playback-state user-modify-playback-state' }) })
  const missing = (await setup({ secrets: old }).auth.connection()).missingScopes
  assert.ok(missing.includes('user-library-read'))
  assert.ok(missing.includes('user-read-recently-played'))
  const full = fakeSecrets({ 'spotify.tokens': storedTokens({ scopes: SCOPES.join(' ') }) })
  assert.deepEqual((await setup({ secrets: full }).auth.connection()).missingScopes, [])
})

test('the login asks for what Home, the library and the heart need', async (t) => {
  const { auth } = setup()
  t.after(() => auth.close())
  const scope = new URL((await auth.start()).url).searchParams.get('scope').split(' ')
  for (const needed of ['user-read-recently-played', 'user-top-read', 'user-library-read', 'user-library-modify', 'user-follow-read']) {
    assert.ok(scope.includes(needed), needed)
  }
})
