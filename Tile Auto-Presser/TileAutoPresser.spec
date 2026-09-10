# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

# onedir (not onefile): a onefile build's hidden parent-process/child-process
# extraction handoff is exactly the code path that trips PyInstaller's
# onefile-parent security validation when run elevated (crashes with
# "Security validation failure: failed to obtain executable path for parent
# process!" on some systems/security software, even for a completely
# legitimate launch -- see README). onedir has no such handoff -- the exe IS
# the extracted app, so that whole check never runs, regardless of
# elevation. Trade-off: ships as a folder (zipped for releases) instead of a
# single portable .exe.
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='TileAutoPresser',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='TileAutoPresser',
)
