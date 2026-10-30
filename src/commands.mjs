// Palette commands. Orca shows a command's string result as-is, so every handler
// answers with a sentence, including the "Spotify is closed" and permission cases.
import { MESSAGES, classifyError } from '../backends/applescript.mjs'

// Spotify swaps the current track a moment after next/previous returns.
const TRACK_CHANGE_DELAY_MS = 350

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function describe(state) {
  if (state.message) return state.message
  if (!state.track) return 'Nothing is playing in Spotify.'
  const { title, artist } = state.track
  const label = artist ? `${title} · ${artist}` : title
  return state.status === 'paused' ? `Paused: ${label}` : label
}

export function createCommands(spotify, { delay = wait } = {}) {
  // Runs a player command, then answers with the state it left Spotify in.
  const control = (name, summarize = describe, settleMs = 0) => async () => {
    try {
      if (!(await spotify.command(name))) return MESSAGES.closed
    } catch (error) {
      return classifyError(error).message
    }
    if (settleMs) await delay(settleMs)
    const state = await spotify.getState()
    return state.message ?? summarize(state)
  }

  return {
    playpause: control('playpause'),
    next: control('next', describe, TRACK_CHANGE_DELAY_MS),
    previous: control('previous', describe, TRACK_CHANGE_DELAY_MS),
    now: async () => describe(await spotify.getState()),
    toggleShuffle: control('toggleShuffle', (state) => `Shuffle ${state.shuffle ? 'on' : 'off'}`)
  }
}
