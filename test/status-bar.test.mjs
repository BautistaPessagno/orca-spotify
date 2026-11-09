import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ITEM_ID, createStatusBar, statusBarView } from '../src/status-bar.mjs'

const track = { title: 'Low Tide Lanterns', artist: 'Harbor Lights', durationMs: 234_000 }

test('shows the song while playing or paused, and hides otherwise', () => {
  assert.deepEqual(statusBarView({ status: 'playing', track, device: { name: 'Kitchen' } }), {
    text: 'Low Tide Lanterns · Harbor Lights',
    icon: 'play',
    tone: 'neutral',
    tooltip: 'Playing: Low Tide Lanterns by Harbor Lights on Kitchen'
  })
  assert.equal(statusBarView({ status: 'paused', track }).icon, 'pause')
  assert.equal(statusBarView({ status: 'stopped', track: null }), null)
  assert.equal(statusBarView({ status: 'closed', message: 'Spotify is not open.' }), null)
  assert.equal(statusBarView(null), null)
})

test('long titles fit the 64-character limit', () => {
  const view = statusBarView({ status: 'playing', track: { title: 'x'.repeat(80), artist: 'y' } })
  assert.equal(view.text.length, 64)
  assert.ok(view.text.endsWith('…'))
})

test('sends a change once, and survives an Orca without status bar updates', async () => {
  const calls = []
  let fail = false
  const host = {
    call: async (method, params) => {
      calls.push(params)
      if (fail) throw Object.assign(new Error('nope'), { code: 'unknown_method' })
      return { ok: true }
    }
  }
  const bar = createStatusBar({ host, spotify: { id: 'applescript', getState: async () => null } })
  bar.show({ status: 'playing', track })
  bar.show({ status: 'playing', track })
  bar.show({ status: 'stopped', track: null })
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(calls.map((c) => [c.id, c.visible]), [[ITEM_ID, true], [ITEM_ID, false]])
  fail = true
  bar.show({ status: 'paused', track })
  await new Promise((r) => setImmediate(r))
})

test('polls on its own, but not when someone just read Spotify', async () => {
  let reads = 0
  let clock = 0
  const timers = []
  const bar = createStatusBar({
    host: { call: async () => ({ ok: true }) },
    spotify: { id: 'webapi', getState: async () => (reads++, { status: 'playing', track, positionMs: 0 }) },
    setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimer: () => {},
    now: () => clock
  })
  bar.start()
  await timers.shift().fn()
  assert.equal(reads, 1)
  assert.equal(timers.at(-1).ms, 30_000) // the Web API's interval while a long song plays
  clock = 40_000
  bar.show({ status: 'playing', track, positionMs: 0 }) // the panel read it
  clock = 50_000
  await timers.shift().fn()
  assert.equal(reads, 1)
  assert.equal(timers.at(-1).ms, 20_000)
  bar.stop()
})
