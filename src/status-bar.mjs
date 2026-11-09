// The status bar item: the song that's playing, hidden when nothing is. Having a status bar item
// is also what keeps the worker running while the plugin is enabled, so the agent bridge stays
// reachable without the panel open.
//
// It reads the player on its own only as often as the backend allows (the Spotify desktop app and
// Apple Music: every 5 s; Web API: every 30 s, or when the song should end), and takes every
// state the panel or an agent reads in between for free through `show`. The tooltip names Apple
// Music while it is the one playing; Spotify's stays as it was.
export const ITEM_ID = 'now-playing'
const TEXT_MAX = 64
const TOOLTIP_MAX = 256

const POLL = { applescript: 5000, applemusic: 5000, webapi: 30_000 }
const IDLE_MS = 30_000

const clip = (text, max) => (text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text)

// What the item says for a state; null hides it.
export function statusBarView(state) {
  const track = state?.track
  if (!track || (state.status !== 'playing' && state.status !== 'paused')) return null
  const label = track.artist ? `${track.title} · ${track.artist}` : track.title
  const where = state.device?.name ? ` on ${state.device.name}` : state.backend === 'applemusic' ? ' in Apple Music' : ''
  return {
    text: clip(label, TEXT_MAX),
    icon: state.status === 'playing' ? 'play' : 'pause',
    tone: 'neutral',
    tooltip: clip(`${state.status === 'playing' ? 'Playing' : 'Paused'}: ${track.title}${track.artist ? ` by ${track.artist}` : ''}${where}`, TOOLTIP_MAX)
  }
}

export function createStatusBar({ host, spotify, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
  let timer = null
  let shown = undefined // the last view sent, to skip identical updates
  let stopped = true
  let lastRead = 0

  const update = async (view) => {
    const key = JSON.stringify(view)
    if (key === shown) return
    shown = key
    try {
      await host.call('statusBar.update', view ? { id: ITEM_ID, visible: true, ...view } : { id: ITEM_ID, visible: false })
    } catch (error) {
      // An Orca without status bar updates, or one without a window: nothing to show it in.
      log(`status bar: ${error.code ?? error.message}`)
    }
  }

  // Every state anyone read: the panel, an agent, or this item's own poll.
  const show = (state) => {
    lastRead = now()
    void update(statusBarView(state))
    return state
  }

  const delayAfter = (state) => {
    const base = POLL[spotify.id] ?? POLL.applescript
    if (!state?.track || state.status !== 'playing') return state?.track ? base : Math.max(base, IDLE_MS)
    const left = (state.track.durationMs ?? 0) - (state.positionMs ?? 0)
    // Catch the next song as it starts instead of up to a whole interval late.
    return left > 0 ? Math.max(1000, Math.min(base, left + 1000)) : base
  }

  const tick = async () => {
    timer = null
    if (stopped) return
    let state = null
    const since = now() - lastRead
    const base = POLL[spotify.id] ?? POLL.applescript
    // Someone else read Spotify a moment ago; wait out the rest of the interval.
    if (lastRead && since < base) return schedule(base - since)
    try {
      state = show(await spotify.getState())
    } catch (error) {
      log(`status bar: ${error.message}`)
    }
    schedule(delayAfter(state))
  }

  const schedule = (ms) => {
    if (stopped) return
    clearTimer(timer)
    timer = setTimer(tick, ms)
    timer?.unref?.()
  }

  return {
    show,
    start() {
      if (!stopped) return
      stopped = false
      schedule(0)
    },
    stop() {
      stopped = true
      clearTimer(timer)
      timer = null
    }
  }
}
