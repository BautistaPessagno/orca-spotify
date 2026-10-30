import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyError, createAppleScriptBackend, parseState } from '../backends/applescript.mjs'

const SEP = '\u001f'
const line = (...fields) => fields.join(SEP) + '\n'

// execFile stand-in: answers each call with the next queued result and records the args.
function fakeExec(...results) {
  const calls = []
  const exec = (file, args, _opts, callback) => {
    calls.push({ file, args })
    const next = results.shift()
    if (next instanceof Error) callback(next, '', next.stderr ?? '')
    else callback(null, next ?? '', '')
  }
  return { exec, calls }
}

test('parseState reads a playing track', () => {
  const state = parseState(
    line('running', 'playing', '64', 'true', 'false', 'Song', 'Artist', 'Album', '228000', '72345', 'https://i.scdn.co/image/x', 'spotify:track:1')
  )
  assert.deepEqual(state, {
    status: 'playing',
    volume: 64,
    shuffle: true,
    repeat: false,
    track: { title: 'Song', artist: 'Artist', album: 'Album', uri: 'spotify:track:1', durationMs: 228000, artworkUrl: 'https://i.scdn.co/image/x' },
    positionMs: 72345
  })
})

test('parseState handles stopped and closed', () => {
  assert.deepEqual(parseState(line('running', 'stopped', '50', 'false', 'true')), {
    status: 'stopped',
    volume: 50,
    shuffle: false,
    repeat: true,
    track: null
  })
  assert.equal(parseState('closed\n').status, 'closed')
})

test('parseState keeps an empty artwork url as null', () => {
  const state = parseState(line('running', 'paused', '1', 'false', 'false', 'Ad', '', '', '30000', '0', '', 'spotify:ad:1'))
  assert.equal(state.status, 'paused')
  assert.equal(state.track.artworkUrl, null)
})

test('classifyError maps the macOS Automation denial', () => {
  const error = Object.assign(new Error('Command failed'), {
    stderr: '0:12: execution error: Not authorized to send Apple events to Spotify. (-1743)\n'
  })
  assert.equal(classifyError(error).kind, 'permission')
  assert.match(classifyError(error).message, /Automation/)
})

test('classifyError maps timeouts and unknown failures', () => {
  assert.equal(classifyError(Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' })).kind, 'timeout')
  const other = classifyError(Object.assign(new Error('x'), { stderr: 'execution error: boom (-2700)' }))
  assert.equal(other.kind, 'error')
  assert.match(other.message, /boom/)
})

test('getState never runs osascript off macOS', async () => {
  const { exec, calls } = fakeExec()
  const state = await createAppleScriptBackend({ exec, platform: 'linux' }).getState()
  assert.equal(state.status, 'unsupported')
  assert.equal(calls.length, 0)
})

test('getState turns a permission error into a state the UI can explain', async () => {
  const denied = Object.assign(new Error('Command failed'), { stderr: 'execution error: Not authorized (-1743)' })
  const { exec } = fakeExec(denied)
  const state = await createAppleScriptBackend({ exec, platform: 'darwin' }).getState()
  assert.equal(state.status, 'no-permission')
})

test('every script checks that Spotify is running before telling it anything', async () => {
  const { exec, calls } = fakeExec('closed\n', 'closed\n')
  const spotify = createAppleScriptBackend({ exec, platform: 'darwin' })
  await spotify.getState()
  assert.equal(await spotify.command('next'), false)
  for (const { args } of calls) {
    const script = args.filter((_, i) => i % 2 === 1)
    assert.match(script[0], /is not running then return "closed"/)
  }
})

test('command builds the expected statement and validates volume', async () => {
  const { exec, calls } = fakeExec('ok\n')
  const spotify = createAppleScriptBackend({ exec, platform: 'darwin' })
  assert.equal(await spotify.command('setVolume', 42), true)
  assert.ok(calls[0].args.includes('tell application "Spotify" to set sound volume to 42'))
  await assert.rejects(spotify.command('setVolume', 400), { kind: 'invalid' })
  await assert.rejects(spotify.command('rm -rf'), { kind: 'invalid' })
})

test('open launches Spotify only when asked', async () => {
  const { exec, calls } = fakeExec('')
  await createAppleScriptBackend({ exec, platform: 'darwin' }).command('open')
  assert.deepEqual(calls[0], { file: '/usr/bin/open', args: ['-a', 'Spotify'] })
})
