// Spotify desktop on macOS, driven through osascript. Every script checks
// `application "Spotify" is running` first so nothing here launches Spotify except the explicit
// `open` command.
import { execFile } from 'node:child_process'
import { MESSAGES, PLAYABLE_URI, REPEAT_MODES, SpotifyError, errorState, isAppMissing } from '../src/backend.mjs'

const BUNDLE_ID = 'com.spotify.client'
const SEP = '\u001f'
const TIMEOUT_MS = 3000

// One osascript round trip for the whole state. Position is rounded to ms in
// AppleScript because reals are formatted with the locale's decimal separator.
const STATE_SCRIPT = [
  'if application "Spotify" is not running then return "closed"',
  'tell application "Spotify"',
  '  set sep to ASCII character 31',
  '  set playerState to player state as string',
  '  set head to "running" & sep & playerState & sep & sound volume & sep & shuffling & sep & repeating',
  '  if playerState is "stopped" then return head',
  '  set t to current track',
  '  set artworkLink to ""',
  '  try',
  '    set artworkLink to artwork url of t',
  '  end try',
  '  return head & sep & (name of t) & sep & (artist of t) & sep & (album of t) & sep & (duration of t) & sep & (round ((player position) * 1000)) & sep & artworkLink & sep & (id of t)',
  'end tell'
]

const COMMANDS = {
  playpause: () => 'playpause',
  play: () => 'play',
  pause: () => 'pause',
  next: () => 'next track',
  previous: () => 'previous track',
  toggleShuffle: () => 'set shuffling to not shuffling',
  toggleRepeat: () => 'set repeating to not repeating',
  // The desktop app only knows on/off: both 'context' and 'track' mean repeating.
  setRepeat: (mode) => {
    if (!REPEAT_MODES.includes(mode)) throw new SpotifyError('invalid', `Unknown repeat mode: ${mode}`)
    return `set repeating to ${mode !== 'off'}`
  },
  setVolume: (value) => {
    const volume = Math.round(Number(value))
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
      throw new SpotifyError('invalid', 'Volume must be a number from 0 to 100.')
    }
    return `set sound volume to ${volume}`
  },
  // Milliseconds in, whole seconds out: AppleScript reads a decimal point by the system locale.
  seek: (value) => {
    const seconds = Math.round(Number(value) / 1000)
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new SpotifyError('invalid', 'Position must be a number of milliseconds.')
    }
    return `set player position to ${seconds}`
  },
  // The URI goes inside the script, so only the strict Spotify URI shape gets through.
  playUri: (uri) => {
    if (typeof uri !== 'string' || !PLAYABLE_URI.test(uri)) {
      throw new SpotifyError('invalid', 'Expected a Spotify URI such as spotify:album:…')
    }
    return `play track "${uri}"`
  }
}

export const CAPABILITIES = Object.freeze({
  repeatModes: ['off', 'context'],
  seekStepMs: 1000,
  volume: true,
  open: true,
  devices: false,
  queue: false,
  search: false,
  playlists: false,
  library: false,
  home: false,
  needsAuth: false,
  poll: { playing: 1000, paused: 1000, hidden: 4000 }
})

// Spotify applies an Apple Event a moment after it returns; re-read quickly a few times.
const SETTLE = Object.freeze({ tries: 6, stepMs: 80 })

export function parseState(output) {
  const fields = output.replace(/\r?\n$/, '').split(SEP)
  if (fields[0] !== 'running') return { status: 'closed', message: MESSAGES.closed }
  const [, state, volume, shuffle, repeat, title, artist, album, durationMs, positionMs, artworkUrl, uri] = fields
  const base = {
    status: state === 'playing' || state === 'paused' ? state : 'stopped',
    volume: Number(volume),
    shuffle: shuffle === 'true',
    repeat: repeat === 'true' ? 'context' : 'off'
  }
  if (title === undefined) return { ...base, track: null }
  return {
    ...base,
    track: {
      title,
      artist,
      album,
      uri,
      durationMs: Number(durationMs),
      artworkUrl: artworkUrl || null
    },
    positionMs: Number(positionMs)
  }
}

// Maps an osascript failure to the cases the UI explains to the user.
export function classifyOsascriptError(error) {
  if (error instanceof SpotifyError) return error
  if (error?.killed || error?.signal === 'SIGTERM') return new SpotifyError('timeout', MESSAGES.timeout)
  const code = /\((-?\d+)\)\s*$/m.exec(String(error?.stderr ?? error?.message ?? ''))?.[1]
  if (code === '-1743') return new SpotifyError('permission', MESSAGES.permission)
  if (code === '-600') return new SpotifyError('closed', MESSAGES.closed)
  const detail = String(error?.stderr || error?.message || error).trim()
  return new SpotifyError('error', `Spotify could not be controlled: ${detail}`)
}

export function createAppleScriptBackend({ exec = execFile, platform = process.platform } = {}) {
  const run = (file, args) =>
    new Promise((resolve, reject) => {
      exec(file, args, { timeout: TIMEOUT_MS }, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stderr: stderr || error.stderr }))
        else resolve(String(stdout))
      })
    })
  const osa = (lines) => run('/usr/bin/osascript', lines.flatMap((line) => ['-e', line]))
  const ensureMac = () => {
    if (platform !== 'darwin') throw new SpotifyError('unsupported', MESSAGES.unsupported)
  }

  return {
    id: 'applescript',
    capabilities: CAPABILITIES,
    settle: SETTLE,

    async getState() {
      if (platform !== 'darwin') return { status: 'unsupported', message: MESSAGES.unsupported }
      try {
        return parseState(await osa(STATE_SCRIPT))
      } catch (error) {
        return errorState(classifyOsascriptError(error))
      }
    },

    // Runs one player command. Resolves to false when Spotify is closed, so callers
    // can say so instead of opening it.
    async command(name, value) {
      ensureMac()
      if (name === 'open') {
        // -g keeps it in the background, so Orca keeps the focus while Spotify starts.
        await run('/usr/bin/open', ['-g', '-b', BUNDLE_ID]).catch((error) => {
          throw isAppMissing(error) ? new SpotifyError('not-installed', MESSAGES.notInstalled) : classifyOsascriptError(error)
        })
        return true
      }
      const build = COMMANDS[name]
      if (!build) throw new SpotifyError('invalid', `Unknown Spotify command: ${name}`)
      const statement = build(value)
      try {
        const out = await osa([
          'if application "Spotify" is not running then return "closed"',
          `tell application "Spotify" to ${statement}`,
          'return "ok"'
        ])
        return out.trim() !== 'closed'
      } catch (error) {
        throw classifyOsascriptError(error)
      }
    }
  }
}
