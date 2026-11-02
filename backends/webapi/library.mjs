// Web API reads and writes beyond the player itself: devices, queue, search, home, your library
// and album / artist / playlist pages, and the mapping from Spotify's objects to the small
// shapes the panel draws. Only endpoints in Spotify's Development Mode set (February 2026).
import { SEARCH_TYPES } from '../../src/backend.mjs'

// Spotify lists images widest first. The panel shows ~300 px: take the smallest that is at
// least that wide, or the widest there is.
export function pickImage(images) {
  if (!Array.isArray(images) || images.length === 0) return null
  const wide = images.filter((image) => (image?.width ?? 0) >= 280)
  return (wide.at(-1) ?? images[0])?.url ?? null
}

export function toTrack(item) {
  if (!item) return null
  const episode = item.type === 'episode'
  const artists = episode ? [item.show?.name].filter(Boolean) : (item.artists ?? []).map((artist) => artist.name)
  return {
    title: item.name,
    artist: artists.join(', '),
    artists,
    album: episode ? (item.show?.publisher ?? '') : (item.album?.name ?? ''),
    uri: item.uri,
    url: item.external_urls?.spotify ?? null,
    durationMs: item.duration_ms ?? 0,
    artworkUrl: pickImage(episode ? item.images : item.album?.images)
  }
}

export function toDevice(device) {
  return {
    id: device.id,
    name: device.name,
    type: device.type,
    active: Boolean(device.is_active),
    supportsVolume: device.supports_volume !== false,
    volume: device.volume_percent ?? null
  }
}

// An album, artist, playlist or show row. `kind` says which page it opens.
function toItem(kind, item, subtitle) {
  return { kind, name: item.name, subtitle, uri: item.uri, url: item.external_urls?.spotify ?? null, artworkUrl: pickImage(item.images) }
}

const artistNames = (item) => (item.artists ?? []).map((artist) => artist.name).join(', ')
const yearOf = (item) => (item.release_date ? String(item.release_date).slice(0, 4) : null)
const toAlbum = (album) => ({ ...toItem('album', album, artistNames(album)), year: yearOf(album) })
const toArtist = (artist) => toItem('artist', artist, 'Artist')
const toShow = (show) => toItem('show', show, show.publisher ?? '')
// Since February 2026 a playlist's songs are under `items` (they were under `tracks`).
const playlistItems = (playlist) => playlist.items ?? playlist.tracks
const toPlaylist = (playlist) => ({
  ...toItem('playlist', playlist, playlist.owner?.display_name ?? ''),
  count: playlistItems(playlist)?.total ?? null
})

const idOf = (uri) => String(uri).split(':').pop()
const LIKED_SONGS = 'Liked Songs'
const RECENT_LIMIT = 8

export const SEARCH_LIMIT = 10
export const PLAYLISTS_LIMIT = 50
export const LIBRARY_LIMIT = 50

// Spotify returns null entries for items it hides (removed playlists); drop them.
const page = (section, map) =>
  section ? { items: (section.items ?? []).filter(Boolean).map(map), total: section.total ?? 0, offset: section.offset ?? 0 } : undefined

const OEMBED = 'https://open.spotify.com/oembed'

export function createLibrary(client, { fetchImpl = globalThis.fetch } = {}) {
  // Names and art of the albums, playlists and artists Home shows, read once each.
  const contexts = new Map()
  const previews = new Map()
  let userId = null

  // Spotify keeps the playlists it makes (This Is, Daily Mix) from new apps' Web API calls, but
  // its public link preview (oEmbed, no login) still names them and gives their cover.
  const preview = (url) => {
    if (!previews.has(url)) {
      const read = fetchImpl(`${OEMBED}?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(5000) })
        .then((response) => (response.ok ? response.json() : null))
        .then((body) => (body?.title ? { name: body.title, artworkUrl: body.thumbnail_url ?? null } : null))
        .catch(() => null)
      previews.set(url, read)
      read.then((value) => value || previews.delete(url))
    }
    return previews.get(url)
  }

  const closedPlaylist = async (uri) => {
    const url = `https://open.spotify.com/playlist/${idOf(uri)}`
    const known = await preview(url)
    return { kind: 'playlist', name: known?.name ?? null, subtitle: 'Spotify', uri, url, artworkUrl: known?.artworkUrl ?? null, count: null, closed: true }
  }

  const me = async () => {
    userId ??= (await client.request('GET', '/me'))?.id ?? null
    return userId
  }

  const contextItem = async ({ type, uri }) => {
    if (type === 'collection') return { kind: 'collection', name: LIKED_SONGS, subtitle: 'Playlist', uri, url: null, artworkUrl: null }
    if (!contexts.has(uri)) {
      const path = { playlist: '/playlists/', album: '/albums/', artist: '/artists/' }[type]
      if (!path) return null
      const read = client.request('GET', path + idOf(uri)).then(
        (body) => {
          if (!body) return null
          return type === 'playlist' ? toPlaylist(body) : type === 'album' ? toAlbum(body) : toArtist(body)
        },
        (error) => {
          if (type === 'playlist' && error?.kind === 'not-found') return closedPlaylist(uri).then((item) => (item.name ? item : null))
          throw error
        }
      )
      contexts.set(uri, read.catch(() => (contexts.delete(uri), null)))
    }
    return contexts.get(uri)
  }

  return {
    async devices() {
      const body = await client.request('GET', '/me/player/devices')
      return (body?.devices ?? []).map(toDevice)
    },

    async transfer(deviceId, play = false) {
      await client.request('PUT', '/me/player', { body: { device_ids: [deviceId], play: Boolean(play) } })
    },

    async queue() {
      const body = await client.request('GET', '/me/player/queue')
      return { current: toTrack(body?.currently_playing), queue: (body?.queue ?? []).filter(Boolean).map(toTrack) }
    },

    async enqueue(uri) {
      await client.request('POST', '/me/player/queue', { query: { uri } })
    },

    // A context (album, playlist, artist, Liked Songs) from an optional position or track, or a
    // list of track URIs.
    async playContext({ contextUri, uris, offset, offsetUri } = {}) {
      const body = contextUri ? { context_uri: contextUri } : { uris }
      if (contextUri && offsetUri) body.offset = { uri: offsetUri }
      else if (contextUri && Number.isInteger(offset)) body.offset = { position: offset }
      await client.request('PUT', '/me/player/play', { body })
    },

    async search(q, types = SEARCH_TYPES, offset = 0) {
      const body = await client.request('GET', '/search', {
        query: { q, type: types.join(','), limit: SEARCH_LIMIT, offset }
      })
      const results = {
        tracks: page(body?.tracks, toTrack),
        albums: page(body?.albums, toAlbum),
        artists: page(body?.artists, toArtist),
        playlists: page(body?.playlists, toPlaylist),
        shows: page(body?.shows, toShow),
        episodes: page(body?.episodes, toTrack)
      }
      return Object.fromEntries(Object.entries(results).filter(([, section]) => section))
    },

    async playlists(offset = 0) {
      const body = await client.request('GET', '/me/playlists', { query: { limit: PLAYLISTS_LIMIT, offset } })
      return { items: (body?.items ?? []).filter(Boolean).map(toPlaylist), total: body?.total ?? 0, offset }
    },

    // Home: what you played lately (by album or playlist, newest first), the songs themselves,
    // and your top artists and songs. Spotify's recommendations are not open to new apps.
    async home() {
      const [recent, topArtists, topTracks] = await Promise.all([
        client.request('GET', '/me/player/recently-played', { query: { limit: 50 } }),
        client.request('GET', '/me/top/artists', { query: { limit: 10 } }).catch(() => null),
        client.request('GET', '/me/top/tracks', { query: { limit: 10 } }).catch(() => null)
      ])
      const played = (recent?.items ?? []).filter((entry) => entry?.track)
      const seen = new Set()
      const sources = []
      // When each album, playlist or artist was last played, newest first (Your Library sorts by it).
      const recentContexts = []
      for (const { track, context, played_at: playedAt } of played) {
        // No context (played from search, say): the track's album stands in.
        const source = context?.uri ? context : track.album?.uri ? { type: 'album', uri: track.album.uri, album: track.album } : null
        if (!source || seen.has(source.uri)) continue
        seen.add(source.uri)
        recentContexts.push({ uri: source.uri, playedAt: Date.parse(playedAt) || null })
        if (sources.length < RECENT_LIMIT) sources.push(source)
      }
      const items = await Promise.all(
        sources.map((source) =>
          source.album ? { ...toAlbum(source.album), subtitle: artistNames(source.album) || 'Album' } : contextItem(source)
        )
      )
      const tracks = []
      const trackSeen = new Set()
      for (const { track } of played) {
        if (trackSeen.has(track.uri)) continue
        trackSeen.add(track.uri)
        tracks.push(toTrack(track))
      }
      return {
        recent: items.filter(Boolean),
        recentContexts,
        recentTracks: tracks.slice(0, 10),
        topArtists: (topArtists?.items ?? []).filter(Boolean).map(toArtist),
        topTracks: (topTracks?.items ?? []).filter(Boolean).map(toTrack)
      }
    },

    // Liked Songs, a page at a time. `uri` plays them as one context.
    async likedSongs(offset = 0) {
      const [body, id] = await Promise.all([
        client.request('GET', '/me/tracks', { query: { limit: LIBRARY_LIMIT, offset } }),
        me().catch(() => null)
      ])
      return {
        items: (body?.items ?? []).filter((entry) => entry?.track).map((entry) => toTrack(entry.track)),
        total: body?.total ?? 0,
        offset,
        uri: id ? `spotify:user:${id}:collection` : null
      }
    },

    async savedAlbums(offset = 0) {
      const body = await client.request('GET', '/me/albums', { query: { limit: LIBRARY_LIMIT, offset } })
      const items = (body?.items ?? []).filter((entry) => entry?.album)
      return { items: items.map((entry) => ({ ...toAlbum(entry.album), addedAt: Date.parse(entry.added_at) || null })), total: body?.total ?? 0, offset }
    },

    // Followed artists page by cursor: pass the `after` the last page returned.
    async followedArtists(after) {
      const query = { type: 'artist', limit: LIBRARY_LIMIT }
      if (after) query.after = after
      const body = await client.request('GET', '/me/following', { query })
      const section = body?.artists ?? {}
      return { items: (section.items ?? []).filter(Boolean).map(toArtist), after: section.next ? (section.cursors?.after ?? null) : null }
    },

    async savedShows(offset = 0) {
      const body = await client.request('GET', '/me/shows', { query: { limit: LIBRARY_LIMIT, offset } })
      return { items: (body?.items ?? []).filter((entry) => entry?.show).map((entry) => toShow(entry.show)), total: body?.total ?? 0, offset }
    },

    async album(uri) {
      const body = await client.request('GET', '/albums/' + idOf(uri))
      const art = body?.images
      return {
        ...toAlbum(body),
        playable: true,
        count: body?.total_tracks ?? body?.tracks?.total ?? null,
        // Album tracks come without the album; give each the album's art and name.
        tracks: (body?.tracks?.items ?? []).filter(Boolean).map((item) => toTrack({ ...item, album: { name: body.name, images: art } }))
      }
    },

    async artist(uri) {
      const [body, albums] = await Promise.all([
        client.request('GET', '/artists/' + idOf(uri)),
        client.request('GET', `/artists/${idOf(uri)}/albums`, { query: { include_groups: 'album,single', limit: 20 } })
      ])
      return { ...toArtist(body), playable: true, albums: (albums?.items ?? []).filter(Boolean).map(toAlbum) }
    },

    // Spotify lists a playlist's songs only for your own playlists; others show their header.
    async playlist(uri) {
      let body
      try {
        body = await client.request('GET', '/playlists/' + idOf(uri))
      } catch (error) {
        // Playlists Spotify makes (This Is, Daily Mix, Discover Weekly) are closed to new apps:
        // the panel shows what it already knows about it, with Play and Open in Spotify.
        if (error?.kind !== 'not-found') throw error
        return { ...(await closedPlaylist(uri)), playable: true, tracks: null }
      }
      const list = playlistItems(body)
      const entries = Array.isArray(list?.items) ? list.items : null
      return {
        ...toPlaylist(body),
        playable: true,
        description: body?.description || null,
        tracks: entries ? entries.map((entry) => entry?.item ?? entry?.track).filter(Boolean).map(toTrack) : null
      }
    },

    // Whether each URI (track, album, episode, show) is in your library.
    async isSaved(uris) {
      const body = await client.request('GET', '/me/library/contains', { query: { uris: uris.join(',') } })
      return Array.isArray(body) ? body.map(Boolean) : uris.map(() => false)
    },

    async setSaved(uri, saved) {
      await client.request(saved ? 'PUT' : 'DELETE', '/me/library', { query: { uris: uri } })
    }
  }
}
