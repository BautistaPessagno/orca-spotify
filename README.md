# Now Playing for Orca

Control the Spotify desktop app on your Mac from [Orca](https://github.com/stablyai/orca): play,
pause, skip and see what's playing from the command palette or a shortcut. No Spotify account
setup, API keys or Premium needed. Not affiliated with Spotify.

## Install

Needs Orca 1.4.245 or newer, macOS, and the Spotify desktop app.

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

`panel/index.html` is a player for Orca's right sidebar. A panel can only drive Spotify once
Orca lets panels message their own plugin's worker
([stablyai/orca#25129](https://github.com/stablyai/orca/issues/25129)); released Orca can't
yet, so the manifest doesn't declare the panel. It will in the release that targets the first
Orca with that channel.

The same code runs on both kinds of Orca:

- `worker.mjs` always registers the commands, and registers the panel's message handler only
  when `orca.panels.onMessage` exists.
- The panel checks for `orca.panel.postMessage`. Without it, it shows the shortcuts instead of
  a player whose buttons would do nothing.

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
- `worker.mjs`: `activate(orca)`; wires commands and, where supported, the panel.
- `backends/applescript.mjs`: every call to Spotify, through `osascript`.
- `src/commands.mjs`: palette commands.
- `src/panel-protocol.mjs`: the worker's side of the panel messages.
- `panel/index.html`: the sidebar player.

## License

MIT
