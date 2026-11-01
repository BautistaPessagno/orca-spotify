import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPanelHandlers, smallArtworkUrl } from '../src/panel-protocol.mjs'

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

test('state and command return the player state', async () => {
  const spotify = fakeSpotify()
  const handlers = createPanelHandlers(spotify)
  assert.equal(await handlers['player.state'](), state)
  assert.equal(await handlers['player.command']({ cmd: 'setVolume', value: 10 }), state)
  assert.deepEqual(spotify.calls, [['setVolume', 10]])
})

test('unknown commands are refused', async () => {
  const command = createPanelHandlers(fakeSpotify())['player.command']
  await assert.rejects(command({ cmd: 'quit' }), /Unknown command/)
  await assert.rejects(command(undefined), /Unknown command/)
})

test('artwork is fetched once per track at 300px and returned as a data URL', async () => {
  const { fetchImpl, urls } = fakeFetch()
  const artwork = createPanelHandlers(fakeSpotify(), { fetchImpl })['player.artwork']
  const url = 'https://i.scdn.co/image/ab67616d0000b273abc'
  const first = await artwork({ url })
  await artwork({ url })
  assert.match(first.dataUrl, /^data:image\/jpeg;base64,/)
  assert.deepEqual(urls, [smallArtworkUrl(url)])
  assert.match(urls[0], /ab67616d00001e02abc$/)
})

test('artwork outside Spotify\'s CDN or too large is not returned', async () => {
  const { fetchImpl, urls } = fakeFetch(200 * 1024)
  const artwork = createPanelHandlers(fakeSpotify(), { fetchImpl })['player.artwork']
  assert.equal((await artwork({ url: 'http://127.0.0.1:8080/x' })).dataUrl, null)
  assert.equal(urls.length, 0)
  assert.equal((await artwork({ url: 'https://i.scdn.co/image/big' })).dataUrl, null)
})
