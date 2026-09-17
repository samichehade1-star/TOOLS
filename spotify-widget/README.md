# Spotify Widget

A tiny, transparent, always-on-top Spotify control bar for Windows — play/pause, skip, volume, and quick access to your Playlists, Queue, Liked Songs, trending playlists, and genre stations. Stays small and out of the way (even over fullscreen games), with a global hotkey to pull focus to it instantly.

## Download

Grab the latest installer from [Releases](https://github.com/samichehade1-star/spotify-widget/releases/latest) and run it. Windows SmartScreen may show an "unrecognized publisher" warning since this isn't code-signed — click **More info → Run anyway**.

## First-time setup: getting your own Spotify Client ID

This app talks to Spotify using Spotify's own Web API, which requires every app to have its own **Client ID** — free, takes two minutes, and Spotify doesn't allow one shared key to be used by everyone. Here's how to get yours:

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and log in with your normal Spotify account.
2. Click **Create app**. Name and description can be anything.
3. For **Redirect URI**, enter exactly:
   ```
   http://127.0.0.1:8888/callback
   ```
4. Check the **Web API** checkbox, then **Save**.
5. Open your new app and copy the **Client ID** shown on its page. (You do *not* need the "Client Secret" — this app never uses it.)
6. Open Spotify Widget — on first launch it'll ask for this Client ID. Paste it in, click Save, then **Log in with Spotify** to connect your account.

You'll need a **Spotify Premium** account — playback control isn't available via the Web API on Free accounts.

## Using it

- Drag the small grip (⋮⋮) to move it anywhere on screen.
- Right-click the bar for Reconnect / Restart Spotify / Check for Updates / Quit.
- Press `Ctrl+Alt+S` anytime to instantly bring the widget into focus (handy for pulling your mouse out of a game that's captured it).
- Click **+** to browse your Playlists, Queue, Liked Songs, trending playlists (Hot), or pick a Genre station.

## Building from source

```
npm install
npm start        # run in dev mode
npm run dist      # build a Windows installer (dist/)
```
