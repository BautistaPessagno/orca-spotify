// The Spotify Web API as a Backend: controls whichever Spotify Connect device is active
// (desktop app, phone, speaker). Needs a login (auth.mjs) and Spotify Premium.
import { MESSAGES, REPEAT_MODES, SpotifyError, classifyError, errorState } from '../../src/backend.mjs'
import { createLibrary, toTrack } from './library.mjs'

// The Web API's rate limit is a rolling 30 s window shared by all of the person's Dev Mode
// apps, so poll far less often than AppleScript; the panel interpolates progress in between.
const POLL = Object.freeze({ playing: 5000, paused: 10_000, hidden: 30_000 })
// "Order of execution is not guaranteed": a command can take a moment to show in /me/player.
const SETTLE = Object.freeze({ tries: 2, stepMs: 400 })

const NEXT_REPEAT = { off: 'context', context: 'track', track: 'off' }

const PLAIN = {
  play: ['PUT', '/me/player/play'],
  pause: ['PUT', '/me/player/pause'],
  next: ['POST', '/me/player/next'],
  previous: ['POST', '/me/player/previous']
}

function invalid(message) {
  return new SpotifyError('invalid', message)
}

export function toState(raw) {
  const track = toTrack(raw.item)
  const state = {
    status: track ? (raw.is_playing ? 'playing' : 'paused') : 'stopped',
    volume: raw.device?.volume_percent ?? 0,
    shuffle: Boolean(raw.shuffle_state),
    repeat: REPEAT_MODES.includes(raw.repeat_state) ? raw.repeat_state : 'off',
    track
  }
  if (track) state.positionMs = raw.progress_ms ?? 0
  // What the track plays from (a playlist, album or artist), for the panel's "Playing from".
  if (raw.context?.uri) state.context = { type: raw.context.type, uri: raw.context.uri }
  if (raw.device) {
    state.device = {
      id: raw.device.id,
      name: raw.device.name,
      type: raw.device.type,
      supportsVolume: raw.device.supports_volume !== false
    }
  }
  return state
}

export function createWebApiBackend({ client, auth }) {
  const library = createLibrary(client)
  let last = null // the last state read, shown again (stale) while rate limited

  const read = () => client.request('GET', '/me/player', { query: { additional_types: 'episode' } })

  // Runs `send` and reports whether there was a device to run it on.
  const onDevice = async (send) => {
    try {
      await send()
      return true
    } catch (error) {
      if (error?.kind === 'no-device') return false
      throw error
    }
  }

  // A command that needs the current player state first (no toggle endpoints).
  const withPlayer = (send) =>
    onDevice(async () => {
      const raw = await read()
      if (!raw) throw new SpotifyError('no-device', MESSAGES.noDevice)
      await send(raw)
    })

  const commands = {
    playpause: () => withPlayer((raw) => client.request('PUT', raw.is_playing ? '/me/player/pause' : '/me/player/play')),
    toggleShuffle: () => withPlayer((raw) => client.request('PUT', '/me/player/shuffle', { query: { state: !raw.shuffle_state } })),
    toggleRepeat: () =>
      withPlayer((raw) => client.request('PUT', '/me/player/repeat', { query: { state: NEXT_REPEAT[raw.repeat_state] ?? 'context' } })),
    setRepeat: (mode) => {
      if (!REPEAT_MODES.includes(mode)) throw invalid(`Unknown repeat mode: ${mode}`)
      return onDevice(() => client.request('PUT', '/me/player/repeat', { query: { state: mode } }))
    },
    setVolume: (value) => {
      const volume = Math.round(Number(value))
      if (!Number.isFinite(volume) || volume < 0 || volume > 100) throw invalid('Volume must be a number from 0 to 100.')
      return onDevice(() => client.request('PUT', '/me/player/volume', { query: { volume_percent: volume } }))
    },
    seek: (value) => {
      const ms = Math.round(Number(value))
      if (!Number.isFinite(ms) || ms < 0) throw invalid('Position must be a number of milliseconds.')
      return onDevice(() => client.request('PUT', '/me/player/seek', { query: { position_ms: ms } }))
    },
    open: () => {
      throw new SpotifyError('unsupported', MESSAGES.noOpen)
    }
  }

  return {
    id: 'webapi',
    settle: SETTLE,
    get capabilities() {
      return {
        repeatModes: [...REPEAT_MODES],
        seekStepMs: 1,
        volume: last?.device ? last.device.supportsVolume : true,
        open: false,
        devices: true,
        queue: true,
        search: true,
        playlists: true,
        library: false,
        needsAuth: true,
        poll: POLL
      }
    },

    async getState() {
      let raw
      try {
        raw = await read()
      } catch (error) {
        const reason = classifyError(error)
        // A short rate limit: keep showing what was playing. A spent quota lasts minutes; say so.
        if (reason.kind === 'rate-limited' && !reason.quota && last) {
          return { ...last, stale: true, retryAfterMs: reason.retryAfterMs }
        }
        if (reason.kind !== 'rate-limited') last = null
        return errorState(reason)
      }
      if (!raw) {
        last = null
        return { status: 'no-device', message: MESSAGES.noDevice }
      }
      last = { ...toState(raw), authExpiresSoon: Boolean(await auth?.expiresSoon?.().catch(() => false)) }
      return last
    },

    async command(name, value) {
      if (PLAIN[name]) {
        const [method, path] = PLAIN[name]
        return onDevice(() => client.request(method, path))
      }
      const run = commands[name]
      if (!run) throw invalid(`Unknown Spotify command: ${name}`)
      return run(value)
    },

    ...library
  }
}
