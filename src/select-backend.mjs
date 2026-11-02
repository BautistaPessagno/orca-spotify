// One Backend that forwards to the backend the `backend` setting picks. It reads the setting on
// every call: Orca has no settings-changed event a worker can rely on, and the read is local.
// When the choice changes, the next state carries the new `backend` id and the panel resets.
import { BACKEND_IDS, MESSAGES, SpotifyError } from './backend.mjs'

export function resolveBackendId(choice, platform) {
  if (choice === 'applescript' || choice === 'webapi') return choice
  return platform === 'darwin' ? 'applescript' : 'webapi'
}

export function createBackendSelector({ backends, settings, platform = process.platform }) {
  let current = backends[resolveBackendId(undefined, platform)]

  const active = async () => {
    const choice = await Promise.resolve(settings.get('backend')).catch(() => undefined)
    current = backends[resolveBackendId(choice, platform)]
    return current
  }

  // AppleScript is chosen by hand off macOS: say so instead of running osascript.
  const usable = (backend) => backend.id !== 'applescript' || platform === 'darwin'

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
      if (!usable(backend)) return { backend: backend.id, status: 'unsupported', message: MESSAGES.unsupported }
      return { ...(await backend.getState()), backend: backend.id }
    },

    async command(name, value) {
      const backend = await active()
      if (!usable(backend)) throw new SpotifyError('unsupported', MESSAGES.unsupported)
      return backend.command(name, value)
    },

    async select(id) {
      if (!BACKEND_IDS.includes(id)) throw new SpotifyError('invalid', `Unknown backend: ${id}`)
      if (!usable({ id })) throw new SpotifyError('unsupported', MESSAGES.unsupported)
      await settings.set('backend', id)
      return active()
    }
  }
}
