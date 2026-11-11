import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { promisify } from 'node:util'
import { AGENT_REQUESTS, createAgentBridge } from '../src/agent-bridge.mjs'
import { SpotifyError } from '../src/backend.mjs'

const CLI = new URL('../bin/now-playing.mjs', import.meta.url)
const run = promisify(execFile)

const playing = {
  status: 'playing',
  volume: 40,
  shuffle: false,
  repeat: 'off',
  positionMs: 61_000,
  track: { title: 'Glass Weather', artist: 'The Quiet Coast', album: 'North Facing', uri: 'spotify:track:t1', durationMs: 258_000 },
  device: { id: 'd1', name: 'MacBook Pro' }
}

const seen = []
// What app.open answers next; a test sets it to a refusal.
let opening = { opened: true, state: { status: 'stopped', track: null, backend: 'webapi' } }
const handlers = {
  'app.open': async () => (seen.push(['app.open']), opening),
  'player.state': async () => playing,
  'player.command': async (input) => (seen.push(['player.command', input]), { ...playing, status: input.cmd === 'pause' ? 'paused' : 'playing' }),
  'library.search': async (input) => (seen.push(['library.search', input]), { tracks: { items: [{ title: 'Dreams', artist: 'Fleetwood Mac', uri: 'spotify:track:dreams' }], total: 1, offset: 0 } }),
  'player.queue': async () => {
    throw new SpotifyError('unsupported', 'This needs the Spotify Web API. Switch to it in the panel.')
  },
  'auth.disconnect': async () => ({ ok: true })
}

let dir
let bridge
let info

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'now-playing-bridge-'))
  bridge = createAgentBridge({ handlers, version: '9.9.9', dir, cliSource: CLI, makeToken: () => 'secret-token' })
  info = await bridge.start()
})

after(async () => {
  await bridge.stop()
  rmSync(dir, { recursive: true, force: true })
})

// A raw HTTP call, so the tests can send headers fetch would not (Host) or would add (Origin).
function call(path, { method = 'POST', headers = {}, body } = {}) {
  const url = new URL(info.url)
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: url.port, path, method, headers: { host: url.host, ...headers } }, (res) => {
      let text = ''
      res.on('data', (chunk) => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

const authed = { authorization: 'Bearer secret-token', 'content-type': 'application/json' }

test('writes a discovery file only the user can read, and the CLI next to it', () => {
  const file = join(dir, 'bridge.json')
  const discovery = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(discovery.url, info.url)
  assert.equal(discovery.token, 'secret-token')
  assert.equal(discovery.version, '9.9.9')
  assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.ok(existsSync(join(dir, 'now-playing.mjs')))
  assert.equal(statSync(join(dir, 'now-playing')).mode & 0o111, 0o111)
})

test('answers a request with what the panel handler returns', async () => {
  const reply = await call('/v1/request', { headers: authed, body: { name: 'player.state' } })
  assert.deepEqual(reply, { status: 200, body: { ok: true, result: playing } })
})

test('refuses calls without the token, from browsers, or for another host', async () => {
  assert.equal((await call('/v1/request', { headers: { 'content-type': 'application/json' }, body: { name: 'player.state' } })).status, 401)
  assert.equal((await call('/v1/request', { headers: { ...authed, authorization: 'Bearer nope' }, body: { name: 'player.state' } })).status, 401)
  assert.equal((await call('/v1/request', { headers: { ...authed, origin: 'https://evil.example' }, body: { name: 'player.state' } })).status, 403)
  assert.equal((await call('/v1/request', { headers: { ...authed, host: 'evil.example' }, body: { name: 'player.state' } })).status, 403)
  assert.equal((await call('/v1/request', { headers: { authorization: 'Bearer secret-token', 'content-type': 'text/plain' }, body: { name: 'player.state' } })).status, 415)
})

test('only offers the agent requests: never the login or the backend choice', async () => {
  assert.ok(!AGENT_REQUESTS.some((name) => name.startsWith('auth.') || name === 'backend.select'))
  const reply = await call('/v1/request', { headers: authed, body: { name: 'auth.disconnect' } })
  assert.equal(reply.status, 404)
  assert.equal(reply.body.error.code, 'unknown_request')
})

test('a handler error comes back with its kind and the panel sentence', async () => {
  const reply = await call('/v1/request', { headers: authed, body: { name: 'player.queue' } })
  assert.equal(reply.status, 409)
  assert.deepEqual(reply.body.error, { code: 'unsupported', message: 'This needs the Spotify Web API. Switch to it in the panel.' })
})

test('health lists the requests', async () => {
  const reply = await call('/v1/health', { method: 'GET', headers: authed })
  assert.equal(reply.body.version, '9.9.9')
  assert.deepEqual(reply.body.requests, AGENT_REQUESTS)
})

// ---------- the CLI against this bridge ----------

const cli = (...args) => run(process.execPath, [CLI.pathname, ...args], { env: { ...process.env, NOW_PLAYING_BRIDGE: join(dir, 'bridge.json') } })

test('cli: status describes the track', async () => {
  const { stdout } = await cli('status')
  assert.match(stdout, /▶ Glass Weather · The Quiet Coast/)
  assert.match(stdout, /1:01 \/ 4:18/)
  assert.match(stdout, /on MacBook Pro · volume 40/)
  assert.match(stdout, /spotify:track:t1/)
})

test('cli: play <words> searches and plays the best song; a link becomes a URI', async () => {
  seen.length = 0
  await cli('play', 'dreams', 'fleetwood')
  assert.deepEqual(seen, [
    ['library.search', { q: 'dreams fleetwood', types: ['track'] }],
    ['player.command', { cmd: 'playUri', value: 'spotify:track:dreams' }]
  ])
  seen.length = 0
  await cli('play', 'https://open.spotify.com/album/1weenld61qoidwYuZ1GESA?si=x')
  assert.deepEqual(seen, [['player.command', { cmd: 'playUri', value: 'spotify:album:1weenld61qoidwYuZ1GESA' }]])
})

test('cli: open starts the app and says what it found', async () => {
  seen.length = 0
  const { stdout } = await cli('open')
  assert.deepEqual(seen, [['app.open']])
  assert.match(stdout, /Spotify is open/)
  assert.match(stdout, /Nothing is playing/)
  assert.deepEqual(JSON.parse((await cli('open', '--json')).stdout), opening)
  opening = { opened: true, state: { ...playing, backend: 'applemusic' } }
  assert.match((await cli('open')).stdout, /Apple Music is open\.\n.*Glass Weather/s)
})

test('cli: open that could not start exits 1 with the sentence, and the link when there is one', async () => {
  opening = {
    opened: false,
    reason: 'not-installed',
    message: 'Spotify is not installed on this Mac.',
    link: { label: 'Open Spotify on the web', url: 'https://open.spotify.com' }
  }
  await assert.rejects(cli('open'), (error) => error.code === 1 && /Spotify is not installed on this Mac\./.test(error.stderr) && /https:\/\/open\.spotify\.com/.test(error.stderr))
  await assert.rejects(cli('open', '--json'), (error) => {
    const body = JSON.parse(error.stdout)
    return error.code === 1 && body.ok === false && body.error.code === 'not-installed' && /not installed/.test(body.error.message)
  })
  opening = { opened: false, reason: 'timeout', message: 'Spotify started, but it did not answer after 15 seconds.' }
  await assert.rejects(cli('open'), (error) => error.code === 1 && !/https:/.test(error.stderr))
})

test('app.open is one of the requests agents may make', () => {
  assert.ok(AGENT_REQUESTS.includes('app.open'))
})

test('cli: --json prints the raw answer', async () => {
  const { stdout } = await cli('pause', '--json')
  assert.equal(JSON.parse(stdout).status, 'paused')
})

test('cli: a refusal exits 1 with the sentence; bad usage exits 2', async () => {
  await assert.rejects(cli('queue'), (error) => error.code === 1 && /needs the Spotify Web API/.test(error.stderr))
  await assert.rejects(cli('volume', '400'), (error) => error.code === 2)
})

test('cli: no bridge file exits 3 and says how to fix it', async () => {
  const error = await run(process.execPath, [CLI.pathname, 'status'], { env: { ...process.env, NOW_PLAYING_BRIDGE: join(dir, 'missing.json') } }).catch((e) => e)
  assert.equal(error.code, 3)
  assert.match(error.stderr, /Now Playing is not running/)
})

test('stop closes the server and removes its discovery file', async () => {
  const other = createAgentBridge({ handlers, version: '1', dir: join(dir, 'other') })
  await other.start()
  assert.ok(existsSync(join(dir, 'other', 'bridge.json')))
  await other.stop()
  assert.ok(!existsSync(join(dir, 'other', 'bridge.json')))
  assert.equal(other.info().running, false)
})
