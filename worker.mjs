// Now Playing worker: palette commands, and the handlers the sidebar panel calls.
// Both go through one backend selector: AppleScript (Spotify desktop on macOS) or the
// Spotify Web API (any Connect device, any OS), picked by the `backend` setting.
import { createAppleScriptBackend } from './backends/applescript.mjs'
import { createAuth } from './backends/webapi/auth.mjs'
import { createWebApiBackend } from './backends/webapi/backend.mjs'
import { createClient } from './backends/webapi/client.mjs'
import { createCommands } from './src/commands.mjs'
import { createPanelHandlers } from './src/panel-protocol.mjs'
import { createBackendSelector } from './src/select-backend.mjs'

let auth = null

export default function activate(orca) {
  auth = createAuth({
    settings: orca.settings,
    secrets: orca.secrets,
    protection: async () => (await orca.host.call('secrets.protection')).status
  })
  const backends = {
    applescript: createAppleScriptBackend(),
    webapi: createWebApiBackend({ client: createClient({ auth }), auth })
  }
  const spotify = createBackendSelector({ backends, settings: orca.settings })

  for (const [id, handler] of Object.entries(createCommands(spotify))) {
    orca.commands.register(id, handler)
  }

  for (const [name, handler] of Object.entries(createPanelHandlers(spotify, { auth }))) {
    orca.panels.handle(name, handler)
  }
}

// Stops a login that is still waiting for the browser, so its port is free next time.
export function deactivate() {
  auth?.close()
}
