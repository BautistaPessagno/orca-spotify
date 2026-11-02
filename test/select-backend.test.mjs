import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBackendSelector } from '../src/select-backend.mjs'

function fakeBackend(id, state = { status: 'playing' }) {
  const calls = []
  return {
    id,
    calls,
    capabilities: { id },
    settle: { tries: id === 'webapi' ? 2 : 6, stepMs: 1 },
    getState: async () => ({ ...state }),
    command: async (name, value) => (calls.push([name, value]), true)
  }
}

function fakeSettings(values = {}) {
  return {
    values,
    get: async (key) => values[key],
    set: async (key, value) => {
      values[key] = value
    }
  }
}

function setup({ backend, platform }) {
  const applescript = fakeBackend('applescript')
  const webapi = fakeBackend('webapi')
  const settings = fakeSettings(backend === undefined ? {} : { backend })
  const selector = createBackendSelector({ backends: { applescript, webapi }, settings, platform })
  return { applescript, webapi, settings, selector }
}

test('auto picks AppleScript on macOS and the Web API elsewhere', async () => {
  assert.equal((await setup({ backend: 'auto', platform: 'darwin' }).selector.active()).id, 'applescript')
  assert.equal((await setup({ backend: 'auto', platform: 'linux' }).selector.active()).id, 'webapi')
  assert.equal((await setup({ platform: 'win32' }).selector.active()).id, 'webapi')
})

test('an explicit choice wins, and AppleScript off macOS answers unsupported', async () => {
  assert.equal((await setup({ backend: 'webapi', platform: 'darwin' }).selector.active()).id, 'webapi')
  const { selector, applescript } = setup({ backend: 'applescript', platform: 'linux' })
  const state = await selector.getState()
  assert.equal(state.status, 'unsupported')
  assert.equal(state.backend, 'applescript')
  await assert.rejects(selector.command('next'), { kind: 'unsupported' })
  assert.deepEqual(applescript.calls, [])
})

test('state and commands go to the active backend and say which one answered', async () => {
  const { selector, webapi, applescript } = setup({ backend: 'webapi', platform: 'darwin' })
  assert.equal((await selector.getState()).backend, 'webapi')
  assert.equal(await selector.command('setVolume', 30), true)
  assert.deepEqual(webapi.calls, [['setVolume', 30]])
  assert.deepEqual(applescript.calls, [])
  assert.equal(selector.settle.tries, 2)
})

test('a settings change takes effect on the next call', async () => {
  const { selector, settings } = setup({ backend: 'auto', platform: 'darwin' })
  assert.equal((await selector.getState()).backend, 'applescript')
  settings.values.backend = 'webapi'
  assert.equal((await selector.getState()).backend, 'webapi')
})

test('select stores the choice and refuses unknown backends', async () => {
  const { selector, settings } = setup({ platform: 'darwin' })
  await selector.select('webapi')
  assert.equal(settings.values.backend, 'webapi')
  assert.equal((await selector.active()).id, 'webapi')
  await assert.rejects(selector.select('winamp'), { kind: 'invalid' })
})

test('off macOS the desktop app cannot be chosen', async () => {
  const { selector, settings } = setup({ platform: 'linux' })
  await assert.rejects(selector.select('applescript'), { kind: 'unsupported' })
  assert.equal(settings.values.backend, undefined)
})
