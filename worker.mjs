// Now Playing worker: palette commands, and the handlers the sidebar panel calls.
import { createAppleScriptBackend } from './backends/applescript.mjs'
import { createCommands } from './src/commands.mjs'
import { createPanelHandlers } from './src/panel-protocol.mjs'

export default function activate(orca) {
  const spotify = createAppleScriptBackend()

  for (const [id, handler] of Object.entries(createCommands(spotify))) {
    orca.commands.register(id, handler)
  }

  for (const [name, handler] of Object.entries(createPanelHandlers(spotify))) {
    orca.panels.handle(name, handler)
  }
}
