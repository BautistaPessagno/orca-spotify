// Web API reads and writes beyond the player itself: devices, queue, search and playlists,
// and the mapping from Spotify's objects to the small shapes the panel draws.
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

// An album, artist or playlist row.
function toItem(item, subtitle) {
  return { name: item.name, subtitle, uri: item.uri, url: item.external_urls?.spotify ?? null, artworkUrl: pickImage(item.images) }
}

const toAlbum = (album) => toItem(album, (album.artists ?? []).map((artist) => artist.name).join(', '))
const toArtist = (artist) => toItem(artist, 'Artist')
const toPlaylist = (playlist) => ({
  ...toItem(playlist, playlist.owner?.display_name ?? ''),
  count: playlist.tracks?.total ?? playlist.items?.total ?? null
})

export const SEARCH_LIMIT = 10
export const PLAYLISTS_LIMIT = 50

// Spotify returns null entries for items it hides (removed playlists); drop them.
const page = (section, map) =>
  section ? { items: (section.items ?? []).filter(Boolean).map(map), total: section.total ?? 0, offset: section.offset ?? 0 } : undefined

export function createLibrary(client) {
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

    // A context (album, playlist, artist) from an optional position, or a list of track URIs.
    async playContext({ contextUri, uris, offset } = {}) {
      const body = contextUri ? { context_uri: contextUri } : { uris }
      if (contextUri && Number.isInteger(offset)) body.offset = { position: offset }
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
        playlists: page(body?.playlists, toPlaylist)
      }
      return Object.fromEntries(Object.entries(results).filter(([, section]) => section))
    },

    async playlists(offset = 0) {
      const body = await client.request('GET', '/me/playlists', { query: { limit: PLAYLISTS_LIMIT, offset } })
      return { items: (body?.items ?? []).filter(Boolean).map(toPlaylist), total: body?.total ?? 0, offset }
    }
  }
}
