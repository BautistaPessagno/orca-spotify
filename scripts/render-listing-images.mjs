// Renders the plugin directory's cover and screenshots into images/ from the real panel/index.html.
// The panel runs unchanged; a stand-in window.orca answers its requests with a fictional track and
// generated artwork, so no real album art or Spotify branding ends up in the listing.
//
//   node scripts/render-listing-images.mjs
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

// Orca 1.4.246's panel tokens (--orca-*), from its stylesheet.
const THEMES = {
  dark: { background: '#0a0a0a', foreground: '#f0f0f0', 'muted-foreground': '#acacac', accent: '#404040', primary: '#e5e5e5', ring: '#737373' },
  light: { background: '#ffffff', foreground: '#0a0a0a', 'muted-foreground': '#696969', accent: '#f5f5f5', primary: '#171717', ring: '#a1a1a1' }
}

// Abstract artwork: a sun over layered hills. No real covers.
function artwork({ sky, sun, hills }) {
  const layers = hills
    .map((color, i) => {
      const y = 170 + i * 38
      return `<path d="M0 ${y} C 70 ${y - 40}, 140 ${y + 30}, 210 ${y - 10} S 300 ${y - 30}, 300 ${y - 20} V300 H0 Z" fill="${color}"/>`
    })
    .join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">
    <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset="1" stop-color="${sky[1]}"/></linearGradient></defs>
    <rect width="300" height="300" fill="url(#s)"/><circle cx="196" cy="128" r="54" fill="${sun}"/>${layers}</svg>`
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
}

const DUSK = artwork({ sky: ['#2b1d5c', '#e0617a'], sun: '#ffd27a', hills: ['#7a3a78', '#4a2563', '#24163f'] })
const TIDE = artwork({ sky: ['#0f3d56', '#7cc6c4'], sun: '#f4efe1', hills: ['#2f7c8a', '#1d5768', '#0e2f40'] })

const track = (title, artist, album, minutes, art) => ({
  title,
  artist,
  album,
  uri: 'spotify:track:demo',
  durationMs: minutes * 60_000,
  artworkUrl: art
})

const STATES = {
  playing: { status: 'playing', volume: 72, shuffle: true, repeat: 'off', positionMs: 83_000, track: track('Low Tide Lanterns', 'Harbor Lights', 'Saltwater Hours', 3.9, DUSK) },
  paused: { status: 'paused', volume: 40, shuffle: false, repeat: 'context', positionMs: 151_000, track: track('Glass Weather', 'The Quiet Coast', 'North Facing', 4.3, TIDE) },
  closed: { status: 'closed', message: 'Spotify is not open. Open the Spotify desktop app and try again.' },
  'no-permission': {
    status: 'no-permission',
    message: 'Orca is not allowed to control Spotify. Open System Settings → Privacy & Security → Automation, turn on Spotify under Orca, then try again.'
  },
  stopped: { status: 'stopped', volume: 60, shuffle: false, repeat: 'off', track: null }
}

const PANEL = readFileSync(join(ROOT, 'panel/index.html'), 'utf8')

// What backend.info answers for the desktop app: the listing shows the AppleScript player.
const INFO = {
  id: 'applescript',
  capabilities: { repeatModes: ['off', 'context'], seekStepMs: 1000, poll: { playing: 1000, paused: 1000, hidden: 4000 } },
  available: ['applescript'],
  connection: { connected: false }
}

// The panel document as Orca would serve it: tokens injected, window.orca answering from `state`.
function panelDoc(stateName, theme) {
  const tokens = Object.entries(THEMES[theme])
    .map(([name, value]) => `--orca-${name}: ${value};`)
    .join(' ')
  const state = STATES[stateName]
  const stub = `<style>:root { ${tokens} }</style><script>
    window.orca = Object.freeze({ plugin: { request: function (name, input) {
      var state = ${JSON.stringify(state)}
      if (name === 'player.artwork') return Promise.resolve({ url: input.url, dataUrl: input.url })
      if (name === 'backend.info') return Promise.resolve(${JSON.stringify(INFO)})
      return Promise.resolve(JSON.parse(JSON.stringify(state)))
    } } })
  </script>`
  return PANEL.replace('<html>', `<html class="${theme}">`).replace('<head>', '<head>' + stub)
}

const escapeAttr = (html) => html.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

function panel(stateName, theme, { width = 340, height = 640, zoom = 1 } = {}) {
  const bg = THEMES[theme].background
  return `<div class="frame ${theme}" style="width:${width * zoom}px;height:${height * zoom}px;background:${bg}">
    <iframe style="width:${width}px;height:${height}px;zoom:${zoom}" srcdoc="${escapeAttr(panelDoc(stateName, theme))}"></iframe>
  </div>`
}

function page(body, { theme = 'dark', glow = '#e0617a' } = {}) {
  const t = THEMES[theme]
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
      color: ${t.foreground};
      background:
        radial-gradient(900px 700px at 78% 40%, color-mix(in srgb, ${glow} ${theme === 'dark' ? 22 : 16}%, transparent), transparent 70%),
        radial-gradient(700px 600px at 12% 90%, color-mix(in srgb, #5b6cff ${theme === 'dark' ? 12 : 8}%, transparent), transparent 70%),
        ${theme === 'dark' ? '#060606' : '#f4f4f5'};
    }
    .frame { border-radius: 16px; overflow: hidden; flex: none;
      border: 1px solid ${theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'};
      box-shadow: 0 40px 90px -30px rgba(0,0,0,${theme === 'dark' ? 0.8 : 0.28}), 0 2px 6px rgba(0,0,0,0.12); }
    .frame iframe { border: 0; display: block; }
    .eyebrow { font-size: 15px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: ${t['muted-foreground']}; }
    h1 { font-size: 84px; line-height: 1; letter-spacing: -0.035em; margin: 18px 0 22px; font-weight: 700; }
    h2 { font-size: 46px; line-height: 1.08; letter-spacing: -0.025em; margin: 16px 0 18px; font-weight: 700; }
    p.lead { font-size: 25px; line-height: 1.4; color: ${t['muted-foreground']}; margin: 0; max-width: 560px; }
    .keys { display: grid; grid-template-columns: auto 1fr; gap: 14px 18px; align-items: center; margin-top: 44px; font-size: 19px; }
    .keys span { color: ${t['muted-foreground']}; }
    kbd { font: 600 17px ui-monospace, Menlo, monospace; padding: 7px 11px; border-radius: 8px; justify-self: start;
      background: ${theme === 'dark' ? 'rgba(255,255,255,0.07)' : '#fff'}; border: 1px solid ${theme === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)'}; }
    ul.feats { list-style: none; padding: 0; margin: 34px 0 0; display: grid; gap: 14px; font-size: 21px; }
    ul.feats li::before { content: ''; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: currentColor; opacity: 0.5; margin: 0 14px 3px 0; }
    .fine { position: absolute; left: 120px; bottom: 56px; font-size: 14px; color: ${t['muted-foreground']}; opacity: 0.8; }
    .caption { font-size: 17px; font-weight: 600; color: ${t['muted-foreground']}; text-align: center; margin-top: 18px; }
  </style></head><body>${body}</body></html>`
}

const KEYS = `<div class="keys">
  <kbd>⌘⌥⇧P</kbd><span>Play / Pause</span>
  <kbd>⌘⌥⇧N</kbd><span>Next track</span>
  <kbd>⌘⌥⇧B</kbd><span>Previous track</span>
</div>`

const SCENES = {
  cover: page(`
    <div style="display:flex;align-items:center;justify-content:space-between;height:100%;padding:0 150px 0 120px">
      <div>
        <div class="eyebrow">Plugin for Orca</div>
        <h1>Now Playing</h1>
        <p class="lead">Control the Spotify desktop app from Orca's sidebar, command palette and shortcuts.</p>
        ${KEYS}
      </div>
      ${panel('playing', 'dark', { height: 572, zoom: 1.28 })}
    </div>
    <div class="fine">macOS · Not affiliated with Spotify</div>`),

  'player-dark': page(`
    <div style="display:flex;align-items:center;justify-content:center;gap:120px;height:100%">
      ${panel('playing', 'dark', { height: 572, zoom: 1.3 })}
      <div style="max-width:520px">
        <div class="eyebrow">Sidebar player</div>
        <h2>The track you're hearing, next to your code</h2>
        <p class="lead">Updates on its own while it's visible. No account setup, API keys or Premium.</p>
        <ul class="feats"><li>Play, pause and skip</li><li>Drag to seek</li><li>Shuffle, repeat and volume</li></ul>
      </div>
    </div>`),

  'player-light': page(`
    <div style="display:flex;align-items:center;justify-content:center;gap:120px;height:100%">
      <div style="max-width:520px">
        <div class="eyebrow">Follows your Orca theme</div>
        <h2>Light or dark, it matches Orca</h2>
        <p class="lead">The panel uses Orca's own colors, so it fits whatever theme you run.</p>
        ${KEYS}
      </div>
      ${panel('paused', 'light', { height: 572, zoom: 1.3 })}
    </div>`, { theme: 'light', glow: '#2f9fb0' }),

  states: page(`
    <div style="height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center">
      <div class="eyebrow">When something's off</div>
      <h2 style="margin-bottom:46px">It says what to do</h2>
      <div style="display:flex;gap:40px">
        <div>${panel('closed', 'dark', { width: 380, height: 330, zoom: 1.15 })}<div class="caption">Spotify is closed</div></div>
        <div>${panel('no-permission', 'dark', { width: 380, height: 330, zoom: 1.15 })}<div class="caption">macOS permission missing</div></div>
        <div>${panel('stopped', 'dark', { width: 380, height: 330, zoom: 1.15 })}<div class="caption">Nothing playing</div></div>
      </div>
    </div>`, { glow: '#7a5cff' })
}

mkdirSync(OUT, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'now-playing-images-'))
try {
  for (const [name, html] of Object.entries(SCENES)) {
    const source = join(work, `${name}.html`)
    const target = join(OUT, `${name}.png`)
    writeFileSync(source, html)
    execFileSync(CHROME, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--virtual-time-budget=3000',
      `--window-size=${WIDTH},${HEIGHT}`,
      `--screenshot=${target}`,
      `file://${source}`
    ], { stdio: 'ignore' })
    console.log(`${target} (${Math.round(statSync(target).size / 1024)} KB)`)
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
