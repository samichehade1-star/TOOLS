# Media Converter

<img src="assets/icon.png" width="64">

[![Download for Windows](https://img.shields.io/badge/Download%20for%20Windows-6366f1?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/samichehade1-star/media-converter/releases/latest/download/MediaConverter_Setup.zip)

Paste a link and save it as MP3, MP4 and more - the whole thing or just a part. Convert files on your PC between formats, or play a file and cut a part out of it.

- **From a link** - YouTube, Instagram, Facebook, TikTok, SoundCloud and 1,700+ other sites (public posts). Video: MP4, MKV, WEBM, MOV, AVI, GIF up to 4K. Audio: MP3, M4A, WAV, FLAC, OGG, OPUS. Turn on **Download only a part** and give a start and/or end time (`83`, `1:23` or `1:02:03`) to download just that piece.
- **Convert a file** - pick or drag in a file and pick the format. MP3 to MP4 uses a cover picture you choose (or a black screen); MP4 to MP3 keeps the sound.
- **Player & trim** - play a video or song, drag the pink (start) and blue (end) handles or use **Start here** / **End here**, preview the cut, and save it in the same or another format. **Fast cut** saves instantly without re-encoding (the start snaps to the nearest keyframe). Keys: Space play/pause, I start, O end, arrow keys skip 5 s (Shift = 1 s). Formats the player cannot show (AVI, WMV, HEVC...) get a quick preview copy; the cut always comes from the original file.

Use it only for content you own or have permission to download.

## Installing

Click **Download for Windows** above (or get `MediaConverter_Setup.zip` from the [latest release](https://github.com/samichehade1-star/media-converter/releases/latest)), unzip it anywhere and run `Media Converter.exe`. Keep `ffmpeg.exe` in the same folder.

Windows SmartScreen may show an "unrecognized publisher" warning on first run since the app isn't code-signed - click **More info -> Run anyway**. Needs the Microsoft Edge WebView2 runtime (built into Windows 11).

## Updating

- **The app** checks its release channel a couple of seconds after it opens (and from **Check for updates** at the bottom). When there is a newer version a banner appears; **Install and restart** downloads `MediaConverter.zip`, swaps the files and reopens the app. `ffmpeg.exe` is left as it is.
- **The download engine (yt-dlp)** updates itself: sites change often, so the app checks PyPI for a newer yt-dlp on every start, downloads the official wheel (sha256 checked) into `%APPDATA%\MediaConverter\engine` and uses it from the next start. No app release is needed when a site breaks.

Settings (the save folder) are in `%APPDATA%\MediaConverter\settings.json`.

## Releasing a new version

1. Raise `APP_VERSION` at the top of `media_converter.py`.
2. Put `ffmpeg.exe` next to `build.bat` (not committed - see `.gitignore`), then run `build.bat`.
3. Create a release on `samichehade1-star/media-converter` tagged `v<APP_VERSION>` and attach both files from `release\`: `MediaConverter.zip` (the update) and `MediaConverter_Setup.zip` (first install, includes ffmpeg).

Run from source: `pip install -r requirements.txt`, then `python media_converter.py` (ffmpeg on PATH or next to the script).

## How it's built

- `media_converter.py` - the back end: downloads (yt-dlp), converting and cutting (ffmpeg), a small local server so the player can stream the open file, and both updaters.
- `ui.html` - the window (shown borderless by pywebview / Edge WebView2; it draws its own title bar, minimize and close). No internet needed for the look.
- `assets/` - SE Visuals logo and app icon.

ffmpeg is a separate program under the GPL (https://ffmpeg.org); yt-dlp is under the Unlicense.
