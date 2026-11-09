#!/usr/bin/env node
// now-playing: control Spotify through Orca's Now Playing plugin, from a terminal or an agent.
// The plugin copies this file to ~/.orca-now-playing/ next to a `now-playing` launcher; run that.
// No dependencies; Node 20 or newer. `now-playing help` lists the commands.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HELP = `now-playing: control Spotify through Orca's Now Playing plugin.

Usage: now-playing <command> [args] [--json]

Player
  status                       What's playing (the default command)
  play                         Resume
  play <spotify uri>           Play a track, album, playlist or artist
  play <words> [--album|--playlist|--artist]
                               Search and play the best match (a song unless a flag says otherwise)
  pause | toggle | next | previous
  shuffle on|off
  repeat off|all|one
  volume <0-100>
  seek <seconds | m:ss>
  like [uri] | unlike [uri]    Save to or remove from your library (default: the current song)

Find and queue (Spotify Web API)
  search <words> [--type track,album,artist,playlist,show,episode]
  queue                        What plays next
  queue <spotify uri>          Add a track or episode to the queue
  playlists                    Your playlists
  devices                      Spotify Connect devices
  device <name or id>          Move playback to a device

Other
  call <request> [json]        Send any request the panel uses (see GET /v1/health)
  help

--json prints the plugin's raw JSON answer instead of text.
Exit codes: 0 done, 1 Spotify refused or failed, 2 bad usage, 3 Now Playing not reachable.`

const SEARCH_TYPES = ['track', 'album', 'artist', 'playlist', 'show', 'episode']
const URI = /^spotify:(track|episode|album|playlist|artist|show):[A-Za-z0-9]+$/
const OPEN_URL = /^https:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|episode|album|playlist|artist|show)\/([A-Za-z0-9]+)/

class UsageError extends Error {}
class Unreachable extends Error {}

function fail(error) {
  const code = error instanceof UsageError ? 2 : error instanceof Unreachable ? 3 : 1
  if (json) process.stdout.write(JSON.stringify({ ok: false, error: { code: error.code ?? (code === 3 ? 'unreachable' : code === 2 ? 'usage' : 'error'), message: error.message } }) + '\n')
  else process.stderr.write(`now-playing: ${error.message}\n`)
  process.exit(code)
}

// ---------- the bridge ----------

function bridge() {
  const file = process.env.NOW_PLAYING_BRIDGE || join(homedir(), '.orca-now-playing', 'bridge.json')
  try {
    const { url, token } = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof url === 'string' && typeof token === 'string') return { url, token }
  } catch {}
  throw new Unreachable(
    'Now Playing is not running. Open Orca, and make sure the Now Playing plugin is enabled with "Agent access" on (Settings → Plugins → Now Playing).'
  )
}

async function request(name, input) {
  const { url, token } = bridge()
  let response
  try {
    response = await fetch(`${url}/v1/request`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input === undefined ? { name } : { name, input }),
      signal: AbortSignal.timeout(35_000)
    })
  } catch {
    throw new Unreachable('Now Playing did not answer. Is Orca open, with the Now Playing plugin enabled?')
  }
  const body = await response.json().catch(() => null)
  if (!body?.ok) {
    const error = new Error(body?.error?.message ?? `Now Playing answered ${response.status}.`)
    error.code = body?.error?.code
    throw error
  }
  return body.result
}

// The player state after a command, or an error when Spotify says why it couldn't.
async function command(cmd, value) {
  const state = await request('player.command', value === undefined ? { cmd } : { cmd, value })
  if (state?.message && !state.track) {
    const error = new Error(state.message)
    error.code = state.status
    throw error
  }
  return state
}

// ---------- text ----------

const fmt = (ms) => {
  const s = Math.max(0, Math.round((ms ?? 0) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function describe(state) {
  if (!state) return 'No answer.'
  if (state.message && !state.track) return state.message
  if (!state.track) return 'Nothing is playing.'
  const t = state.track
  const lines = [`${state.status === 'playing' ? '▶' : '❚❚'} ${t.title}${t.artist ? ` · ${t.artist}` : ''}`]
  if (t.album) lines.push(`  ${t.album}`)
  lines.push(`  ${fmt(state.positionMs)} / ${fmt(t.durationMs)}`)
  const extras = []
  if (state.device?.name) extras.push(`on ${state.device.name}`)
  if (typeof state.volume === 'number') extras.push(`volume ${state.volume}`)
  if (state.shuffle) extras.push('shuffle')
  if (state.repeat && state.repeat !== 'off') extras.push(state.repeat === 'track' ? 'repeat one' : 'repeat')
  if (extras.length) lines.push(`  ${extras.join(' · ')}`)
  if (t.uri) lines.push(`  ${t.uri}`)
  return lines.join('\n')
}

const row = (title, subtitle, uri) => `  ${title}${subtitle ? ` · ${subtitle}` : ''}${uri ? `  ${uri}` : ''}`

function describeSearch(results) {
  const sections = [
    ['tracks', 'Songs', (t) => row(t.title, t.artist, t.uri)],
    ['albums', 'Albums', (a) => row(a.name, [a.subtitle, a.year].filter(Boolean).join(', '), a.uri)],
    ['artists', 'Artists', (a) => row(a.name, '', a.uri)],
    ['playlists', 'Playlists', (p) => row(p.name, p.subtitle, p.uri)],
    ['shows', 'Podcasts', (s) => row(s.name, s.subtitle, s.uri)],
    ['episodes', 'Episodes', (e) => row(e.title, e.artist, e.uri)]
  ]
  const out = []
  for (const [key, title, line] of sections) {
    const items = results?.[key]?.items ?? []
    if (!items.length) continue
    out.push(title, ...items.map(line))
  }
  return out.length ? out.join('\n') : 'Nothing found.'
}

// ---------- arguments ----------

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const flags = new Set(argv.filter((arg) => arg.startsWith('--') && !arg.includes('=')))
const valueOf = (name) => {
  const eq = argv.find((arg) => arg.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const at = argv.indexOf(`--${name}`)
  return at !== -1 ? argv[at + 1] : undefined
}
const positional = argv.filter((arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--type')
const [name = 'status', ...rest] = positional
const words = rest.join(' ').trim()

const print = (result, text) => process.stdout.write((json ? JSON.stringify(result) : text(result)) + '\n')

// A Spotify URI, or an open.spotify.com link turned into one; null for anything else.
function toUri(value) {
  if (URI.test(value)) return value
  const link = OPEN_URL.exec(value)
  return link ? `spotify:${link[1]}:${link[2]}` : null
}

const onOff = (value) => {
  if (value === 'on' || value === 'true') return true
  if (value === 'off' || value === 'false') return false
  throw new UsageError('Say on or off.')
}

function seconds(value) {
  const clock = /^(\d+):(\d{1,2})$/.exec(value ?? '')
  const s = clock ? Number(clock[1]) * 60 + Number(clock[2]) : Number(value)
  if (!Number.isFinite(s) || s < 0) throw new UsageError('Give seconds or m:ss, e.g. seek 1:30.')
  return Math.round(s * 1000)
}

async function current() {
  const state = await request('player.state')
  if (!state?.track?.uri) throw new Error(state?.message || 'Nothing is playing.')
  return state.track
}

async function playBest(query) {
  const type = flags.has('--album') ? 'album' : flags.has('--playlist') ? 'playlist' : flags.has('--artist') ? 'artist' : 'track'
  const results = await request('library.search', { q: query, types: [type] })
  const best = results?.[`${type}s`]?.items?.[0]
  if (!best) throw new Error(`No ${type} matches “${query}”.`)
  return command('playUri', best.uri)
}

const COMMANDS = {
  help: async () => process.stdout.write(HELP + '\n'),
  status: async () => print(await request('player.state'), describe),
  now: async () => COMMANDS.status(),

  play: async () => {
    if (!words) return print(await command('play'), describe)
    const uri = toUri(words)
    print(await (uri ? command('playUri', uri) : playBest(words)), describe)
  },
  pause: async () => print(await command('pause'), describe),
  toggle: async () => print(await command('playpause'), describe),
  next: async () => print(await command('next'), describe),
  skip: async () => COMMANDS.next(),
  previous: async () => print(await command('previous'), describe),
  prev: async () => COMMANDS.previous(),
  back: async () => COMMANDS.previous(),

  shuffle: async () => {
    const want = onOff(rest[0])
    const state = await request('player.state')
    print(state.shuffle === want ? state : await command('toggleShuffle'), (s) => `Shuffle ${s.shuffle ? 'on' : 'off'}`)
  },
  repeat: async () => {
    const mode = { off: 'off', all: 'context', context: 'context', one: 'track', track: 'track' }[rest[0]]
    if (!mode) throw new UsageError('repeat off, all or one.')
    print(await command('setRepeat', mode), (s) => `Repeat ${{ off: 'off', context: 'all', track: 'one' }[s.repeat] ?? s.repeat}`)
  },
  volume: async () => {
    if (rest[0] === undefined) return print(await request('player.state'), (s) => `Volume ${s.volume}`)
    const volume = Number(rest[0])
    if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw new UsageError('volume takes 0 to 100.')
    print(await command('setVolume', volume), (s) => `Volume ${s.volume}`)
  },
  seek: async () => print(await command('seek', seconds(rest[0])), describe),

  like: async () => {
    const uri = words ? toUri(words) : (await current()).uri
    if (!uri) throw new UsageError('like takes a Spotify URI, or nothing for the current song.')
    print(await request('library.save', { uri, saved: true }), () => `Saved ${uri} to your library.`)
  },
  unlike: async () => {
    const uri = words ? toUri(words) : (await current()).uri
    if (!uri) throw new UsageError('unlike takes a Spotify URI, or nothing for the current song.')
    print(await request('library.save', { uri, saved: false }), () => `Removed ${uri} from your library.`)
  },

  search: async () => {
    if (!words) throw new UsageError('search what? e.g. now-playing search "kind of blue"')
    const type = valueOf('type')
    const types = type ? type.split(',').map((t) => t.trim()) : ['track', 'album', 'artist', 'playlist']
    if (!types.every((t) => SEARCH_TYPES.includes(t))) throw new UsageError(`--type takes ${SEARCH_TYPES.join(', ')}.`)
    print(await request('library.search', { q: words, types }), describeSearch)
  },
  queue: async () => {
    if (words) {
      const uri = toUri(words)
      if (!uri) throw new UsageError('queue takes a track or episode URI.')
      return print(await request('player.enqueue', { uri }), () => `Queued ${uri}.`)
    }
    print(await request('player.queue'), (q) =>
      [q.current ? `Now: ${q.current.title} · ${q.current.artist}` : 'Nothing playing', ...(q.queue ?? []).slice(0, 20).map((t, i) => `${String(i + 1).padStart(2)}. ${t.title} · ${t.artist}  ${t.uri}`)].join('\n')
    )
  },
  playlists: async () =>
    print(await request('library.playlists', { offset: 0 }), (p) => (p.items ?? []).map((item) => row(item.name, item.count != null ? `${item.count} songs` : item.subtitle, item.uri)).join('\n') || 'No playlists.'),
  devices: async () =>
    print(await request('player.devices'), (list) => list.map((d) => `${d.active ? '●' : '○'} ${d.name} (${d.type})  ${d.id}`).join('\n') || 'No devices. Open Spotify on one.'),
  device: async () => {
    if (!words) throw new UsageError('device takes a device name or id; see now-playing devices.')
    const list = await request('player.devices')
    const lower = words.toLowerCase()
    const match = list.find((d) => d.id === words) ?? list.find((d) => d.name.toLowerCase() === lower) ?? list.find((d) => d.name.toLowerCase().includes(lower))
    if (!match) throw new Error(`No device called “${words}”. Devices: ${list.map((d) => d.name).join(', ') || 'none'}.`)
    print(await request('player.transfer', { deviceId: match.id, play: true }), (s) => `Playing on ${match.name}.\n${describe(s)}`)
  },

  call: async () => {
    const [request_, input] = rest
    if (!request_) throw new UsageError('call <request> [json input]')
    let parsed
    if (input !== undefined) {
      try {
        parsed = JSON.parse(input)
      } catch {
        throw new UsageError('The input must be JSON.')
      }
    }
    process.stdout.write(JSON.stringify(await request(request_, parsed), null, json ? 0 : 2) + '\n')
  }
}

const run = COMMANDS[name]
if (!run) fail(new UsageError(`Unknown command “${name}”. Run now-playing help.`))
else run().catch(fail)
