// Lets coding agents (and any script you run) control Spotify through Now Playing.
//
// The worker serves the panel's own requests on a loopback port, and writes where to find it to
// ~/.orca-now-playing/bridge.json (only you can read it):
//
//   { url: 'http://127.0.0.1:<port>', token, pid, version }
//
//   POST /v1/request   Authorization: Bearer <token>   { name, input? }
//     → 200 { ok: true, result }  |  4xx/5xx { ok: false, error: { code, message } }
//   GET  /v1/health    Authorization: Bearer <token>   → { ok: true, version, requests }
//
// `name` is one of AGENT_REQUESTS; they answer exactly as they do for the panel (see
// panel-protocol.mjs). bin/now-playing.mjs wraps this in a CLI and is copied next to bridge.json.
//
// Only this machine can reach it (127.0.0.1), and only with the token. Browsers can't: requests
// with an Origin header, or a Host other than the loopback address, are refused.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { classifyError } from './backend.mjs'

// What agents may ask for: playback, devices, queue, search and the library. Not the login,
// the backend choice or artwork data URLs, which are the person's or only the panel's business.
export const AGENT_REQUESTS = Object.freeze([
  'player.state',
  'player.command',
  'player.devices',
  'player.transfer',
  'player.queue',
  'player.enqueue',
  'player.playContext',
  'library.search',
  'library.home',
  'library.playlists',
  'library.liked',
  'library.albums',
  'library.artists',
  'library.shows',
  'library.page',
  'library.saved',
  'library.save',
  'backend.info'
])

const MAX_BODY = 64 * 1024

const WRAPPER = '#!/bin/sh\n# Written by the Now Playing plugin for Orca.\nexec node "$(dirname "$0")/now-playing.mjs" "$@"\n'
const REQUEST_TIMEOUT_MS = 30_000

export const bridgeDir = () => join(homedir(), '.orca-now-playing')

const STATUS_BY_CODE = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  too_large: 413,
  unsupported_media_type: 415,
  unknown_request: 404,
  invalid: 400,
  timeout: 504
}

class BridgeError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new BridgeError('too_large', 'The request body is over 64 KiB.'))
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const sameToken = (given, token) => {
  const a = Buffer.from(String(given))
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function createAgentBridge({
  handlers,
  version,
  dir = bridgeDir(),
  cliSource = null,
  listen = createServer,
  log = () => {},
  makeToken = () => randomBytes(32).toString('hex')
}) {
  let server = null
  let token = null
  let url = null
  let starting = null

  const authorize = (req, port) => {
    // A web page can reach 127.0.0.1 too; it always sends an Origin, and a DNS-rebinding page
    // sends its own Host. Neither gets in.
    if (req.headers.origin !== undefined) throw new BridgeError('forbidden', 'Browsers may not call Now Playing.')
    const host = String(req.headers.host ?? '')
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new BridgeError('forbidden', 'Unexpected Host header.')
    const header = String(req.headers.authorization ?? '')
    const given = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!given || !sameToken(given, token)) throw new BridgeError('unauthorized', 'Missing or wrong token. Read it from bridge.json.')
  }

  const call = async (name, input) => {
    if (!AGENT_REQUESTS.includes(name)) throw new BridgeError('unknown_request', `Unknown request: ${name}. One of: ${AGENT_REQUESTS.join(', ')}.`)
    const handler = handlers[name]
    if (!handler) throw new BridgeError('unknown_request', `Unknown request: ${name}.`)
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const context = { panel: { id: 'agent', surface: 'panel', contributionId: 'agent' }, signal }
    return handler(input ?? undefined, context)
  }

  const handle = async (req, res, port) => {
    try {
      authorize(req, port)
      const path = new URL(req.url, 'http://127.0.0.1').pathname
      if (path === '/v1/health') {
        if (req.method !== 'GET') throw new BridgeError('method_not_allowed', 'Use GET.')
        return send(res, 200, { ok: true, version, requests: AGENT_REQUESTS })
      }
      if (path !== '/v1/request') throw new BridgeError('not_found', 'Use POST /v1/request or GET /v1/health.')
      if (req.method !== 'POST') throw new BridgeError('method_not_allowed', 'Use POST.')
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        throw new BridgeError('unsupported_media_type', 'Send Content-Type: application/json.')
      }
      let body
      try {
        body = JSON.parse((await readBody(req)) || '{}')
      } catch (error) {
        if (error instanceof BridgeError) throw error
        throw new BridgeError('invalid', 'The body is not JSON.')
      }
      if (!body || typeof body !== 'object' || typeof body.name !== 'string') throw new BridgeError('invalid', 'Send { "name": "<request>", "input": … }.')
      const result = await call(body.name, body.input)
      send(res, 200, { ok: true, result: result ?? null })
    } catch (error) {
      if (error instanceof BridgeError) return send(res, STATUS_BY_CODE[error.code] ?? 400, { ok: false, error: { code: error.code, message: error.message } })
      // A handler's own error: the same kinds and sentences the panel shows.
      const reason = classifyError(error)
      const code = reason.kind === 'invalid' ? 'invalid' : reason.kind
      const status = code === 'invalid' ? 400 : code === 'rate-limited' ? 429 : 409
      const body = { ok: false, error: { code, message: reason.message } }
      if (reason.retryAfterMs !== undefined) body.error.retryAfterMs = reason.retryAfterMs
      send(res, status, body)
    }
  }

  const writeDiscovery = async (port) => {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700).catch(() => {})
    const file = join(dir, 'bridge.json')
    await writeFile(file, JSON.stringify({ url, token, pid: process.pid, version, port }, null, 2) + '\n', { mode: 0o600 })
    await chmod(file, 0o600).catch(() => {})
    if (cliSource) {
      // The .mjs keeps Node reading it as a module; `now-playing` is the short name to run.
      await copyFile(cliSource, join(dir, 'now-playing.mjs'))
      const wrapper = join(dir, 'now-playing')
      await writeFile(wrapper, WRAPPER, { mode: 0o755 })
      await chmod(wrapper, 0o755).catch(() => {})
    }
  }

  const start = async () => {
    if (server) return info()
    if (starting) return starting
    starting = (async () => {
      token = makeToken()
      const next = listen((req, res) => handle(req, res, next.address().port))
      await new Promise((resolve, reject) => {
        next.once('error', reject)
        next.listen(0, '127.0.0.1', () => {
          next.off('error', reject)
          resolve()
        })
      })
      // The worker must be able to stop while an agent holds a connection open.
      next.unref?.()
      server = next
      const { port } = next.address()
      url = `http://127.0.0.1:${port}`
      try {
        await writeDiscovery(port)
      } catch (error) {
        log(`agent bridge: could not write ${dir}: ${error.message}`)
      }
      log(`agent bridge: listening on ${url}`)
      return info()
    })()
    try {
      return await starting
    } finally {
      starting = null
    }
  }

  const stop = async () => {
    if (starting) await starting.catch(() => {})
    if (!server) return
    const closing = server
    server = null
    await new Promise((resolve) => closing.close(() => resolve()))
    closing.closeAllConnections?.()
    // Remove the discovery file only if it is still ours (another Orca may have written its own).
    const file = join(dir, 'bridge.json')
    try {
      const current = JSON.parse(await readFile(file, 'utf8'))
      if (current.token === token) await rm(file, { force: true })
    } catch {}
    token = null
    url = null
  }

  const info = () => ({ running: Boolean(server), url, dir })

  return { start, stop, info, call }
}
