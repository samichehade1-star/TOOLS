# Tile Sequence Auto-Presser

Watches the whole screen for the combo row (e.g. `3 1 2 3`, or Xbox icons
`B Y A X`) and presses/inputs it in order, left to right, the instant it
appears. If multiple combo lines are shown at once (e.g. "Weapon Execution"
above "Bare Handed"), it automatically skips any line marked locked (a red
"requirement not met" warning beneath it) and acts on the one that's actually
available.

## Just run it

Double-click **`TileAutoPresser.exe`**. No command line, no Python needed.

**Role and region/templates are calibrated separately for Michael and
Civilian** — their combo tiles look different and can appear in a completely
different screen location, so one shared calibration can't cover both.
Nothing ships pre-filled for either role: Step 1 (region) and Step 2
(templates) must each be done once per role before that role's Start
Watching will work.

Steps, once per role:

1. Pick **Keyboard** or **Controller** input mode at the top (controller mode
   reads Xbox-style A/B/X/Y icon prompts but presses the matching keyboard
   key — see the Controller mode section below).
2. Pick your **Role** (Michael or Civilian). This also bounds how many tiles
   a real combo can have for that role (Michael: 4-5, civilian: 3-4) so a
   mid-animation partial/garbled read outside that range gets rejected
   outright instead of getting pressed as a bogus combo — see "If it's not
   reading correctly" below.
3. Click **Use Whole Screen** (or **Select Region...** for a tighter one)
   for the currently-selected role.
4. **Start Calibration** (F7) and trigger the in-game combo for that role;
   label each new tile once. Repeat steps 2-4 for the other role.
5. Click **Start Watching**. That's it — go play. Press **F8** anywhere
   (even with the game focused) to pause/resume without alt-tabbing back to
   this window.

Switching the **Role** toggle swaps Step 1/Step 2 to that role's own
region/templates — the other role's calibration is untouched and comes right
back when you switch back.

The **Check for Updates** button (top right) checks this tool's GitHub
release channel and offers to download + install anything newer, with no
need to come back here manually — it also checks once, quietly, a couple
seconds after startup.

Press **F7** anywhere to start/stop calibration without alt-tabbing, too —
useful because calibration only captures a tile the instant it sees one it
doesn't recognize, and by the time you'd normally alt-tab in to click "Start
Calibration" the in-game icons are already gone. Press F7 first, then
trigger the in-game sequence; only an unrecognized tile pops the labeling
dialog, and it's already been screenshotted at that point, so tabbing in for
that popup doesn't lose anything.

`config.json` and the `templates/` folder live next to the `.exe` and hold
your per-role region + digit/icon templates (e.g.
`templates/keyboard/michael/`, `templates/keyboard/civilian/`).

## Beta: Mash tab

A second, separate puzzle from a different part of the game: a single icon
box (a mouse-click icon or a letter key) that you fill by repeating that
input rapidly. Unlike the combo row on the Main tab, there's only ever one
icon on screen and no sequence/order to it -- just "read it, spam it" -- so
it's simpler and doesn't share any code, config, or templates with the Main
tab (though `templates/mash/` follows the same file layout). It's its own
tab in the app window.

Setup is the same shape as the Main tab, scoped to this puzzle:
1. **Select Region** (or **Full Screen**, if the prompt doesn't always show
   up in the same spot) — a *tight* region is nicer but not required
   anymore: detection finds the actual icon box inside whatever area you
   give it, so a generously-sized region works fine too.
2. **Start Calibration** (hotkey **F5**) — trigger the prompt in-game; a
   popup shows the captured icon with a full clickable A-Z/0-9 grid plus
   MB1/MB2 buttons to label it. All click-only, on purpose: while the game
   is focused, Windows won't hand this background popup real keyboard focus,
   so a pressed key silently goes to the game instead of the dialog.
3. **Run** (hotkey **F6**) — as soon as it sees a known icon, it mashes that
   icon non-stop for a fixed burst (`mash_burst_ms`, default 2.5s), then
   **stops on its own**. F6 only needs pressing once, right before the
   puzzle appears -- no need to remember to toggle it back off.

   The burst is fixed-length and deliberately ignores the detector once
   locked on: an earlier version stopped as soon as the icon looked "gone,"
   but real prompts flicker in and out of detection for 100-200ms+ at a
   stretch (animation, a busy scan region, etc.), which kept cutting mashing
   short mid-puzzle. Mashing straight through the whole burst regardless of
   what the detector reports fixes that. If the puzzle genuinely needs
   longer than 2.5s, raise `mash_burst_ms`; if Run is finishing before the
   puzzle even appears, that's usually a sign the icon it locked onto is
   stale/wrong -- redo Step 2 for that icon.

Since it's beta, expect this one to need more tuning than the Main tab.
Knobs in `config.json`:
- `mash_match_threshold` / `mash_template_size` control matching the same
  way `match_threshold` does for the Main tab.
- `mash_burst_ms` (default 2500) is how long, in milliseconds, one Run
  press mashes for once it locks onto an icon, before stopping itself.
- `mash_press_hold_ms` / `mash_press_gap_ms` control the spam rate (default
  15ms hold / 10ms gap). Push lower if the game keeps up; back off if
  presses stop registering -- there's a real per-game ceiling past which
  the game just drops input, not a matter of pushing harder.
- `mash_poll_interval_ms` (default 5) is how often the *detector* scans for
  the icon -- pressing no longer waits on this at all (detection and
  pressing run as two independent loops), so this is pure scan cost/CPU
  tuning, not a speed knob.
- `mash_miss_tolerance` (default 15 polls) is how many consecutive
  detection misses are tolerated before a *newly appearing* icon is
  considered not-yet-found -- this only matters while waiting for the first
  icon to show up, since once locked on, the burst ignores misses entirely.
- `mash_min_cell_area` / `mash_max_refine_candidates` tune the icon-box
  finder the same way their Main-tab equivalents do.

## Puzzle types not covered by this tool

Two other minigame types from this game were investigated and deliberately
left out:
- **Sliding-marker timing bar** (click when a marker crosses a target zone) —
  removed after live testing showed it unreliable.
- **Rotary-dial skill check** (a needle sweeps a full circle in roughly
  1 second) — the measured target window is likely tens of milliseconds,
  faster than this tool's screen-capture latency (~20-40ms per read) can
  reliably react to. Not attempted for that reason.

This tool focuses on the row-combo puzzle (digit tiles / controller icons),
which has a multi-second window and is well suited to screen-scraping.

## Controller mode

No virtual controller, no ViGEmBus, no DS4Windows involved at all — that
was tried first and abandoned. Every approach that creates a second virtual
Xbox controller runs into the same wall: the game either only listens to
whichever controller it saw first (DS4Windows' or a real one, not ours), or
outright kicks the player for a second/unrecognized controller appearing
mid-session. No amount of tuning fixes that; it happens at a layer this app
doesn't control.

So instead, Controller mode just reads the same on-screen Xbox-style A/B/X/Y
icon prompts as before, and presses the **keyboard key** this game maps to
that same action instead of a controller button — see `CONTROLLER_KEY_MAP`
in `app.py` for the current mapping (Cross/A→1, Circle/B→2, Square/X→4,
Triangle/Y→3). This sidesteps the entire virtual-controller problem: no
second device ever exists, so there's nothing for the game to reject and
nothing to fight DS4Windows (or anything else) for a slot. Play with
whatever controller/software you normally use — it's completely unaffected.

If your game maps these actions to different keys, edit `CONTROLLER_KEY_MAP`
at the top of `app.py` to match, then rebuild (see below) or just re-run
`python app.py` if running from source.

## Controller-mode fix (worth knowing)

Round controller-button icons (A/B/X/Y) share a nearly identical outer ring
across every letter, which was diluting template matching and made X/Y in
particular easy to confuse (measured cross-match score of 0.744, dangerously
close to the 0.75 accept threshold) — this was the real cause of "messing up
the combination" in controller mode. Fixed by matching only the central
letter glyph instead of the whole icon (cuts worst-case confusion to ~0.47);
templates were regenerated accordingly. Verified against real screenshots
for both keyboard and controller modes before shipping.

## If it's not reading correctly

- Make sure **Role** (Michael/Civilian) matches whoever you're actually
  playing, and that you've done Step 1 + Step 2 for that specific role. A
  mid-animation frame that only shows part of the real combo (or, rarely,
  picks up a stray extra box) gets rejected outright if its tile count falls
  outside that role's real range (Michael: 4-5, civilian: 3-4) instead of
  getting pressed as a bogus short/long combo.
- If it's picking the wrong combo line or ever misfires, or valid tiles are
  missed/misread, edit `config.json`:
  - `match_threshold` (0-1): lower it (e.g. 0.65) if valid tiles are missed;
    raise it if wrong digits/buttons get read.
  - `confirm_count`: how many consecutive identical readings are required
    before pressing (default 1). Raises this if a combo still gets pressed
    more than once for a single on-screen appearance (a tile briefly
    misread due to a UI glow/animation can look like the combo changed,
    causing an extra press) — a real bug that showed up as a 3-key combo
    turning into 5+ presses and failing the puzzle. Lower it (to 1) only if
    combos are being missed entirely because they disappear too fast to be
    read twice.
  - `min_cell_area` / `row_cluster_tolerance_px`: adjust if boxes aren't
    being detected correctly (e.g. very different UI scale).
  - `key_hold_ms` / `key_gap_ms`: how long each press is held and the pause
    between presses — increase if the game isn't registering them.
  - `max_refine_candidates` (default 24): on a whole-screen capture, a busy
    frame (lots of HUD/chat/player-list clutter) can produce dozens of
    candidate boxes, and refining each one's exact position is expensive —
    measured up to ~850ms on a single frame at the old default of 60. Past
    this many candidates, the scan skips refinement and uses the cheaper
    approximate box positions instead (a few pixels less precise, but still
    accurate enough to match). This is the most likely cause of "it usually
    reacts instantly but every so often takes noticeably longer" — lower it
    (e.g. 12) if that's still happening.
  - `stall_log_ms` (default 40): any single watch-loop frame that takes
    longer than this logs a `[stall] ...` line breaking down capture vs. scan
    time, so a one-off slow reaction can be diagnosed from the log instead of
    guessed at.
- If the game's tile/icon styling ever changes and stops matching, delete the
  relevant file in `templates/keyboard/<role>/` or `templates/controller/<role>/`
  (matching whichever role/mode is currently selected) and use
  **Start Calibration** to relabel just that one (a small popup shows the
  crop; click the matching digit/button, or press its key).
- The game generally needs focus (be the active window) for simulated input
  to reach it. If it's exclusive fullscreen and behaves oddly, borderless
  windowed mode is more robust.
- The hotkeys (F5-F9) are a low-level keyboard hook, which Windows will
  silently tear down if its callback doesn't respond fast enough (a busy
  scan, or a mash burst pushing 100+ synthetic presses/sec through that same
  hook can trip this) -- the app re-arms all hotkeys automatically every 45s
  to recover from that, so a hotkey going dead mid-session should fix itself
  within that window.
  **Do not run `TileAutoPresser.exe` as Administrator** to try to fix this —
  on some systems that triggers an unrelated PyInstaller bootloader bug
  ("Security validation failure: failed to obtain executable path for
  parent process!") that prevents the app from starting at all. If the game
  itself runs elevated and hotkeys still don't respond even after the
  45s re-arm, that's a real limitation of running unelevated, not something
  this tool can currently work around.

## Rebuilding the .exe (only needed if you edit the .py files)

```
pip install -r requirements.txt pyinstaller
```
Then:
```
python -m PyInstaller --onefile --noconsole --name TileAutoPresser app.py
```
The new exe will be in `dist/`.
