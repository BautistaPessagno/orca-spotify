// Renders the plugin directory's cover and screenshots into images/ from the real panel/index.html.
// The panel runs unchanged; a stand-in window.orca answers its requests from an invented catalog
// with generated artwork, as the Spotify backends or as the Apple Music one, so no real album art
// and no Spotify or Apple branding ends up in the listing: the services are named in text only.
// A short script per shot then moves the panel to the view it shows (Home, Your Library, an album…).
//
//   node scripts/render-listing-images.mjs           # all of them
//   node scripts/render-listing-images.mjs cover     # one
//
// The cover is also what onorca.dev shows when someone shares the plugin's link, cropped to about
// 1.9:1 around its middle, so everything that matters stays inside the middle 840 px of height.
//
// Needs Google Chrome (or set CHROME to a Chrome or Chromium binary).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'images')
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const WIDTH = 1600
const HEIGHT = 1000

// Orca's panel tokens (--orca-*), from its stylesheet.
const THEMES = {
  dark: { background: '#0a0a0a', foreground: '#f0f0f0', 'muted-foreground': '#acacac', accent: '#404040', primary: '#e5e5e5', ring: '#737373' },
  light: { background: '#ffffff', foreground: '#0a0a0a', 'muted-foreground': '#696969', accent: '#f5f5f5', primary: '#171717', ring: '#a1a1a1' }
}

// ---------- artwork: abstract, generated, no real covers ----------

const svgUrl = (body) => 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">${body}</svg>`).toString('base64')
const sky = (a, b) => `<defs><linearGradient id="g" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="300" height="300" fill="url(#g)"/>`

const ART = {
  hills: (a, b, sun, hills) =>
    svgUrl(sky(a, b) + `<circle cx="196" cy="128" r="54" fill="${sun}"/>` + hills.map((c, i) => {
      const y = 170 + i * 38
      return `<path d="M0 ${y} C 70 ${y - 40}, 140 ${y + 30}, 210 ${y - 10} S 300 ${y - 30}, 300 ${y - 20} V300 H0 Z" fill="${c}"/>`
    }).join('')),
  rings: (a, b, colors) => svgUrl(sky(a, b) + colors.map((c, i) => `<circle cx="150" cy="150" r="${120 - i * 26}" fill="none" stroke="${c}" stroke-width="13"/>`).join('')),
  stripes: (a, colors) => svgUrl(`<rect width="300" height="300" fill="${a}"/>` + colors.map((c, i) => `<rect x="-60" y="${40 + i * 52}" width="420" height="30" fill="${c}" transform="rotate(-24 150 150)"/>`).join('')),
  blocks: (colors) => svgUrl(colors.map((c, i) => `<rect x="${(i % 3) * 100}" y="${Math.floor(i / 3) * 100}" width="100" height="100" fill="${c}"/>`).join('') + `<circle cx="150" cy="150" r="46" fill="${colors[4]}" opacity="0.9"/>`),
  orb: (a, b, orb, glow) => svgUrl(sky(a, b) + `<circle cx="150" cy="160" r="96" fill="${glow}" opacity="0.35"/><circle cx="150" cy="160" r="66" fill="${orb}"/>`),
  waves: (a, b, line) => svgUrl(sky(a, b) + Array.from({ length: 9 }, (_, i) => `<path d="M-10 ${60 + i * 24} Q 75 ${30 + i * 24}, 150 ${60 + i * 24} T 310 ${60 + i * 24}" fill="none" stroke="${line}" stroke-opacity="${0.35 + i * 0.07}" stroke-width="6"/>`).join('')),
  bars: (a, b, color) => svgUrl(sky(a, b) + [70, 130, 95, 180, 120, 150, 85].map((h, i) => `<rect x="${32 + i * 34}" y="${250 - h}" width="22" height="${h}" rx="5" fill="${color}"/>`).join('')),
  peak: (a, b, front, back) => svgUrl(sky(a, b) + `<path d="M-20 300 L120 120 L200 220 L250 160 L330 300 Z" fill="${back}"/><path d="M-20 300 L90 170 L190 300 Z" fill="${front}"/>`)
}

const A = {
  lanterns: ART.hills('#2b1d5c', '#e0617a', '#ffd27a', ['#7a3a78', '#4a2563', '#24163f']),
  glass: ART.hills('#0f3d56', '#7cc6c4', '#f4efe1', ['#2f7c8a', '#1d5768', '#0e2f40']),
  satellites: ART.rings('#101c3d', '#283c7a', ['#7fd1ff', '#4f8dff', '#a58bff', '#ff8fd0']),
  static: ART.stripes('#f2c14e', ['#e8743b', '#d1495b', '#2e294e', '#1b998b', '#e8743b']),
  atlas: ART.orb('#120b2e', '#3b1d63', '#ff9e64', '#ff6f91'),
  choir: ART.waves('#06283d', '#1363df', '#dff6ff'),
  focus: ART.bars('#3a0ca3', '#7209b7', '#f2f2f2'),
  deploys: ART.peak('#0b132b', '#3a506b', '#5bc0be', '#1c2541'),
  porch: ART.orb('#f7d6bf', '#f08a5d', '#fff3e2', '#ffd0a6'),
  release: ART.blocks(['#ff595e', '#ffca3a', '#8ac926', '#1982c4', '#6a4c93', '#ff924c', '#52a675', '#4267ac', '#b5a6c9']),
  road: ART.peak('#ffb88c', '#de6262', '#3d2c8d', '#916bbf'),
  morning: ART.waves('#fbe7c6', '#f4a259', '#5b8e7d'),
  ember: ART.rings('#2d0b00', '#7a1f00', ['#ffb347', '#ff7b54', '#e94560', '#ffd56b']),
  tide: ART.stripes('#0a2342', ['#2ca58d', '#84bc9c', '#fffdf7', '#f46197', '#2ca58d']),
  moss: ART.hills('#1e3b2f', '#9ccc65', '#fff9c4', ['#558b2f', '#33691e', '#1b3a12']),
  neon: ART.bars('#0d0221', '#261447', '#2de2e6'),
  liked: null
}

// ---------- the invented catalog ----------

const artists = {
  harbor: { kind: 'artist', name: 'Harbor Lights', subtitle: 'Artist', uri: 'spotify:artist:harbor', url: 'https://open.spotify.com/artist/harbor', artworkUrl: A.lanterns },
  coast: { kind: 'artist', name: 'The Quiet Coast', subtitle: 'Artist', uri: 'spotify:artist:coast', url: 'https://open.spotify.com/artist/coast', artworkUrl: A.glass },
  satellites: { kind: 'artist', name: 'Paper Satellites', subtitle: 'Artist', uri: 'spotify:artist:sat', url: 'https://open.spotify.com/artist/sat', artworkUrl: A.satellites },
  juniper: { kind: 'artist', name: 'Juniper Static', subtitle: 'Artist', uri: 'spotify:artist:jun', url: 'https://open.spotify.com/artist/jun', artworkUrl: A.static },
  atlas: { kind: 'artist', name: 'Velvet Atlas', subtitle: 'Artist', uri: 'spotify:artist:atlas', url: 'https://open.spotify.com/artist/atlas', artworkUrl: A.atlas },
  choir: { kind: 'artist', name: 'Northbound Choir', subtitle: 'Artist', uri: 'spotify:artist:choir', url: 'https://open.spotify.com/artist/choir', artworkUrl: A.choir }
}

const album = (id, name, artist, year, art) => ({ kind: 'album', name, subtitle: artist.name, year, uri: `spotify:album:${id}`, url: `https://open.spotify.com/album/${id}`, artworkUrl: art })
const albums = {
  saltwater: album('saltwater', 'Saltwater Hours', artists.harbor, '2025', A.lanterns),
  north: album('north', 'North Facing', artists.coast, '2024', A.glass),
  orbit: album('orbit', 'Low Orbit', artists.satellites, '2026', A.satellites),
  signal: album('signal', 'Signal Fires', artists.juniper, '2023', A.static),
  neon: album('neonharbor', 'Neon Harbor', artists.atlas, '2026', A.atlas),
  tide: album('tidelines', 'Tidelines', artists.choir, '2022', A.tide),
  ember: album('ember', 'Ember Season', artists.harbor, '2023', A.ember),
  moss: album('moss', 'Moss & Granite', artists.coast, '2021', A.moss)
}

const playlist = (id, name, owner, count, art) => ({ kind: 'playlist', name, subtitle: owner, count, uri: `spotify:playlist:${id}`, url: `https://open.spotify.com/playlist/${id}`, artworkUrl: art })
const playlists = [
  playlist('focus', 'Deep Focus Coding', 'You', 64, A.focus),
  playlist('deploys', 'Late Night Deploys', 'You', 41, A.deploys),
  playlist('porch', 'Sunday Porch', 'You', 28, A.porch),
  playlist('release', 'Release Day', 'You', 19, A.release),
  playlist('road', 'Road Trip West', 'Sam', 82, A.road),
  playlist('morning', 'Slow Mornings', 'You', 37, A.morning),
  playlist('neon', 'Synthwave Standup', 'Ari', 53, A.neon)
]

let n = 0
const track = (title, artist, alb, minutes) => ({
  title,
  artist: artist.name,
  artists: [artist.name],
  album: alb.name,
  uri: `spotify:track:t${++n}`,
  url: `https://open.spotify.com/track/t${n}`,
  durationMs: Math.round(minutes * 60_000),
  artworkUrl: alb.artworkUrl
})

const T = {
  lanterns: track('Low Tide Lanterns', artists.harbor, albums.saltwater, 3.9),
  glass: track('Glass Weather', artists.coast, albums.north, 4.3),
  orbit: track('Weightless Afternoon', artists.satellites, albums.orbit, 3.4),
  signal: track('Signal Fires', artists.juniper, albums.signal, 3.1),
  neon: track('Night Drive Protocol', artists.atlas, albums.neon, 4.7),
  tide: track('Tidelines', artists.choir, albums.tide, 5.2),
  ember: track('Ember Season', artists.harbor, albums.ember, 3.6),
  moss: track('Granite Lullaby', artists.coast, albums.moss, 4.1)
}

const neonTracks = [
  T.neon,
  track('Afterglow Compiler', artists.atlas, albums.neon, 3.8),
  track('Chrome Tides', artists.atlas, albums.neon, 4.2),
  track('Silent Merge', artists.atlas, albums.neon, 3.3),
  track('Static Bloom', artists.atlas, albums.neon, 4.9),
  track('Harbor at 3 AM', artists.atlas, albums.neon, 5.1),
  track('Last Commit', artists.atlas, albums.neon, 3.7)
]

const list = (items) => ({ items, total: items.length, offset: 0 })

const DEVICES = [
  { id: 'mac', name: 'MacBook Pro', type: 'Computer', active: true, supportsVolume: true, volume: 64 },
  { id: 'phone', name: 'iPhone', type: 'Smartphone', active: false, supportsVolume: true, volume: 80 },
  { id: 'living', name: 'Living Room', type: 'Speaker', active: false, supportsVolume: true, volume: 35 }
]

const device = { id: 'mac', name: 'MacBook Pro', type: 'Computer', supportsVolume: true }

const STATES = {
  neon: { status: 'playing', volume: 64, shuffle: true, repeat: 'context', positionMs: 98_000, track: neonTracks[0], context: { type: 'album', uri: albums.neon.uri }, device, authExpiresSoon: false },
  lanterns: { status: 'playing', volume: 72, shuffle: false, repeat: 'off', positionMs: 83_000, track: T.lanterns, context: { type: 'playlist', uri: playlists[0].uri }, device, authExpiresSoon: false },
  glass: { status: 'paused', volume: 40, shuffle: false, repeat: 'context', positionMs: 151_000, track: T.glass, context: { type: 'album', uri: albums.north.uri }, device, authExpiresSoon: false }
}

const HOME = {
  recent: [albums.neon, playlists[0], { kind: 'collection', name: 'Liked Songs', subtitle: 'Playlist', uri: 'spotify:user:demo:collection', url: null, artworkUrl: null }, albums.saltwater, playlists[1], albums.orbit],
  recentContexts: [albums.neon, playlists[0], albums.saltwater, playlists[1], albums.orbit, playlists[2]].map((item, i) => ({ uri: item.uri, playedAt: Date.now() - i * 3600_000 })),
  recentTracks: [T.neon, T.lanterns, T.orbit, T.signal, T.tide, T.glass],
  topArtists: [artists.atlas, artists.harbor, artists.coast, artists.satellites, artists.juniper, artists.choir],
  topTracks: [T.lanterns, T.neon, T.glass, T.ember, T.orbit]
}

const PAGES = {
  [albums.neon.uri]: { ...albums.neon, playable: true, count: neonTracks.length, tracks: neonTracks },
  [playlists[0].uri]: { ...playlists[0], playable: true, description: 'Long instrumentals for long builds.', tracks: [T.lanterns, T.orbit, T.tide, T.glass, T.moss, T.signal, T.ember] }
}

const SEARCH = {
  tracks: list([T.neon, neonTracks[1], T.lanterns, T.orbit]),
  albums: list([albums.neon, albums.orbit, albums.saltwater]),
  artists: list([artists.atlas, artists.satellites]),
  playlists: list([playlists[6], playlists[1]])
}

const webInfo = (stateName) => ({
  id: 'webapi',
  capabilities: {
    repeatModes: ['off', 'context', 'track'],
    seekStepMs: 1,
    volume: true,
    open: false,
    devices: true,
    queue: true,
    search: true,
    playlists: true,
    library: true,
    home: true,
    needsAuth: true,
    poll: { playing: 600000, paused: 600000, hidden: 600000 }
  },
  available: ['applescript', 'webapi'],
  connection: { clientId: 'demo', connected: true, authorizedAt: Date.now() - 12 * 86400_000, expiresSoon: false, missingScopes: [], protection: 'os-keyring' },
  state: stateName
})

// The desktop app on a Mac: no login, Orca's own colors, the player only.
const DESKTOP_INFO = {
  id: 'applescript',
  capabilities: { repeatModes: ['off', 'context'], seekStepMs: 1000, volume: true, open: true, poll: { playing: 600000, paused: 600000, hidden: 600000 } },
  available: ['applescript', 'webapi'],
  connection: { connected: false }
}

// Apple Music, through the Music app on a Mac: the player only, its covers asked for by the
// track's persistent ID, which the stand-in answers with a generated image.
const MUSIC_INFO = {
  id: 'applemusic',
  service: 'applemusic',
  capabilities: { repeatModes: ['off', 'context', 'track'], seekStepMs: 1000, volume: true, open: true, artwork: 'data', poll: { playing: 600000, paused: 600000, hidden: 600000 } },
  available: ['applescript', 'webapi', 'applemusic'],
  connection: { connected: false }
}

// Invented persistent IDs, one per track the Music shots play.
const MUSIC_IDS = { neon: '4F3A2B1C0D9E8F70', lanterns: '7A1C3E5B9D2F4A60', glass: '2B8D4F6A1C3E5B70' }

// What the Music app reports: no device, context or links; repeat one in the dark shot shows
// the mode Spotify's desktop app doesn't have.
const music = (stateName) => {
  const state = STATES[stateName]
  const id = MUSIC_IDS[stateName]
  const { title, artist, album, durationMs } = state.track
  return {
    backend: 'applemusic',
    status: state.status,
    volume: state.volume,
    shuffle: state.shuffle,
    repeat: stateName === 'neon' ? 'track' : state.repeat,
    positionMs: state.positionMs,
    track: { title, artist, album, durationMs, uri: `applemusic:track:${id}`, id, artworkUrl: `applemusic-artwork:${id}` }
  }
}

// What the desktop app reports: no device, context or links.
const desktop = (state) => ({ ...state, device: undefined, context: undefined, track: { ...state.track, url: undefined } })

// Every request the panel can make, answered from the catalog.
function answers(stateName, backend = 'webapi') {
  if (backend === 'applemusic') {
    const state = music(stateName)
    return { 'backend.info': MUSIC_INFO, 'player.state': state, 'player.command': state, 'agents.info': { access: true, bridge: true, skill: ['Claude Code'] } }
  }
  if (backend === 'applescript') {
    const state = desktop(STATES[stateName])
    return { 'backend.info': DESKTOP_INFO, 'player.state': state, 'player.command': state, 'agents.info': { access: true, bridge: true, skill: ['Claude Code'] } }
  }
  return {
    'backend.info': webInfo(stateName),
    'player.state': STATES[stateName],
    'player.command': STATES[stateName],
    'agents.info': { access: true, bridge: true, skill: ['Claude Code', 'Codex and others'] },
    'library.home': HOME,
    'library.playlists': list(playlists),
    'library.liked': { ...list([T.lanterns, T.glass, T.neon, T.orbit, T.tide]), total: 812, uri: 'spotify:user:demo:collection' },
    'library.albums': list(Object.values(albums).map((a, i) => ({ ...a, addedAt: Date.now() - i * 86400_000 }))),
    'library.artists': { items: Object.values(artists), after: null },
    'library.shows': list([]),
    'library.page': PAGES,
    'library.saved': [true],
    'library.search': SEARCH,
    'player.devices': DEVICES,
    'player.queue': { current: neonTracks[0], queue: neonTracks.slice(1) }
  }
}

const PANEL = readFileSync(join(ROOT, 'panel/index.html'), 'utf8')

// The panel document as Orca would serve it: tokens injected, window.orca answering from the
// catalog, then `steps` (panel functions such as setTab) once it has loaded.
function panelDoc(stateName, theme, steps = '', backend = 'webapi') {
  const tokens = Object.entries(THEMES[theme])
    .map(([name, value]) => `--orca-${name}: ${value};`)
    .join(' ')
  const stub = `<style>:root { ${tokens} } html, body { scrollbar-width: none; } ::-webkit-scrollbar { display: none; }</style><script>
    (function () {
      var A = ${JSON.stringify(answers(stateName, backend))}
      // Apple Music asks for its cover by persistent ID; the generated image stands in.
      var MUSIC_ART = ${JSON.stringify(backend === 'applemusic' ? { [music(stateName).track.artworkUrl]: STATES[stateName].track.artworkUrl } : {})}
      var copy = function (value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) }
      window.orca = Object.freeze({
        plugin: { request: function (name, input) {
          if (name === 'player.artwork') return Promise.resolve({ url: input.url, dataUrl: MUSIC_ART[input.url] || input.url })
          if (name === 'library.page' && A['library.page']) return Promise.resolve(copy(A['library.page'][input.uri]))
          if (!(name in A)) return Promise.reject(Object.assign(new Error('not in the demo'), { code: 'unknown_method' }))
          return Promise.resolve(copy(A[name]))
        } },
        storage: { get: function () { return Promise.resolve(null) }, set: function () { return Promise.resolve() } },
        shell: { openExternal: function () { return Promise.resolve({ opened: false }) } }
      })
    })()
  </script>`
  const run = steps ? `<script>window.addEventListener('load', function () { setTimeout(function () { ${steps} }, 250) })</script>` : ''
  return PANEL.replace('<html>', `<html class="${theme}">`).replace('<head>', '<head>' + stub).replace('</body>', run + '</body>')
}

const escapeAttr = (html) => html.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

const STEPS = {
  player: "setTab('player')",
  home: "setTab('home')",
  library: "setTab('playlists')",
  album: `setTab('home'); setTimeout(function () { openItem(${JSON.stringify(albums.neon)}, 'home') }, 150)`,
  search: "setTab('search'); document.getElementById('search-q').value = 'night drive'; runSearch()",
  devices: "setTab('devices')"
}

function panel(view, { state = 'neon', theme = 'dark', backend = 'webapi', width = 340, height = 700, zoom = 1, style = '' } = {}) {
  const bg = THEMES[theme].background
  return `<div class="frame ${theme}" style="width:${width * zoom}px;height:${height * zoom}px;background:${bg};${style}">
    <iframe style="width:${width}px;height:${height}px;zoom:${zoom}" srcdoc="${escapeAttr(panelDoc(state, theme, STEPS[view], backend))}"></iframe>
  </div>`
}

// A terminal with an agent session that drives Now Playing. `lines` are [kind, text] pairs.
function terminal(lines, { width = 640, title = 'agent · orca-spotify', style = '' } = {}) {
  const body = lines
    .map(([kind, text]) => {
      const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
      if (kind === 'user') return `<div class="t-user"><span class="t-caret">›</span>${safe}</div>`
      if (kind === 'say') return `<div class="t-say">${safe}</div>`
      if (kind === 'run') return `<div class="t-run"><span class="t-dot">●</span><span class="t-cmd">${safe}</span></div>`
      if (kind === 'out') return `<div class="t-out">${safe}</div>`
      return `<div class="t-gap"></div>`
    })
    .join('')
  return `<div class="term" style="width:${width}px;${style}">
    <div class="term-bar"><i></i><i></i><i></i><span>${title}</span></div>
    <div class="term-body">${body}</div>
  </div>`
}

function page(body, { theme = 'dark', glow = '#e0617a', glow2 = '#5b6cff' } = {}) {
  const t = THEMES[theme]
  const dark = theme === 'dark'
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
    body {
      position: relative;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
      color: ${t.foreground};
      background:
        radial-gradient(900px 700px at 76% 38%, color-mix(in srgb, ${glow} ${dark ? 24 : 16}%, transparent), transparent 70%),
        radial-gradient(800px 600px at 8% 96%, color-mix(in srgb, ${glow2} ${dark ? 16 : 10}%, transparent), transparent 70%),
        ${dark ? '#070708' : '#f4f4f5'};
    }
    .frame { border-radius: 18px; overflow: hidden; flex: none;
      border: 1px solid ${dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.08)'};
      box-shadow: 0 50px 100px -30px rgba(0,0,0,${dark ? 0.85 : 0.3}), 0 2px 8px rgba(0,0,0,0.18); }
    .frame iframe { border: 0; display: block; }
    .eyebrow { font-size: 15px; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: ${t['muted-foreground']}; }
    h1 { font-size: 104px; line-height: 0.95; letter-spacing: -0.045em; margin: 18px 0 26px; font-weight: 750; }
    h2 { font-size: 50px; line-height: 1.06; letter-spacing: -0.03em; margin: 16px 0 20px; font-weight: 700; }
    p.lead { font-size: 27px; line-height: 1.38; color: ${t['muted-foreground']}; margin: 0; max-width: 560px; }
    .chips { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 38px; max-width: 600px; }
    .chips span { font-size: 19px; font-weight: 550; padding: 10px 18px; border-radius: 999px;
      border: 1px solid ${dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.12)'}; background: ${dark ? 'rgba(255,255,255,0.04)' : '#fff'}; }
    .chips span.hot { border-color: color-mix(in srgb, #1ed760 60%, transparent); color: #1ed760; background: color-mix(in srgb, #1ed760 9%, transparent); }
    .chips span.red { border-color: color-mix(in srgb, #fc3c44 60%, transparent); color: #ff6b72; background: color-mix(in srgb, #fc3c44 10%, transparent); }
    /* Which service a panel shows: its name in text, with the accent the panel uses. No logos. */
    .svc { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; font-size: 19px; font-weight: 650; letter-spacing: -0.01em; }
    .svc i { width: 10px; height: 10px; border-radius: 50%; background: var(--dot); }
    ul.feats { list-style: none; padding: 0; margin: 34px 0 0; display: grid; gap: 15px; font-size: 21px; }
    ul.feats li { display: flex; gap: 14px; align-items: baseline; }
    ul.feats li::before { content: ''; flex: none; width: 7px; height: 7px; border-radius: 50%; background: #1ed760; transform: translateY(-3px); }
    .fine { position: absolute; left: 110px; bottom: 60px; font-size: 14px; color: ${t['muted-foreground']}; opacity: 0.8; }
    .caption { font-size: 17px; font-weight: 600; color: ${t['muted-foreground']}; text-align: center; margin-top: 18px; }
    .term { border-radius: 14px; overflow: hidden; background: #0d0e11; border: 1px solid rgba(255,255,255,0.1);
      box-shadow: 0 50px 100px -30px rgba(0,0,0,0.9), 0 2px 8px rgba(0,0,0,0.3); font: 15.5px/1.6 "SF Mono", ui-monospace, Menlo, monospace; color: #d6d8de; }
    .term-bar { height: 38px; display: flex; align-items: center; gap: 8px; padding: 0 14px; background: #16171b; border-bottom: 1px solid rgba(255,255,255,0.06); }
    .term-bar i { width: 12px; height: 12px; border-radius: 50%; background: #3a3b40; }
    .term-bar span { margin-left: 10px; font: 600 12.5px -apple-system, system-ui, sans-serif; color: #8b8d94; letter-spacing: 0.02em; }
    .term-body { padding: 18px 22px 22px; }
    .t-user { white-space: normal; color: #f2f3f5; background: rgba(255,255,255,0.05); border-radius: 8px; padding: 8px 12px; margin: 2px 0 12px; }
    .t-caret { color: #1ed760; margin-right: 10px; font-weight: 700; }
    .t-say { color: #c9ccd3; margin: 4px 0 8px; font-family: -apple-system, system-ui, sans-serif; font-size: 16px; }
    .t-run { margin-top: 6px; } .t-dot { color: #1ed760; margin-right: 10px; } .t-cmd { color: #f2f3f5; }
    .t-out { color: #8b8f99; white-space: pre; padding-left: 24px; }
    .t-gap { height: 10px; }
  </style></head><body>${body}</body></html>`
}

const AGENT_SESSION = [
  ['user', 'put on something with no vocals while you run the migration'],
  ['run', 'now-playing play "night drive protocol" --album'],
  ['out', '▶ Night Drive Protocol · Velvet Atlas'],
  ['out', '  Neon Harbor · on MacBook Pro'],
  ['gap', ''],
  ['say', 'Neon Harbor by Velvet Atlas is on. Starting the migration.']
]

const SCENES = {
  // Spotify and Apple Music side by side, each named above its panel, inside the middle 840 px.
  cover: () =>
    page(`
    <div style="position:absolute;left:110px;top:150px;width:640px">
      <div class="eyebrow">Plugin for Orca</div>
      <h1>Now Playing</h1>
      <p class="lead">Spotify or Apple Music in Orca's sidebar, and in your coding agents' hands.</p>
      <div class="chips"><span class="hot">Spotify</span><span class="red">Apple Music</span><span>Your Library</span><span>Agents</span></div>
    </div>
    ${terminal(AGENT_SESSION.slice(0, 4), { width: 600, style: 'position:absolute;left:110px;top:590px' })}
    <div style="position:absolute;left:818px;top:84px"><div class="svc" style="--dot:#1ed760"><i></i>Spotify</div>${panel('player', { height: 790 })}</div>
    <div style="position:absolute;left:1198px;top:84px"><div class="svc" style="--dot:#fc3c44"><i></i>Apple Music</div>${panel('player', { state: 'glass', theme: 'light', backend: 'applemusic', height: 790 })}</div>`, { glow: '#ff6f91', glow2: '#2de2e6' }),

  // The Music look in Orca's light and dark themes, the switch at the bottom of each.
  'apple-music': () =>
    page(`
    <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:48px">
      <div style="max-width:430px">
        <div class="eyebrow">Apple Music too</div>
        <h2>The Music app, in its own look.</h2>
        <p class="lead">Flip the switch under the player. Play, skip, seek, shuffle and all three repeat modes, in Orca's light and dark themes.</p>
      </div>
      ${panel('player', { state: 'glass', theme: 'light', backend: 'applemusic', height: 680, zoom: 1.08 })}
      ${panel('player', { state: 'neon', theme: 'dark', backend: 'applemusic', height: 680, zoom: 1.08 })}
    </div>`, { glow: '#fc3c44', glow2: '#7a5cff' }),

  library: () =>
    page(`
    <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
      <div class="eyebrow">Connect your Spotify account</div>
      <h2 style="margin-bottom:44px">Your whole library, next to your code</h2>
      <div style="display:flex;gap:36px;align-items:flex-start">
        <div>${panel('home', { height: 640, zoom: 1.08 })}<div class="caption">Home</div></div>
        <div>${panel('library', { height: 640, zoom: 1.08 })}<div class="caption">Your Library</div></div>
        <div>${panel('album', { height: 640, zoom: 1.08 })}<div class="caption">Albums, artists, playlists</div></div>
      </div>
    </div>`, { glow: '#7a5cff', glow2: '#1ed760' }),

  agents: () =>
    page(`
    <div style="position:absolute;left:110px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;width:530px">
      <div class="eyebrow">For your agents</div>
      <h2>Your agents can pick the music too</h2>
      <p class="lead">Claude Code, Codex or any script runs <b style="color:inherit;font-weight:600;white-space:nowrap">now-playing</b>: play, pause, skip, search, queue, like and switch speakers.</p>
      <ul class="feats">
        <li>Turn it on with one click in the panel</li>
        <li>Installs a skill so agents know how</li>
        <li>Local only: a loopback port and a token just for you</li>
      </ul>
    </div>
    ${terminal([
      ...AGENT_SESSION,
      ['gap', ''],
      ['user', 'a bit quieter, and save this one'],
      ['run', 'now-playing volume 35'],
      ['out', 'Volume 35'],
      ['run', 'now-playing like'],
      ['out', 'Saved spotify:track:t9 to your library.']
    ], { width: 540, style: 'position:absolute;left:650px;top:190px' })}
    ${panel('player', { height: 790, zoom: 1.0, style: 'position:absolute;left:1220px;top:105px' })}`, { glow: '#1ed760', glow2: '#7a5cff' }),

  player: () =>
    page(`
    <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:56px">
      <div style="max-width:470px">
        <div class="eyebrow">Two ways into Spotify</div>
        <h2>No setup on a Mac. Any device with your account.</h2>
        <p class="lead">With the Spotify app on a Mac it just works, in your Orca theme. Connect your account to pick the speaker.</p>
      </div>
      ${panel('player', { state: 'glass', theme: 'light', backend: 'applescript', height: 700, zoom: 1.08 })}
      ${panel('devices', { state: 'neon', theme: 'dark', height: 700, zoom: 1.08 })}
    </div>`, { glow: '#2f9fb0', glow2: '#ff6f91' })
}

mkdirSync(OUT, { recursive: true })
const only = process.argv.slice(2)
const work = mkdtempSync(join(tmpdir(), 'now-playing-images-'))
try {
  for (const [name, scene] of Object.entries(SCENES)) {
    if (only.length && !only.includes(name)) continue
    const source = join(work, `${name}.html`)
    const target = join(OUT, `${name}.png`)
    writeFileSync(source, scene())
    execFileSync(CHROME, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--virtual-time-budget=4000',
      `--window-size=${WIDTH},${HEIGHT}`,
      `--screenshot=${target}`,
      `file://${source}`
    ], { stdio: 'ignore' })
    console.log(`${target} (${Math.round(statSync(target).size / 1024)} KB)`)
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
