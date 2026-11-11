// Apple's Music app on macOS, driven through osascript like the Spotify desktop app. Every
// script checks `application "Music" is running` first so nothing here launches Music except the
// explicit `open` command.
//
// Music's dictionary differs from Spotify's: durations and positions are seconds (reals), repeat
// is `song repeat` (off, one, all), shuffle is `shuffle enabled`, and artwork is image data on the
// track instead of a URL. Read it with `sdef /System/Applications/Music.app`.
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MUSIC_MESSAGES, REPEAT_MODES, SpotifyError, errorState, isAppMissing } from '../src/backend.mjs'

const SEP = '\u001f'
const TIMEOUT_MS = 3000
// Reading and shrinking a cover can take longer than a state read on a busy Mac.
const ARTWORK_TIMEOUT_MS = 8000
const ARTWORK_PX = 300
const ARTWORK_CACHE = 32

// What the panel asks `player.artwork` for: the track's persistent ID, never a path or a URL.
export const ARTWORK_PREFIX = 'applemusic-artwork:'
const PERSISTENT_ID = /^[0-9A-F]{16}$/

// One osascript round trip for the whole state. Duration and position are rounded to ms in
// AppleScript because reals are formatted with the locale's decimal separator ("228,5" in many
// locales). A radio stream or a missing value leaves its field empty instead of failing the read.
// Artwork is only counted here; its bytes are read once per track, by `artwork()`.
const STATE_SCRIPT = [
  'if application "Music" is not running then return "closed"',
  'tell application "Music"',
  '  set sep to ASCII character 31',
  '  set playerState to player state as string',
  '  set head to "running" & sep & playerState & sep & sound volume & sep & shuffle enabled & sep & (song repeat as string)',
  '  if playerState is "stopped" then return head',
  '  try',
  '    set t to current track',
  '  on error',
  '    return head',
  '  end try',
  '  set durationMs to ""',
  '  try',
  '    set durationMs to round ((duration of t) * 1000)',
  '  end try',
  '  set positionMs to ""',
  '  try',
  '    set positionMs to round ((player position) * 1000)',
  '  end try',
  '  set trackId to ""',
  '  try',
  '    set trackId to persistent ID of t',
  '  end try',
  '  set artCount to 0',
  '  try',
  '    set artCount to count of artworks of t',
  '  end try',
  '  return head & sep & (name of t) & sep & (artist of t) & sep & (album of t) & sep & durationMs & sep & positionMs & sep & trackId & sep & artCount',
  'end tell'
]

// Music's repeat modes, by the names the shared REPEAT_MODES use.
const TO_MUSIC_REPEAT = { off: 'off', context: 'all', track: 'one' }
const FROM_MUSIC_REPEAT = { off: 'off', all: 'context', one: 'track' }

const COMMANDS = {
  playpause: () => 'playpause',
  play: () => 'play',
  pause: () => 'pause',
  next: () => 'next track',
  // What Music's own ⏮ does: back to the start, or to the previous track when already there.
  previous: () => 'back track',
  toggleShuffle: () => 'set shuffle enabled to not shuffle enabled',
  toggleRepeat: () => 'if song repeat is off then\nset song repeat to all\nelse\nset song repeat to off\nend if',
  setRepeat: (mode) => {
    if (!REPEAT_MODES.includes(mode)) throw new SpotifyError('invalid', `Unknown repeat mode: ${mode}`)
    return `set song repeat to ${TO_MUSIC_REPEAT[mode]}`
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
    if (!Number.isFinite(seconds) || Number(value) < 0) {
      throw new SpotifyError('invalid', 'Position must be a number of milliseconds.')
    }
    return `set player position to ${seconds}`
  },
  playUri: () => {
    throw new SpotifyError('unsupported', MUSIC_MESSAGES.noSpotify)
  }
}

export const CAPABILITIES = Object.freeze({
  repeatModes: ['off', 'context', 'track'],
  seekStepMs: 1000,
  volume: true,
  open: true,
  // The cover comes from `artwork(id)` through `player.artwork`, not from a URL.
  artwork: 'data',
  playUri: false,
  devices: false,
  queue: false,
  search: false,
  playlists: false,
  library: false,
  home: false,
  needsAuth: false,
  poll: { playing: 1000, paused: 1000, hidden: 4000 }
})

const SETTLE = Object.freeze({ tries: 6, stepMs: 80 })

const number = (text) => (text === '' || text === undefined ? null : Number(text))

export function parseState(output) {
  const fields = output.replace(/\r?\n$/, '').split(SEP)
  if (fields[0] !== 'running') return { status: 'closed', message: MUSIC_MESSAGES.closed }
  const [, state, volume, shuffle, repeat, title, artist, album, durationMs, positionMs, id, artCount] = fields
  const base = {
    // "fast forwarding" and "rewinding" are still a track that plays.
    status: state === 'paused' ? 'paused' : state === 'stopped' ? 'stopped' : 'playing',
    volume: Number(volume),
    shuffle: shuffle === 'true',
    repeat: FROM_MUSIC_REPEAT[repeat] ?? 'off'
  }
  if (title === undefined) return { ...base, track: null }
  const trackId = PERSISTENT_ID.test(id ?? '') ? id : null
  return {
    ...base,
    track: {
      title,
      artist,
      album,
      // Not a Spotify URI: it tells tracks apart (settling a skip, the status bar) and no more.
      uri: trackId ? `applemusic:track:${trackId}` : null,
      id: trackId,
      durationMs: number(durationMs) ?? 0,
      artworkUrl: trackId && Number(artCount) > 0 ? ARTWORK_PREFIX + trackId : null
    },
    positionMs: number(positionMs) ?? 0
  }
}

// Maps an osascript failure to the cases the UI explains to the user.
export function classifyOsascriptError(error) {
  if (error instanceof SpotifyError) return error
  if (error?.killed || error?.signal === 'SIGTERM') return new SpotifyError('timeout', MUSIC_MESSAGES.timeout)
  const code = /\((-?\d+)\)\s*$/m.exec(String(error?.stderr ?? error?.message ?? ''))?.[1]
  if (code === '-1743') return new SpotifyError('permission', MUSIC_MESSAGES.permission)
  if (code === '-600') return new SpotifyError('closed', MUSIC_MESSAGES.closed)
  const detail = String(error?.stderr || error?.message || error).trim()
  return new SpotifyError('error', `Music could not be controlled: ${detail}`)
}

// Writes the current track's first artwork to `path`, if it is still the track `id`. `raw data`
// is the image as Music stores it (JPEG or PNG), which `sips` reads.
const artworkScript = (id, path) => [
  'if application "Music" is not running then return "closed"',
  'tell application "Music"',
  '  set t to current track',
  `  if persistent ID of t is not "${id}" then return "changed"`,
  '  if (count of artworks of t) is 0 then return "none"',
  '  set imageData to raw data of artwork 1 of t',
  'end tell',
  `set f to open for access (POSIX file "${path}") with write permission`,
  'try',
  '  set eof f to 0',
  '  write imageData to f',
  'end try',
  'close access f',
  'return "ok"'
]

export function createAppleMusicBackend({ exec = execFile, platform = process.platform, tmp = tmpdir } = {}) {
  const run = (file, args, timeout = TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      exec(file, args, { timeout }, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stderr: stderr || error.stderr }))
        else resolve(String(stdout))
      })
    })
  const osa = (lines, timeout) => run('/usr/bin/osascript', lines.flatMap((line) => ['-e', line]), timeout)
  const ensureMac = () => {
    if (platform !== 'darwin') throw new SpotifyError('unsupported', MUSIC_MESSAGES.unsupported)
  }

  // The cover of the track playing now, as a 300 px JPEG data URL, or null when it has none.
  // Read once per track: the state only says whether there is one.
  const readArtwork = async (id) => {
    const dir = await mkdtemp(join(tmp(), 'now-playing-art-'))
    const original = join(dir, 'original')
    const small = join(dir, 'small.jpg')
    try {
      const out = (await osa(artworkScript(id, original), ARTWORK_TIMEOUT_MS)).trim()
      if (out === 'none') return { dataUrl: null, keep: true }
      if (out !== 'ok') return { dataUrl: null, keep: false }
      // sips ships with macOS: shrink to fit one panel reply, whatever size Music stored.
      await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '-Z', String(ARTWORK_PX), original, '--out', small], ARTWORK_TIMEOUT_MS)
      const bytes = await readFile(small)
      return { dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`, keep: true }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  // By persistent ID; a read that found another track playing is not kept, so it can be asked again.
  const artworkCache = new Map()

  return {
    id: 'applemusic',
    capabilities: CAPABILITIES,
    settle: SETTLE,

    async getState() {
      if (platform !== 'darwin') return { status: 'unsupported', message: MUSIC_MESSAGES.unsupported }
      try {
        return parseState(await osa(STATE_SCRIPT))
      } catch (error) {
        return errorState(classifyOsascriptError(error))
      }
    },

    // Resolves to null for anything but a persistent ID, or when the cover can't be read.
    async artwork(id) {
      if (platform !== 'darwin' || typeof id !== 'string' || !PERSISTENT_ID.test(id)) return null
      let entry = artworkCache.get(id)
      if (entry) artworkCache.delete(id)
      else {
        entry = readArtwork(id).catch(() => ({ dataUrl: null, keep: false }))
        entry.then(({ keep }) => {
          if (!keep && artworkCache.get(id) === entry) artworkCache.delete(id)
        })
      }
      artworkCache.set(id, entry)
      if (artworkCache.size > ARTWORK_CACHE) artworkCache.delete(artworkCache.keys().next().value)
      return (await entry).dataUrl
    },

    // Runs one player command. Resolves to false when Music is closed, so callers can say so
    // instead of opening it.
    async command(name, value) {
      ensureMac()
      if (name === 'open') {
        // -g keeps it in the background, so Orca keeps the focus while Music starts.
        await run('/usr/bin/open', ['-g', '-b', 'com.apple.Music']).catch((error) => {
          throw isAppMissing(error) ? new SpotifyError('not-installed', MUSIC_MESSAGES.notInstalled) : classifyOsascriptError(error)
        })
        return true
      }
      const build = COMMANDS[name]
      if (!build) throw new SpotifyError('invalid', `Unknown Music command: ${name}`)
      const statement = build(value)
      try {
        const out = await osa([
          'if application "Music" is not running then return "closed"',
          'tell application "Music"',
          ...statement.split('\n'),
          'end tell',
          'return "ok"'
        ])
        return out.trim() !== 'closed'
      } catch (error) {
        throw classifyOsascriptError(error)
      }
    }
  }
}
