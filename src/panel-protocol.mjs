// Worker side of the Now Playing panel: the handlers the panel calls with
// `orca.plugin.request(name, input)`. worker.mjs registers each with `orca.panels.handle`.
//
//   player.state                              → state
//   player.command      { cmd, value? }       → state after the command
//   player.artwork      { url }               → { url, dataUrl } | { url, dataUrl: null }
//   backend.info                              → { id, service, capabilities, available, connection }
//   backend.select      { backend }           → backend.info; backend is a BACKEND_IDS id or
//                                               'spotify' (back to the Spotify backend you had)
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
//   library.home                              → { recent, recentTracks, topArtists, topTracks }
//   library.liked       { offset? }           → { items: Track[], total, offset, uri }
//   library.albums      { offset? }           → { items, total, offset }
//   library.artists     { after? }            → { items, after }
//   library.shows       { offset? }           → { items, total, offset }
//   library.page        { uri }               → an album, artist or playlist page
//   library.saved       { uris }              → boolean[] (up to 20)
//   library.save        { uri, saved }        → { saved }
//
// player.devices through library.save need a backend with that capability (the Web API); on
// the Spotify desktop app and on Apple Music they reject with a sentence that says so.
//
// player.artwork takes a Spotify image URL, or the `applemusic-artwork:<persistent id>` the Apple
// Music backend puts in its state, which it answers from the Music app itself.
import { ARTWORK_PREFIX as MUSIC_ARTWORK } from '../backends/applemusic.mjs'
import { COMMAND_NAMES, MUSIC_MESSAGES, SEARCH_TYPES, SpotifyError, classifyError, errorState, serviceOf } from './backend.mjs'
import { runAndSettle } from './settle.mjs'

// AppleScript artwork URLs end in a size-coded image id; 1e02 is the 300×300 variant, small
// enough for one panel reply. Web API URLs are already picked at ~300 px.
const ARTWORK_640 = 'ab67616d0000b273'
const ARTWORK_300 = 'ab67616d00001e02'
// Spotify's image hosts: i.scdn.co, mosaic.scdn.co, thisis-images.scdn.co, *.spotifycdn.com.
const ARTWORK_HOSTS = [/^https:\/\/[a-z0-9-]+\.(scdn\.co|spotifycdn\.com)\//]
const ARTWORK_MAX_BYTES = 96 * 1024
const ARTWORK_CACHE = 64

const URI = /^spotify:(track|album|playlist|artist|episode|show):[A-Za-z0-9]+$/
// Liked Songs as a context: spotify:user:<user id>:collection.
const LIKED = /^spotify:user:[A-Za-z0-9._-]{1,64}:collection$/
const CURSOR = /^[A-Za-z0-9_-]{1,64}$/
const CONTEXT_KINDS = ['album', 'playlist', 'artist']
const ITEM_KINDS = ['track', 'episode']
const PAGE_KINDS = ['album', 'artist', 'playlist']
const SAVE_KINDS = ['track', 'album', 'episode', 'show']
const MAX_SAVED_CHECK = 20
const MAX_URIS = 100

// What only the Spotify Web API can do. Apple Music refuses these before reading their input, so
// an agent hears what Apple Music lacks instead of what a Spotify URI looks like.
const SPOTIFY_ONLY = [
  'player.devices',
  'player.transfer',
  'player.queue',
  'player.enqueue',
  'player.playContext',
  'library.search',
  'library.playlists',
  'library.home',
  'library.liked',
  'library.albums',
  'library.artists',
  'library.shows',
  'library.page',
  'library.saved',
  'library.save'
]

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
      service: serviceOf(backend.id),
      capabilities: backend.capabilities,
      // Apple Music and the Spotify desktop app are reached with osascript, so only on a Mac.
      available: platform === 'darwin' ? ['applescript', 'webapi', 'applemusic'] : ['webapi'],
      connection: auth ? await auth.connection() : null
    }
  }

  const handlers = {
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
      // Apple Music: the cover of the track playing now, read from the Music app once per track.
      if (typeof url === 'string' && url.startsWith(MUSIC_ARTWORK)) {
        const backend = await active()
        const dataUrl = backend.id === 'applemusic' && backend.artwork ? await backend.artwork(url.slice(MUSIC_ARTWORK.length)) : null
        return { url, dataUrl }
      }
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
        request = { contextUri: typeof contextUri === 'string' && LIKED.test(contextUri) ? contextUri : spotifyUri(contextUri, CONTEXT_KINDS) }
        if (input.offsetUri !== undefined) request.offsetUri = spotifyUri(input.offsetUri, ITEM_KINDS)
        else if (offset !== undefined) request.offset = offsetOf(offset, 10_000)
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

    'library.playlists': async (input) => (await needs('playlists')).playlists(offsetOf(input?.offset, 10_000)),

    'library.home': async () => (await needs('home')).home(),

    'library.liked': async (input) => (await needs('library')).likedSongs(offsetOf(input?.offset, 10_000)),

    'library.albums': async (input) => (await needs('library')).savedAlbums(offsetOf(input?.offset, 10_000)),

    'library.artists': async (input) => {
      const after = input?.after
      if (after !== undefined && after !== null && !(typeof after === 'string' && CURSOR.test(after))) throw bad('That is not a page cursor.')
      return (await needs('library')).followedArtists(after ?? undefined)
    },

    'library.shows': async (input) => (await needs('library')).savedShows(offsetOf(input?.offset, 10_000)),

    'library.page': async (input) => {
      const uri = spotifyUri(input?.uri, PAGE_KINDS)
      const backend = await needs('library')
      return backend[uri.split(':')[1]](uri)
    },

    'library.saved': async (input) => {
      const uris = input?.uris
      if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_SAVED_CHECK) throw bad(`Check 1 to ${MAX_SAVED_CHECK} URIs at a time.`)
      return (await needs('library')).isSaved(uris.map((uri) => spotifyUri(uri, SAVE_KINDS)))
    },

    'library.save': async (input) => {
      const uri = spotifyUri(input?.uri, SAVE_KINDS)
      if (typeof input.saved !== 'boolean') throw bad('Say whether it should be saved.')
      await (await needs('library')).setSaved(uri, input.saved)
      return { saved: input.saved }
    }
  }

  for (const name of SPOTIFY_ONLY) {
    const handler = handlers[name]
    handlers[name] = async (input, context) => {
      if ((await active()).id === 'applemusic') throw new SpotifyError('unsupported', MUSIC_MESSAGES.lacks)
      return handler(input, context)
    }
  }
  return handlers
}
