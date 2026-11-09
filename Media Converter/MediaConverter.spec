# PyInstaller spec - onedir build (same reason as Tile Auto-Presser: onefile re-launches itself, and an update has to replace
# the folder contents anyway). ffmpeg.exe is NOT bundled here - build.bat copies it next to the exe for the Setup zip only,
# so update zips stay small and never touch it.
from PyInstaller.utils.hooks import collect_submodules

a = Analysis(
    ["media_converter.py"],
    datas=[("ui.html", "."), ("assets", "assets")],
    hiddenimports=collect_submodules("yt_dlp") + ["clr"],
    excludes=["tkinter"],
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="Media Converter", icon="assets/icon.ico", console=False, upx=False)
coll = COLLECT(exe, a.binaries, a.datas, name="Media Converter", upx=False)
