// Palette commands. Orca shows a command's string result as-is, so every handler
// answers with a sentence, including the "Spotify is closed", permission, not-connected and
// no-device cases.
import { MESSAGES, classifyError } from './backend.mjs'
import { runAndSettle } from './settle.mjs'

export function describe(state) {
  if (state.message) return state.message
  if (!state.track) return 'Nothing is playing in Spotify.'
  const { title, artist } = state.track
  const label = artist ? `${title} · ${artist}` : title
  return state.status === 'paused' ? `Paused: ${label}` : label
}

export function createCommands(spotify, options) {
  // Runs a player command, then answers with the state it left Spotify in.
  const control = (name, summarize = describe) => async () => {
    try {
      const { ran, state } = await runAndSettle(spotify, name, undefined, options)
      // No player to send it to: the backend's state says why (closed app, no active device).
      if (!ran) return state.message ?? MESSAGES.closed
      return state.message ?? summarize(state)
    } catch (error) {
      return classifyError(error).message
    }
  }

  return {
    playpause: control('playpause'),
    next: control('next'),
    previous: control('previous'),
    now: async () => describe(await spotify.getState()),
    toggleShuffle: control('toggleShuffle', (state) => `Shuffle ${state.shuffle ? 'on' : 'off'}`)
  }
}
