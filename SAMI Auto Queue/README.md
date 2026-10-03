# SAMI Auto Queue

Automation for Halloween (Ravage): auto-requeues after a match, mashes the
killer ability the instant it's up, and can auto-leave a lobby that doesn't
match a name filter (or that's just sitting idle too long).

## Just run it

Download **`SAMIAutoQueue.zip`**, extract it anywhere, then double-click
**`SAMI Auto Queue.exe`** inside the extracted folder. No AutoHotkey install
needed, no command line.

Three independent features, each its own toggle + gear-icon settings on the
dashboard:

- **AUTO QUEUE** — detects the match-summary screen and the matchmake menu
  (read via on-screen text, so it isn't tied to one specific resolution) and
  presses through them automatically. Also handles the game's own startup
  screens (press-enter splash, login) and dismisses "ERROR"/"NETWORK ERROR"
  popups on its own.
- **KILLER** — presses a configured key the instant a calibrated screen
  pixel (the start-of-match ability icon) changes color. Click **Pick pixel
  on screen...** in its settings once, then click the icon in-game — it's
  a fixed screen pixel, so it needs re-picking if the game window ever moves.
- **MONKEY FINDER** — reads all 5 lobby player names and, once all 5 are
  known, leaves and re-queues if none of them contain any of your filter
  words (e.g. stream/Discord handles you want to stay in a match with).
  Filters are case-insensitive. Also leaves on its own if the lobby just
  sits there too long without starting (configurable, default 60s).

The window is borderless and always-on-top by design — drag it by the
title area, and it's deliberately invisible to screen capture (so dragging
it on top of the game never confuses detection with its own UI).

The update icon (top right, appears only when a newer version is out) and
the small banner under the title check this repo's release channel and
install anything newer with one click, restarting the app automatically.

## If something's not detecting right

- All the OCR-based checks (match-summary text, matchmake menu, error
  dialogs, lobby names) scale with the game's resolution since they scan a
  **fraction** of the game window rather than a fixed pixel region — but
  they were only calibrated against 1920x1080 screenshots. A very different
  aspect ratio (not 16:9) or a non-default in-game UI scale could still miss.
- Click **TEST NOW** on the dashboard to log exactly what each check reads
  right now, and **VIEW LOG** for the full running history — both are the
  fastest way to tell whether a detector is misreading vs. just not seeing
  the screen state yet.
- The Killer ability pixel is a genuine fixed screen coordinate, not a
  fraction of the window — re-run **Pick pixel on screen...** any time the
  game window moves or resizes.

## Rebuilding the .exe (only needed if you edit the .ahk files)

Needs [AutoHotkey v2](https://www.autohotkey.com/) installed (for its
bundled `Ahk2Exe` compiler, under `Compiler\Ahk2Exe.exe`):

```
Ahk2Exe.exe /in "SAMIAutoQueue.ahk" /out "SAMI Auto Queue.exe" /base "C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe"
```

Zip `SAMI Auto Queue.exe` together with the `ui\` and `lib\` folders
(contents at the zip's root, not inside an extra folder) as
`SAMIAutoQueue.zip` for distribution/auto-update — the in-app updater
extracts it directly into the install directory.
