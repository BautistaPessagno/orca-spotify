import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createAgentSkill, skillTargets } from '../src/agent-skill.mjs'

const SOURCE = new URL('../agent/SKILL.md', import.meta.url)

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'now-playing-skill-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('installs only where the agent folder exists, keeping the front matter first', async () => {
  const h = home()
  mkdirSync(join(h.dir, '.claude'))
  const skill = createAgentSkill({ source: SOURCE, targets: skillTargets(h.dir) })
  assert.deepEqual(await skill.install(), { installed: ['Claude Code'] })
  const text = readFileSync(join(h.dir, '.claude/skills/now-playing/SKILL.md'), 'utf8')
  assert.match(text, /^---\nname: now-playing\n/)
  assert.match(text, /Installed by the Now Playing plugin/)
  assert.ok(!existsSync(join(h.dir, '.agents')))
  assert.deepEqual(await skill.status(), { installed: ['Claude Code'] })
  h.done()
})

test('never overwrites or removes a skill of the same name that is not ours', async () => {
  const h = home()
  const theirs = join(h.dir, '.agents/skills/now-playing/SKILL.md')
  mkdirSync(join(h.dir, '.agents/skills/now-playing'), { recursive: true })
  writeFileSync(theirs, 'mine')
  const skill = createAgentSkill({ source: SOURCE, targets: skillTargets(h.dir) })
  assert.deepEqual(await skill.install(), { installed: [] })
  await skill.remove()
  assert.equal(readFileSync(theirs, 'utf8'), 'mine')
  h.done()
})

test('remove deletes ours and its folder', async () => {
  const h = home()
  mkdirSync(join(h.dir, '.agents'))
  const skill = createAgentSkill({ source: SOURCE, targets: skillTargets(h.dir) })
  await skill.install()
  await skill.remove()
  assert.ok(!existsSync(join(h.dir, '.agents/skills/now-playing')))
  assert.deepEqual(await skill.status(), { installed: [] })
  h.done()
})
