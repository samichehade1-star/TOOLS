Drop these two files into this "assets" folder to activate them — the app
already looks for them by these exact names and falls back gracefully
(emoji logo, no splash video) if they're missing:

  logo.png    — square app logo, used as the titlebar mark.
                Recommended: at least 128x128, transparent background.

  intro.mp4   — startup splash video, plays once when the app opens
                (skippable, and auto-hidden after ~8s regardless).
                Recommended: short (2-5s), under a few MB, no audio track
                required (it starts muted — unmute logic can be added on
                request once you drop a video in).

After adding either file, just restart the app (or reload with Ctrl+R
if you're running it via `npm start`) to pick them up.
