// "Open Spotify" / "Open Music": starts the app behind the panel and waits until it can be used,
// so a closed app, or Spotify's "No active device", is one press from the player.
//
//   open() → { opened: true, state }                         the app is up and the panel can show `state`
//          | { opened: false, reason, message, link? }       it could not be, and why in a sentence
//
// reason: 'not-installed' | 'unsupported' (not a Mac) | 'timeout' | 'error'. `link` is
// { label, url } for the best other thing to do: the web player, or Spotify's download page. The
// panel offers it as a button (Orca opens links only for a click in the panel, never for the
// worker). Anything else a backend throws, such as a lost login, is thrown for the panel to explain.
//
// What it does depends on the backend the panel is driving:
//   Spotify desktop app, Apple Music   start the app, wait until it answers Apple Events.
//   Spotify Web API                    start the Spotify desktop app, wait until this computer
//                                      shows up among the Connect devices, then transfer
//                                      playback to it (paused: opening an app starts no music).
// The app starts in the background (`open -g`, in the backends), so Orca keeps the focus.
import { execFile } from 'node:child_process'
import { hostname } from 'node:os'
import { MESSAGES, classifyError } from './backend.mjs'

export const WEB_PLAYER = 'https://open.spotify.com'
const DOWNLOAD = 'https://www.spotify.com/download'

// How long to wait for the app, and for its Connect device (which shows up later). The panel's
// request gives up at 30 s, so the longest wait stays well under it.
const APP_WAIT_MS = 15_000
const DEVICE_WAIT_MS = 22_000
const APP_STEP_MS = 1000
const DEVICE_STEP_MS = 2000

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Spotify names a computer's Connect device after the computer: macOS's own name for it ("MacBook
// Pro (26)") or the host name ("MacBook-Pro-90.local"). Compare them loosely.
const normalize = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/\.local$/, '')
    .replace(/[^a-z0-9]/g, '')

// The Connect device that is the Spotify app on this computer, or null: the Computer device named
// after this computer; failing that, a Computer device that was not there before `before` (the
// list from before Spotify started). The web player is a Computer device too, and is never taken.
export function pickThisComputer(devices, before, names) {
  const computers = devices.filter((device) => /^computer$/i.test(device.type))
  const mine = new Set(names.map(normalize).filter(Boolean))
  const named = computers.find((device) => mine.has(normalize(device.name)))
  if (named) return named
  const known = new Set(before.map((device) => device.id))
  return computers.find((device) => !known.has(device.id) && !/^web player/i.test(device.name)) ?? null
}

async function computerNamesOfThisMac() {
  const names = [hostname()]
  const scutil = await new Promise((resolve) => {
    execFile('/usr/sbin/scutil', ['--get', 'ComputerName'], { timeout: 2000 }, (error, stdout) => resolve(error ? '' : String(stdout).trim()))
  })
  if (scutil) names.push(scutil)
  return names
}

const refusal = (reason, message, link) => ({ opened: false, reason, message, ...(link ? { link } : {}) })

export function createAppOpener({
  spotify,
  backends,
  platform = process.platform,
  computerNames = computerNamesOfThisMac,
  delay = wait,
  now = Date.now,
  appWaitMs = APP_WAIT_MS,
  deviceWaitMs = DEVICE_WAIT_MS
}) {
  // The run in progress for each backend, so a second press gets the first one's answer.
  const running = new Map()

  // Starts `app` (a desktop backend) and says why not when it could not be. `link` is what to
  // offer when the app is not installed.
  const start = async (app, link) => {
    try {
      await app.command('open')
      return null
    } catch (error) {
      const reason = classifyError(error)
      if (reason.kind === 'not-installed' || reason.kind === 'unsupported') return refusal(reason.kind, reason.message, reason.kind === 'not-installed' ? link : undefined)
      return refusal('error', reason.message)
    }
  }

  // The Spotify desktop app or the Music app, closed: start it and wait until it answers.
  const openDesktopApp = async (backend) => {
    const music = backend.id === 'applemusic'
    let state = await backend.getState()
    if (state.status === 'unsupported') return refusal('unsupported', state.message)
    if (state.status !== 'closed') return { opened: true, state: await spotify.getState() }
    const failed = await start(backend, music ? undefined : { label: 'Get Spotify', url: DOWNLOAD })
    if (failed) return failed
    const deadline = now() + appWaitMs
    for (;;) {
      await delay(APP_STEP_MS)
      state = await backend.getState()
      if (state.status !== 'closed') return { opened: true, state: await spotify.getState() }
      if (now() >= deadline) break
    }
    const seconds = Math.round(appWaitMs / 1000)
    return refusal('timeout', `${music ? 'Music' : 'Spotify'} started, but it did not answer after ${seconds} seconds. Give it a moment, then try again.`)
  }

  // The Web API: the desktop app is one more Connect device, so wait for it to be listed.
  const openThroughDevices = async (web) => {
    const names = await computerNames().catch(() => [])
    const before = await web.devices()
    let mine = pickThisComputer(before, before, names)
    if (!mine) {
      const onTheWeb = { label: 'Open Spotify on the web', url: WEB_PLAYER }
      if (platform !== 'darwin') return refusal('unsupported', MESSAGES.cantStart, onTheWeb)
      const failed = await start(backends.applescript, onTheWeb)
      if (failed) return failed
      const deadline = now() + deviceWaitMs
      while (!mine) {
        await delay(DEVICE_STEP_MS)
        try {
          mine = pickThisComputer(await web.devices(), before, names)
        } catch (error) {
          // Spotify asked to slow down: that is no reason to give up, only to look again later.
          // A spent quota lasts minutes, so that one is the answer.
          if (error?.kind !== 'rate-limited' || error.quota) throw error
          await delay(Math.min(error.retryAfterMs ?? 0, Math.max(0, deadline - now())))
        }
        if (!mine && now() >= deadline) {
          const seconds = Math.round(deviceWaitMs / 1000)
          return refusal('timeout', `Spotify started, but it did not show up as a device after ${seconds} seconds. Check that it is signed in to the same account, then try again.`)
        }
      }
    }
    if (!mine.active) await web.transfer(mine.id, false)
    await delay(web.settle.stepMs)
    return { opened: true, state: await spotify.getState() }
  }

  return {
    async open() {
      const backend = await spotify.active()
      if (!running.has(backend.id)) {
        const run = backend.id === 'webapi' ? openThroughDevices(backend) : openDesktopApp(backend)
        running.set(backend.id, run.finally(() => running.delete(backend.id)))
      }
      return running.get(backend.id)
    }
  }
}
