import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWebApiBackend } from '../backends/webapi/backend.mjs'
import { createClient } from '../backends/webapi/client.mjs'
import { SpotifyError } from '../src/backend.mjs'
import { fakeSpotifyApi, reply } from './fakes.mjs'

const images = [
  { url: 'https://i.scdn.co/image/640', width: 640, height: 640 },
  { url: 'https://i.scdn.co/image/300', width: 300, height: 300 },
  { url: 'https://i.scdn.co/image/64', width: 64, height: 64 }
]

const trackItem = (id = '1', overrides = {}) => ({
  type: 'track',
  name: `Song ${id}`,
  uri: `spotify:track:${id}`,
  duration_ms: 228_000,
  external_urls: { spotify: `https://open.spotify.com/track/${id}` },
  artists: [{ name: 'Artist A' }, { name: 'Artist B' }],
  album: { name: 'Album', images },
  ...overrides
})

const device = { id: 'dev1', name: 'Kitchen', type: 'Speaker', volume_percent: 64, supports_volume: true, is_active: true }

const playback = (overrides = {}) => ({
  is_playing: true,
  progress_ms: 72_345,
  shuffle_state: true,
  repeat_state: 'context',
  device,
  item: trackItem(),
  ...overrides
})

function setup(routes, { authError, expiresSoon = false, now = () => 0 } = {}) {
  const api = fakeSpotifyApi(routes)
  const auth = {
    getAccessToken: async () => {
      if (authError) throw authError
      return 'token'
    },
    expire: async () => {},
    expiresSoon: async () => expiresSoon
  }
  const client = createClient({ auth, fetchImpl: api.fetchImpl, now })
  return { api, backend: createWebApiBackend({ client, auth }) }
}

test('reads the player into the shared state shape', async () => {
  const { api, backend } = setup({ 'GET /me/player': reply(200, playback()) })
  assert.deepEqual(await backend.getState(), {
    status: 'playing',
    volume: 64,
    shuffle: true,
    repeat: 'context',
    positionMs: 72_345,
    track: {
      title: 'Song 1',
      artist: 'Artist A, Artist B',
      artists: ['Artist A', 'Artist B'],
      album: 'Album',
      uri: 'spotify:track:1',
      url: 'https://open.spotify.com/track/1',
      durationMs: 228_000,
      artworkUrl: 'https://i.scdn.co/image/300'
    },
    device: { id: 'dev1', name: 'Kitchen', type: 'Speaker', supportsVolume: true },
    authExpiresSoon: false
  })
  assert.equal(api.requests[0].query.additional_types, 'episode')
})

test('a paused player, an episode, and a device with nothing loaded', async () => {
  const episode = {
    type: 'episode',
    name: 'Ep 1',
    uri: 'spotify:episode:9',
    duration_ms: 1000,
    external_urls: { spotify: 'https://open.spotify.com/episode/9' },
    images,
    show: { name: 'A Show', publisher: 'Pub' }
  }
  const paused = await setup({ 'GET /me/player': reply(200, playback({ is_playing: false, item: episode })) }).backend.getState()
  assert.equal(paused.status, 'paused')
  assert.equal(paused.track.artist, 'A Show')
  assert.equal(paused.track.artworkUrl, 'https://i.scdn.co/image/300')
  const idle = await setup({ 'GET /me/player': reply(200, playback({ is_playing: false, item: null })) }).backend.getState()
  assert.equal(idle.status, 'stopped')
  assert.equal(idle.track, null)
})

test('no active device, no Client ID and no login are states the panel can explain', async () => {
  const none = await setup({ 'GET /me/player': reply(204) }).backend.getState()
  assert.equal(none.status, 'no-device')
  assert.match(none.message, /Open Spotify on any device/)
  const setupState = await setup({}, { authError: new SpotifyError('needs-setup', 'connect') }).backend.getState()
  assert.equal(setupState.status, 'needs-setup')
  const loggedOut = await setup({}, { authError: new SpotifyError('unauthenticated', 'connect') }).backend.getState()
  assert.equal(loggedOut.status, 'unauthenticated')
})

test('while rate limited, the last state comes back marked stale', async () => {
  const { backend } = setup({ 'GET /me/player': [reply(200, playback()), reply(429, undefined, { 'retry-after': '5' })] })
  await backend.getState()
  const stale = await backend.getState()
  assert.equal(stale.status, 'playing')
  assert.equal(stale.stale, true)
  assert.equal(stale.retryAfterMs, 5000)
  const fresh = await setup({ 'GET /me/player': reply(429, undefined, { 'retry-after': '5' }) }).backend.getState()
  assert.equal(fresh.status, 'rate-limited')
  assert.equal(fresh.retryAfterMs, 5000)
})

test('an exhausted quota is never hidden behind a stale state', async () => {
  const quota = reply(429, { error: { status: 429, reason: 'QUOTA_EXCEEDED' } })
  const { backend } = setup({ 'GET /me/player': [reply(200, playback()), quota] })
  await backend.getState()
  const state = await backend.getState()
  assert.equal(state.status, 'rate-limited')
  assert.match(state.message, /quota/)
})

test('the panel is told when the 6-month login is about to end', async () => {
  const { backend } = setup({ 'GET /me/player': reply(200, playback()) }, { expiresSoon: true })
  assert.equal((await backend.getState()).authExpiresSoon, true)
})

test('playpause reads the play state first, since there is no toggle endpoint', async () => {
  const { api, backend } = setup({ 'GET /me/player': reply(200, playback({ is_playing: true })) })
  assert.equal(await backend.command('playpause'), true)
  assert.deepEqual(api.requests.map((r) => `${r.method} ${r.path}`), ['GET /me/player', 'PUT /me/player/pause'])
})

test('player commands map to their endpoints', async () => {
  const { api, backend } = setup({ 'GET /me/player': reply(200, playback({ shuffle_state: true, repeat_state: 'context' })) })
  await backend.command('play')
  await backend.command('next')
  await backend.command('previous')
  await backend.command('toggleShuffle')
  await backend.command('toggleRepeat')
  await backend.command('setRepeat', 'off')
  await backend.command('setVolume', 42)
  await backend.command('seek', 61_600)
  const sent = api.requests.filter((r) => r.method !== 'GET').map((r) => [r.method, r.path, r.query])
  assert.deepEqual(sent, [
    ['PUT', '/me/player/play', {}],
    ['POST', '/me/player/next', {}],
    ['POST', '/me/player/previous', {}],
    ['PUT', '/me/player/shuffle', { state: 'false' }],
    ['PUT', '/me/player/repeat', { state: 'track' }],
    ['PUT', '/me/player/repeat', { state: 'off' }],
    ['PUT', '/me/player/volume', { volume_percent: '42' }],
    ['PUT', '/me/player/seek', { position_ms: '61600' }]
  ])
})

test('repeat steps off → context → track → off', async () => {
  for (const [from, to] of [['off', 'context'], ['context', 'track'], ['track', 'off']]) {
    const { api, backend } = setup({ 'GET /me/player': reply(200, playback({ repeat_state: from })) })
    await backend.command('toggleRepeat')
    assert.deepEqual(api.requests.at(-1).query, { state: to })
  }
})

test('bad values are refused before reaching Spotify', async () => {
  const { api, backend } = setup({})
  await assert.rejects(backend.command('setVolume', 101), { kind: 'invalid' })
  await assert.rejects(backend.command('seek', -1), { kind: 'invalid' })
  await assert.rejects(backend.command('setRepeat', 'twice'), { kind: 'invalid' })
  await assert.rejects(backend.command('launch'), { kind: 'invalid' })
  await assert.rejects(backend.command('open'), { kind: 'unsupported' })
  assert.equal(api.requests.length, 0)
})

test('a command with no active device reports that nothing ran', async () => {
  const noDevice = reply(404, { error: { status: 404, message: 'No active device found', reason: 'NO_ACTIVE_DEVICE' } })
  assert.equal(await setup({ 'POST /me/player/next': noDevice }).backend.command('next'), false)
  assert.equal(await setup({ 'GET /me/player': reply(204) }).backend.command('playpause'), false)
})

test('capabilities: three repeat modes, millisecond seek, volume as the device allows', async () => {
  const { backend } = setup({ 'GET /me/player': reply(200, playback({ device: { ...device, supports_volume: false } })) })
  assert.equal(backend.id, 'webapi')
  assert.deepEqual(backend.capabilities.repeatModes, ['off', 'context', 'track'])
  assert.equal(backend.capabilities.seekStepMs, 1)
  assert.equal(backend.capabilities.open, false)
  assert.equal(backend.capabilities.needsAuth, true)
  assert.equal(backend.capabilities.volume, true)
  await backend.getState()
  assert.equal(backend.capabilities.volume, false)
  assert.deepEqual(backend.settle, { tries: 2, stepMs: 400 })
  assert.deepEqual(backend.capabilities.poll, { playing: 5000, paused: 10_000, hidden: 30_000 })
})

test('devices and transfer', async () => {
  const { api, backend } = setup({
    'GET /me/player/devices': reply(200, { devices: [device, { ...device, id: 'dev2', name: 'Phone', type: 'Smartphone', is_active: false, volume_percent: null }] })
  })
  assert.deepEqual(await backend.devices(), [
    { id: 'dev1', name: 'Kitchen', type: 'Speaker', active: true, supportsVolume: true, volume: 64 },
    { id: 'dev2', name: 'Phone', type: 'Smartphone', active: false, supportsVolume: true, volume: null }
  ])
  await backend.transfer('dev2', true)
  assert.deepEqual(api.requests.at(-1), { method: 'PUT', path: '/me/player', query: {}, body: { device_ids: ['dev2'], play: true } })
})

test('queue, enqueue and playing a context', async () => {
  const { api, backend } = setup({
    'GET /me/player/queue': reply(200, { currently_playing: trackItem('1'), queue: [trackItem('2'), trackItem('3')] })
  })
  const { current, queue } = await backend.queue()
  assert.equal(current.uri, 'spotify:track:1')
  assert.deepEqual(queue.map((t) => t.title), ['Song 2', 'Song 3'])
  await backend.enqueue('spotify:track:4')
  assert.deepEqual(api.requests.at(-1).query, { uri: 'spotify:track:4' })
  await backend.playContext({ contextUri: 'spotify:album:7', offset: 2 })
  assert.deepEqual(api.requests.at(-1).body, { context_uri: 'spotify:album:7', offset: { position: 2 } })
  await backend.playContext({ uris: ['spotify:track:5'] })
  assert.deepEqual(api.requests.at(-1).body, { uris: ['spotify:track:5'] })
})

test('search asks for 10 per type and keeps only real items', async () => {
  const { api, backend } = setup({
    'GET /search': reply(200, {
      tracks: { items: [trackItem('1')], total: 31, offset: 0 },
      albums: { items: [{ name: 'LP', uri: 'spotify:album:a', artists: [{ name: 'X' }], images, external_urls: { spotify: 'u' } }], total: 1 },
      playlists: { items: [null, { name: 'Mix', uri: 'spotify:playlist:p', owner: { display_name: 'Me' }, images: [], external_urls: { spotify: 'u' } }], total: 2 }
    })
  })
  const results = await backend.search('lofi', ['track', 'album', 'playlist'], 10)
  assert.deepEqual(api.requests[0].query, { q: 'lofi', type: 'track,album,playlist', limit: '10', offset: '10' })
  assert.equal(results.tracks.items[0].title, 'Song 1')
  assert.equal(results.tracks.total, 31)
  assert.deepEqual(results.albums.items[0], { name: 'LP', subtitle: 'X', uri: 'spotify:album:a', url: 'u', artworkUrl: 'https://i.scdn.co/image/300' })
  assert.deepEqual(results.playlists.items.map((p) => p.name), ['Mix'])
  assert.equal(results.playlists.items[0].artworkUrl, null)
})

test('your playlists, 50 per page', async () => {
  const { api, backend } = setup({
    'GET /me/playlists': reply(200, {
      items: [{ name: 'Mine', uri: 'spotify:playlist:m', owner: { display_name: 'Me' }, images, external_urls: { spotify: 'u' }, tracks: { total: 12 } }],
      total: 60
    })
  })
  const page = await backend.playlists(50)
  assert.deepEqual(api.requests[0].query, { limit: '50', offset: '50' })
  assert.deepEqual(page, {
    items: [{ name: 'Mine', subtitle: 'Me', uri: 'spotify:playlist:m', url: 'u', artworkUrl: 'https://i.scdn.co/image/300', count: 12 }],
    total: 60,
    offset: 50
  })
})

test('every shared command name is one the Web API backend knows', async () => {
  const { COMMAND_NAMES } = await import('../src/backend.mjs')
  const { backend } = setup({ 'GET /me/player': reply(200, playback()) })
  const values = { setRepeat: 'off', setVolume: 10, seek: 0 }
  for (const name of COMMAND_NAMES) {
    if (name === 'open') continue
    assert.equal(await backend.command(name, values[name]), true, name)
  }
})

test('the state says what the track is playing from', async () => {
  const context = { type: 'playlist', uri: 'spotify:playlist:p1', external_urls: { spotify: 'u' } }
  const state = await setup({ 'GET /me/player': reply(200, playback({ context })) }).backend.getState()
  assert.deepEqual(state.context, { type: 'playlist', uri: 'spotify:playlist:p1' })
})
