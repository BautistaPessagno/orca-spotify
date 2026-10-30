import assert from 'node:assert/strict'
import { test } from 'node:test'
import activate from '../worker.mjs'

function fakeOrca({ withPanels }) {
  const commands = new Map()
  const panels = new Map()
  const orca = {
    commands: { register: (id, fn) => (commands.set(id, fn), { dispose() {} }) },
    log: () => {}
  }
  if (withPanels) orca.panels = { onMessage: (id, fn) => (panels.set(id, fn), { dispose() {} }) }
  return { orca, commands, panels }
}

const manifest = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8')))

test('registers exactly the commands the manifest declares', () => {
  const { orca, commands } = fakeOrca({ withPanels: false })
  activate(orca)
  assert.deepEqual([...commands.keys()].sort(), manifest.contributes.commands.map((c) => c.id).sort())
})

test('works on an Orca without the panel channel', () => {
  const { orca } = fakeOrca({ withPanels: false })
  assert.doesNotThrow(() => activate(orca))
})

test('serves the player panel when Orca routes panel messages', () => {
  const { orca, panels } = fakeOrca({ withPanels: true })
  activate(orca)
  assert.deepEqual([...panels.keys()], ['player'])
})
