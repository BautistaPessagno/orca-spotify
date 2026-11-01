// Worker side of the Now Playing panel: the handlers the panel calls with
// `orca.plugin.request(name, input)`. worker.mjs registers each with `orca.panels.handle`.
//
//   player.state                    → state
//   player.command  { cmd, value? } → state after the command
//   player.artwork  { url }         → { url, dataUrl } | { url, dataUrl: null }
import { COMMAND_NAMES, classifyError } from '../backends/applescript.mjs'
import { runAndSettle } from './settle.mjs'

// Spotify artwork URLs end in a size-coded image id; 1e02 is the 300×300 variant,
// small enough for one panel reply.
const ARTWORK_640 = 'ab67616d0000b273'
const ARTWORK_300 = 'ab67616d00001e02'
const ARTWORK_HOST = 'https://i.scdn.co/'
const ARTWORK_MAX_BYTES = 96 * 1024

export function smallArtworkUrl(url) {
  return url.replace(ARTWORK_640, ARTWORK_300)
}

export function createPanelHandlers(spotify, { fetchImpl = globalThis.fetch } = {}) {
  // One track's artwork is asked for repeatedly while it plays; keep the last one.
  let artwork = { url: null, promise: null }

  const loadArtwork = async (url) => {
    const response = await fetchImpl(smallArtworkUrl(url), { signal: AbortSignal.timeout(5000) })
    if (!response.ok) return null
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > ARTWORK_MAX_BYTES) return null
    const type = response.headers.get('content-type') || 'image/jpeg'
    return `data:${type};base64,${bytes.toString('base64')}`
  }

  // The last state the panel was sent: what the panel is showing when it sends a command.
  let shown = null
  const show = (state) => (shown = state)

  return {
    'player.state': async () => show(await spotify.getState()),

    'player.command': async (input) => {
      const { cmd, value } = input ?? {}
      if (!COMMAND_NAMES.includes(cmd)) throw new Error(`Unknown command: ${cmd}`)
      try {
        const before = shown?.track ? shown : undefined
        return show((await runAndSettle(spotify, cmd, value, { before })).state)
      } catch (error) {
        const { kind, message } = classifyError(error)
        return { status: kind === 'permission' ? 'no-permission' : 'error', message }
      }
    },

    'player.artwork': async (input) => {
      const url = input?.url
      // Only Spotify's CDN: the panel must not turn the worker into a general fetcher.
      if (typeof url !== 'string' || !url.startsWith(ARTWORK_HOST)) return { url: url ?? null, dataUrl: null }
      if (artwork.url !== url) artwork = { url, promise: loadArtwork(url).catch(() => null) }
      return { url, dataUrl: await artwork.promise }
    }
  }
}
