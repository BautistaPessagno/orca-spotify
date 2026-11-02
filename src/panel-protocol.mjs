// Worker side of the Now Playing panel: the handlers the panel calls with
// `orca.plugin.request(name, input)`. worker.mjs registers each with `orca.panels.handle`.
//
//   player.state                              → state
//   player.command      { cmd, value? }       → state after the command
//   player.artwork      { url }               → { url, dataUrl } | { url, dataUrl: null }
//   backend.info                              → { id, capabilities, available, connection }
//   backend.select      { backend }           → backend.info
//   auth.start          { clientId? }         → { url } | { url: null, message }
//   auth.status                               → { status: 'idle' | 'pending' | 'connected' | 'failed', message? }
//   auth.disconnect                           → { ok }
//   player.devices                            → Device[]
//   player.transfer     { deviceId, play? }   → state
//   player.queue                              → { current, queue: Track[] }
//   player.enqueue      { uri }               → { ok }
//   player.playContext  { contextUri?, uris?, offset? } → state
//   library.search      { q, types?, offset? } → { tracks?, albums?, artists?, playlists? }, 10 per type
//   library.playlists   { offset? }           → { items, total, offset }, 50 per page
//
// player.devices through library.playlists need a backend with that capability (the Web API);
// on AppleScript they reject.
import { COMMAND_NAMES, SEARCH_TYPES, SpotifyError, classifyError, errorState } from './backend.mjs'
import { runAndSettle } from './settle.mjs'

// AppleScript artwork URLs end in a size-coded image id; 1e02 is the 300×300 variant, small
// enough for one panel reply. Web API URLs are already picked at ~300 px.
const ARTWORK_640 = 'ab67616d0000b273'
const ARTWORK_300 = 'ab67616d00001e02'
const ARTWORK_HOSTS = [/^https:\/\/i\.scdn\.co\//, /^https:\/\/mosaic\.scdn\.co\//, /^https:\/\/image-cdn-[a-z]+\.spotifycdn\.com\//]
const ARTWORK_MAX_BYTES = 96 * 1024
const ARTWORK_CACHE = 64

const URI = /^spotify:(track|album|playlist|artist|episode):[A-Za-z0-9]+$/
const CONTEXT_KINDS = ['album', 'playlist', 'artist']
const ITEM_KINDS = ['track', 'episode']
const MAX_URIS = 100

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function smallArtworkUrl(url) {
  return url.replace(ARTWORK_640, ARTWORK_300)
}

function bad(message) {
  return new SpotifyError('invalid', message)
}

function spotifyUri(value, kinds) {
  const match = typeof value === 'string' ? URI.exec(value) : null
  if (!match) throw bad('Expected a Spotify URI such as spotify:track:…')
  if (kinds && !kinds.includes(match[1])) throw bad(`Expected a ${kinds.join(', ').replace(/, (\w+)$/, ' or $1')} URI.`)
  return value
}

function offsetOf(value, max = 1000) {
  const offset = value ?? 0
  if (!Number.isInteger(offset) || offset < 0 || offset > max) throw bad(`The offset must be a whole number from 0 to ${max}.`)
  return offset
}

export function createPanelHandlers(spotify, { fetchImpl = globalThis.fetch, auth, platform = process.platform, delay = wait } = {}) {
  // Artwork is asked for repeatedly (the playing track, list rows); keep the last few.
  const artworkCache = new Map()

  const loadArtwork = async (url) => {
    const response = await fetchImpl(smallArtworkUrl(url), { signal: AbortSignal.timeout(5000) })
    if (!response.ok) return null
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > ARTWORK_MAX_BYTES) return null
    const type = response.headers.get('content-type') || 'image/jpeg'
    return `data:${type};base64,${bytes.toString('base64')}`
  }

  const artwork = (url) => {
    let promise = artworkCache.get(url)
    if (promise) artworkCache.delete(url)
    else promise = loadArtwork(url).catch(() => null)
    artworkCache.set(url, promise)
    if (artworkCache.size > ARTWORK_CACHE) artworkCache.delete(artworkCache.keys().next().value)
    return promise
  }

  // The last state the panel was sent: what the panel is showing when it sends a command.
  let shown = null
  const show = (state) => (shown = state)

  const active = async () => (spotify.active ? spotify.active() : spotify)

  // The active backend, if it has one of `features` (devices, queue, search, playlists).
  const needs = async (...features) => {
    const backend = await active()
    if (!features.some((feature) => backend.capabilities?.[feature])) throw new SpotifyError('unsupported', 'This needs the Spotify Web API. Switch to it in the panel.')
    return backend
  }

  // Runs an action that changes playback, then reads the state once it had time to show.
  const thenState = async (action) => {
    await action()
    await delay((await active()).settle.stepMs)
    return show(await spotify.getState())
  }

  const info = async () => {
    const backend = await active()
    return {
      id: backend.id,
      capabilities: backend.capabilities,
      available: platform === 'darwin' ? ['applescript', 'webapi'] : ['webapi'],
      connection: auth ? await auth.connection() : null
    }
  }

  return {
    'player.state': async () => show(await spotify.getState()),

    'player.command': async (input) => {
      const { cmd, value } = input ?? {}
      if (!COMMAND_NAMES.includes(cmd)) throw new Error(`Unknown command: ${cmd}`)
      try {
        const before = shown?.track ? shown : undefined
        return show((await runAndSettle(spotify, cmd, value, { before })).state)
      } catch (error) {
        return errorState(error)
      }
    },

    'player.artwork': async (input) => {
      const url = input?.url
      // Only Spotify's image hosts: the panel must not turn the worker into a general fetcher.
      if (typeof url !== 'string' || !ARTWORK_HOSTS.some((host) => host.test(url))) return { url: url ?? null, dataUrl: null }
      return { url, dataUrl: await artwork(url) }
    },

    'backend.info': info,

    'backend.select': async (input) => {
      await spotify.select(input?.backend)
      return info()
    },

    // Reported, not thrown: the setup view shows the sentence next to the field.
    'auth.start': async (input) => {
      try {
        return await auth.start(input?.clientId === undefined ? {} : { clientId: input.clientId })
      } catch (error) {
        return { url: null, message: classifyError(error).message }
      }
    },

    'auth.status': () => auth.status(),

    'auth.disconnect': () => auth.disconnect(),

    'player.devices': async () => (await needs('devices')).devices(),

    'player.transfer': async (input) => {
      const deviceId = input?.deviceId
      if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 128) throw bad('Pick a device to play on.')
      const backend = await needs('devices')
      return thenState(() => backend.transfer(deviceId, Boolean(input.play)))
    },

    'player.queue': async () => (await needs('queue')).queue(),

    'player.enqueue': async (input) => {
      const uri = spotifyUri(input?.uri, ITEM_KINDS)
      await (await needs('queue')).enqueue(uri)
      return { ok: true }
    },

    'player.playContext': async (input) => {
      const { contextUri, uris, offset } = input ?? {}
      let request
      if (contextUri !== undefined) {
        request = { contextUri: spotifyUri(contextUri, CONTEXT_KINDS) }
        if (offset !== undefined) request.offset = offsetOf(offset, 10_000)
      } else {
        if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_URIS) throw bad(`Send 1 to ${MAX_URIS} track URIs.`)
        request = { uris: uris.map((uri) => spotifyUri(uri, ITEM_KINDS)) }
      }
      // Search and playlists are where something gets played from.
      const backend = await needs('search', 'playlists')
      return thenState(() => backend.playContext(request))
    },

    'library.search': async (input) => {
      const q = typeof input?.q === 'string' ? input.q.trim() : ''
      if (!q || q.length > 200) throw bad('Type something to search for.')
      const types = input.types ?? SEARCH_TYPES
      if (!Array.isArray(types) || types.length === 0 || !types.every((type) => SEARCH_TYPES.includes(type))) {
        throw bad(`Search type must be one of ${SEARCH_TYPES.join(', ')}.`)
      }
      const offset = offsetOf(input.offset)
      return (await needs('search')).search(q, [...new Set(types)], offset)
    },

    'library.playlists': async (input) => (await needs('playlists')).playlists(offsetOf(input?.offset, 10_000))
  }
}
