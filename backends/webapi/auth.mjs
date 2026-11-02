// Spotify login with Authorization Code + PKCE, for a Client ID the person pastes in.
//
// start() builds the authorize URL and opens a loopback server on 127.0.0.1 that waits for
// Spotify's redirect. The panel opens the URL in the browser on a click; the browser comes back
// to /callback with a code, which is traded for tokens. The server closes after the first valid
// callback or after 2 minutes without the panel watching.
//
// Tokens are one JSON secret. When the OS has no keyring (Linux without gnome-keyring or KWallet)
// secrets.set fails; the tokens then live in worker memory until the worker stops.
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { MESSAGES, SpotifyError } from '../../src/backend.mjs'

export const SCOPES = Object.freeze([
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  // Home, Your Library and the heart.
  'user-read-recently-played',
  'user-top-read',
  'user-library-read',
  'user-library-modify',
  'user-follow-read'
])
export const DEFAULT_PORT = 43117
export const TOKENS_KEY = 'spotify.tokens'

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize'
const TOKEN_URL = 'https://accounts.spotify.com/api/token'
const LOGIN_TIMEOUT_MS = 2 * 60_000
const REFRESH_EARLY_MS = 60_000
const DAY_MS = 24 * 3600_000
// Spotify ends a login after 6 months; warn from month 5.
const EXPIRY_WARNING_MS = 150 * DAY_MS
const CLIENT_ID = /^[A-Za-z0-9]{1,64}$/

const base64url = (buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:15px system-ui;margin:20vh auto;max-width:28em;text-align:center">` +
  `<h1 style="font-size:20px">${title}</h1><p>${body}</p></body>`

export function createAuth({
  settings,
  secrets,
  protection = async () => 'os-keyring',
  fetchImpl = globalThis.fetch,
  now = Date.now,
  listen = listenLoopback
}) {
  let memory = null // the tokens last read or written
  let memoryOnly = false // secrets.set failed: tokens are only in memory
  let refreshing = null // the one refresh in flight
  let login = null // the pending login: { clientId, port, url, state, verifier, server, timer }
  let result = { status: 'idle' } // the outcome of the last login

  const endsSoon = (tokens) => Boolean(tokens?.access_token) && now() - tokens.authorized_at > EXPIRY_WARNING_MS

  const clientId = async () => {
    const value = await Promise.resolve(settings.get('clientId')).catch(() => '')
    return typeof value === 'string' ? value.trim() : ''
  }

  const port = async () => {
    const value = Number(await Promise.resolve(settings.get('redirectPort')).catch(() => undefined))
    return Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : DEFAULT_PORT
  }

  const load = async () => {
    if (memory || memoryOnly) return memory
    const raw = await secrets.get(TOKENS_KEY).catch(() => null)
    try {
      memory = raw ? JSON.parse(raw) : null
    } catch {
      memory = null
    }
    return memory
  }

  const save = async (tokens) => {
    memory = tokens
    try {
      await secrets.set(TOKENS_KEY, JSON.stringify(tokens))
      memoryOnly = false
    } catch {
      memoryOnly = true
    }
  }

  const forget = async () => {
    memory = null
    memoryOnly = false
    await secrets.delete(TOKENS_KEY).catch(() => {})
  }

  const postToken = async (form) => {
    let response
    try {
      response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(10_000)
      })
    } catch (error) {
      throw new SpotifyError('error', `Could not reach Spotify: ${error?.message ?? error}`)
    }
    const body = await response.json().catch(() => ({}))
    return { ok: response.ok, status: response.status, body: body ?? {} }
  }

  const tokensFrom = (body, previous, id) => ({
    access_token: body.access_token,
    // Spotify may or may not send a new refresh token; keep the old one when it doesn't.
    refresh_token: body.refresh_token ?? previous?.refresh_token,
    expires_at: now() + Number(body.expires_in ?? 3600) * 1000,
    authorized_at: previous?.authorized_at ?? now(),
    scopes: body.scope ?? previous?.scopes ?? SCOPES.join(' '),
    client_id: id
  })

  const refresh = async (tokens, id) => {
    const { ok, body } = await postToken({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: id })
    if (ok && body.access_token) {
      const next = tokensFrom(body, tokens, id)
      await save(next)
      return next.access_token
    }
    // The login ended (6 months, revoked access, another Client ID): never retry it.
    if (body.error === 'invalid_grant' || body.error === 'invalid_client') {
      await forget()
      throw new SpotifyError('unauthenticated', MESSAGES.unauthenticated)
    }
    throw new SpotifyError('error', `Spotify did not refresh the login: ${body.error_description ?? body.error ?? 'unknown error'}`)
  }

  // A usable access token, refreshed when it is about to expire. `force` refreshes anyway
  // (the API just answered 401).
  async function getAccessToken({ force = false } = {}) {
    const id = await clientId()
    if (!id) throw new SpotifyError('needs-setup', MESSAGES.needsSetup)
    const tokens = await load()
    if (!tokens?.access_token || (tokens.client_id && tokens.client_id !== id)) {
      throw new SpotifyError('unauthenticated', MESSAGES.unauthenticated)
    }
    if (!force && tokens.expires_at - REFRESH_EARLY_MS > now()) return tokens.access_token
    if (!tokens.refresh_token) {
      await forget()
      throw new SpotifyError('unauthenticated', MESSAGES.unauthenticated)
    }
    refreshing ??= refresh(tokens, id).finally(() => {
      refreshing = null
    })
    return refreshing
  }

  // Forgets the pending login. The server closes now, or, for the callback being answered,
  // once the browser has its page (`keepServer`).
  const closeLogin = ({ keepServer = false } = {}) => {
    if (!login) return
    clearTimeout(login.timer)
    if (!keepServer) login.server.close()
    login = null
  }

  const armTimeout = () => {
    clearTimeout(login.timer)
    login.timer = setTimeout(() => {
      closeLogin()
      result = { status: 'failed', message: 'The login timed out. Click Connect to try again.' }
    }, LOGIN_TIMEOUT_MS)
    login.timer.unref?.()
  }

  // Handles one request to the loopback server; answers with the page the browser shows.
  const onCallback = async (query, current) => {
    if (query.get('state') !== current.state) {
      return { status: 400, html: page('Login link out of date', 'Start the login again from Orca.') }
    }
    if (login === current) closeLogin({ keepServer: true })
    const error = query.get('error')
    if (error) {
      result = {
        status: 'failed',
        message: error === 'access_denied' ? 'You declined the Spotify login.' : `Spotify login failed: ${error}`
      }
      return { status: 200, close: true, html: page('Not connected', `${result.message} You can close this tab.`) }
    }
    const { ok, body } = await postToken({
      grant_type: 'authorization_code',
      code: query.get('code') ?? '',
      redirect_uri: current.redirectUri,
      client_id: current.clientId,
      code_verifier: current.verifier
    }).catch((failure) => ({ ok: false, body: { error_description: failure.message } }))
    if (!ok || !body.access_token) {
      result = { status: 'failed', message: `Spotify login failed: ${body.error_description ?? body.error ?? 'no token'}` }
      return { status: 502, close: true, html: page('Not connected', `${result.message} Go back to Orca and try again.`) }
    }
    await save({ ...tokensFrom(body, null, current.clientId), authorized_at: now() })
    result = { status: 'connected' }
    return { status: 200, close: true, html: page('Connected', 'Go back to Orca. You can close this tab.') }
  }

  return {
    getAccessToken,

    // Builds the authorize URL and starts listening for the redirect. Calling it again while a
    // login waits returns the same URL. `clientId` saves a new Client ID first.
    async start({ clientId: newId } = {}) {
      if (newId !== undefined) {
        const trimmed = String(newId).trim()
        if (!CLIENT_ID.test(trimmed)) throw new SpotifyError('invalid', 'That doesn’t look like a Spotify Client ID.')
        if (trimmed !== (await clientId())) await settings.set('clientId', trimmed)
      }
      const id = await clientId()
      if (!id) throw new SpotifyError('needs-setup', MESSAGES.needsSetup)
      const wanted = await port()
      if (login && login.clientId === id && login.requestedPort === wanted) {
        armTimeout()
        return { url: login.url }
      }
      closeLogin()

      const verifier = base64url(randomBytes(48))
      const state = base64url(randomBytes(16))
      const current = { clientId: id, requestedPort: wanted, verifier, state }
      const server = await listen(wanted, async (query) => onCallback(query, current))
      current.server = server
      current.redirectUri = `http://127.0.0.1:${server.port}/callback`
      const url = new URL(AUTHORIZE_URL)
      url.search = new URLSearchParams({
        client_id: id,
        response_type: 'code',
        redirect_uri: current.redirectUri,
        code_challenge_method: 'S256',
        code_challenge: base64url(createHash('sha256').update(verifier).digest()),
        scope: SCOPES.join(' '),
        state
      }).toString()
      current.url = url.toString()
      login = current
      result = { status: 'pending' }
      armTimeout()
      return { url: current.url }
    },

    // The login's progress. While the panel keeps asking, the loopback server keeps waiting.
    async status() {
      if (login) armTimeout()
      return result
    },

    // Whether the 6-month login ends within a month. Cheap: no host calls once tokens are loaded.
    expiresSoon: async () => endsSoon(await load()),

    async connection() {
      const tokens = await load()
      const id = await clientId()
      const connected = Boolean(tokens?.access_token) && (!tokens.client_id || tokens.client_id === id)
      return {
        clientId: id || null,
        connected,
        authorizedAt: connected ? tokens.authorized_at : null,
        expiresSoon: connected && endsSoon(tokens),
        // A login from an older version lacks the permissions newer features need.
        missingScopes: connected && typeof tokens.scopes === 'string' ? SCOPES.filter((scope) => !tokens.scopes.split(' ').includes(scope)) : [],
        protection: memoryOnly ? 'unavailable' : await Promise.resolve(protection()).catch(() => 'unavailable'),
        redirectUri: `http://127.0.0.1:${await port()}/callback`
      }
    },

    // The API refused a fresh token: the login is no good any more.
    async expire() {
      await forget()
    },

    async disconnect() {
      closeLogin()
      result = { status: 'idle' }
      await forget()
      return { ok: true }
    },

    close: closeLogin
  }
}

// A one-route HTTP server on 127.0.0.1. `handle(query)` answers each /callback request with
// { status, html, close? }; `close` shuts the server once that page is sent.
export function listenLoopback(port, handle) {
  return new Promise((resolve, reject) => {
    const shutdown = () => {
      server.close()
      server.closeAllConnections?.()
    }
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const { status, html, close } =
        url.pathname === '/callback'
          ? await handle(url.searchParams).catch(() => ({ status: 500, html: page('Something went wrong', 'Go back to Orca and try again.') }))
          : { status: 404, html: page('Not found', '') }
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' })
      res.end(html, () => {
        if (close) shutdown()
      })
    })
    server.once('error', (error) => {
      reject(
        error?.code === 'EADDRINUSE'
          ? new SpotifyError('error', `Port ${port} is already in use. Pick another Redirect port in Orca Settings, and add it to your Spotify app.`)
          : new SpotifyError('error', `Could not wait for the Spotify login: ${error?.message ?? error}`)
      )
    })
    server.listen(port, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: shutdown })
    })
  })
}
