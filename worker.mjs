// Now Playing worker: the handlers the sidebar panel calls, the status bar item, and the agent
// bridge that lets coding agents use the same handlers. All go through one backend selector:
// AppleScript (Spotify desktop on macOS) or the Spotify Web API (any Connect device), picked by
// the `backend` setting, or Apple's Music app on macOS when the `service` setting says so.
import { readFileSync } from 'node:fs'
import { createAppleMusicBackend } from './backends/applemusic.mjs'
import { createAppleScriptBackend } from './backends/applescript.mjs'
import { createAuth } from './backends/webapi/auth.mjs'
import { createWebApiBackend } from './backends/webapi/backend.mjs'
import { createClient } from './backends/webapi/client.mjs'
import { createAgentBridge } from './src/agent-bridge.mjs'
import { createAgentSkill } from './src/agent-skill.mjs'
import { createAppOpener } from './src/open-app.mjs'
import { createPanelHandlers } from './src/panel-protocol.mjs'
import { createBackendSelector } from './src/select-backend.mjs'
import { createStatusBar } from './src/status-bar.mjs'

const file = (path) => new URL(path, import.meta.url)
const VERSION = JSON.parse(readFileSync(file('./orca-plugin.json'), 'utf8')).version

let auth = null
let bridge = null
let statusBar = null

export default function activate(orca, deps = {}) {
  const log = (message) => orca.log?.(message)
  auth = createAuth({
    settings: orca.settings,
    secrets: orca.secrets,
    protection: async () => (await orca.host.call('secrets.protection')).status
  })
  const backends = deps.backends ?? {
    applescript: createAppleScriptBackend(),
    applemusic: createAppleMusicBackend(),
    webapi: createWebApiBackend({ client: createClient({ auth }), auth })
  }
  const spotify = createBackendSelector({ backends, settings: orca.settings })

  // Every state read, by the panel, an agent or the status bar itself, updates the status bar.
  statusBar = createStatusBar({ host: orca.host, spotify, log })
  const getState = spotify.getState
  spotify.getState = async () => statusBar.show(await getState())

  const handlers = createPanelHandlers(spotify, { auth, apps: createAppOpener({ spotify, backends }) })
  bridge = createAgentBridge({ handlers, version: VERSION, cliSource: file('./bin/now-playing.mjs'), log, ...deps.bridge })
  const skill = createAgentSkill({ source: file('./agent/SKILL.md'), log, ...deps.skill })

  const setting = async (key, fallback) => {
    const value = await Promise.resolve(orca.settings.get(key)).catch(() => undefined)
    return typeof value === 'boolean' ? value : fallback
  }

  // What the panel's agent link shows.
  const agentInfo = async () => ({
    access: await setting('agentAccess', true),
    bridge: bridge.info().running,
    skill: (await skill.status()).installed
  })

  // Brings the bridge and the skill in line with the settings.
  let syncing = Promise.resolve()
  const sync = () =>
    (syncing = syncing.then(async () => {
      try {
        if (await setting('agentAccess', true)) await bridge.start()
        else await bridge.stop()
        // The skill follows its setting both ways, so turning it off in Settings removes it.
        if (await setting('agentSkill', false)) await skill.install()
        else await skill.remove()
      } catch (error) {
        log(`agents: ${error.message}`)
      }
    }))

  for (const [name, handler] of Object.entries(handlers)) orca.panels.handle(name, handler)

  orca.panels.handle('agents.info', agentInfo)
  // The panel's "Let your coding agents control …": turns on access and the skill in one click.
  orca.panels.handle('agents.enable', async () => {
    await orca.settings.set('agentAccess', true)
    await orca.settings.set('agentSkill', true)
    await sync()
    return agentInfo()
  })

  orca.settings.onDidChange?.(() => void sync())
  void sync()
  statusBar.start()
}

// Stops a login still waiting for the browser (so its port is free next time), the status bar
// poll and the agent bridge (which removes its discovery file).
export async function deactivate() {
  auth?.close()
  statusBar?.stop()
  await bridge?.stop()
}
