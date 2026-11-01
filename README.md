# Now Playing for Orca

Control the Spotify desktop app on your Mac from [Orca](https://github.com/stablyai/orca): play,
pause, skip and see what's playing from the command palette or a shortcut. No Spotify account
setup, API keys or Premium needed. Not affiliated with Spotify.

## Install

Needs Orca 1.4.246 or newer, macOS, and the Spotify desktop app.

1. Orca → Settings → Plugins → **Turn on plugins**.
2. **Install plugin** → Git URL → `https://github.com/BautistaPessagno/orca-spotify#v0.1.0`.
3. Review what it asks for and click **Enable**.
4. The first time you use it, macOS asks whether Orca may control Spotify. Allow it.

## Use

| Command (palette: type "Spotify") | Shortcut |
| --------------------------------- | -------- |
| Spotify: Play / Pause             | ⌘⌥⇧P     |
| Spotify: Next track               | ⌘⌥⇧N     |
| Spotify: Previous track           | ⌘⌥⇧B     |
| Spotify: Now playing              |          |
| Spotify: Toggle shuffle           |          |

Each command answers with the current track, or says what to do when Spotify is closed or
Orca lacks permission. The plugin never opens Spotify on its own.

If you denied the macOS prompt: System Settings → Privacy & Security → Automation → Orca →
turn on Spotify.

## Sidebar panel

Open **Now Playing** from the right sidebar's activity bar: cover, title, a seek bar,
play / pause, next, previous, shuffle, repeat and volume. It updates by itself while Spotify
plays. The panel asks the plugin's worker for everything with `orca.plugin.request`; the worker
answers through `orca.panels.handle` (`src/panel-protocol.mjs`).

## Develop

```sh
npm test                  # node:test, no dependencies
orca plugin validate .
orca plugin dev load .    # or Settings → Plugins → Development folders…
orca plugin logs local.now-playing
```

Use **Restart** on the plugin row after changing `worker.mjs`.

Layout:

- `orca-plugin.json`: manifest.
- `worker.mjs`: `activate(orca)`; wires the commands and the panel's handlers.
- `backends/applescript.mjs`: every call to Spotify, through `osascript`.
- `src/commands.mjs`: palette commands.
- `src/panel-protocol.mjs`: the handlers the panel calls.
- `src/settle.mjs`: waits for Spotify to apply a command before reading its state.
- `panel/index.html`: the sidebar player.

## License

MIT
