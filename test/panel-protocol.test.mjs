import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SpotifyError } from '../src/backend.mjs'
import { createPanelHandlers, smallArtworkUrl } from '../src/panel-protocol.mjs'
import { createBackendSelector } from '../src/select-backend.mjs'

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

// A Web API–like backend behind the real selector, with recorded library calls.
function webSetup({ backend = 'webapi', platform = 'linux' } = {}) {
  const calls = []
  const record = (name, result) => async (...args) => (calls.push([name, ...args]), result)
  const webapi = {
    id: 'webapi',
    capabilities: { devices: true, queue: true, search: true, playlists: true, needsAuth: true },
    settle: { tries: 2, stepMs: 400 },
    getState: async () => ({ status: 'playing', track: { title: 'Song' } }),
    command: async () => true,
    devices: record('devices', [{ id: 'd1', name: 'Phone' }]),
    transfer: record('transfer'),
    queue: record('queue', { current: null, queue: [] }),
    enqueue: record('enqueue'),
    playContext: record('playContext'),
    search: record('search', { tracks: { items: [], total: 0, offset: 0 } }),
    playlists: record('playlists', { items: [], total: 0, offset: 0 })
  }
  const applescript = { id: 'applescript', capabilities: { devices: false, search: false }, getState: async () => state, command: async () => true }
  const settings = { values: { backend }, get: async (k) => settings.values[k], set: async (k, v) => (settings.values[k] = v) }
  const spotify = createBackendSelector({ backends: { applescript, webapi }, settings, platform })
  const auth = {
    calls: [],
    start: async (input) => (auth.calls.push(['start', input]), { url: 'https://accounts.spotify.com/authorize?x' }),
    status: async () => ({ status: 'pending' }),
    disconnect: async () => (auth.calls.push(['disconnect']), { ok: true }),
    connection: async () => ({ clientId: 'abc', connected: true, authorizedAt: 1, protection: 'os-keyring' })
  }
  const handlers = createPanelHandlers(spotify, { auth, platform, delay: async () => {} })
  return { handlers, calls, auth, settings }
}

test('backend.info names the active backend, what it can do, and the login', async () => {
  const { handlers } = webSetup({ platform: 'darwin' })
  const info = await handlers['backend.info']()
  assert.equal(info.id, 'webapi')
  assert.equal(info.capabilities.search, true)
  assert.deepEqual(info.available, ['applescript', 'webapi'])
  assert.equal(info.connection.connected, true)
  assert.deepEqual((await webSetup({ platform: 'linux' }).handlers['backend.info']()).available, ['webapi'])
})

test('backend.select switches backends and answers with the new info', async () => {
  const { handlers, settings } = webSetup({ backend: 'auto', platform: 'darwin' })
  assert.equal((await handlers['backend.info']()).id, 'applescript')
  assert.equal((await handlers['backend.select']({ backend: 'webapi' })).id, 'webapi')
  assert.equal(settings.values.backend, 'webapi')
  await assert.rejects(handlers['backend.select']({ backend: 'cd-player' }), /Unknown backend/)
})

test('auth handlers forward to the login and report failures as messages', async () => {
  const { handlers, auth } = webSetup()
  assert.deepEqual(await handlers['auth.start']({ clientId: 'abc' }), { url: 'https://accounts.spotify.com/authorize?x' })
  assert.deepEqual(auth.calls[0], ['start', { clientId: 'abc' }])
  assert.deepEqual(await handlers['auth.status'](), { status: 'pending' })
  assert.deepEqual(await handlers['auth.disconnect'](), { ok: true })
  auth.start = async () => {
    throw new SpotifyError('invalid', 'That doesn’t look like a Spotify Client ID.')
  }
  assert.deepEqual(await handlers['auth.start']({ clientId: '!' }), { url: null, message: 'That doesn’t look like a Spotify Client ID.' })
})

test('library handlers validate their input before reaching Spotify', async () => {
  const { handlers, calls } = webSetup()
  await handlers['player.enqueue']({ uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC' })
  await handlers['player.playContext']({ contextUri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', offset: 3 })
  await handlers['player.playContext']({ uris: ['spotify:track:a1', 'spotify:episode:b2'] })
  await handlers['library.search']({ q: 'lofi beats', types: ['track', 'album'], offset: 10 })
  await handlers['library.playlists']({ offset: 50 })
  await handlers['player.transfer']({ deviceId: 'd1', play: true })
  assert.deepEqual(calls, [
    ['enqueue', 'spotify:track:4uLU6hMCjMI75M1A2tKUQC'],
    ['playContext', { contextUri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', offset: 3 }],
    ['playContext', { uris: ['spotify:track:a1', 'spotify:episode:b2'] }],
    ['search', 'lofi beats', ['track', 'album'], 10],
    ['playlists', 50],
    ['transfer', 'd1', true]
  ])

  for (const uri of ['spotify:track:../x', 'https://open.spotify.com/track/1', 'spotify:user:me', 42]) {
    await assert.rejects(handlers['player.enqueue']({ uri }), /Spotify URI/)
  }
  await assert.rejects(handlers['player.playContext']({ contextUri: 'spotify:track:1' }), /album, playlist or artist/)
  await assert.rejects(handlers['player.playContext']({ uris: ['spotify:album:1'] }), /track or episode/)
  await assert.rejects(handlers['library.search']({ q: '' }), /search/i)
  await assert.rejects(handlers['library.search']({ q: 'x', types: ['user'] }), /type/)
  await assert.rejects(handlers['library.search']({ q: 'x', offset: 5000 }), /offset/)
  await assert.rejects(handlers['player.transfer']({}), /device/)
  assert.equal(calls.length, 6)
})

test('search defaults to every type from the start', async () => {
  const { handlers, calls } = webSetup()
  await handlers['library.search']({ q: 'x' })
  assert.deepEqual(calls[0], ['search', 'x', ['track', 'album', 'artist', 'playlist', 'show', 'episode'], 0])
})

test('transfer and play return the player state after they apply', async () => {
  const { handlers } = webSetup()
  assert.equal((await handlers['player.transfer']({ deviceId: 'd1' })).status, 'playing')
  assert.equal((await handlers['player.playContext']({ contextUri: 'spotify:album:1' })).status, 'playing')
})

test('library handlers say so when the active backend has no such feature', async () => {
  const { handlers } = webSetup({ backend: 'applescript', platform: 'darwin' })
  await assert.rejects(handlers['player.devices'](), /Web API/)
  await assert.rejects(handlers['library.search']({ q: 'x' }), /Web API/)
})

test('a command error becomes the state the panel explains', async () => {
  const spotify = { ...fakeSpotify(), command: async () => { throw new SpotifyError('unauthenticated', 'connect') } }
  const state = await createPanelHandlers(spotify)['player.command']({ cmd: 'next' })
  assert.deepEqual(state, { status: 'unauthenticated', message: 'connect' })
})

test('artwork from Spotify\'s other image hosts is allowed, and several are kept', async () => {
  const { fetchImpl, urls } = fakeFetch()
  const artwork = createPanelHandlers(fakeSpotify(), { fetchImpl })['player.artwork']
  const a = 'https://mosaic.scdn.co/300/abc'
  const b = 'https://image-cdn-ak.spotifycdn.com/image/def'
  await artwork({ url: a })
  await artwork({ url: b })
  await artwork({ url: a })
  assert.deepEqual(urls, [a, b])
  assert.equal((await artwork({ url: 'https://evil.spotifycdn.com.example/x' })).dataUrl, null)
})

test('devices and queue come from the Web API backend', async () => {
  const { handlers, calls } = webSetup()
  assert.deepEqual(await handlers['player.devices'](), [{ id: 'd1', name: 'Phone' }])
  assert.deepEqual(await handlers['player.queue'](), { current: null, queue: [] })
  assert.deepEqual(calls, [['devices'], ['queue']])
})

function librarySetup() {
  const calls = []
  const record = (name, result) => async (...args) => (calls.push([name, ...args]), result)
  const webapi = {
    id: 'webapi',
    capabilities: { home: true, library: true, search: true, playlists: true },
    settle: { tries: 2, stepMs: 400 },
    getState: async () => ({ status: 'playing' }),
    command: async () => true,
    playContext: record('playContext'),
    home: record('home', { recent: [] }),
    likedSongs: record('likedSongs', { items: [] }),
    savedAlbums: record('savedAlbums', { items: [] }),
    followedArtists: record('followedArtists', { items: [] }),
    savedShows: record('savedShows', { items: [] }),
    album: record('album', { kind: 'album' }),
    artist: record('artist', { kind: 'artist' }),
    playlist: record('playlist', { kind: 'playlist' }),
    isSaved: record('isSaved', [true]),
    setSaved: record('setSaved')
  }
  const settings = { get: async () => 'webapi', set: async () => {} }
  const spotify = createBackendSelector({ backends: { webapi, applescript: { id: 'applescript', capabilities: {} } }, settings, platform: 'linux' })
  return { calls, handlers: createPanelHandlers(spotify, { platform: 'linux', delay: async () => {} }) }
}

test('home and library handlers page through what the backend reads', async () => {
  const { calls, handlers } = librarySetup()
  await handlers['library.home']()
  await handlers['library.liked']({ offset: 50 })
  await handlers['library.albums']({})
  await handlers['library.artists']({ after: 'abc' })
  await handlers['library.shows']({ offset: 0 })
  assert.deepEqual(calls, [['home'], ['likedSongs', 50], ['savedAlbums', 0], ['followedArtists', 'abc'], ['savedShows', 0]])
  await assert.rejects(handlers['library.artists']({ after: 'not a cursor!' }), /cursor/)
})

test('a page opens by the kind of URI it is given', async () => {
  const { calls, handlers } = librarySetup()
  assert.equal((await handlers['library.page']({ uri: 'spotify:album:a1' })).kind, 'album')
  assert.equal((await handlers['library.page']({ uri: 'spotify:artist:b2' })).kind, 'artist')
  assert.equal((await handlers['library.page']({ uri: 'spotify:playlist:c3' })).kind, 'playlist')
  assert.deepEqual(calls.map((c) => c[0]), ['album', 'artist', 'playlist'])
  await assert.rejects(handlers['library.page']({ uri: 'spotify:track:x' }), /album, artist or playlist/)
})

test('saving: check up to 20 at once, and save or remove one', async () => {
  const { calls, handlers } = librarySetup()
  assert.deepEqual(await handlers['library.saved']({ uris: ['spotify:track:a'] }), [true])
  assert.deepEqual(await handlers['library.save']({ uri: 'spotify:album:b', saved: false }), { saved: false })
  assert.deepEqual(calls, [['isSaved', ['spotify:track:a']], ['setSaved', 'spotify:album:b', false]])
  await assert.rejects(handlers['library.saved']({ uris: Array(21).fill('spotify:track:a') }), /20/)
  await assert.rejects(handlers['library.save']({ uri: 'spotify:artist:x', saved: true }), /track, album, episode or show/)
  await assert.rejects(handlers['library.save']({ uri: 'spotify:track:x' }), /saved/)
})

test('Liked Songs plays as a context, from a chosen track', async () => {
  const { calls, handlers } = librarySetup()
  await handlers['player.playContext']({ contextUri: 'spotify:user:bau.pessa:collection', offsetUri: 'spotify:track:t1' })
  assert.deepEqual(calls[0], ['playContext', { contextUri: 'spotify:user:bau.pessa:collection', offsetUri: 'spotify:track:t1' }])
  await assert.rejects(handlers['player.playContext']({ contextUri: 'spotify:user:x/../y:collection' }), /album, playlist or artist|Spotify URI/)
})

test('artwork from any of Spotify\'s image hosts, such as This Is covers', async () => {
  const { fetchImpl, urls } = fakeFetch()
  const artwork = createPanelHandlers(fakeSpotify(), { fetchImpl })['player.artwork']
  assert.ok((await artwork({ url: 'https://thisis-images.scdn.co/37i9dQZF1DZ06evO1-large.jpg' })).dataUrl)
  assert.ok((await artwork({ url: 'https://pickasso.spotifycdn.com/image/ab67c0de' })).dataUrl)
  assert.equal((await artwork({ url: 'https://scdn.co.example.com/x' })).dataUrl, null)
  assert.equal((await artwork({ url: 'http://i.scdn.co/x' })).dataUrl, null)
  assert.equal(urls.length, 2)
})
