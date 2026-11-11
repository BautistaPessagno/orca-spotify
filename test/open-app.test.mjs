import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MESSAGES, MUSIC_MESSAGES, SpotifyError } from '../src/backend.mjs'
import { WEB_PLAYER, createAppOpener, pickThisComputer } from '../src/open-app.mjs'

// A clock the tests move by waiting, so "give up after 20 s" costs no time.
function clock() {
  let t = 0
  return { now: () => t, delay: async (ms) => void (t += ms), elapsed: () => t }
}

const mac = { id: 'mac', name: 'Bautista’s MacBook Pro', type: 'Computer', active: false }
const imac = { id: 'imac', name: 'Work iMac', type: 'Computer', active: false }
const web = { id: 'web', name: 'Web Player (Chrome)', type: 'Computer', active: false }
const phone = { id: 'phone', name: 'Pixel 9', type: 'Smartphone', active: false }
const NAMES = ['Bautista’s MacBook Pro', 'Bautistas-MacBook-Pro.local']

// ---------- which Connect device is this computer ----------

test('this computer is the Computer device named after it, however the name is written', () => {
  assert.equal(pickThisComputer([phone, imac, mac], [], NAMES), mac)
  // Spotify and macOS disagree on the apostrophe and the dashes; the host name has ".local".
  assert.equal(pickThisComputer([{ ...mac, name: "Bautista's MacBook Pro" }], [], ['Bautistas-MacBook-Pro.local']).id, 'mac')
})

test('a phone, a speaker or someone else’s computer is not this computer', () => {
  assert.equal(pickThisComputer([phone, imac], [imac, phone], NAMES), null)
  assert.equal(pickThisComputer([], [], NAMES), null)
})

test('a Computer device that appeared after the launch is this one when no name fits', () => {
  assert.equal(pickThisComputer([imac, { ...mac, name: 'Mac' }], [imac], NAMES).id, 'mac')
  // The name still wins over what is new.
  assert.equal(pickThisComputer([{ ...mac, id: 'new', name: 'Studio' }, mac], [], NAMES), mac)
})

test('the web player is never taken for the app', () => {
  assert.equal(pickThisComputer([web], [], NAMES), null)
})

// ---------- fakes ----------

// The Spotify desktop app or Music app: `states` is what getState answers in turn (the last repeats).
function fakeApp({ id = 'applescript', states = [{ status: 'closed' }], launch } = {}) {
  const calls = []
  const queue = [...states]
  return {
    id,
    calls,
    getState: async () => (calls.push('getState'), queue.length > 1 ? queue.shift() : queue[0]),
    command: async (name) => {
      calls.push(name)
      if (launch) throw launch
      return true
    }
  }
}

// The Web API backend: `lists` is what devices() answers in turn (the last repeats).
function fakeWeb({ lists = [[]], transfer } = {}) {
  const calls = []
  const queue = [...lists]
  return {
    id: 'webapi',
    calls,
    settle: { tries: 2, stepMs: 400 },
    devices: async () => {
      calls.push(['devices'])
      const next = queue.length > 1 ? queue.shift() : queue[0]
      if (next instanceof Error) throw next
      return next
    },
    transfer: async (deviceId, play) => {
      calls.push(['transfer', deviceId, play])
      if (transfer) throw transfer
    }
  }
}

function setup({ active, desktop = fakeApp(), music = fakeApp({ id: 'applemusic' }), platform = 'darwin', time = clock(), state, ...options } = {}) {
  const spotify = { active: async () => active ?? desktop, getState: async () => state ?? { status: 'paused', track: null } }
  const opener = createAppOpener({
    spotify,
    backends: { applescript: desktop, applemusic: music },
    platform,
    computerNames: async () => NAMES,
    delay: time.delay,
    now: time.now,
    ...options
  })
  return { opener, desktop, music, time }
}

// ---------- the Spotify desktop app (and Apple Music) when it is closed ----------

test('closed: starts the app, waits until it answers, and returns its state', async () => {
  const desktop = fakeApp({ states: [{ status: 'closed' }, { status: 'closed' }, { status: 'stopped', track: null }] })
  // The state it returns is the selector's, so the status bar and the backend id are in it.
  const { opener } = setup({ desktop, state: { status: 'stopped', track: null, backend: 'applescript' } })
  const result = await opener.open()
  assert.deepEqual(result, { opened: true, state: { status: 'stopped', track: null, backend: 'applescript' } })
  assert.deepEqual(desktop.calls, ['getState', 'open', 'getState', 'getState'])
})

test('closed: an app that is already open is left alone', async () => {
  const desktop = fakeApp({ states: [{ status: 'playing', track: { title: 'Song' } }] })
  const { opener } = setup({ desktop, state: { status: 'playing', track: { title: 'Song' } } })
  const result = await opener.open()
  assert.equal(result.opened, true)
  assert.equal(result.state.status, 'playing')
  assert.ok(!desktop.calls.includes('open'))
})

test('closed: gives up after a while with a message, and the app was only started once', async () => {
  const desktop = fakeApp({ states: [{ status: 'closed' }] })
  const { opener, time } = setup({ desktop })
  const result = await opener.open()
  assert.equal(result.opened, false)
  assert.equal(result.reason, 'timeout')
  assert.match(result.message, /Spotify/)
  assert.match(result.message, /\d+ seconds/)
  assert.equal(desktop.calls.filter((call) => call === 'open').length, 1)
  assert.ok(time.elapsed() >= 10_000 && time.elapsed() < 30_000, `waited ${time.elapsed()} ms`)
})

test('closed: Spotify that is not installed says so and offers the download page', async () => {
  const desktop = fakeApp({ launch: new SpotifyError('not-installed', MESSAGES.notInstalled) })
  const { opener } = setup({ desktop })
  const result = await opener.open()
  assert.equal(result.opened, false)
  assert.equal(result.reason, 'not-installed')
  assert.match(result.message, /Spotify is not installed/)
  assert.deepEqual(result.link, { label: 'Get Spotify', url: 'https://www.spotify.com/download' })
})

test('closed: Apple Music says Music, and has no link to offer', async () => {
  const music = fakeApp({ id: 'applemusic', states: [{ status: 'closed' }, { status: 'paused', track: null }] })
  const { opener } = setup({ active: music, music })
  assert.deepEqual(await opener.open(), { opened: true, state: { status: 'paused', track: null } })
  assert.deepEqual(music.calls, ['getState', 'open', 'getState'])

  const lost = fakeApp({ id: 'applemusic', launch: new SpotifyError('not-installed', MUSIC_MESSAGES.notInstalled) })
  const refused = await setup({ active: lost, music: lost }).opener.open()
  assert.equal(refused.reason, 'not-installed')
  assert.match(refused.message, /Music/)
  assert.doesNotMatch(refused.message, /Spotify/)
  assert.equal(refused.link, undefined)

  const slow = fakeApp({ id: 'applemusic', states: [{ status: 'closed' }] })
  const late = await setup({ active: slow, music: slow }).opener.open()
  assert.equal(late.reason, 'timeout')
  assert.match(late.message, /Music/)
  assert.doesNotMatch(late.message, /Spotify/)
})

test('closed: off macOS the app cannot be started, and it says so', async () => {
  const desktop = fakeApp({ states: [{ status: 'unsupported', message: 'Only on macOS.' }] })
  const result = await setup({ desktop, platform: 'linux' }).opener.open()
  assert.deepEqual(result, { opened: false, reason: 'unsupported', message: 'Only on macOS.' })
  assert.ok(!desktop.calls.includes('open'))
})

test('closed: any other failure to start is reported, not swallowed', async () => {
  const desktop = fakeApp({ launch: new SpotifyError('error', 'Spotify could not be controlled: boom') })
  const result = await setup({ desktop }).opener.open()
  assert.deepEqual(result, { opened: false, reason: 'error', message: 'Spotify could not be controlled: boom' })
})

// ---------- the Spotify Web API with no active device ----------

test('web: starts Spotify, waits for this computer to show up, makes it the active device without playing', async () => {
  const web_ = fakeWeb({ lists: [[phone], [phone], [phone, mac]] })
  const desktop = fakeApp()
  const { opener, time } = setup({ active: web_, desktop, state: { status: 'paused', track: null, device: { name: mac.name } } })
  const result = await opener.open()
  assert.deepEqual(result, { opened: true, state: { status: 'paused', track: null, device: { name: mac.name } } })
  assert.deepEqual(desktop.calls, ['open'])
  assert.deepEqual(web_.calls.at(-1), ['transfer', 'mac', false])
  assert.equal(web_.calls.filter(([name]) => name === 'transfer').length, 1)
  assert.ok(time.elapsed() < 10_000)
})

test('web: this computer is already listed, so nothing is started, only transferred to', async () => {
  const web_ = fakeWeb({ lists: [[phone, mac]] })
  const desktop = fakeApp()
  const { opener } = setup({ active: web_, desktop })
  assert.equal((await opener.open()).opened, true)
  assert.deepEqual(desktop.calls, [])
  assert.deepEqual(web_.calls, [['devices'], ['transfer', 'mac', false]])
})

test('web: another device being listed does not stop the app from being started', async () => {
  const web_ = fakeWeb({ lists: [[phone], [phone, mac]] })
  const desktop = fakeApp()
  await setup({ active: web_, desktop }).opener.open()
  assert.deepEqual(desktop.calls, ['open'])
  assert.ok(!web_.calls.some(([name, id]) => name === 'transfer' && id === 'phone'))
})

test('web: a Computer device that is new after the launch counts when its name is unknown', async () => {
  const web_ = fakeWeb({ lists: [[phone, imac], [phone, imac, { id: 'fresh', name: 'Studio Mac', type: 'Computer' }]] })
  await setup({ active: web_ }).opener.open()
  assert.deepEqual(web_.calls.at(-1), ['transfer', 'fresh', false])
})

test('web: keeps waiting through a rate limit', async () => {
  const limited = new SpotifyError('rate-limited', 'slow down', { retryAfterMs: 3000 })
  const web_ = fakeWeb({ lists: [[], limited, [mac]] })
  const { opener } = setup({ active: web_ })
  assert.equal((await opener.open()).opened, true)
  assert.deepEqual(web_.calls.at(-1), ['transfer', 'mac', false])
})

test('web: gives up with a message when it never shows up, and transfers nothing', async () => {
  const web_ = fakeWeb({ lists: [[phone]] })
  const { opener, time } = setup({ active: web_ })
  const result = await opener.open()
  assert.equal(result.opened, false)
  assert.equal(result.reason, 'timeout')
  assert.match(result.message, /device/)
  assert.match(result.message, /same account/)
  assert.ok(!web_.calls.some(([name]) => name === 'transfer'))
  // The panel's own request would time out at 30 s; this answers before.
  assert.ok(time.elapsed() >= 15_000 && time.elapsed() < 27_000, `waited ${time.elapsed()} ms`)
})

test('web: Spotify that is not installed points at the web player instead', async () => {
  const web_ = fakeWeb({ lists: [[]] })
  const desktop = fakeApp({ launch: new SpotifyError('not-installed', MESSAGES.notInstalled) })
  const result = await setup({ active: web_, desktop }).opener.open()
  assert.equal(result.opened, false)
  assert.equal(result.reason, 'not-installed')
  assert.match(result.message, /Spotify is not installed on this Mac/)
  assert.deepEqual(result.link, { label: 'Open Spotify on the web', url: WEB_PLAYER })
})

test('web: off macOS it does not pretend; it offers the web player', async () => {
  const web_ = fakeWeb({ lists: [[phone]] })
  const desktop = fakeApp()
  const result = await setup({ active: web_, desktop, platform: 'linux' }).opener.open()
  assert.equal(result.opened, false)
  assert.equal(result.reason, 'unsupported')
  assert.match(result.message, /can’t start Spotify on this computer/)
  assert.deepEqual(result.link, { label: 'Open Spotify on the web', url: 'https://open.spotify.com' })
  assert.deepEqual(desktop.calls, [])
})

test('web: off macOS, a device that is already there is still used', async () => {
  const web_ = fakeWeb({ lists: [[{ ...mac, name: 'Linux Box' }]] })
  const result = await setup({ active: web_, platform: 'linux', computerNames: async () => ['Linux Box'] }).opener.open()
  assert.equal(result.opened, true)
  assert.deepEqual(web_.calls.at(-1), ['transfer', 'mac', false])
})

test('web: an error from Spotify while looking is passed on', async () => {
  const web_ = fakeWeb({ lists: [new SpotifyError('unauthenticated', 'Open the Now Playing panel to connect your Spotify account.')] })
  await assert.rejects(setup({ active: web_ }).opener.open(), { kind: 'unauthenticated' })
})

test('web: a spent request quota is reported, not waited out', async () => {
  const quota = new SpotifyError('rate-limited', 'Your Spotify app’s request quota ran out.', { retryAfterMs: 300_000, quota: true })
  const web_ = fakeWeb({ lists: [[], quota] })
  const { opener, time } = setup({ active: web_ })
  await assert.rejects(opener.open(), { kind: 'rate-limited', quota: true })
  assert.ok(time.elapsed() < 5000)
})

test('a press for another app while one is running is its own run', async () => {
  const music = fakeApp({ id: 'applemusic', states: [{ status: 'closed' }, { status: 'paused', track: null }] })
  const web_ = fakeWeb({ lists: [[], [], [mac]] })
  const desktop = fakeApp()
  let current = web_
  const spotify = { active: async () => current, getState: async () => ({ status: 'paused', track: null }) }
  const time = clock()
  const opener = createAppOpener({ spotify, backends: { applescript: desktop, applemusic: music }, platform: 'darwin', computerNames: async () => NAMES, delay: time.delay, now: time.now })
  const first = opener.open()
  await Promise.resolve()
  current = music
  const second = opener.open()
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.opened, true)
  assert.equal(b.opened, true)
  assert.ok(music.calls.includes('open'), 'Music was started by its own press')
  assert.deepEqual(desktop.calls, ['open'])
})

test('a second press while one is running shares it instead of starting twice', async () => {
  const web_ = fakeWeb({ lists: [[], [], [mac]] })
  const desktop = fakeApp()
  const { opener } = setup({ active: web_, desktop })
  const [a, b] = await Promise.all([opener.open(), opener.open()])
  assert.equal(a, b)
  assert.deepEqual(desktop.calls, ['open'])
  // And once it is done, a new press is a new run.
  await opener.open()
  assert.deepEqual(desktop.calls, ['open'])
  assert.equal(web_.calls.filter(([name]) => name === 'transfer').length, 2)
})
