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

function setupMusic({ backend, service, platform = 'darwin' }) {
  const applescript = fakeBackend('applescript')
  const webapi = fakeBackend('webapi')
  const applemusic = fakeBackend('applemusic')
  const values = {}
  if (backend !== undefined) values.backend = backend
  if (service !== undefined) values.service = service
  const settings = fakeSettings(values)
  const selector = createBackendSelector({ backends: { applescript, webapi, applemusic }, settings, platform })
  return { applescript, webapi, applemusic, settings, selector }
}

test('the service setting picks Apple Music; without one, a saved backend works as before', async () => {
  assert.equal((await setupMusic({ backend: 'webapi' }).selector.active()).id, 'webapi')
  assert.equal((await setupMusic({ backend: 'auto' }).selector.active()).id, 'applescript')
  assert.equal((await setupMusic({ backend: 'auto', platform: 'linux' }).selector.active()).id, 'webapi')
  assert.equal((await setupMusic({ backend: 'webapi', service: 'spotify' }).selector.active()).id, 'webapi')
  assert.equal((await setupMusic({ backend: 'webapi', service: 'applemusic' }).selector.active()).id, 'applemusic')
})

test('switching to Apple Music and back returns to the Spotify backend you had', async () => {
  for (const backend of ['webapi', 'applescript', 'auto']) {
    const { selector, settings } = setupMusic({ backend })
    const before = (await selector.active()).id
    assert.equal((await selector.select('applemusic')).id, 'applemusic')
    assert.equal(settings.values.service, 'applemusic')
    assert.equal(settings.values.backend, backend)
    assert.equal((await selector.getState()).backend, 'applemusic')
    assert.equal((await selector.select('spotify')).id, before)
    assert.equal(settings.values.service, 'spotify')
    assert.equal(settings.values.backend, backend)
  }
})

test('picking a Spotify backend by name also leaves Apple Music', async () => {
  const { selector, settings } = setupMusic({ service: 'applemusic' })
  assert.equal((await selector.select('webapi')).id, 'webapi')
  assert.deepEqual(settings.values, { service: 'spotify', backend: 'webapi' })
})

test('off macOS Apple Music says so instead of running osascript, and cannot be chosen', async () => {
  const { selector, applemusic, settings } = setupMusic({ service: 'applemusic', platform: 'linux' })
  const state = await selector.getState()
  assert.equal(state.status, 'unsupported')
  assert.equal(state.backend, 'applemusic')
  assert.match(state.message, /Apple Music/)
  assert.doesNotMatch(state.message, /Spotify desktop app/)
  await assert.rejects(selector.command('next'), { kind: 'unsupported', message: /Apple Music/ })
  assert.deepEqual(applemusic.calls, [])
  await assert.rejects(setupMusic({ platform: 'linux' }).selector.select('applemusic'), { kind: 'unsupported' })
  // The way back still works.
  assert.equal((await selector.select('spotify')).id, 'webapi')
  assert.equal(settings.values.service, 'spotify')
})
