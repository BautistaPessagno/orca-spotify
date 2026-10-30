// Worker side of the Now Playing panel. Only wired up on an Orca that has the
// panel↔worker channel (stablyai/orca#25129); see worker.mjs.
//
// Messages the panel sends:
//   { type: 'getState' }                       → state
//   { type: 'command', cmd, value? }           → state after the command
//   { type: 'getArtwork', url }                → { url, dataUrl } | { url, dataUrl: null }
import { COMMAND_NAMES, classifyError } from '../backends/applescript.mjs'

// Spotify artwork URLs end in a size-coded image id; 1e02 is the 300×300 variant,
// small enough for one panel message.
const ARTWORK_640 = 'ab67616d0000b273'
const ARTWORK_300 = 'ab67616d00001e02'
const ARTWORK_HOST = 'https://i.scdn.co/'
const ARTWORK_MAX_BYTES = 96 * 1024

export function smallArtworkUrl(url) {
  return url.replace(ARTWORK_640, ARTWORK_300)
}

export function createPanelHandler(spotify, { fetchImpl = globalThis.fetch } = {}) {
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

  return async function handlePanelMessage(message) {
    switch (message?.type) {
      case 'getState':
        return spotify.getState()

      case 'command': {
        if (!COMMAND_NAMES.includes(message.cmd)) throw new Error(`Unknown command: ${message.cmd}`)
        try {
          await spotify.command(message.cmd, message.value)
        } catch (error) {
          const { kind, message: text } = classifyError(error)
          return { status: kind === 'permission' ? 'no-permission' : 'error', message: text }
        }
        return spotify.getState()
      }

      case 'getArtwork': {
        const { url } = message
        // Only Spotify's CDN: the panel must not turn the worker into a general fetcher.
        if (typeof url !== 'string' || !url.startsWith(ARTWORK_HOST)) return { url, dataUrl: null }
        if (artwork.url !== url) artwork = { url, promise: loadArtwork(url).catch(() => null) }
        return { url, dataUrl: await artwork.promise }
      }

      default:
        throw new Error(`Unknown panel message: ${message?.type}`)
    }
  }
}
