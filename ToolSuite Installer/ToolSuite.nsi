; Sami's Tool Suite - unified installer with per-app checkboxes
; Built with NSIS (Modern UI 2) - components page lets the user pick which apps to install.

!include "MUI2.nsh"

Name "Sami's Tool Suite"
OutFile "..\dist\SamiToolSuite-Setup.exe"
Unicode true
RequestExecutionLevel admin
InstallDir "$PROGRAMFILES64\Sami Tool Suite"
InstallDirRegKey HKLM "Software\SamiToolSuite" "InstallDir"
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!define MUI_ABORTWARNING
!define MUI_ICON "icons\LaunchPadX.ico"
!define MUI_UNICON "icons\LaunchPadX.ico"

;--------------------------------
; Pages

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_NOAUTOCLOSE
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

;--------------------------------
; Sections

Section "LaunchPad X" secLaunchPad
  SetOutPath "$INSTDIR\LaunchPad X"
  File /r "staging\LaunchPadX\*.*"

  CreateDirectory "$SMPROGRAMS\Sami Tool Suite"
  CreateShortcut "$SMPROGRAMS\Sami Tool Suite\LaunchPad X.lnk" "$INSTDIR\LaunchPad X\LaunchPad X.exe"
  CreateShortcut "$DESKTOP\LaunchPad X.lnk" "$INSTDIR\LaunchPad X\LaunchPad X.exe"

  WriteRegStr HKLM "Software\SamiToolSuite\LaunchPadX" "Installed" "1"
SectionEnd

Section "Diddler" secDiddler
  SetOutPath "$INSTDIR\Diddler"
  File /r "staging\Diddler\*.*"

  CreateDirectory "$SMPROGRAMS\Sami Tool Suite"
  CreateShortcut "$SMPROGRAMS\Sami Tool Suite\Diddler.lnk" "$INSTDIR\Diddler\Diddler.exe"
  CreateShortcut "$DESKTOP\Diddler.lnk" "$INSTDIR\Diddler\Diddler.exe"

  WriteRegStr HKLM "Software\SamiToolSuite\Diddler" "Installed" "1"
SectionEnd

Section "CHUB Mod Manager" secCHUB
  SetOutPath "$INSTDIR\CHUB Mod Manager"
  File /r "staging\CHUBModManager\*.*"

  CreateDirectory "$SMPROGRAMS\Sami Tool Suite"
  CreateShortcut "$SMPROGRAMS\Sami Tool Suite\CHUB Mod Manager.lnk" "$INSTDIR\CHUB Mod Manager\CHUB Mod Manager.exe"
  CreateShortcut "$DESKTOP\CHUB Mod Manager.lnk" "$INSTDIR\CHUB Mod Manager\CHUB Mod Manager.exe"

  WriteRegStr HKLM "Software\SamiToolSuite\CHUBModManager" "Installed" "1"
SectionEnd

Section "FMP Mod Manager" secFMP
  SetOutPath "$INSTDIR\FMP Mod Manager"
  File /r "staging\FMPModManager\*.*"

  CreateDirectory "$SMPROGRAMS\Sami Tool Suite"
  CreateShortcut "$SMPROGRAMS\Sami Tool Suite\FMP Mod Manager.lnk" "$INSTDIR\FMP Mod Manager\FMP Mod Manager.exe"
  CreateShortcut "$DESKTOP\FMP Mod Manager.lnk" "$INSTDIR\FMP Mod Manager\FMP Mod Manager.exe"

  WriteRegStr HKLM "Software\SamiToolSuite\FMPModManager" "Installed" "1"
SectionEnd

Section "PC Toolkit" secPCToolkit
  SetOutPath "$INSTDIR\PC Toolkit"
  File /r "staging\PCToolkit\*.*"

  CreateDirectory "$SMPROGRAMS\Sami Tool Suite"
  CreateShortcut "$SMPROGRAMS\Sami Tool Suite\PC Toolkit.lnk" "$INSTDIR\PC Toolkit\Run PC Toolkit.bat"
  CreateShortcut "$DESKTOP\PC Toolkit.lnk" "$INSTDIR\PC Toolkit\Run PC Toolkit.bat"

  WriteRegStr HKLM "Software\SamiToolSuite\PCToolkit" "Installed" "1"
SectionEnd

;--------------------------------
; Always-installed bookkeeping (uninstaller + registry)

Section "-Finish" secFinish
  WriteRegStr HKLM "Software\SamiToolSuite" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SamiToolSuite" "DisplayName" "Sami's Tool Suite"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SamiToolSuite" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SamiToolSuite" "DisplayIcon" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SamiToolSuite" "Publisher" "sami"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SamiToolSuite" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SamiToolSuite" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SamiToolSuite" "NoRepair" 1
SectionEnd

;--------------------------------
; Component descriptions

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${secLaunchPad} "LaunchPad X - universal launch pad for trainers, spoofers, bypasses and unlockers."
  !insertmacro MUI_DESCRIPTION_TEXT ${secDiddler} "Diddler - send and cancel Dead by Daylight friend requests when the in-game system won't cooperate. Requires admin rights to run."
  !insertmacro MUI_DESCRIPTION_TEXT ${secCHUB} "CHUB Mod Manager - mod manager for Dead by Daylight."
  !insertmacro MUI_DESCRIPTION_TEXT ${secFMP} "FMP Mod Manager - mod manager for Dead by Daylight."
  !insertmacro MUI_DESCRIPTION_TEXT ${secPCToolkit} "PC Toolkit - PowerShell-based system utility script."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

;--------------------------------
; Uninstaller
; Removes any/all of the subfolders + shortcuts that exist, regardless of
; which components were originally selected.

Section "Uninstall"
  RMDir /r "$INSTDIR\LaunchPad X"
  RMDir /r "$INSTDIR\Diddler"
  RMDir /r "$INSTDIR\CHUB Mod Manager"
  RMDir /r "$INSTDIR\FMP Mod Manager"
  RMDir /r "$INSTDIR\PC Toolkit"

  Delete "$SMPROGRAMS\Sami Tool Suite\LaunchPad X.lnk"
  Delete "$SMPROGRAMS\Sami Tool Suite\Diddler.lnk"
  Delete "$SMPROGRAMS\Sami Tool Suite\CHUB Mod Manager.lnk"
  Delete "$SMPROGRAMS\Sami Tool Suite\FMP Mod Manager.lnk"
  Delete "$SMPROGRAMS\Sami Tool Suite\PC Toolkit.lnk"
  RMDir "$SMPROGRAMS\Sami Tool Suite"

  Delete "$DESKTOP\LaunchPad X.lnk"
  Delete "$DESKTOP\Diddler.lnk"
  Delete "$DESKTOP\CHUB Mod Manager.lnk"
  Delete "$DESKTOP\FMP Mod Manager.lnk"
  Delete "$DESKTOP\PC Toolkit.lnk"

  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKLM "Software\SamiToolSuite"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SamiToolSuite"
SectionEnd
