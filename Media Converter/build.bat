@echo off
rem Builds dist\Media Converter\ and the two release zips:
rem   release\MediaConverter.zip        - the app update (no ffmpeg.exe, so updates are small and keep the installed ffmpeg)
rem   release\MediaConverter_Setup.zip  - first install: the same plus ffmpeg.exe
rem Before a release: raise APP_VERSION in media_converter.py, then run this, then attach both zips to a GitHub release
rem tagged v<APP_VERSION> on samichehade1-star/media-converter.
cd /d "%~dp0"
py -m pip install -q -r requirements.txt pyinstaller || goto :fail
py -m PyInstaller --noconfirm --clean MediaConverter.spec || goto :fail
if not exist ffmpeg.exe (
  echo ffmpeg.exe is missing next to build.bat - copy it here first ^(winget install ffmpeg, then copy ffmpeg.exe^).
  goto :fail
)
if not exist release mkdir release
del /q release\*.zip 2>nul
powershell -NoProfile -Command "Compress-Archive -Path 'dist\Media Converter\*' -DestinationPath 'release\MediaConverter.zip' -Force" || goto :fail
copy /y ffmpeg.exe "dist\Media Converter\ffmpeg.exe" >nul
powershell -NoProfile -Command "Compress-Archive -Path 'dist\Media Converter\*' -DestinationPath 'release\MediaConverter_Setup.zip' -Force" || goto :fail
echo.
echo Done. Release files are in the release folder:
dir /b release
exit /b 0
:fail
echo.
echo BUILD FAILED
exit /b 1
