---
name: now-playing
description: >-
  Control the user's Spotify through Orca's Now Playing plugin: see what's playing, play, pause,
  skip, set volume, search and play songs, albums, playlists or artists, queue tracks, like songs
  and move playback between devices. Use when the user asks for music, a song, a playlist,
  "what's playing", to pause or skip, or to change the volume or the speaker.
---

# Now Playing (Spotify in Orca)

Run `~/.orca-now-playing/now-playing`. It talks to the Now Playing plugin inside Orca, which
holds the Spotify connection; there is nothing to log in to or configure from here.

```sh
NP=~/.orca-now-playing/now-playing
$NP status                         # what's playing, with its spotify: URI
$NP play                           # resume
$NP play "dreams fleetwood mac"    # search, play the best matching song
$NP play "lofi beats" --playlist   # …or the best playlist (--album, --artist)
$NP play spotify:album:1weenld61qoidwYuZ1GESA   # a URI or open.spotify.com link
$NP pause | toggle | next | previous
$NP volume 30 | shuffle on | repeat all | seek 1:30
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

## When it fails

The CLI prints the reason and exits non-zero. Tell the user the sentence it printed.

- Exit 3, "Now Playing is not running": Orca is closed, the plugin is off, or its Agent access
  setting is off (Orca → Settings → Plugins → Now Playing).
- "This needs the Spotify Web API": search, queue, devices and likes need the user to connect
  Spotify in the Now Playing panel. `play <uri>`, pause, skip, volume and status work without it
  on a Mac.
- "No Spotify device is active" / "Spotify is not open": ask the user to open Spotify.

## Without the CLI

`~/.orca-now-playing/bridge.json` has `url` and `token`. POST `{url}/v1/request` with
`Authorization: Bearer {token}`, `Content-Type: application/json` and
`{"name": "player.state"}`; `GET {url}/v1/health` lists every request name.
