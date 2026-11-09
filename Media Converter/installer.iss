; Inno Setup script for MediaConverter_Setup.exe - the one file people download.
; Installs per user (no admin prompt) into %LOCALAPPDATA%\Programs\Media Converter, which the in-app updater can write to.
; Built by build.bat after PyInstaller; dist\Media Converter must already contain ffmpeg.exe.
#define AppVersion GetEnv("MC_VERSION")
#if AppVersion == ""
  #define AppVersion "1.0.0"
#endif

[Setup]
AppId={{6F3C2E1A-9B4D-4E8A-A1C7-5D2E8F0B3A61}
AppName=Media Converter
AppVersion={#AppVersion}
AppVerName=Media Converter {#AppVersion}
AppPublisher=SE Visuals
AppPublisherURL=https://github.com/samichehade1-star/media-converter
AppSupportURL=https://github.com/samichehade1-star/media-converter
AppUpdatesURL=https://github.com/samichehade1-star/media-converter/releases/latest
PrivilegesRequired=lowest
DefaultDirName={autopf}\Media Converter
DefaultGroupName=Media Converter
DisableProgramGroupPage=yes
DisableDirPage=yes
OutputDir=release
OutputBaseFilename=MediaConverter_Setup
SetupIconFile=assets\icon.ico
UninstallDisplayIcon={app}\Media Converter.exe
UninstallDisplayName=Media Converter
WizardStyle=modern
Compression=lzma2/ultra64
SolidCompression=yes
CloseApplications=yes
RestartApplications=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "dist\Media Converter\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Media Converter"; Filename: "{app}\Media Converter.exe"
Name: "{autodesktop}\Media Converter"; Filename: "{app}\Media Converter.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Media Converter.exe"; Description: "Open Media Converter now"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; the self-updated download engine and the player's preview copies; the save-folder setting stays
Type: filesandordirs; Name: "{userappdata}\MediaConverter\engine"
Type: filesandordirs; Name: "{localappdata}\Temp\MediaConverterPreview"
