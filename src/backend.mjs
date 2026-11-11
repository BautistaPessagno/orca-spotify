// What every backend shares: command names, the sentences the UI shows, and the error type.
//
//   Backend {
//     id            'applescript' | 'webapi' | 'applemusic'
//     capabilities  what the panel may draw (repeat modes, seek step, tabs, poll intervals)
//     settle        { tries, stepMs } for runAndSettle
//     getState()    normalized state, never rejects
//     command(name, value)  false when there is no player to send it to
//   }
//
// `seek` takes milliseconds on every backend; AppleScript rounds to whole seconds.
// `playUri` plays a Spotify URI on both Spotify backends: a track alone, or an album, playlist or
// artist. Apple Music refuses it (MUSIC_MESSAGES.noSpotify).

export const COMMAND_NAMES = Object.freeze([
  'playpause',
  'play',
  'pause',
  'next',
  'previous',
  'toggleShuffle',
  'toggleRepeat',
  'setRepeat',
  'setVolume',
  'seek',
  'open',
  'playUri'
])

// What `playUri` takes: a track, episode, album, playlist or artist. Strict, because the
// AppleScript backend puts it inside a script.
export const PLAYABLE_URI = /^spotify:(track|episode|album|playlist|artist):[A-Za-z0-9]{1,64}$/

export const REPEAT_MODES = Object.freeze(['off', 'context', 'track'])

export const BACKEND_IDS = Object.freeze(['applescript', 'webapi', 'applemusic'])

// The two services the panel's switch moves between. Spotify is reached through the backend the
// `backend` setting picks; Apple Music has one backend, the Music app on a Mac.
export const SERVICES = Object.freeze(['spotify', 'applemusic'])

export const serviceOf = (backendId) => (backendId === 'applemusic' ? 'applemusic' : 'spotify')

// What a search can look for (backends with the `search` capability).
export const SEARCH_TYPES = Object.freeze(['track', 'album', 'artist', 'playlist', 'show', 'episode'])

export const MESSAGES = Object.freeze({
  unsupported: 'Now Playing controls the Spotify desktop app, which it can only reach on macOS.',
  closed: 'Spotify is not open. Open the Spotify desktop app and try again.',
  permission:
    'Orca is not allowed to control Spotify. Open System Settings → Privacy & Security → Automation, turn on Spotify under Orca, then try again.',
  timeout: 'Spotify did not answer within 3 seconds.',
  needsSetup: 'Open the Now Playing panel to connect your Spotify account.',
  unauthenticated: 'Open the Now Playing panel to connect your Spotify account.',
  noDevice: 'No Spotify device is active. Open Spotify on any device.',
  premium: 'Needs Spotify Premium, and your account must be on the app’s user list.',
  rateLimited: 'Spotify asked Now Playing to slow down. It tries again in a moment.',
  quota: 'Your Spotify app’s request quota ran out. Now Playing tries again in 5 minutes.',
  noOpen: 'The Spotify Web API can’t open Spotify. Open it on any device.',
  needsScopes: 'Reconnect Spotify to turn on Home, your library and Liked Songs.',
  notInstalled: 'Spotify is not installed on this Mac.',
  cantStart: 'Now Playing can’t start Spotify on this computer. Open it on any device, or use the web player.'
})

// What the Apple Music backend says instead, so no Spotify wording shows while it is selected.
export const MUSIC_MESSAGES = Object.freeze({
  unsupported: 'Apple Music works through the Music app on macOS, so Now Playing can’t reach it on this computer. Switch to Spotify instead.',
  closed: 'Music is not open. Open the Music app and try again.',
  permission:
    'Orca is not allowed to control Music. Open System Settings → Privacy & Security → Automation, turn on Music under Orca, then try again.',
  timeout: 'Music did not answer within 3 seconds.',
  notInstalled: 'The Music app was not found on this Mac.',
  noSpotify: 'Apple Music can’t play Spotify links or URIs. Switch to Spotify in the Now Playing panel to play them.',
  // Search, the queue, devices, playlists, Home and likes: what the Web API adds for Spotify.
  lacks: 'Apple Music can’t do that from Now Playing: it plays, pauses, skips, seeks and sets volume, shuffle and repeat in the Music app. Switch to Spotify for search, the queue, devices and your library.'
})

export class SpotifyError extends Error {
  constructor(kind, message, extra) {
    super(message)
    this.kind = kind
    if (extra) Object.assign(this, extra)
  }
}

// What /usr/bin/open prints when there is no such app: by name, or by bundle id.
const APP_MISSING = /Unable to find application|LSCopyApplicationURLsForBundleIdentifier\(\) failed|cannot be found/i

export const isAppMissing = (error) => APP_MISSING.test(String(error?.stderr ?? error?.message ?? ''))

// Anything a backend throws, as a SpotifyError the UI can explain.
export function classifyError(error) {
  if (error instanceof SpotifyError) return error
  const detail = String(error?.message || error).trim()
  return new SpotifyError('error', `Spotify could not be controlled: ${detail}`)
}

// Error kinds that are also a panel state of their own; the rest show as 'error'.
const STATUS_BY_KIND = {
  closed: 'closed',
  permission: 'no-permission',
  unsupported: 'unsupported',
  'needs-setup': 'needs-setup',
  unauthenticated: 'unauthenticated',
  'no-device': 'no-device',
  'rate-limited': 'rate-limited'
}

export function errorState(error) {
  const { kind, message, retryAfterMs } = classifyError(error)
  const state = { status: STATUS_BY_KIND[kind] ?? 'error', message }
  if (retryAfterMs !== undefined) state.retryAfterMs = retryAfterMs
  return state
}
