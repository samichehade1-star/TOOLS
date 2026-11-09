@echo off
rem Builds dist\Media Converter\ and the two release files:
rem   release\MediaConverter.zip        - the in-app update (no ffmpeg.exe, so updates are small and keep the installed ffmpeg)
rem   release\MediaConverter_Setup.exe  - the installer people download (includes ffmpeg); needs Inno Setup 6
rem Before a release: raise APP_VERSION in media_converter.py, then run this, then attach both files to a GitHub release
rem tagged v<APP_VERSION> on samichehade1-star/media-converter.
cd /d "%~dp0"
set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" (
  echo Inno Setup 6 is missing - install it: winget install JRSoftware.InnoSetup
  goto :fail
)
if not exist ffmpeg.exe (
  echo ffmpeg.exe is missing next to build.bat - copy it here first ^(winget install ffmpeg, then copy ffmpeg.exe^).
  goto :fail
)
for /f "delims=" %%v in ('py -c "import re;print(re.search(r'^APP_VERSION = .(.+?).$',open('media_converter.py',encoding='utf-8').read(),re.M).group(1))"') do set "MC_VERSION=%%v"
echo Building Media Converter %MC_VERSION%
py -m pip install -q -r requirements.txt pyinstaller || goto :fail
py -m PyInstaller --noconfirm --clean MediaConverter.spec || goto :fail
if not exist release mkdir release
del /q release\*.zip release\*.exe 2>nul
powershell -NoProfile -Command "Compress-Archive -Path 'dist\Media Converter\*' -DestinationPath 'release\MediaConverter.zip' -Force" || goto :fail
copy /y ffmpeg.exe "dist\Media Converter\ffmpeg.exe" >nul
"%ISCC%" /Q installer.iss || goto :fail
echo.
echo Done. Release files are in the release folder:
dir /b release
exit /b 0
:fail
echo.
echo BUILD FAILED
exit /b 1
