import assert from 'node:assert/strict'
import { test } from 'node:test'
import activate from '../worker.mjs'

function fakeOrca() {
  const commands = new Map()
  const handlers = new Map()
  const orca = {
    commands: { register: (id, fn) => (commands.set(id, fn), { dispose() {} }) },
    panels: { handle: (name, fn) => (handlers.set(name, fn), { dispose() {} }), post() {} },
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
  assert.deepEqual([...handlers.keys()].sort(), ['player.artwork', 'player.command', 'player.state'])
})

test('declares the player panel', () => {
  assert.deepEqual(manifest.contributes.panels.map((p) => p.entry), ['panel/index.html'])
})
