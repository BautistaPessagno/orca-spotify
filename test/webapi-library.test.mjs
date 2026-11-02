import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWebApiBackend } from '../backends/webapi/backend.mjs'
import { createClient } from '../backends/webapi/client.mjs'
import { fakeSpotifyApi, reply } from './fakes.mjs'

const images = [
  { url: 'https://i.scdn.co/image/640', width: 640, height: 640 },
  { url: 'https://i.scdn.co/image/300', width: 300, height: 300 }
]
const track = (id, overrides = {}) => ({
  type: 'track',
  name: `Song ${id}`,
  uri: `spotify:track:${id}`,
  duration_ms: 1000,
  external_urls: { spotify: `https://open.spotify.com/track/${id}` },
  artists: [{ name: 'Artist A', uri: 'spotify:artist:a' }],
  album: { name: 'Album', uri: 'spotify:album:al', images, release_date: '2024-05-01' },
  ...overrides
})
const album = { name: 'LP', uri: 'spotify:album:al', artists: [{ name: 'Artist A' }], images, external_urls: { spotify: 'u' }, release_date: '2021-03-04', total_tracks: 2 }
const artist = { name: 'Artist A', uri: 'spotify:artist:a', images, external_urls: { spotify: 'u' }, type: 'artist' }
const playlist = { name: 'Focus', uri: 'spotify:playlist:p1', owner: { display_name: 'Me' }, images, external_urls: { spotify: 'u' }, items: { total: 2 } }

// Spotify's public link previews (oEmbed): the name and cover of any playlist, Spotify's own too.
function fakeOembed(titles = {}) {
  const asked = []
  const fetchImpl = async (url) => {
    const target = new URL(url).searchParams.get('url')
    asked.push(target)
    const id = target.split('/').pop()
    if (!titles[id]) return { ok: false, status: 404, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ({ title: titles[id], thumbnail_url: `https://thisis-images.scdn.co/${id}.jpg` }) }
  }
  return { fetchImpl, asked }
}

function setup(routes, { oembed = fakeOembed() } = {}) {
  const api = fakeSpotifyApi(routes)
  const auth = { getAccessToken: async () => 'token', expire: async () => {}, expiresSoon: async () => false }
  return { api, oembed, backend: createWebApiBackend({ client: createClient({ auth, fetchImpl: api.fetchImpl }), auth, fetchImpl: oembed.fetchImpl }) }
}

test('home: what you played lately, by album or playlist, then your top artists and songs', async () => {
  const { api, backend } = setup({
    'GET /me/player/recently-played': reply(200, {
      items: [
        { track: track('1'), context: { type: 'playlist', uri: 'spotify:playlist:p1' } },
        { track: track('2'), context: { type: 'playlist', uri: 'spotify:playlist:p1' } },
        { track: track('3'), context: null },
        { track: track('4'), context: { type: 'collection', uri: 'spotify:user:me:collection' } }
      ]
    }),
    'GET /playlists/p1': reply(200, playlist),
    'GET /me/top/artists': reply(200, { items: [artist] }),
    'GET /me/top/tracks': reply(200, { items: [track('9')] })
  })
  const home = await backend.home()
  assert.deepEqual(home.recent.map((item) => [item.kind, item.name, item.uri]), [
    ['playlist', 'Focus', 'spotify:playlist:p1'],
    ['album', 'Album', 'spotify:album:al'],
    ['collection', 'Liked Songs', 'spotify:user:me:collection']
  ])
  assert.deepEqual(home.recentTracks.map((t) => t.uri), ['spotify:track:1', 'spotify:track:2', 'spotify:track:3', 'spotify:track:4'])
  assert.equal(home.topArtists[0].name, 'Artist A')
  assert.equal(home.topArtists[0].kind, 'artist')
  assert.equal(home.topTracks[0].uri, 'spotify:track:9')
  assert.equal(api.requests.filter((r) => r.path === '/playlists/p1').length, 1, 'each context name is read once')
  await backend.home()
  assert.equal(api.requests.filter((r) => r.path === '/playlists/p1').length, 1, 'and cached after that')
})

test('library: Liked Songs, saved albums, followed artists and podcasts', async () => {
  const { api, backend } = setup({
    'GET /me/tracks': reply(200, { items: [{ added_at: 'x', track: track('1') }], total: 120 }),
    'GET /me/albums': reply(200, { items: [{ album }], total: 1 }),
    'GET /me/following': reply(200, { artists: { items: [artist], next: 'https://api.spotify.com/v1/me/following?type=artist&after=a', cursors: { after: 'a' } } }),
    'GET /me/shows': reply(200, { items: [{ show: { name: 'Pod', publisher: 'Pub', uri: 'spotify:show:s', images, external_urls: { spotify: 'u' } } }], total: 1 }),
    'GET /me': reply(200, { id: 'me' })
  })
  const liked = await backend.likedSongs(50)
  assert.deepEqual(api.requests.find((r) => r.path === '/me/tracks').query, { limit: '50', offset: '50' })
  assert.equal(liked.items[0].uri, 'spotify:track:1')
  assert.equal(liked.total, 120)
  assert.equal(liked.uri, 'spotify:user:me:collection')
  const albums = await backend.savedAlbums(0)
  assert.deepEqual(albums.items[0], { kind: 'album', name: 'LP', subtitle: 'Artist A', uri: 'spotify:album:al', url: 'u', artworkUrl: 'https://i.scdn.co/image/300', year: '2021', addedAt: null })
  const artists = await backend.followedArtists()
  assert.equal(artists.items[0].kind, 'artist')
  assert.equal(artists.after, 'a')
  assert.deepEqual(api.requests.find((r) => r.path === '/me/following').query, { type: 'artist', limit: '50' })
  const shows = await backend.savedShows(0)
  assert.deepEqual(shows.items[0], { kind: 'show', name: 'Pod', subtitle: 'Pub', uri: 'spotify:show:s', url: 'u', artworkUrl: 'https://i.scdn.co/image/300' })
})

test('an album page: header and every track, each with the album art', async () => {
  const { backend } = setup({
    'GET /albums/al': reply(200, { ...album, tracks: { items: [track('1', { album: undefined }), track('2', { album: undefined })], total: 2 } })
  })
  const page = await backend.album('spotify:album:al')
  assert.equal(page.kind, 'album')
  assert.equal(page.name, 'LP')
  assert.equal(page.subtitle, 'Artist A')
  assert.equal(page.year, '2021')
  assert.equal(page.playable, true)
  assert.deepEqual(page.tracks.map((t) => t.uri), ['spotify:track:1', 'spotify:track:2'])
  assert.equal(page.tracks[0].artworkUrl, 'https://i.scdn.co/image/300')
})

test('an artist page lists the discography', async () => {
  const { api, backend } = setup({
    'GET /artists/a': reply(200, artist),
    'GET /artists/a/albums': reply(200, { items: [album], total: 1 })
  })
  const page = await backend.artist('spotify:artist:a')
  assert.equal(page.kind, 'artist')
  assert.equal(page.name, 'Artist A')
  assert.equal(page.albums[0].name, 'LP')
  assert.equal(page.albums[0].year, '2021')
  assert.equal(api.requests.at(-1).query.include_groups, 'album,single')
})

test('a playlist page: your own lists its songs, someone else\'s only its header', async () => {
  const own = { ...playlist, items: { total: 2, items: [{ item: track('1') }, { track: track('2') }, { item: null }] } }
  const page = await setup({ 'GET /playlists/p1': reply(200, own) }).backend.playlist('spotify:playlist:p1')
  assert.deepEqual(page.tracks.map((t) => t.uri), ['spotify:track:1', 'spotify:track:2'])
  assert.equal(page.count, 2)
  const theirs = await setup({ 'GET /playlists/p1': reply(200, { ...playlist, items: { total: 30 } }) }).backend.playlist('spotify:playlist:p1')
  assert.equal(theirs.tracks, null)
  assert.equal(theirs.count, 30)
})

test('saving to and removing from your library', async () => {
  const { api, backend } = setup({ 'GET /me/library/contains': reply(200, [true, false]) })
  assert.deepEqual(await backend.isSaved(['spotify:track:1', 'spotify:album:al']), [true, false])
  assert.equal(api.requests.at(-1).query.uris, 'spotify:track:1,spotify:album:al')
  await backend.setSaved('spotify:track:1', true)
  assert.deepEqual([api.requests.at(-1).method, api.requests.at(-1).path, api.requests.at(-1).query.uris], ['PUT', '/me/library', 'spotify:track:1'])
  await backend.setSaved('spotify:track:1', false)
  assert.equal(api.requests.at(-1).method, 'DELETE')
})

test('playing a track inside an album, a playlist or Liked Songs', async () => {
  const { api, backend } = setup({})
  await backend.playContext({ contextUri: 'spotify:user:me:collection', offsetUri: 'spotify:track:1' })
  assert.deepEqual(api.requests.at(-1).body, { context_uri: 'spotify:user:me:collection', offset: { uri: 'spotify:track:1' } })
})

test('search can look for podcasts too', async () => {
  const { api, backend } = setup({
    'GET /search': reply(200, {
      shows: { items: [{ name: 'Pod', publisher: 'Pub', uri: 'spotify:show:s', images }], total: 1 },
      episodes: { items: [{ type: 'episode', name: 'Ep', uri: 'spotify:episode:e', duration_ms: 5, images, show: { name: 'Pod' } }], total: 1 }
    })
  })
  const results = await backend.search('pod', ['show', 'episode'], 0)
  assert.equal(api.requests[0].query.type, 'show,episode')
  assert.equal(results.shows.items[0].kind, 'show')
  assert.equal(results.episodes.items[0].uri, 'spotify:episode:e')
})

test('a Spotify-made playlist (This Is, Daily Mix) opens as a page Spotify keeps closed', async () => {
  const oembed = fakeOembed({ '37i9dQZF1DZ06evO1': 'This Is Soda Stereo' })
  const { backend } = setup({ 'GET /playlists/37i9dQZF1DZ06evO1': reply(404, { error: { status: 404, message: 'Resource not found' } }) }, { oembed })
  const page = await backend.playlist('spotify:playlist:37i9dQZF1DZ06evO1')
  assert.equal(page.closed, true)
  assert.equal(page.name, 'This Is Soda Stereo', 'named from the public link preview')
  assert.equal(page.artworkUrl, 'https://thisis-images.scdn.co/37i9dQZF1DZ06evO1.jpg')
  assert.deepEqual(oembed.asked, ['https://open.spotify.com/playlist/37i9dQZF1DZ06evO1'])
  assert.equal(page.tracks, null)
  assert.equal(page.playable, true)
  assert.equal(page.uri, 'spotify:playlist:37i9dQZF1DZ06evO1')
  assert.equal(page.url, 'https://open.spotify.com/playlist/37i9dQZF1DZ06evO1')
})


test('Home keeps the Spotify-made playlists you played, named from their link preview', async () => {
  const closed = reply(404, { error: { status: 404, message: 'Resource not found' } })
  const oembed = fakeOembed({ '37i9dQZF1DZ06evO1': 'This Is Soda Stereo' })
  const { backend } = setup({
    'GET /me/player/recently-played': reply(200, {
      items: [
        { track: track('1'), played_at: '2026-11-02T10:00:00Z', context: { type: 'playlist', uri: 'spotify:playlist:37i9dQZF1DZ06evO1' } },
        { track: track('2'), played_at: '2026-11-02T09:00:00Z', context: { type: 'album', uri: 'spotify:album:al' } }
      ]
    }),
    'GET /playlists/37i9dQZF1DZ06evO1': closed,
    'GET /albums/al': reply(200, album)
  }, { oembed })
  const home = await backend.home()
  assert.deepEqual(home.recent[0], {
    kind: 'playlist', name: 'This Is Soda Stereo', subtitle: 'Spotify', uri: 'spotify:playlist:37i9dQZF1DZ06evO1',
    url: 'https://open.spotify.com/playlist/37i9dQZF1DZ06evO1', artworkUrl: 'https://thisis-images.scdn.co/37i9dQZF1DZ06evO1.jpg', count: null, closed: true
  })
  assert.deepEqual(home.recentContexts, [
    { uri: 'spotify:playlist:37i9dQZF1DZ06evO1', playedAt: Date.parse('2026-11-02T10:00:00Z') },
    { uri: 'spotify:album:al', playedAt: Date.parse('2026-11-02T09:00:00Z') }
  ])
})

test('saved albums say when you saved them, for sorting by recently added', async () => {
  const { backend } = setup({ 'GET /me/albums': reply(200, { items: [{ added_at: '2025-01-02T03:04:05Z', album }], total: 1 }) })
  assert.equal((await backend.savedAlbums(0)).items[0].addedAt, Date.parse('2025-01-02T03:04:05Z'))
})
