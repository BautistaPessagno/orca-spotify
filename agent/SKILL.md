---
name: now-playing
description: >-
  Control the user's music through Orca's Now Playing plugin, in Spotify or Apple Music: see
  what's playing, play, pause, skip, set volume, shuffle and repeat; with Spotify also search and
  play songs, albums, playlists or artists, queue tracks, like songs and move playback between
  devices. Use when the user asks for music, a song, a playlist, "what's playing", to pause or
  skip, or to change the volume or the speaker.
---

# Now Playing (Spotify or Apple Music in Orca)

Run `~/.orca-now-playing/now-playing`. It talks to the Now Playing plugin inside Orca, which
holds the connection to Spotify or to the Music app; there is nothing to log in to or configure
from here. It drives whichever service the user picked with the switch in the Now Playing panel;
`status` says "in Apple Music" when that is the one.

```sh
NP=~/.orca-now-playing/now-playing
$NP status                         # what's playing (with its spotify: URI on Spotify)
$NP play                           # resume
$NP pause | toggle | next | previous
$NP volume 30 | shuffle on | repeat all | seek 1:30
$NP open                           # start the app if it is closed; starts no music
```

Spotify only:

```sh
$NP play "dreams fleetwood mac"    # search, play the best matching song
$NP play "lofi beats" --playlist   # …or the best playlist (--album, --artist)
$NP play spotify:album:1weenld61qoidwYuZ1GESA   # a URI or open.spotify.com link
$NP like                           # save the current song (unlike to remove)
$NP search "miles davis" --type album,artist
$NP queue                          # what plays next
$NP queue spotify:track:…          # add a track after the current one
$NP devices                        # then: $NP device "Living Room"
```

Add `--json` for the plugin's raw answer when you need fields or URIs to act on.

## Rules

- Search before playing something specific if the request is ambiguous, then play the URI you chose.
- Change volume or device only when asked. Don't start music on your own.
- One command per action; don't poll `status` in a loop.
- Don't switch between Spotify and Apple Music yourself; that choice is the user's, in the panel.

## When it fails

The CLI prints the reason and exits non-zero. Tell the user the sentence it printed.

- Exit 3, "Now Playing is not running": Orca is closed, the plugin is off, or its Agent access
  setting is off (Orca → Settings → Plugins → Now Playing).
- "Apple Music can't do that from Now Playing": with Apple Music selected, only play, pause,
  skip, seek, volume, shuffle and repeat work. Searching, playing something by name, the queue,
  devices and likes need Spotify; tell the user, and let them switch if they want.
- "This needs the Spotify Web API": search, queue, devices and likes need the user to connect
  Spotify in the Now Playing panel. `play <uri>`, pause, skip, volume and status work without it
  on a Mac.
- "No Spotify device is active" / "Spotify is not open" / "Music is not open": run `$NP open`,
  then try again. It starts the app in the background and waits for it (with the Spotify Web API,
  it also makes this computer the active device, paused). If it says it can't (the app is not
  installed, or this is not a Mac), tell the user the sentence it printed.

## Without the CLI

`~/.orca-now-playing/bridge.json` has `url` and `token`. POST `{url}/v1/request` with
`Authorization: Bearer {token}`, `Content-Type: application/json` and
`{"name": "player.state"}`; `GET {url}/v1/health` lists every request name.
