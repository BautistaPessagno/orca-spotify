// Spotify applies a command a moment after it is accepted (the Apple Event returns, or the Web
// API answers 204), so a state read right away can still show the old track or play state.
// Re-read until the command shows, as often and as far apart as the backend's `settle` says.
const DEFAULT_SETTLE = { tries: 6, stepMs: 80 }

const trackChanged = (before, after) => before.track?.uri !== after.track?.uri

// Whether `after` shows the command. Commands that need the prior state list it in NEEDS_BEFORE.
const applied = {
  play: (_before, after) => after.status === 'playing',
  pause: (_before, after) => after.status === 'paused',
  playpause: (before, after) => before.status !== after.status,
  next: trackChanged,
  // Past the first seconds, "previous" restarts the same track instead of changing it.
  previous: (before, after) =>
    trackChanged(before, after) || (after.positionMs ?? 0) < (before.positionMs ?? 0)
}
const NEEDS_BEFORE = new Set(['playpause', 'next', 'previous'])

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Runs one command and resolves to { ran, state }; ran is false when there is no player to
// send it to (Spotify closed, or no active Web API device).
// Pass `before` when the caller already knows the current state, to skip reading it first.
export async function runAndSettle(spotify, name, value, { before, delay = wait } = {}) {
  const isApplied = applied[name]
  if (isApplied && NEEDS_BEFORE.has(name) && !before) before = await spotify.getState()
  const ran = await spotify.command(name, value)
  let state = await spotify.getState()
  if (!ran || !isApplied) return { ran, state }
  const { tries, stepMs } = spotify.settle ?? DEFAULT_SETTLE
  for (let i = 0; i < tries && !state.message && !isApplied(before, state); i++) {
    await delay(stepMs)
    state = await spotify.getState()
  }
  return { ran, state }
}
