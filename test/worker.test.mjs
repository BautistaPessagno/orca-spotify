import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import activate, { deactivate } from '../worker.mjs'

const home = mkdtempSync(join(tmpdir(), 'now-playing-worker-'))
after(() => rmSync(home, { recursive: true, force: true }))

const idle = { id: 'applescript', capabilities: { poll: {} }, settle: { tries: 0, stepMs: 0 }, getState: async () => ({ status: 'stopped', track: null }), command: async () => true }

function fakeOrca(settings = {}) {
  const handlers = new Map()
  const calls = []
  const orca = {
    panels: { handle: (name, fn) => (handlers.set(name, fn), { dispose() {} }), post() {} },
    settings: { get: async (key) => settings[key], set: async (key, value) => void (settings[key] = value), onDidChange: () => ({ dispose() {} }) },
    secrets: { get: async () => null, set: async () => {}, delete: async () => {} },
    host: { call: async (method, params) => (calls.push({ method, params }), method === 'secrets.protection' ? { status: 'os-keyring' } : { ok: true }) },
    log: () => {}
  }
  const deps = {
    backends: { applescript: idle, webapi: { ...idle, id: 'webapi' } },
    bridge: { dir: join(home, 'bridge') },
    skill: { targets: [] }
  }
  return { orca, handlers, calls, deps, settings }
}

const manifest = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8')))

test('contributes no palette commands or shortcuts', () => {
  assert.equal(manifest.contributes.commands, undefined)
  assert.equal(manifest.contributes.keybindings, undefined)
  assert.equal(manifest.publisher, undefined)
})

test('answers the player panel requests and the agent link', async () => {
  const { orca, handlers, deps } = fakeOrca({ agentAccess: false })
  activate(orca, deps)
  await deactivate()
  assert.deepEqual([...handlers.keys()].sort(), [
    'agents.enable',
    'agents.info',
    'auth.disconnect',
    'auth.start',
    'auth.status',
    'backend.info',
    'backend.select',
    'library.albums',
    'library.artists',
    'library.home',
    'library.liked',
    'library.page',
    'library.playlists',
    'library.save',
    'library.saved',
    'library.search',
    'library.shows',
    'player.artwork',
    'player.command',
    'player.devices',
    'player.enqueue',
    'player.playContext',
    'player.queue',
    'player.state',
    'player.transfer'
  ])
})

test('declares a status bar item, which keeps the worker running for agents', () => {
  assert.deepEqual(manifest.contributes.statusBarItems.map((item) => item.id), ['now-playing'])
  assert.equal(manifest.contributes.statusBarItems[0].command, undefined)
})

test('agent access starts the bridge; agents.enable also turns the skill on', async () => {
  const { orca, handlers, deps, settings } = fakeOrca({ agentSkill: false })
  activate(orca, deps)
  let info
  for (let i = 0; i < 50 && !(info = await handlers.get('agents.info')()).bridge; i++) await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(info, { access: true, bridge: true, skill: [] })
  await handlers.get('agents.enable')()
  assert.equal(settings.agentSkill, true)
  await deactivate()
})

test('every state read updates the status bar', async () => {
  const { orca, handlers, calls, deps } = fakeOrca({ agentAccess: false })
  deps.backends.applescript = { ...idle, getState: async () => ({ status: 'playing', track: { title: 'Song', artist: 'Band', durationMs: 1000 }, positionMs: 0 }) }
  activate(orca, deps)
  await handlers.get('player.state')()
  await deactivate()
  const update = calls.find((call) => call.method === 'statusBar.update' && call.params.visible)
  assert.equal(update.params.text, 'Song · Band')
})

test('declares the player panel', () => {
  assert.deepEqual(manifest.contributes.panels.map((p) => p.entry), ['panel/index.html'])
})

test('declares the settings and capabilities the Web API backend needs', () => {
  assert.deepEqual(manifest.capabilities.map((c) => c.kind).sort(), ['secrets:own', 'settings:own', 'storage:own'])
  assert.equal(Object.fromEntries(manifest.contributes.settings.map((s) => [s.key, s.default])).agentAccess, true)
  assert.equal(Object.fromEntries(manifest.contributes.settings.map((s) => [s.key, s.default])).agentSkill, false)
  const settings = Object.fromEntries(manifest.contributes.settings.map((s) => [s.key, s]))
  assert.deepEqual(settings.backend.enum, ['auto', 'applescript', 'webapi'])
  assert.equal(settings.backend.default, 'auto')
  // The switch: its own setting, so a saved `backend` keeps working and survives a trip to Apple Music.
  assert.deepEqual(settings.service.enum, ['spotify', 'applemusic'])
  assert.equal(settings.service.default, 'spotify')
  assert.equal(settings.service.enumLabels.length, 2)
  assert.equal(settings.clientId.type, 'string')
  assert.equal(settings.clientId.maxLength, 64)
  assert.equal(settings.redirectPort.default, 43117)
  assert.equal(settings.redirectPort.minimum, 1024)
  assert.equal(settings.redirectPort.maximum, 65535)
})

test('a panel can ask which backend is active without touching Spotify', async () => {
  const { orca, handlers, deps } = fakeOrca({ agentAccess: false })
  activate(orca, deps)
  const info = await handlers.get('backend.info')()
  await deactivate()
  assert.equal(info.id, process.platform === 'darwin' ? 'applescript' : 'webapi')
  assert.equal(info.connection.connected, false)
})
