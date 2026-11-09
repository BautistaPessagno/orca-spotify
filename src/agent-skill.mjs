// The agent skill: agent/SKILL.md, copied into the skill folders coding agents read, so they know
// the `now-playing` CLI exists and how to use it. Installed only when the person turns on the
// `agentSkill` setting (or presses the panel's link), and removed when they turn it off.
//
//   ~/.claude/skills/now-playing/SKILL.md    Claude Code
//   ~/.agents/skills/now-playing/SKILL.md    Codex and other agents that read ~/.agents
//
// A folder is written only if its parent (~/.claude, ~/.agents) already exists, and removed only
// if the SKILL.md in it is ours.
import { access, mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const MARKER = '<!-- Installed by the Now Playing plugin for Orca. -->'

export const skillTargets = (home = homedir()) => [
  { agent: 'Claude Code', root: join(home, '.claude'), dir: join(home, '.claude', 'skills', 'now-playing') },
  { agent: 'Codex and others', root: join(home, '.agents'), dir: join(home, '.agents', 'skills', 'now-playing') }
]

const exists = (path) => access(path).then(() => true, () => false)

const ours = async (file) => {
  try {
    return (await readFile(file, 'utf8')).includes(MARKER)
  } catch {
    return false
  }
}

export function createAgentSkill({ source, targets = skillTargets(), log = () => {} }) {
  const content = async () => {
    const text = await readFile(source, 'utf8')
    // After the front matter, so agents still read `name` and `description` first.
    return text.replace(/^(---\n[\s\S]*?\n---\n)/, `$1${MARKER}\n`)
  }

  return {
    // Where it is installed now.
    async status() {
      const installed = []
      for (const target of targets) if (await ours(join(target.dir, 'SKILL.md'))) installed.push(target.agent)
      return { installed }
    },

    async install() {
      const text = await content()
      const installed = []
      for (const target of targets) {
        if (!(await exists(target.root))) continue
        const file = join(target.dir, 'SKILL.md')
        // Someone else's skill by that name stays.
        if ((await exists(file)) && !(await ours(file))) {
          log(`agent skill: ${file} is not ours; left alone`)
          continue
        }
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, text)
        installed.push(target.agent)
      }
      return { installed }
    },

    async remove() {
      for (const target of targets) {
        const file = join(target.dir, 'SKILL.md')
        if (!(await ours(file))) continue
        await rm(file, { force: true })
        // The folder goes too, unless something else was put in it.
        await rmdir(target.dir).catch(() => {})
      }
      return { installed: [] }
    }
  }
}
