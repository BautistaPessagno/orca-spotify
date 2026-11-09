import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { ARTWORK_PREFIX, classifyOsascriptError, createAppleMusicBackend, parseState } from '../backends/applemusic.mjs'
import { COMMAND_NAMES, MESSAGES } from '../src/backend.mjs'

const SEP = '\u001f'
const line = (...fields) => fields.join(SEP) + '\n'
const ID = '4F3A2B1C0D9E8F70'

// execFile stand-in: answers each call with the next queued result (or a function of the call)
// and records the args.
function fakeExec(...results) {
  const calls = []
  const exec = (file, args, _opts, callback) => {
    calls.push({ file, args })
    let next = results.shift()
    if (typeof next === 'function') next = next(file, args)
    if (next instanceof Error) callback(next, '', next.stderr ?? '')
    else callback(null, next ?? '', '')
  }
  return { exec, calls }
}

const scriptOf = (call) => call.args.filter((_, i) => i % 2 === 1)

const tmp = mkdtempSync(join(tmpdir(), 'now-playing-music-test-'))
after(() => rmSync(tmp, { recursive: true, force: true }))

test('parseState reads a playing track, in milliseconds, with all three repeat modes', () => {
  const state = parseState(line('running', 'playing', '64', 'true', 'all', 'Song', 'Artist', 'Album', '228500', '72345', ID, '1'))
  assert.deepEqual(state, {
    status: 'playing',
    volume: 64,
    shuffle: true,
    repeat: 'context',
    track: { title: 'Song', artist: 'Artist', album: 'Album', uri: `applemusic:track:${ID}`, id: ID, durationMs: 228500, artworkUrl: ARTWORK_PREFIX + ID },
    positionMs: 72345
  })
  assert.equal(parseState(line('running', 'paused', '1', 'false', 'one', 'A', 'B', 'C', '1000', '0', ID, '0')).repeat, 'track')
  assert.equal(parseState(line('running', 'paused', '1', 'false', 'off', 'A', 'B', 'C', '1000', '0', ID, '0')).repeat, 'off')
})

test('parseState handles stopped, closed, streams without a duration and tracks without artwork', () => {
  assert.deepEqual(parseState(line('running', 'stopped', '50', 'false', 'one')), {
    status: 'stopped',
    volume: 50,
    shuffle: false,
    repeat: 'track',
    track: null
  })
  const closed = parseState('closed\n')
  assert.equal(closed.status, 'closed')
  assert.match(closed.message, /Music is not open/)
  const stream = parseState(line('running', 'playing', '30', 'false', 'off', 'Radio', '', '', '', '', '', '0'))
  assert.equal(stream.track.durationMs, 0)
  assert.equal(stream.positionMs, 0)
  assert.equal(stream.track.uri, null)
  assert.equal(stream.track.artworkUrl, null)
  assert.equal(parseState(line('running', 'fast forwarding', '30', 'false', 'off', 'A', 'B', 'C', '1', '0', ID, '0')).status, 'playing')
})

test('the state script reads in whole milliseconds, never a locale-formatted decimal', async () => {
  const { exec, calls } = fakeExec(line('running', 'stopped', '50', 'false', 'off'))
  await createAppleMusicBackend({ exec, platform: 'darwin' }).getState()
  const script = scriptOf(calls[0]).join('\n')
  assert.match(script, /round \(\(duration of t\) \* 1000\)/)
  assert.match(script, /round \(\(player position\) \* 1000\)/)
  assert.match(script, /song repeat as string/)
  assert.match(script, /shuffle enabled/)
  // Only counts the artwork: the image is read once per track, not on every poll.
  assert.doesNotMatch(script, /raw data/)
})

test('classifyOsascriptError speaks of Music, not Spotify', () => {
  const denied = classifyOsascriptError(Object.assign(new Error('x'), { stderr: 'execution error: Not authorized to send Apple events to Music. (-1743)\n' }))
  assert.equal(denied.kind, 'permission')
  assert.match(denied.message, /Automation/)
  assert.match(denied.message, /Music under Orca/)
  assert.doesNotMatch(denied.message, /Spotify/)
  assert.equal(classifyOsascriptError(Object.assign(new Error('x'), { stderr: 'boom (-600)' })).kind, 'closed')
  const timeout = classifyOsascriptError(Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' }))
  assert.equal(timeout.kind, 'timeout')
  assert.match(timeout.message, /^Music/)
  const other = classifyOsascriptError(Object.assign(new Error('x'), { stderr: 'execution error: boom (-2700)' }))
  assert.match(other.message, /^Music could not be controlled: .*boom/)
})

test('getState never runs osascript off macOS, and says Apple Music needs a Mac', async () => {
  const { exec, calls } = fakeExec()
  const state = await createAppleMusicBackend({ exec, platform: 'linux' }).getState()
  assert.equal(state.status, 'unsupported')
  assert.match(state.message, /Apple Music/)
  assert.notEqual(state.message, MESSAGES.unsupported)
  assert.equal(calls.length, 0)
  await assert.rejects(createAppleMusicBackend({ exec, platform: 'linux' }).command('play'), { kind: 'unsupported' })
  assert.equal(calls.length, 0)
})

test('getState turns a permission error into a state the UI can explain', async () => {
  const { exec } = fakeExec(Object.assign(new Error('Command failed'), { stderr: 'execution error: Not authorized (-1743)' }))
  assert.equal((await createAppleMusicBackend({ exec, platform: 'darwin' }).getState()).status, 'no-permission')
})

test('every script checks that Music is running before telling it anything', async () => {
  const { exec, calls } = fakeExec('closed\n', 'closed\n', 'closed\n')
  const music = createAppleMusicBackend({ exec, platform: 'darwin', tmp: () => tmp })
  await music.getState()
  assert.equal(await music.command('next'), false)
  assert.equal(await music.artwork(ID), null)
  assert.equal(calls.length, 3)
  for (const call of calls) assert.equal(scriptOf(call)[0], 'if application "Music" is not running then return "closed"')
})

test('commands map to Music’s dictionary', async () => {
  const cases = [
    ['play', undefined, 'play'],
    ['pause', undefined, 'pause'],
    ['playpause', undefined, 'playpause'],
    ['next', undefined, 'next track'],
    ['previous', undefined, 'back track'],
    ['toggleShuffle', undefined, 'set shuffle enabled to not shuffle enabled'],
    ['setRepeat', 'off', 'set song repeat to off'],
    ['setRepeat', 'context', 'set song repeat to all'],
    ['setRepeat', 'track', 'set song repeat to one'],
    ['setVolume', 42, 'set sound volume to 42'],
    ['seek', 61_600, 'set player position to 62']
  ]
  for (const [name, value, statement] of cases) {
    const { exec, calls } = fakeExec('ok\n')
    assert.equal(await createAppleMusicBackend({ exec, platform: 'darwin' }).command(name, value), true, name)
    const script = scriptOf(calls[0])
    assert.ok(script.includes('tell application "Music"'), name)
    assert.ok(script.includes(statement), `${name}: ${script.join(' / ')}`)
  }
  const { exec, calls } = fakeExec('ok\n')
  await createAppleMusicBackend({ exec, platform: 'darwin' }).command('toggleRepeat')
  assert.match(scriptOf(calls[0]).join('\n'), /if song repeat is off then\nset song repeat to all\nelse\nset song repeat to off/)
})

test('bad values and unknown commands never reach a script', async () => {
  const { exec, calls } = fakeExec()
  const music = createAppleMusicBackend({ exec, platform: 'darwin' })
  await assert.rejects(music.command('setVolume', 400), { kind: 'invalid' })
  await assert.rejects(music.command('seek', -5), { kind: 'invalid' })
  await assert.rejects(music.command('setRepeat', 'sometimes'), { kind: 'invalid' })
  await assert.rejects(music.command('rm -rf'), { kind: 'invalid' })
  assert.equal(calls.length, 0)
})

test('Spotify URIs are refused with a sentence that says why', async () => {
  const { exec, calls } = fakeExec()
  const error = await createAppleMusicBackend({ exec, platform: 'darwin' }).command('playUri', 'spotify:album:1').catch((e) => e)
  assert.equal(error.kind, 'unsupported')
  assert.match(error.message, /Apple Music can’t play Spotify/)
  assert.equal(calls.length, 0)
})

test('every shared command but playUri is one Music knows', async () => {
  const values = { setRepeat: 'off', setVolume: 10, seek: 0 }
  for (const name of COMMAND_NAMES) {
    if (name === 'playUri') continue
    const { exec } = fakeExec('ok\n')
    assert.equal(await createAppleMusicBackend({ exec, platform: 'darwin' }).command(name, values[name]), true, name)
  }
})

test('open launches Music only when asked, by bundle id', async () => {
  const { exec, calls } = fakeExec('')
  await createAppleMusicBackend({ exec, platform: 'darwin' }).command('open')
  assert.deepEqual(calls[0], { file: '/usr/bin/open', args: ['-b', 'com.apple.Music'] })
})

test('describes itself: three repeat modes, nothing the panel can’t use', () => {
  const music = createAppleMusicBackend({ exec: fakeExec().exec, platform: 'darwin' })
  assert.equal(music.id, 'applemusic')
  assert.deepEqual(music.capabilities.repeatModes, ['off', 'context', 'track'])
  assert.equal(music.capabilities.seekStepMs, 1000)
  assert.equal(music.capabilities.open, true)
  for (const feature of ['devices', 'queue', 'search', 'playlists', 'library', 'home', 'needsAuth', 'playUri']) {
    assert.equal(music.capabilities[feature], false, feature)
  }
})

// Stands in for osascript writing the cover and sips shrinking it.
function artworkExec(answer = 'ok') {
  return fakeExec(
    (file, args) => {
      assert.equal(file, '/usr/bin/osascript')
      const path = /POSIX file "([^"]+)"/.exec(scriptOf({ args }).join('\n'))[1]
      if (answer === 'ok') writeFileSync(path, 'original image')
      return answer + '\n'
    },
    (file, args) => {
      assert.equal(file, '/usr/bin/sips')
      writeFileSync(args[args.indexOf('--out') + 1], 'small jpeg')
      return ''
    }
  )
}

test('artwork is read once per track, shrunk to 300 px, and the files are removed', async () => {
  const { exec, calls } = artworkExec()
  const music = createAppleMusicBackend({ exec, platform: 'darwin', tmp: () => tmp })
  const first = await music.artwork(ID)
  assert.equal(first, `data:image/jpeg;base64,${Buffer.from('small jpeg').toString('base64')}`)
  assert.equal(await music.artwork(ID), first)
  assert.equal(calls.length, 2)
  const script = scriptOf(calls[0]).join('\n')
  assert.match(script, new RegExp(`persistent ID of t is not "${ID}"`))
  assert.match(script, /raw data of artwork 1 of t/)
  assert.deepEqual(calls[1].args.slice(0, 7), ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '-Z'])
  assert.equal(calls[1].args[7], '300')
  assert.deepEqual(readdirSync(tmp), [])
})

test('a track without artwork is remembered as none; a track that changed is asked again', async () => {
  const none = artworkExec('none')
  const music = createAppleMusicBackend({ exec: none.exec, platform: 'darwin', tmp: () => tmp })
  assert.equal(await music.artwork(ID), null)
  assert.equal(await music.artwork(ID), null)
  assert.equal(none.calls.length, 1)

  const changed = fakeExec('changed\n', 'changed\n')
  const other = createAppleMusicBackend({ exec: changed.exec, platform: 'darwin', tmp: () => tmp })
  assert.equal(await other.artwork(ID), null)
  assert.equal(await other.artwork(ID), null)
  assert.equal(changed.calls.length, 2)
})

test('artwork takes only a persistent ID, so nothing else reaches the script', async () => {
  const { exec, calls } = fakeExec()
  const music = createAppleMusicBackend({ exec, platform: 'darwin', tmp: () => tmp })
  for (const bad of ['x" & (do shell script "id") & "', '../etc', 'abc', 42, undefined]) assert.equal(await music.artwork(bad), null)
  assert.equal(calls.length, 0)
})
