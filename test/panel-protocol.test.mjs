import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPanelHandler, smallArtworkUrl } from '../src/panel-protocol.mjs'

const state = { status: 'playing', track: { title: 'Song' } }

function fakeSpotify() {
  const calls = []
  return { calls, getState: async () => state, command: async (...args) => (calls.push(args), true) }
}

function fakeFetch(bytes = 1000) {
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(url)
    return {
      ok: true,
      headers: new Map([['content-type', 'image/jpeg']]),
      arrayBuffer: async () => new Uint8Array(bytes).buffer
    }
  }
  return { fetchImpl, urls }
}

test('getState and command return the player state', async () => {
  const spotify = fakeSpotify()
  const handle = createPanelHandler(spotify)
  assert.equal(await handle({ type: 'getState' }), state)
  assert.equal(await handle({ type: 'command', cmd: 'setVolume', value: 10 }), state)
  assert.deepEqual(spotify.calls, [['setVolume', 10]])
})

test('unknown commands and messages are refused', async () => {
  const handle = createPanelHandler(fakeSpotify())
  await assert.rejects(handle({ type: 'command', cmd: 'quit' }), /Unknown command/)
  await assert.rejects(handle({ type: 'eval' }), /Unknown panel message/)
  await assert.rejects(handle(null), /Unknown panel message/)
})

test('artwork is fetched once per track at 300px and returned as a data URL', async () => {
  const { fetchImpl, urls } = fakeFetch()
  const handle = createPanelHandler(fakeSpotify(), { fetchImpl })
  const url = 'https://i.scdn.co/image/ab67616d0000b273abc'
  const first = await handle({ type: 'getArtwork', url })
  await handle({ type: 'getArtwork', url })
  assert.match(first.dataUrl, /^data:image\/jpeg;base64,/)
  assert.deepEqual(urls, [smallArtworkUrl(url)])
  assert.match(urls[0], /ab67616d00001e02abc$/)
})

test('artwork outside Spotify\'s CDN or too large is not returned', async () => {
  const { fetchImpl, urls } = fakeFetch(200 * 1024)
  const handle = createPanelHandler(fakeSpotify(), { fetchImpl })
  assert.equal((await handle({ type: 'getArtwork', url: 'http://127.0.0.1:8080/x' })).dataUrl, null)
  assert.equal(urls.length, 0)
  assert.equal((await handle({ type: 'getArtwork', url: 'https://i.scdn.co/image/big' })).dataUrl, null)
})
