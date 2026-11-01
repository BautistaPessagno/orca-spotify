import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runAndSettle } from '../src/settle.mjs'

const noDelay = { delay: async () => {} }
const track = (uri) => ({ uri, title: uri })

// Spotify stand-in whose state reads return `states` in order, repeating the last one.
function fakeSpotify(...states) {
  const commands = []
  let reads = 0
  return {
    commands,
    get reads() { return reads },
    getState: async () => states[Math.min(reads++, states.length - 1)],
    command: async (name, value) => (commands.push([name, value]), true)
  }
}

test('waits until Spotify shows the new play state', async () => {
  const spotify = fakeSpotify(
    { status: 'paused', track: track('a') },
    { status: 'paused', track: track('a') },
    { status: 'playing', track: track('a') }
  )
  const { state } = await runAndSettle(spotify, 'play', undefined, noDelay)
  assert.equal(state.status, 'playing')
  assert.deepEqual(spotify.commands, [['play', undefined]])
})

test('uses a known prior state instead of reading it first', async () => {
  const spotify = fakeSpotify({ status: 'playing', track: track('b') })
  const before = { status: 'playing', track: track('a'), positionMs: 1000 }
  const { state } = await runAndSettle(spotify, 'next', undefined, { ...noDelay, before })
  assert.equal(state.track.uri, 'b')
  assert.equal(spotify.reads, 1)
})

test('gives up after a few tries and returns the latest state', async () => {
  const spotify = fakeSpotify({ status: 'paused', track: track('a') })
  const { state } = await runAndSettle(spotify, 'play', undefined, noDelay)
  assert.equal(state.status, 'paused')
  assert.ok(spotify.reads <= 8)
})

test('previous counts restarting the same track as applied', async () => {
  const spotify = fakeSpotify({ status: 'playing', track: track('a'), positionMs: 200 })
  const before = { status: 'playing', track: track('a'), positionMs: 60000 }
  await runAndSettle(spotify, 'previous', undefined, { ...noDelay, before })
  assert.equal(spotify.reads, 1)
})

test('commands without a visible effect are not retried', async () => {
  const spotify = fakeSpotify({ status: 'playing', track: track('a') })
  await runAndSettle(spotify, 'setVolume', 30, noDelay)
  assert.equal(spotify.reads, 1)
})
