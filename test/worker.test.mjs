import assert from 'node:assert/strict'
import { test } from 'node:test'
import activate from '../worker.mjs'

function fakeOrca() {
  const commands = new Map()
  const handlers = new Map()
  const orca = {
    commands: { register: (id, fn) => (commands.set(id, fn), { dispose() {} }) },
    panels: { handle: (name, fn) => (handlers.set(name, fn), { dispose() {} }), post() {} },
    settings: { get: async () => undefined, set: async () => {} },
    secrets: { get: async () => null, set: async () => {}, delete: async () => {} },
    host: { call: async () => ({ status: 'os-keyring' }) },
    log: () => {}
  }
  return { orca, commands, handlers }
}

const manifest = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8')))

test('registers exactly the commands the manifest declares', () => {
  const { orca, commands } = fakeOrca()
  activate(orca)
  assert.deepEqual([...commands.keys()].sort(), manifest.contributes.commands.map((c) => c.id).sort())
})

test('answers the player panel requests', () => {
  const { orca, handlers } = fakeOrca()
  activate(orca)
  assert.deepEqual([...handlers.keys()].sort(), [
    'auth.disconnect',
    'auth.start',
    'auth.status',
    'backend.info',
    'backend.select',
    'library.playlists',
    'library.search',
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

test('declares the player panel', () => {
  assert.deepEqual(manifest.contributes.panels.map((p) => p.entry), ['panel/index.html'])
})

test('declares the settings and capabilities the Web API backend needs', () => {
  assert.deepEqual(manifest.capabilities.map((c) => c.kind).sort(), ['secrets:own', 'settings:own'])
  const settings = Object.fromEntries(manifest.contributes.settings.map((s) => [s.key, s]))
  assert.deepEqual(settings.backend.enum, ['auto', 'applescript', 'webapi'])
  assert.equal(settings.backend.default, 'auto')
  assert.equal(settings.clientId.type, 'string')
  assert.equal(settings.clientId.maxLength, 64)
  assert.equal(settings.redirectPort.default, 43117)
  assert.equal(settings.redirectPort.minimum, 1024)
  assert.equal(settings.redirectPort.maximum, 65535)
})

test('a panel can ask which backend is active without touching Spotify', async () => {
  const { orca, handlers } = fakeOrca()
  activate(orca)
  const info = await handlers.get('backend.info')()
  assert.equal(info.id, process.platform === 'darwin' ? 'applescript' : 'webapi')
  assert.equal(info.connection.connected, false)
})
