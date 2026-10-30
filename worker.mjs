// Now Playing worker: palette commands on every Orca, plus the sidebar panel's
// backend on an Orca that can route panel messages to the worker (stablyai/orca#25129).
import { createAppleScriptBackend } from './backends/applescript.mjs'
import { createCommands } from './src/commands.mjs'
import { createPanelHandler } from './src/panel-protocol.mjs'

export default function activate(orca) {
  const spotify = createAppleScriptBackend()

  for (const [id, handler] of Object.entries(createCommands(spotify))) {
    orca.commands.register(id, handler)
  }

  // Older Orca has no orca.panels; the commands above are then the whole plugin.
  if (typeof orca.panels?.onMessage === 'function') {
    orca.panels.onMessage('player', createPanelHandler(spotify))
  }
}
