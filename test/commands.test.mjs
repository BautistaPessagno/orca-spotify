import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SpotifyError } from '../src/backend.mjs'
import { createCommands, describe } from '../src/commands.mjs'

const playing = { status: 'playing', shuffle: true, track: { title: 'Song', artist: 'Artist' } }

function fakeSpotify({ state = playing, ran = true, fail } = {}) {
  const calls = []
  return {
    calls,
    getState: async () => state,
    command: async (name) => {
      calls.push(name)
      if (fail) throw fail
      return ran
    }
  }
}

const noDelay = { delay: async () => {} }

test('describe formats each state', () => {
  assert.equal(describe(playing), 'Song · Artist')
  assert.equal(describe({ ...playing, status: 'paused' }), 'Paused: Song · Artist')
  assert.equal(describe({ status: 'stopped', track: null }), 'Nothing is playing in Spotify.')
  assert.equal(describe({ status: 'closed', message: 'closed!' }), 'closed!')
})

test('next runs the command and reports the new track', async () => {
  const spotify = fakeSpotify()
  assert.equal(await createCommands(spotify, noDelay).next(), 'Song · Artist')
  assert.deepEqual(spotify.calls, ['next'])
})

test('a command on a closed Spotify says so instead of opening it', async () => {
  const result = await createCommands(fakeSpotify({ ran: false }), noDelay).playpause()
  assert.match(result, /not open/)
})

test('a command failure is returned as its explanation', async () => {
  const fail = new SpotifyError('permission', 'grant Automation')
  assert.equal(await createCommands(fakeSpotify({ fail }), noDelay).playpause(), 'grant Automation')
})

test('toggleShuffle reports the resulting mode', async () => {
  assert.equal(await createCommands(fakeSpotify(), noDelay).toggleShuffle(), 'Shuffle on')
})

test('with no player to send to, the backend\'s own explanation is returned', async () => {
  const state = { status: 'no-device', message: 'No Spotify device is active. Open Spotify on any device.' }
  assert.equal(await createCommands(fakeSpotify({ state, ran: false }), noDelay).next(), state.message)
})

test('a Web API account that is not connected points to the panel', async () => {
  const fail = new SpotifyError('unauthenticated', 'Open the Now Playing panel to connect your Spotify account.')
  assert.match(await createCommands(fakeSpotify({ fail }), noDelay).playpause(), /Now Playing panel/)
})
