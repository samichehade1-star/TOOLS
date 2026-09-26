# Halloween Mod Manager

Mod manager for **Halloween** (Ravage). Installs to `<game>\Ravage\Content\Paks\~mods`.

- **On**: the mod's files are copied into `~mods`.
- **Off**: the mod's files are deleted from `~mods`. The only copy stays in
  `%APPDATA%\Halloween Mod Manager\mods`.
- On launch, any unknown mod already in `~mods` is imported, so nothing needs re-downloading.
- Add mods with **install mods** (name the mod and pick its pakchunks), or drag `.pak/.ucas/.utoc/.sig`
  files, folders, `.zip`, `.rar` or `.7z` onto the window.
- **Downloads tab**: lists mod folders, archives and loose pakchunks in your Downloads folder.
  **add to mods** moves one into storage as a mod that starts off.
- **Categories**: group mods and drag them to reorder or move them between categories (custom order).
- Sidebar: **trainer** (path set in settings), **open MODS**, and **launch game** via Steam or Epic.
- Colours, presets, font size and glow can be changed under Settings → appearance and layout.
- Checks this app's GitHub releases for updates on start, every 4 hours, and on demand.

## Custom intro

Go to Settings → **custom intro**. Pick a PNG or JPEG, set its size (25–300%, fit or fill), then click **apply to game**.
The image is converted to a 24-bit BMP at the original splash's resolution and written over
`Ravage\Content\Splash\Splash.bmp`, keeping the same file name. This only works while the intro mod is on.
Turning the intro mod off restores the original splash.

Each time you apply a new intro or restore the original, the previous one is kept. The last 5 are listed
under **previous intros**, and **undo last change** puts the last one back.

## Dev

    npm install
    npm start       # run
    npm run dist    # build NSIS installer into dist/

## Releasing

1. Bump `version` in `package.json`.
2. Run `npm run dist`.
3. Create a GitHub release `vX.Y.Z` on `samichehade1-star/halloween-mod-manager` with
   `Halloween-Mod-Manager-Setup-X.Y.Z.exe` (dashed name, as in `latest.yml`) and `dist/latest.yml`.
