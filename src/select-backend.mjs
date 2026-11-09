// One Backend that forwards to the backend the settings pick. It reads them on every call: Orca
// has no settings-changed event a worker can rely on, and the read is local. When the choice
// changes, the next state carries the new `backend` id and the panel resets.
//
// Two settings, so that switching to Apple Music and back keeps the Spotify backend you had:
//   service   'spotify' (default) | 'applemusic'
//   backend   which way to reach Spotify: 'auto' (default) | 'applescript' | 'webapi'
import { BACKEND_IDS, MESSAGES, MUSIC_MESSAGES, SpotifyError } from './backend.mjs'

export function resolveBackendId(choice, platform, service) {
  if (service === 'applemusic') return 'applemusic'
  if (choice === 'applescript' || choice === 'webapi') return choice
  return platform === 'darwin' ? 'applescript' : 'webapi'
}

// The desktop apps are reached with osascript, so only on a Mac.
const NEEDS_MAC = { applescript: MESSAGES.unsupported, applemusic: MUSIC_MESSAGES.unsupported }

export function createBackendSelector({ backends, settings, platform = process.platform }) {
  let current = backends[resolveBackendId(undefined, platform)]

  const read = (key) => Promise.resolve(settings.get(key)).catch(() => undefined)

  const active = async () => {
    const [service, choice] = await Promise.all([read('service'), read('backend')])
    current = backends[resolveBackendId(choice, platform, backends.applemusic ? service : undefined)]
    return current
  }

  // Chosen by hand off macOS: say so instead of running osascript.
  const usable = (id) => !NEEDS_MAC[id] || platform === 'darwin'

  return {
    active,
    get id() {
      return current.id
    },
    get capabilities() {
      return current.capabilities
    },
    get settle() {
      return current.settle
    },

    async getState() {
      const backend = await active()
      if (!usable(backend.id)) return { backend: backend.id, status: 'unsupported', message: NEEDS_MAC[backend.id] }
      return { ...(await backend.getState()), backend: backend.id }
    },

    async command(name, value) {
      const backend = await active()
      if (!usable(backend.id)) throw new SpotifyError('unsupported', NEEDS_MAC[backend.id])
      return backend.command(name, value)
    },

    // The panel's switch and links. 'spotify' goes back to whichever Spotify backend the
    // `backend` setting holds; 'applescript' and 'webapi' pick one and also mean Spotify.
    async select(id) {
      if (id !== 'spotify' && !BACKEND_IDS.includes(id)) throw new SpotifyError('invalid', `Unknown backend: ${id}`)
      if (!usable(id)) throw new SpotifyError('unsupported', NEEDS_MAC[id])
      if (id === 'applemusic') {
        await settings.set('service', 'applemusic')
        return active()
      }
      if (id !== 'spotify') await settings.set('backend', id)
      await settings.set('service', 'spotify')
      return active()
    }
  }
}
