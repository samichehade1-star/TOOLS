#Requires AutoHotkey v2.0
#SingleInstance Force
#Include OCR.ahk
#Include lib\WebView2\WebView2.ahk
Persistent

; NOTE: this used to force-elevate (run as admin) as a precaution against Halloween.exe possibly
; running elevated and UIPI blocking input into it. Removed because admin elevation breaks WebView2
; rendering entirely (Chromium's sandboxed renderer can't draw into a higher-integrity parent
; window - confirmed directly: identical code rendered fine unelevated, blank when elevated).
; Game-input delivery doesn't actually depend on this - it was never confirmed necessary, and the
; real input-delivery fixes since then (tab-in/SendEvent) don't need it either. If key-sending
; stops working without elevation, that's the signal elevation really was load-bearing - tell me.

; =====================================================================
;  SAMI - Auto Queue
;  Three independent features, each its own on/off checkbox + gear-icon settings:
;   - AUTO QUEUE     - match summary bar (Escape, wait, Enter) + lobby icon row (Enter)
;   - KILLER         - presses a key when a calibrated screen pixel matches (start-of-match ability)
;   - MONKEY FINDER  - reads all 5 lobby names; if none match your filters, leaves and re-queues
;  None of this has been tested against the real game end-to-end - verify live and report back.
; =====================================================================

TARGET_PROCESS := "Halloween.exe"

; bump this on every release pushed to UPDATE_REPO - CheckForUpdateOnce() compares it against the
; latest GitHub release tag there to decide whether to show the update prompt.
APP_VERSION := "1.3.0"
UPDATE_REPO := "samichehade1-star/sami-auto-queue"
UPDATE_ASSET_NAME := "SAMIAutoQueue.zip"

SETTINGS_INI := A_ScriptDir "\autoqueue_settings.ini"
MATCHED_NAMES_FILE := A_ScriptDir "\matched_names.txt"
PERSISTENT_LOG_FILE := A_ScriptDir "\activity_log.txt"

DARK_BG   := "0A0A0C"
DARK_EDIT := "151518"
DARK_TEXT := "E8F4F8"
DARK_DIM  := "8A8A90"
ACCENT    := "4FD8E8"
GREEN     := "5FBF6B"
RED       := "E05C5C"
UI_DIR    := A_ScriptDir "\ui"

; all 5 name boxes in the lobby (killer + 4 civilians), as fractions of the game window's client
; area - just the bold username line in each row, top to bottom in the roster
NAME_BOXES := [
    {label: "Killer",     x1: 0.09, y1: 0.285, x2: 0.30, y2: 0.322},
    {label: "Civilian 1", x1: 0.09, y1: 0.424, x2: 0.30, y2: 0.471},
    {label: "Civilian 2", x1: 0.09, y1: 0.508, x2: 0.30, y2: 0.550},
    {label: "Civilian 3", x1: 0.09, y1: 0.591, x2: 0.30, y2: 0.633},
    {label: "Civilian 4", x1: 0.09, y1: 0.669, x2: 0.30, y2: 0.715},
]
; the "LOBBY" header text, top-left - used as a gate so the name boxes are only trusted on this exact screen
LOBBY_HEADER_BOX := {x1: 0.02, y1: 0.025, x2: 0.09, y2: 0.07}
; generously-sized, screen-centered box for "ERROR" / "NETWORK ERROR!" popups (account locked,
; connection timed out, etc). Not calibrated against a specific screenshot like the other boxes -
; these dialogs are centered modals, so a wide central box catches the title regardless of exact
; dialog size.
ERROR_DIALOG_BOX := {x1: 0.25, y1: 0.28, x2: 0.75, y2: 0.58}
; game-launch screens - confirmed against real screenshots at 1920x1080: the splash screen's
; "Press [Enter]" prompt, and the title screen's "Login" button (with "Offline" beneath it).
STARTUP_PRESS_BOX := {x1: 0.46, y1: 0.68, x2: 0.56, y2: 0.76}
LOGIN_SCREEN_BOX  := {x1: 0.46, y1: 0.66, x2: 0.56, y2: 0.78}

global queueOn := (IniRead(SETTINGS_INI, "settings", "queueon", "0") = "1")
global killerOn := (IniRead(SETTINGS_INI, "settings", "killeron", "0") = "1")
global monkeyOn := (IniRead(SETTINGS_INI, "settings", "monkeyon", "0") = "1")
global voiceOn := (IniRead(SETTINGS_INI, "settings", "voiceon", "0") = "1")
global masterRunning := false   ; START/STOP - gates whether anything scans at all, separate from
                                 ; which features are selected via their toggles
global activityLog := ""

global readyKey        := IniRead(SETTINGS_INI, "settings", "readykey", "!k")
global toggleHotkey    := IniRead(SETTINGS_INI, "settings", "togglehotkey", "F9")
global registeredToggle := ""
global queueCooldownSec := IniRead(SETTINGS_INI, "settings", "queuecooldown", "10") + 0
global lastQueueAction := 0

global monkeyFilters := IniRead(SETTINGS_INI, "settings", "monkeyfilters", "")
global lastCapturedNames := ["", "", "", "", ""]
global pendingNames := ["", "", "", "", ""]
global pendingCounts := [0, 0, 0, 0, 0]
global monkeyDecided := false
global lobbyIdleTimeoutSec := IniRead(SETTINGS_INI, "settings", "lobbyidletimeout", "60") + 0
global lobbyFirstSeenAt := 0

global killerPressCount := 0  ; resets to 0 each launch - not persisted, just this session's count

; streamer mode - a fully transparent, click-through, top-right HUD showing the kill counter,
; deliberately NOT excluded from screen capture (unlike mainGui/logGui) so it actually shows up on
; stream. OBS note: this is a normal window, not a DirectX overlay hook - OBS's "Game Capture"
; source needs "Capture third-party overlays" enabled to see it, or use Display/Window Capture.
global streamerMode := (IniRead(SETTINGS_INI, "settings", "streamermode", "0") = "1")
global killerHudGui := 0, killerHudTxt := 0

; voice soundboard - fires through Voicemod (or similar) once Monkey Finder decides to stay in a
; match (covers both "filter actually matched" and "no filter configured", since those share the
; same stay branch already). Open-mic only: slot 1 plays immediately; slots 2-5 each wait their own
; delay after the PREVIOUS sound before playing - an empty hotkey means that slot is unused.
; Push-to-talk was tried (several ways: SendEvent, SendInput, single hold, continuously
; re-asserted hold) and dropped - every synthetic key-hold behaved like a brief tap in Voicemod even
; though physically holding the key worked perfectly, consistent with push-to-talk software
; distinguishing real hardware input from any form of injected input.
global voiceSoundSlots := [
    {hotkey: IniRead(SETTINGS_INI, "settings", "sound1key", ""), delayMs: 0},
    {hotkey: IniRead(SETTINGS_INI, "settings", "sound2key", ""), delayMs: IniRead(SETTINGS_INI, "settings", "sound2delay", "800") + 0},
    {hotkey: IniRead(SETTINGS_INI, "settings", "sound3key", ""), delayMs: IniRead(SETTINGS_INI, "settings", "sound3delay", "800") + 0},
    {hotkey: IniRead(SETTINGS_INI, "settings", "sound4key", ""), delayMs: IniRead(SETTINGS_INI, "settings", "sound4delay", "800") + 0},
    {hotkey: IniRead(SETTINGS_INI, "settings", "sound5key", ""), delayMs: IniRead(SETTINGS_INI, "settings", "sound5delay", "800") + 0},
]

; second, independent trigger for the same sound sequence above - fires N seconds after the Killer
; ability key is actually sent, instead of (or alongside) the Monkey Finder stay-decision trigger.
global killerSoundEnabled := (IniRead(SETTINGS_INI, "settings", "killersoundenabled", "0") = "1")
global killerSoundDelaySec := IniRead(SETTINGS_INI, "settings", "killersounddelay", "3") + 0

; cumulative, deduplicated list of full names that ever matched a filter, across all sessions -
; loaded from MATCHED_NAMES_FILE at startup so a restart doesn't lose history or re-add duplicates.
global matchedNamesSeen := Map()
if FileExist(MATCHED_NAMES_FILE) {
    for line in StrSplit(FileRead(MATCHED_NAMES_FILE, "UTF-8"), "`n", "`r") {
        line := Trim(line)
        if (line != "")
            matchedNamesSeen[line] := true
    }
}
global handsSeen := false, matchSeen := false, lobbySeen := false, errorDialogSeen := false
global matchBarConsecutive := 0
global lastErrorDialogErrLog := 0, lastErrorDialogLog := 0
global startupPressSeen := false, loginScreenSeen := false
global lastStartupErrLog := 0, lastStartupLog := 0
global lastLoginErrLog := 0, lastLoginLog := 0
global lastErrLog := 0
global lastMonkeyErrLog := 0
global lastGateLog := 0
global lastNoWinLog := 0
global lastMatchBarErrLog := 0, lastMatchBarLog := 0
global lastLobbyErrLog := 0, lastLobbyLog := 0

; crash recovery - if Halloween.exe disappears after we've already seen it running once this session,
; relaunch it via the Visenya loader (a ReShade-based accessibility tool the user confirmed is from a
; trusted source) and bring the game back automatically. The loader's own exe filename has two
; zero-width-space characters spliced into it (U+200B, between "Hall" and "oween") and its process/
; window name randomizes on every single launch, so it can't be found by name - everything here is
; driven by fixed, pre-recorded screen coordinates instead (confirmed consistent across multiple runs,
; same monitor/resolution). User's explicit standing instruction: click OK on any prompt that appears
; during this whole flow, don't stop to ask.
global haveSeenHalloweenRunning := false
global crashRecoveryInProgress := false
global lastCrashRecoveryAttempt := 0
VISENYA_LAUNCHER_DIR := "C:\Users\Sami1\Desktop\Hax\Halloween"
VISENYA_OK_BTN := {x: 1036, y: 602}       ; "update available" confirmation dialog's OK button
VISENYA_LAUNCH_BTN := {x: 1158, y: 698}   ; the loader's own "> Launch" control
; the loader's status line (reads Idle -> Please wait... -> Waiting for Halloween...), measured via
; UI Automation BoundingRectangle - generously wide since "Waiting for Halloween..." is much longer
; than "Idle" and this is a plain OCR box, not a resize-aware control.
VISENYA_STATUS_BOX := {x1: 733, y1: 685, x2: 1130, y2: 710}
STEAM_APP_ID := "3219630"

; ability icon - calibrated by clicking it live on screen (fraction of the game window) + its exact color
global abilityX := IniRead(SETTINGS_INI, "settings", "abilityx", "0") + 0
global abilityY := IniRead(SETTINGS_INI, "settings", "abilityy", "0") + 0
global abilityColor := IniRead(SETTINGS_INI, "settings", "abilitycolor", "")
global abilityTolerance := IniRead(SETTINGS_INI, "settings", "abilitytolerance", "20") + 0
global pickingPixel := false
global lastUserHwnd := 0

global mainGui, wv
global toggleHk, keyHk, pixelStatusTxt, tolEdit, queueCooldownEdit, filterEdit, wmNameTxt, wmLogEdit
global soundHkCtrls, soundDelayCtrls
global streamerCheckbox
global killerSoundCheckbox, killerSoundDelayEdit
global logGui := 0, logEditCtl := 0
global updateAvailable := false, updateVersionStr := "", updateDownloadUrl := ""
global dragActive := false, dragStartMouseX := 0, dragStartMouseY := 0, dragStartWinX := 0, dragStartWinY := 0

; ---------------------------------------------------------------- UI (WebView2) ----
; The dashboard is a real HTML/CSS page (ui\dashboard.html) rendered via WebView2, not native AHK
; controls - native Gui positioning kept producing overlapping/broken layouts. AHK still does 100%
; of the automation; the page just displays state and calls back into AHK for every action, via
; a host object exposed as `ahk` in the page's JS.
; IMPORTANT: this setup must run at the top level, NOT inside a function - CreateControllerAsync's
; .await2() silently fails to actually attach the control when called from inside a function (found
; by direct testing: identical code works at top level, returns zero child controls from a function).
mainGui := Gui("-Caption +Border +AlwaysOnTop", "SAMI - Auto Queue")
mainGui.BackColor := "0A0A0C"
mainGui.OnEvent("Close", (*) => mainGui.Hide())
; makes this window invisible to ALL screen-capture methods (PixelGetColor/ImageSearch/OCR included -
; they all ultimately read via the same GDI/DWM capture path this blocks) while still rendering
; normally on the user's actual screen. Without this, dragging the always-on-top dashboard over the
; ability-icon pixel or lobby-name OCR zones makes detection read the dashboard's own UI instead of
; the game underneath it. Needs Windows 10 2004+; DllCall just no-ops on older builds.
DllCall("user32\SetWindowDisplayAffinity", "ptr", mainGui.Hwnd, "uint", 0x11)  ; WDA_EXCLUDEFROMCAPTURE
mainGui.OnEvent("Escape", (*) => mainGui.Hide())
mainGui.Show("w380 h446")

dllPath := A_ScriptDir "\lib\WebView2\64bit\WebView2Loader.dll"
dataDir := A_ScriptDir "\webview_data"
try {
    wvc := WebView2.CreateControllerAsync(mainGui.Hwnd, 0, dataDir, "", dllPath).await2()
    wv := wvc.CoreWebView2
    wv.AddHostObjectToScript("ahk", {
        GetStatus: GetStatusJson,
        SetQueue: SetQueueOn,
        SetKiller: SetKillerOn,
        SetMonkey: SetMonkeyOn,
        SetVoice: SetVoiceOn,
        ToggleAll: ToggleAllFeatures,
        OpenQueueSettings: OpenQueueSettings,
        OpenKillerSettings: OpenKillerSettings,
        OpenMonkeySettings: OpenMonkeySettings,
        OpenVoiceboardSettings: OpenVoiceboardSettings,
        TestNow: TestNow,
        OpenLogWindow: OpenLogWindow,
        StartDrag: StartDragMainWindow,
        MinimizeWindow: MinimizeMainWindow,
        CloseWindow: CloseMainWindow,
        GetVersion: GetAppVersion,
        StartUpdate: StartUpdateFlow
    })
    pageUrl := "file:///" StrReplace(StrReplace(UI_DIR, "\", "/"), " ", "%20") "/dashboard.html"
    wv.Navigate(pageUrl)
} catch as e {
    MsgBox("WebView2 failed to start:`n" e.Message, "SAMI - Auto Queue", "Icon!")
}

RegisterToggleHotkey(toggleHotkey)
if streamerMode {
    EnsureKillerHud()
    UpdateKillerHud()
}

A_TrayMenu.Delete()
A_TrayMenu.Add("Show window", (*) => ShowWin())
A_TrayMenu.Add()
A_TrayMenu.Add("Exit", (*) => ExitApp())
A_TrayMenu.Default := "Show window"
A_IconTip := "SAMI - Auto Queue"

; ScanLoop and MonkeyLoop used to be two independent timers (500ms/600ms), both issuing OCR calls
; against the same underlying engine - they got merged into MainLoop() below specifically because
; that setup let one starve the other out. See MainLoop's own comment for the full story.
SetTimer(MainLoop, 150)
SetTimer(UpdateActiveUserWindow, 300)
SetTimer(RefreshLogWindow, 500)
SetTimer(CheckForUpdateOnce, -3000)  ; one-shot, after the dashboard has had time to come up

; START/STOP is a separate master gate from which features are selected - toggling a feature just
; changes which one Will run once started; START/STOP changes whether anything runs at all.
ToggleAllFeatures(*) {
    global masterRunning
    masterRunning := !masterRunning
    LogMsg(masterRunning ? "Started watching." : "Stopped.")
}

GetStatusJson() {
    global queueOn, killerOn, monkeyOn, voiceOn, masterRunning, activityLog, updateAvailable, updateVersionStr, killerPressCount
    return '{"queueOn":' (queueOn ? "true" : "false")
        . ',"killerOn":' (killerOn ? "true" : "false")
        . ',"monkeyOn":' (monkeyOn ? "true" : "false")
        . ',"voiceOn":' (voiceOn ? "true" : "false")
        . ',"running":' (masterRunning ? "true" : "false")
        . ',"updateAvailable":' (updateAvailable ? "true" : "false")
        . ',"updateVersion":"' updateVersionStr '"'
        . ',"killerCount":' killerPressCount
        . ',"log":"' JsonEscape(activityLog) '"}'
}

JsonEscape(s) {
    s := StrReplace(s, "\", "\\")
    s := StrReplace(s, '"', '\"')
    s := StrReplace(s, "`r", "")
    s := StrReplace(s, "`n", "\n")
    return s
}

SetDarkTitleBar(hwnd) {
    try DllCall("dwmapi\DwmSetWindowAttribute", "ptr", hwnd, "int", 20, "int*", 1, "int", 4)
}

ShowWin() {
    global mainGui
    mainGui.Show()
}

; ------------------------------------------------------------ streamer mode HUD ----
; Deliberately NOT given the WDA_EXCLUDEFROMCAPTURE treatment that mainGui/logGui get - this one's
; whole purpose is to show up on stream, the opposite of the dashboard's goal of never contaminating
; screen-capture-based detection.
EnsureKillerHud() {
    global killerHudGui, killerHudTxt
    if killerHudGui
        return
    killerHudGui := Gui("-Caption +Border +AlwaysOnTop +ToolWindow +E0x20", "SAMI - Killer HUD")
    ; +E0x20 = WS_EX_TRANSPARENT (click-through - never intercepts mouse input over the game)
    killerHudGui.BackColor := "0A0A0C"
    killerHudGui.MarginX := 12
    killerHudGui.MarginY := 8
    killerHudGui.SetFont("s16 bold cFF8C1A", "Segoe UI")
    ; fixed width generous enough for up to 3-digit counts ("MONKEYS KILLED: 999") so the window
    ; never needs to resize as the number grows. A plain AutoSize-at-creation approach was tried
    ; first and left the number clipped off entirely as soon as it got longer than "0" - the
    ; control's pixel width was locked in at creation time and never grew when .Text later changed
    ; to something wider, since changing .Text alone doesn't resize the control or window.
    killerHudTxt := killerHudGui.AddText("w280", "MONKEYS KILLED: 0")
    killerHudGui.Show("NoActivate")
    ; makes the background color itself invisible, leaving only the text visible - "fully
    ; transparent" as requested, not just a dark box with text in it
    WinSetTransColor("0A0A0C", "ahk_id " killerHudGui.Hwnd)
    WinGetPos(, , &w, &h, "ahk_id " killerHudGui.Hwnd)
    killerHudGui.Move(A_ScreenWidth - w - 24, 24)
}

UpdateKillerHud() {
    global streamerMode, killerHudGui, killerHudTxt, killerPressCount
    if (!streamerMode || !killerHudGui)
        return
    try killerHudTxt.Text := "MONKEYS KILLED: " (killerPressCount * 4)
}

; the window is borderless (-Caption), so dragging has to be done manually. Two approaches were
; tried and failed before this one:
;   1. Posting WM_NCLBUTTONDOWN/HTCAPTION to simulate grabbing the title bar - does nothing,
;      because WebView2's own mouse capture inside the page swallows it.
;   2. Tracking pointer deltas in JS (e.screenX/screenY) and calling into AHK to WinMove on every
;      pointermove - caused runaway feedback: moving the window changes the coordinate frame
;      Chromium reports screenX/Y relative to, so each move amplified the next one exponentially.
; This version has JS only kick off the drag; AHK polls the real OS cursor position directly
; (GetCursorPos, not anything WebView2-reported) on a timer until the mouse button is released.
StartDragMainWindow(*) {
    global mainGui, dragStartMouseX, dragStartMouseY, dragStartWinX, dragStartWinY, dragActive
    GetCursorScreenXY(&mx, &my)
    WinGetPos(&wx, &wy, , , "ahk_id " mainGui.Hwnd)
    dragStartMouseX := mx, dragStartMouseY := my
    dragStartWinX := wx, dragStartWinY := wy
    dragActive := true
    SetTimer(DragTick, 15)
}

DragTick() {
    global mainGui, dragStartMouseX, dragStartMouseY, dragStartWinX, dragStartWinY, dragActive
    if !dragActive || !GetKeyState("LButton", "P") {
        dragActive := false
        SetTimer(DragTick, 0)
        return
    }
    GetCursorScreenXY(&mx, &my)
    WinMove(dragStartWinX + (mx - dragStartMouseX), dragStartWinY + (my - dragStartMouseY), , , "ahk_id " mainGui.Hwnd)
}

GetCursorScreenXY(&mx, &my) {
    pt := Buffer(8)
    DllCall("GetCursorPos", "ptr", pt)
    mx := NumGet(pt, 0, "int")
    my := NumGet(pt, 4, "int")
}

MinimizeMainWindow(*) {
    global mainGui
    WinMinimize("ahk_id " mainGui.Hwnd)
}

; closing just hides the window (same as the old title-bar X) - the tray icon's "Show window"
; brings it back; "Exit" on the tray menu is the only thing that actually ends the script.
CloseMainWindow(*) {
    global mainGui
    mainGui.Hide()
}

; ------------------------------------------------------------ auto-update ----
; Same pattern as the rest of Sami's tools (see TOOLS repo): a small public "release mirror" repo
; per app, checked via the GitHub Releases API. tag_name > APP_VERSION means there's an update;
; the zip asset gets downloaded and expanded over this install directory by a detached .bat (the
; running exe can't overwrite itself, so a helper script waits for this PID to exit, extracts,
; relaunches, then deletes itself - same trick used in the Tile Auto-Presser source).
GetAppVersion() {
    global APP_VERSION
    return APP_VERSION
}

ParseVersionParts(v) {
    v := RegExReplace(v, "^[vV]")
    parts := []
    for p in StrSplit(v, ".") {
        digits := RegExReplace(p, "[^\d]", "")
        parts.Push(digits = "" ? 0 : Integer(digits))
    }
    return parts
}

VersionIsNewer(candidate, current) {
    a := ParseVersionParts(candidate), b := ParseVersionParts(current)
    len := Max(a.Length, b.Length)
    Loop len {
        av := A_Index <= a.Length ? a[A_Index] : 0
        bv := A_Index <= b.Length ? b[A_Index] : 0
        if (av > bv)
            return true
        if (av < bv)
            return false
    }
    return false
}

CheckForUpdateOnce() {
    global updateAvailable, updateVersionStr, updateDownloadUrl, UPDATE_REPO, UPDATE_ASSET_NAME, APP_VERSION
    try {
        whr := ComObject("WinHttp.WinHttpRequest.5.1")
        whr.Open("GET", "https://api.github.com/repos/" UPDATE_REPO "/releases/latest", false)
        whr.SetRequestHeader("User-Agent", "SAMIAutoQueue-UpdateCheck")
        whr.SetRequestHeader("Accept", "application/vnd.github+json")
        whr.SetTimeouts(4000, 4000, 4000, 6000)
        whr.Send()
        if (whr.Status != 200)
            return
        json := whr.ResponseText
        tag := ""
        if RegExMatch(json, '"tag_name"\s*:\s*"([^"]+)"', &m)
            tag := m[1]
        if (tag = "" || !VersionIsNewer(tag, APP_VERSION))
            return
        ; the asset's own download URL ends with its filename, so this doesn't need to assume
        ; which field GitHub's JSON puts first (browser_download_url actually comes BEFORE name
        ; in the real response - a "name" ... "browser_download_url" pattern never matches)
        pattern := '"browser_download_url"\s*:\s*"([^"]*/' UPDATE_ASSET_NAME ')"'
        if !RegExMatch(json, pattern, &m2)
            return
        updateVersionStr := RegExReplace(tag, "^[vV]")
        updateDownloadUrl := StrReplace(m2[1], "\/", "/")
        updateAvailable := true
        LogMsg("Update v" updateVersionStr " is available (currently v" APP_VERSION ").")
    } catch as e {
        ; silent - a failed/offline check should never interrupt normal use of the tool
    }
}

StartUpdateFlow(*) {
    global updateAvailable, updateVersionStr, updateDownloadUrl, APP_VERSION
    if !updateAvailable
        return
    result := MsgBox("Update v" updateVersionStr " is available (you're on v" APP_VERSION ").`n`nUpdate now? The app will restart.", "SAMI - Auto Queue", "YesNo Icon!")
    if (result != "Yes")
        return
    try {
        ApplyUpdate(updateDownloadUrl)
    } catch as e {
        MsgBox("Update failed: " e.Message, "SAMI - Auto Queue", "Icon!")
    }
}

ApplyUpdate(url) {
    if !A_IsCompiled
        throw Error("Auto-update only works from the compiled .exe, not the raw .ahk script.")
    tempZip := A_Temp "\sami_auto_queue_update.zip"
    whr := ComObject("WinHttp.WinHttpRequest.5.1")
    whr.Open("GET", url, false)
    whr.SetRequestHeader("User-Agent", "SAMIAutoQueue-UpdateCheck")
    whr.SetTimeouts(4000, 4000, 4000, 30000)
    whr.Send()
    if (whr.Status != 200)
        throw Error("Download failed: HTTP " whr.Status)

    stream := ComObject("ADODB.Stream")
    stream.Type := 1  ; binary
    stream.Open()
    stream.Write(whr.ResponseBody)
    try FileDelete(tempZip)
    stream.SaveToFile(tempZip, 2)  ; 2 = overwrite
    stream.Close()

    installDir := A_ScriptDir
    exePath := A_ScriptFullPath
    pid := DllCall("GetCurrentProcessId", "uint")
    Q := Chr(34)
    batPath := A_Temp "\sami_auto_queue_update.bat"
    lines := []
    lines.Push("@echo off")
    lines.Push(":wait")
    lines.Push("tasklist /fi " Q "PID eq " pid Q " | find " Q pid Q " >nul")
    lines.Push("if not errorlevel 1 (")
    lines.Push("    timeout /t 1 /nobreak >nul")
    lines.Push("    goto wait")
    lines.Push(")")
    lines.Push("powershell -NoProfile -Command " Q "Expand-Archive -LiteralPath '" tempZip "' -DestinationPath '" installDir "' -Force" Q)
    lines.Push("del " Q tempZip Q)
    lines.Push("start " Q Q " " Q exePath Q)
    lines.Push("del " Q "%~f0" Q)
    batContent := ""
    for line in lines
        batContent .= line "`r`n"
    try FileDelete(batPath)
    FileAppend(batContent, batPath, "UTF-8")

    Run('"' batPath '"', , "Hide")
    ExitApp()
}

; ------------------------------------------------------------ popout log window ----
OpenLogWindow(*) {
    global mainGui, DARK_BG, DARK_EDIT, DARK_TEXT, ACCENT, activityLog, logGui, logEditCtl
    if (logGui) {
        try logEditCtl.Value := activityLog
        logGui.Show()
        return
    }
    logGui := Gui("-Caption +Border +AlwaysOnTop +Owner" mainGui.Hwnd, "SAMI - Activity Log")
    logGui.BackColor := DARK_BG
    ; same reasoning as mainGui - without this, leaving the log open over the game means the
    ; error-dialog OCR box can end up reading the log window's OWN text instead of the game (its
    ; text always contains the word "Error", which guaranteed a false-positive and fired a
    ; spurious Enter into the game - seen directly in a real log capture).
    DllCall("user32\SetWindowDisplayAffinity", "ptr", logGui.Hwnd, "uint", 0x11)  ; WDA_EXCLUDEFROMCAPTURE
    logGui.MarginX := 10
    logGui.MarginY := 10
    logGui.OnEvent("Escape", (*) => logGui.Hide())

    logGui.SetFont("s10 bold c" ACCENT, "Segoe UI")
    logGui.AddText("w560 Center", "ACTIVITY LOG")

    logGui.SetFont("s9 c" DARK_TEXT, "Consolas")
    logEditCtl := logGui.AddEdit("w560 h380 y+8 ReadOnly VScroll -Wrap", activityLog)
    logEditCtl.Opt("+Background" DARK_EDIT)

    logGui.SetFont("s9 norm c" DARK_TEXT, "Segoe UI")
    closeBtn := logGui.AddButton("w560 y+8", "Close")
    closeBtn.OnEvent("Click", (*) => logGui.Hide())

    logGui.Show()
}

RefreshLogWindow() {
    global logGui, logEditCtl, activityLog
    if !logGui
        return
    if !DllCall("IsWindowVisible", "ptr", logGui.Hwnd)
        return
    try logEditCtl.Value := activityLog
}

; ------------------------------------------------------------ feature toggles ----
SetQueueOn(v) {
    global queueOn, SETTINGS_INI, matchSeen, lobbySeen
    queueOn := v
    IniWrite(v ? 1 : 0, SETTINGS_INI, "settings", "queueon")
    if v
        matchSeen := false, lobbySeen := false
    LogMsg(v ? "Auto Queue: on." : "Auto Queue: off.")
}

SetKillerOn(v) {
    global killerOn, SETTINGS_INI, handsSeen
    killerOn := v
    IniWrite(v ? 1 : 0, SETTINGS_INI, "settings", "killeron")
    if v
        handsSeen := false
    LogMsg(v ? "Killer: on." : "Killer: off.")
}

SetMonkeyOn(v) {
    global monkeyOn, SETTINGS_INI, lastCapturedNames, pendingNames, pendingCounts, monkeyDecided
    monkeyOn := v
    IniWrite(v ? 1 : 0, SETTINGS_INI, "settings", "monkeyon")
    if v {
        lastCapturedNames := ["", "", "", "", ""]
        pendingNames := ["", "", "", "", ""]
        pendingCounts := [0, 0, 0, 0, 0]
        monkeyDecided := false
    }
    LogMsg(v ? "Monkey Finder: on." : "Monkey Finder: off.")
}

SetVoiceOn(v) {
    global voiceOn, SETTINGS_INI
    voiceOn := v
    IniWrite(v ? 1 : 0, SETTINGS_INI, "settings", "voiceon")
    LogMsg(v ? "Voice soundboard: on." : "Voice soundboard: off.")
}

ToggleFromHotkey(*) {
    ToggleAllFeatures()
}

; ------------------------------------------------------------ gear settings popups ----
OpenQueueSettings(*) {
    global mainGui, DARK_BG, DARK_EDIT, DARK_TEXT, DARK_DIM, ACCENT, toggleHotkey, queueCooldownSec
    global toggleHk, queueCooldownEdit
    g := Gui("+AlwaysOnTop +Owner" mainGui.Hwnd, "AUTO QUEUE - settings")
    g.BackColor := DARK_BG
    SetDarkTitleBar(g.Hwnd)
    g.MarginX := 14
    g.MarginY := 12

    g.SetFont("s9 bold c" ACCENT, "Segoe UI")
    g.AddText("xm ym w320", "START / STOP HOTKEY")
    g.SetFont("s10 norm c" DARK_TEXT, "Segoe UI")
    toggleHk := g.AddHotkey("xm y+4 w150", toggleHotkey)
    saveToggleBtn := g.AddButton("x+8 yp w130", "Save hotkey")
    saveToggleBtn.OnEvent("Click", (*) => SaveToggleHotkey())

    g.SetFont("s9 bold c" ACCENT, "Segoe UI")
    g.AddText("xm y+16 w320", "WAIT BEFORE ACTING AGAIN (seconds)")
    g.SetFont("s8 c" DARK_DIM, "Segoe UI")
    g.AddText("xm y+2 w320", "After Escape/Enter or a lobby confirm fires, ignore that screen for at least this long. Stops it from double-firing and cancelling a queue you just joined.")
    g.SetFont("s10 norm c" DARK_TEXT, "Segoe UI")
    queueCooldownEdit := g.AddEdit("xm y+6 w80 Background" DARK_EDIT " c" DARK_TEXT, String(queueCooldownSec))
    saveCooldownBtn := g.AddButton("x+8 yp w130", "Save")
    saveCooldownBtn.OnEvent("Click", (*) => SaveQueueCooldown())

    g.OnEvent("Close", (*) => g.Destroy())
    g.Show()
}

SaveToggleHotkey() {
    global toggleHk, toggleHotkey, SETTINGS_INI
    v := toggleHk.Value
    toggleHotkey := v
    IniWrite(toggleHotkey, SETTINGS_INI, "settings", "togglehotkey")
    RegisterToggleHotkey(toggleHotkey)
    LogMsg((v = "") ? "Start/stop hotkey cleared." : "Start/stop hotkey set to " PrettyKey(v) ".")
}

SaveQueueCooldown() {
    global queueCooldownEdit, queueCooldownSec, SETTINGS_INI
    v := Integer(queueCooldownEdit.Value)
    if (v < 0) {
        MsgBox("Enter 0 or more seconds.", "SAMI - Auto Queue", "Icon!")
        return
    }
    queueCooldownSec := v
    IniWrite(queueCooldownSec, SETTINGS_INI, "settings", "queuecooldown")
    LogMsg("Auto Queue cooldown set to " queueCooldownSec "s.")
}

RegisterToggleHotkey(spec) {
    global registeredToggle
    if (registeredToggle != "") {
        try Hotkey(registeredToggle, "Off")
        registeredToggle := ""
    }
    if (spec = "")
        return
    try {
        Hotkey(spec, ToggleFromHotkey, "On")
        registeredToggle := spec
    } catch as e {
        LogMsg("Couldn't bind '" spec "' - it may be reserved. (" e.Message ")")
    }
}

OpenKillerSettings(*) {
    global mainGui, DARK_BG, DARK_EDIT, DARK_TEXT, DARK_DIM, ACCENT, readyKey, abilityTolerance, streamerMode
    global keyHk, pixelStatusTxt, tolEdit, streamerCheckbox
    g := Gui("+AlwaysOnTop +Owner" mainGui.Hwnd, "KILLER - settings")
    g.BackColor := DARK_BG
    SetDarkTitleBar(g.Hwnd)
    g.MarginX := 14
    g.MarginY := 12

    g.SetFont("s9 bold c" ACCENT, "Segoe UI")
    g.AddText("xm ym w320", "ABILITY KEY   -   sent when the pixel below is matched")
    g.SetFont("s10 norm c" DARK_TEXT, "Segoe UI")
    keyHk := g.AddHotkey("xm y+4 w150", readyKey)
    saveKeyBtn := g.AddButton("x+8 yp w130", "Save key")
    saveKeyBtn.OnEvent("Click", (*) => SaveKey())

    g.SetFont("s9 bold c" ACCENT, "Segoe UI")
    g.AddText("xm y+16 w320", "ABILITY ICON PIXEL")
    g.SetFont("s9 c" DARK_DIM, "Segoe UI")
    pixelStatusTxt := g.AddText("xm y+4 w320", PixelStatusText())
    g.SetFont("s10 norm c" DARK_TEXT, "Segoe UI")
    pickBtn := g.AddButton("xm y+6 w190", "Pick pixel on screen...")
    pickBtn.OnEvent("Click", (*) => PickPixel())
    g.AddText("x+10 yp+6 w30", "Tol:")
    tolEdit := g.AddEdit("x+2 yp-6 w50 Background" DARK_EDIT " c" DARK_TEXT, String(abilityTolerance))
    saveTolBtn := g.AddButton("x+8 yp w80", "Save")
    saveTolBtn.OnEvent("Click", (*) => SaveTolerance())

    g.SetFont("s9 bold c" ACCENT, "Segoe UI")
    g.AddText("xm y+16 w320", "STREAMER MODE")
    g.SetFont("s8 c" DARK_DIM, "Segoe UI")
    g.AddText("xm y+2 w320", "Shows a transparent kill counter in the top-right corner of the screen. Unlike the dashboard, this IS visible to screen capture so it shows on stream. For OBS Game Capture specifically, enable 'Capture third-party overlays' - otherwise use Display/Window Capture.")
    g.SetFont("s10 norm c" DARK_TEXT, "Segoe UI")
    streamerCheckbox := g.AddCheckbox("xm y+6 w250", "Show kill counter overlay")
    streamerCheckbox.Value := streamerMode
    streamerCheckbox.OnEvent("Click", (*) => SaveStreamerMode())

    g.OnEvent("Close", (*) => g.Destroy())
    g.Show()
}

SaveStreamerMode() {
    global streamerCheckbox, streamerMode, SETTINGS_INI, killerHudGui
    streamerMode := streamerCheckbox.Value
    IniWrite(streamerMode ? 1 : 0, SETTINGS_INI, "settings", "streamermode")
    if streamerMode {
        EnsureKillerHud()
        UpdateKillerHud()
        killerHudGui.Show("NoActivate")
    } else if killerHudGui {
        killerHudGui.Hide()
    }
    LogMsg("Streamer mode: " (streamerMode ? "on." : "off."))
}

SaveKey() {
    global keyHk, readyKey, SETTINGS_INI
    v := keyHk.Value
    if (v = "") {
        MsgBox("Pick a key first.", "SAMI - Auto Queue", "Icon!")
        return
    }
    readyKey := v
    IniWrite(readyKey, SETTINGS_INI, "settings", "readykey")
    LogMsg("Ability key set to " PrettyKey(readyKey) ".")
}

SaveTolerance() {
    global tolEdit, abilityTolerance, SETTINGS_INI
    v := Integer(tolEdit.Value)
    if (v < 0 || v > 255) {
        MsgBox("Tolerance should be between 0 and 255.", "SAMI - Auto Queue", "Icon!")
        return
    }
    abilityTolerance := v
    IniWrite(abilityTolerance, SETTINGS_INI, "settings", "abilitytolerance")
    LogMsg("Tolerance set to " abilityTolerance ".")
}

OpenMonkeySettings(*) {
    global mainGui, DARK_BG, DARK_EDIT, DARK_TEXT, DARK_DIM, ACCENT, monkeyFilters, lobbyIdleTimeoutSec
    global filterEdit, wmNameTxt, wmLogEdit, idleTimeoutEdit
    g := Gui("+AlwaysOnTop +Owner" mainGui.Hwnd, "MONKEY FINDER - settings")
    g.BackColor := DARK_BG
    SetDarkTitleBar(g.Hwnd)
    g.MarginX := 14
    g.MarginY := 12

    g.SetFont("s9 bold c" ACCENT, "Segoe UI")
    g.AddText("xm ym w400", "STAY-IN-MATCH FILTERS")
    g.SetFont("s8 c" DARK_DIM, "Segoe UI")
    g.AddText("xm y+2 w400", "Words to look for in any of the 5 lobby names - separate multiple with a space. If any name contains any filter word once all 5 are known, it stays; if none match, it leaves and re-queues. Leave blank to never auto-leave.")
    g.SetFont("s10 norm c" DARK_TEXT, "Segoe UI")
    filterEdit := g.AddEdit("xm y+6 w400 Background" DARK_EDIT " c" DARK_TEXT, monkeyFilters)
    saveFilterBtn := g.AddButton("xm y+6 w192", "Save filters")
    saveFilterBtn.OnEvent("Click", (*) => SaveMonkeyFilters())
    exportNamesBtn := g.AddButton("x+8 yp w200", "Export matched names")
    exportNamesBtn.OnEvent("Click", (*) => ExportMatchedNames())

    g.SetFont("s9 bold c" ACCENT, "Segoe UI")
    g.AddText("xm y+16 w400", "LOBBY IDLE TIMEOUT (seconds)")
    g.SetFont("s8 c" DARK_DIM, "Segoe UI")
    g.AddText("xm y+2 w400", "If the lobby sits here this long (players not readying up), leave and re-queue regardless of the filter result. 0 disables this.")
    g.SetFont("s10 norm c" DARK_TEXT, "Segoe UI")
    idleTimeoutEdit := g.AddEdit("xm y+6 w80 Background" DARK_EDIT " c" DARK_TEXT, String(lobbyIdleTimeoutSec))
    saveIdleBtn := g.AddButton("x+8 yp w130", "Save")
    saveIdleBtn.OnEvent("Click", (*) => SaveIdleTimeout())

    g.SetFont("s9 bold c" ACCENT, "Segoe UI")
    g.AddText("xm y+16 w400", "LAST SEEN")
    g.SetFont("s10 norm c" DARK_TEXT, "Segoe UI")
    wmNameTxt := g.AddText("xm y+4 w400 h90", BuildNameSummary())

    g.SetFont("s9 bold c" ACCENT, "Segoe UI")
    g.AddText("xm y+4 w400", "RECORDINGS")
    g.SetFont("s9 norm c" DARK_TEXT, "Segoe UI")
    wmLogEdit := g.AddEdit("xm y+4 w400 h190 ReadOnly -Wrap VScroll Background" DARK_EDIT " c" DARK_TEXT)

    g.OnEvent("Close", (*) => g.Destroy())
    g.Show()
}

SaveMonkeyFilters() {
    global filterEdit, monkeyFilters, SETTINGS_INI
    monkeyFilters := Trim(filterEdit.Value)
    IniWrite(monkeyFilters, SETTINGS_INI, "settings", "monkeyfilters")
    LogMsg("Monkey Finder filters set to: " (monkeyFilters = "" ? "(none - won't auto-leave)" : monkeyFilters))
}

ExportMatchedNames() {
    global matchedNamesSeen, MATCHED_NAMES_FILE
    if (matchedNamesSeen.Count = 0) {
        MsgBox("No matched names recorded yet - this fills in as filter matches happen.", "SAMI - Auto Queue", "Icon!")
        return
    }
    savePath := FileSelect("S16", "matched_names.txt", "Export matched names", "Text files (*.txt)")
    if (savePath = "")
        return
    if !InStr(savePath, ".")
        savePath .= ".txt"
    try {
        FileCopy(MATCHED_NAMES_FILE, savePath, true)
        LogMsg("Exported " matchedNamesSeen.Count " matched name(s) to " savePath ".")
    } catch as e {
        MsgBox("Export failed: " e.Message, "SAMI - Auto Queue", "Icon!")
    }
}

; ------------------------------------------------------------ voice soundboard settings ----
; Open-mic only - push-to-talk was tried several ways (see the note by voiceSoundSlots above) and
; never worked reliably, since Voicemod/Windows treats synthetic key holds differently from a real
; physical hold no matter how the hold was injected. No PTT option here anymore as a result.
OpenVoiceboardSettings(*) {
    global mainGui, DARK_BG, DARK_EDIT, DARK_TEXT, DARK_DIM, ACCENT, voiceSoundSlots, killerSoundEnabled, killerSoundDelaySec
    global soundHkCtrls, soundDelayCtrls, killerSoundCheckbox, killerSoundDelayEdit
    g := Gui("+AlwaysOnTop +Owner" mainGui.Hwnd, "VOICE SOUNDBOARD - settings")
    g.BackColor := DARK_BG
    SetDarkTitleBar(g.Hwnd)
    g.MarginX := 14
    g.MarginY := 12

    g.SetFont("s9 bold c" ACCENT, "Segoe UI")
    g.AddText("xm ym w400", "SOUNDS (VOICEMOD HOTKEYS, OPEN MIC ONLY)")
    g.SetFont("s8 c" DARK_DIM, "Segoe UI")
    g.AddText("xm y+2 w400", "Sound 1 plays immediately; each sound after that waits its own delay after the previous one. Leave a hotkey blank to skip that slot.")

    soundHkCtrls := [], soundDelayCtrls := [""]  ; index 1 unused - slot 1 has no delay field
    g.SetFont("s9 norm c" DARK_TEXT, "Segoe UI")
    Loop 5 {
        i := A_Index
        label := (i = 1) ? "Sound 1 (first):" : "Sound " i ":"
        g.AddText("xm y+8 w110", label)
        hk := g.AddHotkey("x+4 yp-3 w110", voiceSoundSlots[i].hotkey)
        soundHkCtrls.Push(hk)
        if (i > 1) {
            g.AddText("x+10 yp+3 w60", "Delay (ms):")
            de := g.AddEdit("x+4 yp-3 w60 Background" DARK_EDIT " c" DARK_TEXT, String(voiceSoundSlots[i].delayMs))
            soundDelayCtrls.Push(de)
        }
    }

    g.SetFont("s9 bold c" ACCENT, "Segoe UI")
    g.AddText("xm y+16 w400", "PLAY AFTER KILLER ABILITY")
    g.SetFont("s8 c" DARK_DIM, "Segoe UI")
    g.AddText("xm y+2 w400", "Separately from the lobby trigger above, also play the same sound sequence a set delay after the Killer ability key is actually sent.")
    g.SetFont("s10 norm c" DARK_TEXT, "Segoe UI")
    killerSoundCheckbox := g.AddCheckbox("xm y+6 w220", "Also play after Killer ability fires")
    killerSoundCheckbox.Value := killerSoundEnabled
    g.AddText("x+10 yp+3 w90", "Delay (sec):")
    killerSoundDelayEdit := g.AddEdit("x+4 yp-3 w50 Background" DARK_EDIT " c" DARK_TEXT, String(killerSoundDelaySec))

    saveBtn := g.AddButton("xm y+16 w200", "Save")
    saveBtn.OnEvent("Click", (*) => SaveVoiceboardSettings())

    g.OnEvent("Close", (*) => g.Destroy())
    g.Show()
}

SaveVoiceboardSettings() {
    global soundHkCtrls, soundDelayCtrls, voiceSoundSlots, SETTINGS_INI
    global killerSoundCheckbox, killerSoundDelayEdit, killerSoundEnabled, killerSoundDelaySec
    killerSoundEnabled := killerSoundCheckbox.Value
    killerSoundDelaySec := Max(0, Integer(killerSoundDelayEdit.Value))
    IniWrite(killerSoundEnabled ? 1 : 0, SETTINGS_INI, "settings", "killersoundenabled")
    IniWrite(killerSoundDelaySec, SETTINGS_INI, "settings", "killersounddelay")
    Loop 5 {
        i := A_Index
        voiceSoundSlots[i].hotkey := soundHkCtrls[i].Value
        IniWrite(voiceSoundSlots[i].hotkey, SETTINGS_INI, "settings", "sound" i "key")
        if (i > 1) {
            v := Integer(soundDelayCtrls[i].Value)
            if (v < 0)
                v := 0
            voiceSoundSlots[i].delayMs := v
            IniWrite(v, SETTINGS_INI, "settings", "sound" i "delay")
        }
    }
    configured := 0
    for slot in voiceSoundSlots
        if (Trim(slot.hotkey) != "")
            configured++
    LogMsg("Voice soundboard settings saved: " configured " sound(s) configured.")
}

SaveIdleTimeout() {
    global idleTimeoutEdit, lobbyIdleTimeoutSec, SETTINGS_INI
    v := Integer(idleTimeoutEdit.Value)
    if (v < 0) {
        MsgBox("Enter 0 or more seconds.", "SAMI - Auto Queue", "Icon!")
        return
    }
    lobbyIdleTimeoutSec := v
    IniWrite(lobbyIdleTimeoutSec, SETTINGS_INI, "settings", "lobbyidletimeout")
    LogMsg("Lobby idle timeout set to " (lobbyIdleTimeoutSec = 0 ? "disabled" : lobbyIdleTimeoutSec "s") ".")
}

BuildNameSummary() {
    global lastCapturedNames, NAME_BOXES
    summary := ""
    for i, box in NAME_BOXES
        summary .= box.label ": " (lastCapturedNames[i] = "" ? "(none yet)" : lastCapturedNames[i]) "`n"
    return Trim(summary, "`n")
}

PrettyKey(k) {
    if (k = "")
        return "(none)"
    out := ""
    if InStr(k, "^")
        out .= "Ctrl + "
    if InStr(k, "+")
        out .= "Shift + "
    if InStr(k, "!")
        out .= "Alt + "
    if InStr(k, "#")
        out .= "Win + "
    base := RegExReplace(k, "[\^\+!#]")
    return out StrUpper(base)
}

; ------------------------------------------------------------ delivery: tab-in, act, tab-back-out ----
; This mirrors a confirmed-working approach seen elsewhere for this exact game: briefly activate
; Halloween.exe, send the key with SendEvent (the older keybd_event-based method - a different
; injection path than Send/SendPlay, which we'd already tried and which didn't register), then
; immediately re-activate whatever window you were actually using. Done in ~150-250ms total, so
; it reads as a quick flicker rather than actually losing your place in whatever you're tabbed to.

; continuously tracks the last real window you were using (never the game, never our own GUI) so
; we know what to switch back to after acting.
UpdateActiveUserWindow() {
    global lastUserHwnd, mainGui, TARGET_PROCESS
    try {
        active := WinExist("A")
        if !active
            return
        if (active = FindGameHwnd())
            return
        if (IsSet(mainGui) && active = mainGui.Hwnd)
            return
        style := WinGetStyle("ahk_id " active)
        if (style & 0x10000000)   ; WS_VISIBLE
            lastUserHwnd := active
    }
}

FindGameHwnd() {
    global TARGET_PROCESS
    hwnd := WinExist("ahk_exe " TARGET_PROCESS)
    if hwnd
        return hwnd
    pid := ProcessExist(TARGET_PROCESS)
    if pid {
        hwnd := WinExist("ahk_pid " pid)
        if hwnd
            return hwnd
    }
    return 0
}

; brings a window fully to the foreground - WinActivate alone can silently fail while you're
; actively using another window, so this also calls SwitchToThisWindow (the same API the taskbar
; uses), and briefly drops our own AlwaysOnTop so it isn't fighting the game for the top spot.
ActivateWindow(hwnd) {
    global mainGui
    if (!hwnd || !WinExist("ahk_id " hwnd))
        return false
    if WinActive("ahk_id " hwnd)
        return true
    try mainGui.Opt("-AlwaysOnTop")
    ; only restore if actually MINIMIZED (-1) - calling this on an already-maximized window
    ; un-maximizes it back to its smaller floating size, which is not what we want
    try {
        if WinGetMinMax("ahk_id " hwnd) = -1
            DllCall("user32\ShowWindow", "ptr", hwnd, "int", 9)   ; SW_RESTORE
    }
    DllCall("user32\SwitchToThisWindow", "ptr", hwnd, "int", 1)
    try WinActivate("ahk_id " hwnd)
    result := WinWaitActive("ahk_id " hwnd, , 1)
    try {
        if WinGetMinMax(mainGui.Hwnd) != -1
            mainGui.Opt("+AlwaysOnTop")
    }
    return result
}

RestoreUserWindow() {
    global lastUserHwnd
    if (lastUserHwnd && WinExist("ahk_id " lastUserHwnd)) {
        ActivateWindow(lastUserHwnd)
        Sleep(50)
    }
}

; Screen-reading (ImageSearch/PixelGetColor/OCR) returns a blank placeholder instead of live
; content for this game when it isn't the focused window - confirmed directly (identical 0xFFFFFF
; read twice, minutes apart, with two different capture methods). There's no way to read real
; content without focus, so this briefly flickers into the game for the scan, then back out -
; same proven tab-in/tab-out approach already used for sending keys, now used for reading too.
; Returns wasAlreadyActive - pass it to EndGameFocus() when the scan is done.
BeginGameFocus() {
    gameHwnd := FindGameHwnd()
    if !gameHwnd
        return {ok: false, wasActive: false}
    wasActive := WinActive("ahk_id " gameHwnd)
    if !wasActive {
        UpdateActiveUserWindow()
        ActivateWindow(gameHwnd)
        Sleep(60)
    }
    return {ok: true, wasActive: wasActive}
}

EndGameFocus(state) {
    if (state.ok && !state.wasActive)
        RestoreUserWindow()
}

; send a Hotkey-control-format spec ("!k", "^F1", "+Enter", ...) as real keystrokes to Halloween.exe.
SendKeySpec(spec) {
    mods := ""
    base := spec
    while (base != "" && InStr("^+!#", SubStr(base, 1, 1))) {
        mods .= SubStr(base, 1, 1)
        base := SubStr(base, 2)
    }
    modNames := []
    if InStr(mods, "^")
        modNames.Push("Ctrl")
    if InStr(mods, "!")
        modNames.Push("Alt")
    if InStr(mods, "+")
        modNames.Push("Shift")
    if InStr(mods, "#")
        modNames.Push("LWin")

    gameHwnd := FindGameHwnd()
    if !gameHwnd {
        LogMsg("Halloween.exe not found - ability key not sent.")
        return
    }
    wasAlreadyActive := WinActive("ahk_id " gameHwnd)
    if !wasAlreadyActive
        UpdateActiveUserWindow()
    ActivateWindow(gameHwnd)
    Sleep(75)
    SetKeyDelay(40, 40)
    for n in modNames
        SendEvent("{" n " down}")
    Sleep(60)
    SendEvent("{" base " down}")
    Sleep(60)
    SendEvent("{" base " up}")
    Sleep(40)
    Loop modNames.Length
        SendEvent("{" modNames[modNames.Length - A_Index + 1] " up}")
    Sleep(50)
    ; only switch anywhere if we actually had to switch INTO the game for this - if you were
    ; already in Halloween the whole time, there's nothing to restore and nowhere to go back to
    if !wasAlreadyActive
        RestoreUserWindow()
}

; sends a plain named key (Escape/Enter/etc) to the game the same way: tab in, press, tab back out.
SendGameKeyTimed(keyName) {
    gameHwnd := FindGameHwnd()
    if !gameHwnd {
        LogMsg("Halloween.exe not found - " keyName " not sent.")
        return false
    }
    wasAlreadyActive := WinActive("ahk_id " gameHwnd)
    if !wasAlreadyActive
        UpdateActiveUserWindow()
    ActivateWindow(gameHwnd)
    Sleep(75)
    SetKeyDelay(40, 40)
    SendEvent("{" keyName " down}")
    Sleep(60)
    SendEvent("{" keyName " up}")
    Sleep(50)
    if !wasAlreadyActive
        RestoreUserWindow()
    return true
}

; ------------------------------------------------------------ voice soundboard ----
; Voicemod's soundboard hotkeys are global (its own low-level keyboard hook, same as most
; push-to-talk software), so unlike game keys this deliberately does NOT tab into/out of the game
; window - sending it directly works regardless of what's focused, and tabbing away mid-match would
; be actively harmful (interrupts whatever the user is doing right when a match starts).
; open-mic only (see the note by voiceSoundSlots's declaration for why PTT was dropped entirely).
PlayVoiceboardSequence() {
    global voiceOn, voiceSoundSlots
    if !voiceOn
        return
    active := []
    for slot in voiceSoundSlots
        if (Trim(slot.hotkey) != "")
            active.Push(slot)
    if (active.Length = 0)
        return
    for slot in active {
        if (slot.delayMs > 0)
            Sleep(slot.delayMs)
        SendEvent(slot.hotkey)
    }
    LogMsg("Voice soundboard: played " active.Length " sound(s).")
}

LogMsg(m) {
    global activityLog, PERSISTENT_LOG_FILE
    line := "[" FormatTime(A_Now, "HH:mm:ss") "] " m
    activityLog .= line "`n"
    if (StrLen(activityLog) > 20000)
        activityLog := SubStr(activityLog, -15000)
    ; the in-memory log (above) is all the dashboard shows, but it's lost the moment the app
    ; restarts - which is exactly what happened mid-investigation of a real reported bug (the app
    ; had restarted, taking the only copy of the relevant log with it). This survives that.
    try FileAppend("[" FormatTime(A_Now, "yyyy-MM-dd HH:mm:ss") "] " m "`n", PERSISTENT_LOG_FILE, "UTF-8")
}

; ------------------------------------------------------------ scanning ----
GetGameRect(&gx, &gy, &gw, &gh) {
    global TARGET_PROCESS
    try {
        WinGetClientPos(&gx, &gy, &gw, &gh, "ahk_exe " TARGET_PROCESS)
        return true
    } catch {
        return false
    }
}

; Was two separate timers (ScanLoop + MonkeyLoop) fighting over the same OCR engine - each one
; issuing OCR.ahk calls, which wait via Sleep(0)/Sleep(-1) that pumps messages, so the OTHER timer
; could fire mid-call and submit a second concurrent OCR request, killing the first with "AsyncInfo
; failed...". That got "fixed" earlier with a shared ocrBusy lock making them mutually exclusive -
; but that only traded corruption for starvation: whichever timer was mid-cycle when the other
; fired caused the other to skip that tick ENTIRELY, including not even attempting its OCR calls.
; Confirmed live and directly: a lobby with a real, consistent ~10s window reliably only yielded
; 1-3 of 5 names captured before the match started - the Monkey Finder side was getting starved out
; by Auto Queue's checks a large fraction of the time, not failing to read fast enough once it ran.
; One single loop has nothing left to contend with - every check runs every single cycle, always.
MainLoop() {
    global masterRunning, queueOn, killerOn, monkeyOn, lastNoWinLog, TARGET_PROCESS
    global handsSeen, matchSeen, lobbySeen, errorDialogSeen, startupPressSeen, loginScreenSeen
    global lastMonkeyErrLog, haveSeenHalloweenRunning
    if !masterRunning || (!queueOn && !killerOn && !monkeyOn)
        return
    if !GetGameRect(&gx, &gy, &gw, &gh) {
        if (A_TickCount - lastNoWinLog > 30000) {
            LogMsg(TARGET_PROCESS " isn't running - standing by.")
            lastNoWinLog := A_TickCount
        }
        handsSeen := false, matchSeen := false, lobbySeen := false, errorDialogSeen := false
        startupPressSeen := false, loginScreenSeen := false
        CheckCrashRecovery()
        return
    }
    haveSeenHalloweenRunning := true
    if killerOn
        try DetectHands()   ; pixel-based, not OCR
    ; Monkey Finder goes first, every cycle - the lobby roster window is the most time-critical
    ; thing this script ever reacts to, and nothing should get a chance to push it back in line.
    if monkeyOn {
        try {
            CaptureNames()
        } catch as e {
            if (A_TickCount - lastMonkeyErrLog > 5000) {
                LogMsg("Monkey Finder error: " e.Message " (" e.What ", line " e.Line ")")
                lastMonkeyErrLog := A_TickCount
            }
        }
    }
    if queueOn {
        try DetectErrorDialog(gx, gy, gw, gh)
        try DetectStartupPress(gx, gy, gw, gh)
        try DetectLoginScreen(gx, gy, gw, gh)
        try DetectMatchBar(gx, gy, gw, gh)
        try DetectLobby(gx, gy, gw, gh)
    }
}

; splash screen right after launch - "Press [Enter]" to get past the title card.
DetectStartupPress(gx, gy, gw, gh) {
    global startupPressSeen, STARTUP_PRESS_BOX, lastStartupErrLog, lastStartupLog
    x1 := gx + gw * STARTUP_PRESS_BOX.x1, y1 := gy + gh * STARTUP_PRESS_BOX.y1
    x2 := gx + gw * STARTUP_PRESS_BOX.x2, y2 := gy + gh * STARTUP_PRESS_BOX.y2
    found := false
    try {
        result := OCR.FromRect(Round(x1), Round(y1), Round(x2 - x1), Round(y2 - y1), {scale: 3, grayscale: 1})
        clean := RegExReplace(StrUpper(result.Text), "[^A-Z]")
        found := FuzzyContains(clean, "PRESS", 1)
        if (A_TickCount - lastStartupLog > 4000) {
            LogMsg("Startup press-enter OCR check: read '" result.Text "' -> " (found ? "PASS" : "fail"))
            lastStartupLog := A_TickCount
        }
    } catch as e {
        if (A_TickCount - lastStartupErrLog > 5000) {
            LogMsg("Startup press-enter OCR error: " e.Message)
            lastStartupErrLog := A_TickCount
        }
    }
    if found {
        if !startupPressSeen
            startupPressSeen := ConfirmEnterDismissed(x1, y1, x2, y2, "PRESS", "Startup splash screen")
    } else {
        startupPressSeen := false
    }
}

; title screen's "Login" button (with "Offline" beneath it) - Enter activates the highlighted
; Login option, same as every other single-default-option screen this script handles.
DetectLoginScreen(gx, gy, gw, gh) {
    global loginScreenSeen, LOGIN_SCREEN_BOX, lastLoginErrLog, lastLoginLog
    x1 := gx + gw * LOGIN_SCREEN_BOX.x1, y1 := gy + gh * LOGIN_SCREEN_BOX.y1
    x2 := gx + gw * LOGIN_SCREEN_BOX.x2, y2 := gy + gh * LOGIN_SCREEN_BOX.y2
    found := false
    try {
        result := OCR.FromRect(Round(x1), Round(y1), Round(x2 - x1), Round(y2 - y1), {scale: 3, grayscale: 1})
        clean := RegExReplace(StrUpper(result.Text), "[^A-Z]")
        found := FuzzyContains(clean, "LOGIN", 1)
        if (A_TickCount - lastLoginLog > 4000) {
            LogMsg("Login screen OCR check: read '" result.Text "' -> " (found ? "PASS" : "fail"))
            lastLoginLog := A_TickCount
        }
    } catch as e {
        if (A_TickCount - lastLoginErrLog > 5000) {
            LogMsg("Login screen OCR error: " e.Message)
            lastLoginErrLog := A_TickCount
        }
    }
    if found {
        if !loginScreenSeen
            loginScreenSeen := ConfirmEnterDismissed(x1, y1, x2, y2, "LOGIN", "Login screen")
    } else {
        loginScreenSeen := false
    }
}

; "ERROR" / "NETWORK ERROR!" popups (account locked, connection timed out, etc) can show up at any
; point and just sit there blocking everything else until dismissed, so this gets checked ahead of
; the match-bar/lobby checks every cycle. Confirmed Enter dismisses the single "Okay" button, same
; as every other dialog this script handles - no mouse automation needed.
DetectErrorDialog(gx, gy, gw, gh) {
    global errorDialogSeen, ERROR_DIALOG_BOX, lastErrorDialogErrLog, lastErrorDialogLog
    x1 := gx + gw * ERROR_DIALOG_BOX.x1, y1 := gy + gh * ERROR_DIALOG_BOX.y1
    x2 := gx + gw * ERROR_DIALOG_BOX.x2, y2 := gy + gh * ERROR_DIALOG_BOX.y2
    found := false
    try {
        result := OCR.FromRect(Round(x1), Round(y1), Round(x2 - x1), Round(y2 - y1), {scale: 3, grayscale: 1})
        clean := RegExReplace(StrUpper(result.Text), "[^A-Z]")
        found := FuzzyContains(clean, "ERROR", 1)
        if (A_TickCount - lastErrorDialogLog > 4000) {
            LogMsg("Error dialog OCR check: read '" result.Text "' -> " (found ? "PASS" : "fail"))
            lastErrorDialogLog := A_TickCount
        }
    } catch as e {
        if (A_TickCount - lastErrorDialogErrLog > 5000) {
            LogMsg("Error dialog OCR error: " e.Message)
            lastErrorDialogErrLog := A_TickCount
        }
    }
    if found {
        if !errorDialogSeen
            errorDialogSeen := ConfirmEnterDismissed(x1, y1, x2, y2, "ERROR", "Error dialog")
    } else {
        errorDialogSeen := false
    }
}

; pixel-color match instead of ImageSearch - full-image matching kept failing on this icon
; (lighting/blur made it only ~80% similar, not the ~99% ImageSearch needs). A single calibrated
; pixel + color tolerance is far more forgiving of that kind of noise.
; Uses a FIXED absolute screen coordinate, not a fraction of the game window's rect recomputed
; each check - a known-working reference script for this exact game does the same, and recomputing
; from WinGetClientPos turned out to be unreliable for an unfocused window.
DetectHands() {
    global handsSeen, readyKey, abilityX, abilityY, abilityColor, abilityTolerance, killerPressCount
    global killerSoundEnabled, killerSoundDelaySec
    if (abilityColor = "" || (abilityX = 0 && abilityY = 0))
        return
    found := false
    try found := ColorClose(PixelGetColor(abilityX, abilityY, "RGB Alt"), abilityColor, abilityTolerance)
    if (found && !handsSeen) {
        SendKeySpec(readyKey)
        killerPressCount++
        try UpdateKillerHud()
        LogMsg("Ability pixel matched -> sent " PrettyKey(readyKey) ". (count: " killerPressCount ")")
        ; one-shot, deferred - NOT a blocking Sleep() here, which would stall every other check
        ; (Auto Queue, Monkey Finder) for the whole delay. PlayVoiceboardSequence takes no
        ; parameters, so it's directly usable as a SetTimer callback.
        if killerSoundEnabled
            SetTimer(PlayVoiceboardSequence, -killerSoundDelaySec * 1000)
    }
    handsSeen := found
}

ColorClose(c1, c2, tol) {
    c1 := Integer(c1), c2 := Integer("0x" . c2)
    r1 := (c1 >> 16) & 0xFF, g1 := (c1 >> 8) & 0xFF, b1 := c1 & 0xFF
    r2 := (c2 >> 16) & 0xFF, g2 := (c2 >> 8) & 0xFF, b2 := c2 & 0xFF
    return Abs(r1 - r2) <= tol && Abs(g1 - g2) <= tol && Abs(b1 - b2) <= tol
}

PixelStatusText() {
    global abilityColor, abilityX, abilityY
    if (abilityColor = "")
        return "Not calibrated yet - click the button below, then click the icon in your game."
    return "Calibrated: " abilityX "," abilityY "  color 0x" abilityColor
}

; waits for the user's next real left-click anywhere on screen, and captures that exact
; absolute screen pixel's position and color (fixed - not relative to the game window, since
; recalculating from the window rect each check turned out to be unreliable when unfocused).
; If the game's window ever moves, this needs to be re-picked.
PickPixel(*) {
    global pickingPixel
    if pickingPixel
        return
    pickingPixel := true
    LogMsg("Click the ability icon in your game now (next left-click is captured, times out in 10s)...")
    Hotkey("~LButton", OnPixelPick, "On")
    SetTimer(CancelPixelPick, -10000)
}

CancelPixelPick() {
    global pickingPixel
    if !pickingPixel
        return
    try Hotkey("~LButton", "Off")
    pickingPixel := false
    LogMsg("Pixel pick timed out - click 'Pick pixel on screen...' again to retry.")
}

OnPixelPick(*) {
    global pickingPixel, SETTINGS_INI, abilityX, abilityY, abilityColor, pixelStatusTxt
    if !pickingPixel
        return
    SetTimer(CancelPixelPick, 0)
    Hotkey("~LButton", "Off")
    pickingPixel := false
    MouseGetPos(&mx, &my)
    color := PixelGetColor(mx, my, "RGB Alt")
    abilityX := mx
    abilityY := my
    abilityColor := Format("{:06X}", color)
    IniWrite(abilityX, SETTINGS_INI, "settings", "abilityx")
    IniWrite(abilityY, SETTINGS_INI, "settings", "abilityy")
    IniWrite(abilityColor, SETTINGS_INI, "settings", "abilitycolor")
    try pixelStatusTxt.Text := PixelStatusText()
    LogMsg("Captured pixel at " mx "," my " (color 0x" abilityColor "). Will match on this from now on.")
}

; OCR-based, not ImageSearch - the match-summary bar has real text ("SUMMARY / MATCH RESULTS /
; PERSONAL") unlike the lobby icon row, and OCR against a fractional box scales with any game
; resolution, where a pixel-exact ImageSearch crop only matches the resolution it was taken at.
DetectMatchBar(gx, gy, gw, gh) {
    global matchSeen, lastQueueAction, queueCooldownSec, lastMatchBarErrLog, lastMatchBarLog, matchBarConsecutive
    x1 := gx + gw * 0.2, y1 := gy
    x2 := gx + gw * 0.8, y2 := gy + gh * 0.25
    found := false
    try {
        result := OCR.FromRect(Round(x1), Round(y1), Round(x2 - x1), Round(y2 - y1), {scale: 3, grayscale: 1})
        clean := RegExReplace(StrUpper(result.Text), "[^A-Z]")
        ; single-keyword fuzzy "SUMMARY" false-fired mid-match - confirmed live, directly in a real
        ; log: a kill-feed/HUD frame reading "...MARY T H 100%..." (the game has an NPC named "Mary
        ; Thompson") matched within edit-distance 2, since "SUMMARY" literally ends in "MARY" - any
        ; nearby name/text containing it is a near-miss by construction, not random noise, so a
        ; consecutive-reads requirement alone doesn't help (the same false text sits on screen for many
        ; consecutive polls too). Now requires a SECOND, independent keyword from the screen's own real
        ; text ("SUMMARY / MATCH RESULTS / PERSONAL" per the comment above) before acting - two
        ; unrelated short fuzzy matches landing in the same noisy HUD frame is far less likely than one.
        found := FuzzyContains(clean, "SUMMARY", 1) && (FuzzyContains(clean, "RESULTS", 1) || FuzzyContains(clean, "PERSONAL", 2))
        if (A_TickCount - lastMatchBarLog > 4000) {
            LogMsg("Match bar OCR check: read '" result.Text "' -> " (found ? "PASS" : "fail"))
            lastMatchBarLog := A_TickCount
        }
    } catch as e {
        if (A_TickCount - lastMatchBarErrLog > 5000) {
            LogMsg("Match bar OCR error: " e.Message)
            lastMatchBarErrLog := A_TickCount
        }
    }
    ; NOTE: matchSeen is only latched true once the action actually FIRES. A cooldown-suppressed
    ; sighting used to set it anyway (old: unconditional `matchSeen := found` at the end), which
    ; permanently blocked every future attempt for as long as the screen stayed on this exact menu
    ; - confirmed directly in a real log: it logged "still cooling down" exactly once, then sat on
    ; a screen reading PASS every single poll for over two minutes without ever trying again.
    ; kept as defense-in-depth alongside the two-keyword requirement above.
    if found {
        matchBarConsecutive += 1
        if (matchBarConsecutive >= 2 && !matchSeen) {
            remaining := queueCooldownSec * 1000 - (A_TickCount - lastQueueAction)
            if (remaining > 0) {
                LogMsg("Match summary bar seen, but still cooling down (" Round(remaining / 1000, 1) "s left) - not acting yet.")
            } else {
                lastQueueAction := A_TickCount
                matchSeen := PressMatchSummaryEscape(x1, y1, x2, y2)
            }
        }
    } else {
        matchBarConsecutive := 0
        matchSeen := false
    }
}

; same verify-and-retry reasoning as PressMatchmakeEnter below - a single blind Escape/Right/Enter
; sequence isn't trustworthy, so this actually checks the summary bar is gone before latching.
PressMatchSummaryEscape(x1, y1, x2, y2) {
    maxAttempts := 3
    Loop maxAttempts {
        attempt := A_Index
        LogMsg("Match summary bar seen -> Escape." (attempt > 1 ? " (retry " attempt ")" : ""))
        SendGameKeyTimed("Escape")
        Sleep(2000)
        SendGameKeyTimed("Right")
        Sleep(300)
        SendGameKeyTimed("Enter")
        LogMsg("-> Right -> Enter.")
        Sleep(700)
        stillThere := false
        try {
            result := OCR.FromRect(Round(x1), Round(y1), Round(x2 - x1), Round(y2 - y1), {scale: 3, grayscale: 1})
            clean := RegExReplace(StrUpper(result.Text), "[^A-Z]")
            stillThere := FuzzyContains(clean, "SUMMARY", 2)
        } catch {
            stillThere := false
        }
        if !stillThere
            return true
    }
    LogMsg("Match summary bar still showing after " maxAttempts " attempts - will keep trying.")
    return false
}

; OCR-based too, same reasoning as DetectMatchBar - this used to ImageSearch a pixel crop of the
; gear/party/exit icon row, but icons alone give OCR nothing to key off. The main menu this icon
; row sits on on also shows "MATCHMAKE" as plain text (confirmed against a real screenshot), so
; that's the anchor instead - same fractional box + fuzzy match approach, still resolution-proof.
DetectLobby(gx, gy, gw, gh) {
    global lobbySeen, lastQueueAction, queueCooldownSec, lastLobbyErrLog, lastLobbyLog
    x1 := gx + gw * 0.03, y1 := gy + gh * 0.44
    x2 := gx + gw * 0.20, y2 := gy + gh * 0.52
    found := false
    try {
        result := OCR.FromRect(Round(x1), Round(y1), Round(x2 - x1), Round(y2 - y1), {scale: 3, grayscale: 1})
        clean := RegExReplace(StrUpper(result.Text), "[^A-Z]")
        found := FuzzyContains(clean, "MATCHMAKE", 2)
        if (A_TickCount - lastLobbyLog > 4000) {
            LogMsg("Matchmake menu OCR check: read '" result.Text "' -> " (found ? "PASS" : "fail"))
            lastLobbyLog := A_TickCount
        }
    } catch as e {
        if (A_TickCount - lastLobbyErrLog > 5000) {
            LogMsg("Matchmake menu OCR error: " e.Message)
            lastLobbyErrLog := A_TickCount
        }
    }
    ; see the matching note in DetectMatchBar - lobbySeen only latches once the Enter actually
    ; fires, not on a cooldown-suppressed sighting. This exact bug was caught live: the real log
    ; showed one "still cooling down" line followed by over two minutes of "MATCHMAKE" reading
    ; PASS on every poll with no further action - it had latched permanently and given up.
    if found {
        if !lobbySeen {
            remaining := queueCooldownSec * 1000 - (A_TickCount - lastQueueAction)
            if (remaining > 0) {
                LogMsg("Lobby menu seen, but still cooling down (" Round(remaining / 1000, 1) "s left) - not acting yet.")
            } else {
                lastQueueAction := A_TickCount
                lobbySeen := PressMatchmakeEnter(x1, y1, x2, y2)
            }
        }
    } else {
        lobbySeen := false
    }
}

; sends Enter on the matchmake menu, then actually verifies it worked instead of assuming it did -
; confirmed live that a single blind press can just not register: the menu sat reading "MATCHMAKE"
; continuously for minutes afterward with lobbySeen latched true (since the old code assumed one
; press was enough) and no further attempt ever made. Mirrors LeaveLobbyAndRequeue's approach.
; Returns true (latch) once the menu's actually gone, false (don't latch - retry next poll) if
; every attempt here failed to move past it.
PressMatchmakeEnter(x1, y1, x2, y2) {
    maxAttempts := 3
    Loop maxAttempts {
        attempt := A_Index
        SendGameKeyTimed("Enter")
        LogMsg("Lobby menu seen -> Enter." (attempt > 1 ? " (retry " attempt ")" : ""))
        Sleep(700)
        stillThere := false
        try {
            result := OCR.FromRect(Round(x1), Round(y1), Round(x2 - x1), Round(y2 - y1), {scale: 3, grayscale: 1})
            clean := RegExReplace(StrUpper(result.Text), "[^A-Z]")
            stillThere := FuzzyContains(clean, "MATCHMAKE", 2)
        } catch {
            stillThere := false
        }
        if !stillThere
            return true
    }
    LogMsg("Matchmake menu still showing after " maxAttempts " Enter presses - will keep trying.")
    return false
}

; generic version of PressMatchmakeEnter's verify-and-retry pattern, for the three screens that
; never got this treatment (startup splash, login, error dialogs) - confirmed live that all three
; have the exact same latent bug: a single blind Enter press with no verification, latched
; permanently "already handled" on the first sighting regardless of whether it actually worked.
; Seen directly: the startup splash screen's "Press Enter" OCR read PASS continuously for minutes
; with zero further Enter presses, since the one unverified attempt had already set the seen-flag.
ConfirmEnterDismissed(x1, y1, x2, y2, keyword, label) {
    maxAttempts := 3
    Loop maxAttempts {
        attempt := A_Index
        SendGameKeyTimed("Enter")
        LogMsg(label " detected -> Enter." (attempt > 1 ? " (retry " attempt ")" : ""))
        Sleep(700)
        stillThere := false
        try {
            result := OCR.FromRect(Round(x1), Round(y1), Round(x2 - x1), Round(y2 - y1), {scale: 3, grayscale: 1})
            clean := RegExReplace(StrUpper(result.Text), "[^A-Z]")
            stillThere := FuzzyContains(clean, keyword, 1)
        } catch {
            stillThere := false
        }
        if !stillThere
            return true
    }
    LogMsg(label " still showing after " maxAttempts " Enter presses - will keep trying.")
    return false
}

; ------------------------------------------------- crash recovery (Halloween.exe watchdog) ----
; Chained via SetTimer(-delayMs) rather than Sleep() so this never blocks MainLoop for the ~20s this
; whole sequence takes - same non-blocking pattern used for the killer-triggered sound delay.

; Visenya's window runs ELEVATED (confirmed via process token check: TokenElevationType=1) while this
; script runs unelevated (elevating the whole app breaks WebView2 rendering for the dashboard - already
; established earlier in this project). Windows' UIPI silently drops synthetic mouse input from a
; lower-integrity process aimed at a higher-integrity window - confirmed live: Click() fired with no
; error, screenshot taken immediately after showed the status still stuck on "Idle", completely
; unaffected. UAC is fully disabled on this machine (EnableLUA=0, confirmed via registry), so a *RunAs
; elevation happens instantly with zero prompt - spin up the one-shot elevated click_helper.ahk instead
; of elevating the whole app.
ElevatedClick(x, y) {
    try Run('*RunAs "' A_AhkPath '" "' A_ScriptDir '\click_helper.ahk" ' x ' ' y)
}

; chains multiple clicks inside ONE elevated process - confirmed live that two separate ElevatedClick()
; calls a fixed delay apart raced against each other (Run('*RunAs ...')'s own elevation-broker latency
; ate into the gap unpredictably), silently dropping one or both clicks. pts is a flat list [x1,y1,x2,y2,...].
ElevatedClickSequence(pts*) {
    args := ""
    for v in pts
        args .= " " v
    try Run('*RunAs "' A_AhkPath '" "' A_ScriptDir '\click_helper.ahk"' args)
}

CheckCrashRecovery() {
    global haveSeenHalloweenRunning, crashRecoveryInProgress, lastCrashRecoveryAttempt, TARGET_PROCESS
    if (!haveSeenHalloweenRunning || crashRecoveryInProgress)
        return
    ; GetGameRect() failing only means no window was found RIGHT NOW - the process can legitimately be
    ; alive with no window yet (its own intro cutscene/loading screen before the main window draws).
    ; Confirmed live this was firing a false "crash recovery" cycle against a game that was still
    ; genuinely starting up. Only actually missing process counts as crashed.
    if ProcessExist(TARGET_PROCESS)
        return
    if (A_TickCount - lastCrashRecoveryAttempt < 20000)
        return
    lastCrashRecoveryAttempt := A_TickCount
    crashRecoveryInProgress := true
    LogMsg(TARGET_PROCESS " not found after previously running - starting crash recovery.")
    CrashRecoveryWaitForExit(0)
}

; GetGameRect() failing (no window) doesn't mean the process has actually exited yet - confirmed live
; that launching Visenya while Halloween.exe is still mid-shutdown makes Visenya think the game is
; still open, so it shows its own "Please do not launch Visenya while the game is open" warning INSTEAD
; of the normal Launch screen - the Launch-button click then lands on nothing useful and the whole
; sequence silently fails to ever reach "Waiting for Halloween...". Poll ProcessExist directly (not
; just the window) and give it a buffer afterward before touching Visenya at all.
CrashRecoveryWaitForExit(attempt) {
    global TARGET_PROCESS, crashRecoveryInProgress
    if ProcessExist(TARGET_PROCESS) {
        if (attempt >= 20) {
            LogMsg("Crash recovery: " TARGET_PROCESS " still has a lingering process after 20s - will retry after cooldown.")
            crashRecoveryInProgress := false
            return
        }
        SetTimer(() => CrashRecoveryWaitForExit(attempt + 1), -1000)
        return
    }
    SetTimer(CrashRecoveryLaunchVisenya, -3000)
}

CrashRecoveryLaunchVisenya() {
    global VISENYA_LAUNCHER_DIR, crashRecoveryInProgress
    ; the loader's filename has invisible characters spliced into it that don't round-trip reliably
    ; through a hardcoded Chr()-built string (confirmed: FileExist() on the Chr(0x200B)-built path
    ; returns false even though the real file exists) - a wildcard directory scan sidesteps that
    ; entirely by letting the filesystem hand back the exact on-disk name.
    launcherPath := ""
    Loop Files, VISENYA_LAUNCHER_DIR "\Visenya*.exe" {
        launcherPath := A_LoopFileFullPath
        break
    }
    if (launcherPath = "") {
        LogMsg("Crash recovery: couldn't find Visenya launcher exe in " VISENYA_LAUNCHER_DIR)
        crashRecoveryInProgress := false
        return
    }
    try {
        ; explicit WorkingDir is load-bearing - confirmed live that without it, Visenya's elevated
        ; child self-extracts its real payload into a "bin\<random>.exe" RELATIVE to the CALLER's
        ; working directory (this script's own folder, since AUTOQ is launched with its own dir as
        ; WorkingDirectory) instead of its own exe's folder. Found two stray payloads sitting in THIS
        ; script's own "bin\" folder from earlier failed cycles - that misplaced instance still shows
        ; a normal-looking "Idle" window but its clicks never actually do anything, which is why the
        ; whole sequence kept silently failing even after the click-delivery mechanism itself was fixed.
        Run('"' launcherPath '"', VISENYA_LAUNCHER_DIR)
        LogMsg("Crash recovery: started Visenya launcher.")
    } catch as e {
        LogMsg("Crash recovery: failed to start Visenya launcher - " e.Message)
        crashRecoveryInProgress := false
        return
    }
    SetTimer(() => CrashRecoveryWaitForVisenyaReady(0), -1500)
}

; a fixed 2.5s delay before clicking anything was NOT enough - confirmed live that a cold-launched
; Visenya window can still be rendering its welcome text when the click fires, so the click lands on a
; not-yet-interactive window and does nothing (status stayed "Idle" the whole time). Poll for ANY
; readable text in its status box first - same verify-before-act principle as everything else here.
CrashRecoveryWaitForVisenyaReady(attempt) {
    global VISENYA_STATUS_BOX, crashRecoveryInProgress
    ready := false
    try {
        result := OCR.FromRect(VISENYA_STATUS_BOX.x1, VISENYA_STATUS_BOX.y1, VISENYA_STATUS_BOX.x2 - VISENYA_STATUS_BOX.x1, VISENYA_STATUS_BOX.y2 - VISENYA_STATUS_BOX.y1, {scale: 3, grayscale: 1})
        ready := (Trim(result.Text) != "")
    } catch {
        ready := false
    }
    if ready {
        SetTimer(CrashRecoveryClickLaunch, -300)
        return
    }
    if (attempt >= 10) {
        LogMsg("Crash recovery: Visenya window never became readable after 10s - clicking anyway.")
        SetTimer(CrashRecoveryClickLaunch, -300)
        return
    }
    SetTimer(() => CrashRecoveryWaitForVisenyaReady(attempt + 1), -1000)
}

; clicks the "update available, download now?" dialog's OK (user's standing instruction: always click
; OK on it, harmless no-op if it isn't up) AND the Launch control, both inside one elevated process via
; ElevatedClickSequence - see its comment for why two separate ElevatedClick() calls a fixed delay apart
; is unreliable (confirmed live: raced and silently dropped the second click).
CrashRecoveryClickLaunch() {
    global VISENYA_OK_BTN, VISENYA_LAUNCH_BTN
    ElevatedClickSequence(VISENYA_OK_BTN.x, VISENYA_OK_BTN.y, VISENYA_LAUNCH_BTN.x, VISENYA_LAUNCH_BTN.y)
    LogMsg("Crash recovery: clicked Launch in Visenya.")
    SetTimer(() => CrashRecoveryPollWaiting(0), -1500)
}

; a fixed delay before launching the game is NOT good enough - confirmed live (both windows visibly
; open at once, user caught it directly) that the game can get launched before Visenya actually
; reaches its ready state, which is exactly the condition that makes Visenya show its own "please
; don't launch while the game is open" warning back at itself. Actually poll Visenya's status text via
; OCR and only proceed once it genuinely reads "Waiting for Halloween...", same verify-before-proceed
; principle as ConfirmEnterDismissed elsewhere in this script.
; Also RE-CLICKS Launch every ~6s if still stuck - confirmed live that the click can silently fail to
; register even with elevation/coordinates/timing all independently verified correct in isolation
; (suspected contention between the elevated *RunAs dispatch and this script's own 150ms MainLoop/OCR
; activity, never fully pinned down) - retrying is the same verify-and-retry principle that fixed every
; other "single unverified action" bug in this script, applied here regardless of root cause.
CrashRecoveryPollWaiting(attempt) {
    global VISENYA_STATUS_BOX, VISENYA_LAUNCH_BTN, crashRecoveryInProgress
    found := false
    try {
        result := OCR.FromRect(VISENYA_STATUS_BOX.x1, VISENYA_STATUS_BOX.y1, VISENYA_STATUS_BOX.x2 - VISENYA_STATUS_BOX.x1, VISENYA_STATUS_BOX.y2 - VISENYA_STATUS_BOX.y1, {scale: 3, grayscale: 1})
        clean := RegExReplace(StrUpper(result.Text), "[^A-Z]")
        found := FuzzyContains(clean, "WAITING", 1)
    } catch {
        found := false
    }
    if found {
        LogMsg("Crash recovery: Visenya reports 'Waiting for Halloween...'")
        SetTimer(CrashRecoveryStartGame, -300)
        return
    }
    if (attempt >= 25) {
        LogMsg("Crash recovery: Visenya never reached 'Waiting for Halloween...' after 25s - will retry after cooldown.")
        crashRecoveryInProgress := false
        return
    }
    if (attempt > 0 && Mod(attempt, 6) = 0) {
        LogMsg("Crash recovery: still not waiting after " attempt "s - re-clicking Launch.")
        ElevatedClick(VISENYA_LAUNCH_BTN.x, VISENYA_LAUNCH_BTN.y)
    }
    SetTimer(() => CrashRecoveryPollWaiting(attempt + 1), -1000)
}

CrashRecoveryStartGame() {
    global STEAM_APP_ID
    try Run("steam://rungameid/" STEAM_APP_ID)
    LogMsg("Crash recovery: sent Steam launch for app " STEAM_APP_ID ".")
    SetTimer(CrashRecoveryDismissRunningWarning, -8000)
}

; once the game is actually up, Visenya may show its own "Please do not launch Visenya while the
; game is open. OK" warning (it doesn't know the game it just launched is now running) - confirmed
; live this does NOT clear on its own, so dismiss it. UNLIKE the earlier update-dialog click, this one
; is OCR-gated first - confirmed live that blind-clicking this coordinate when the dialog ISN'T up
; lands on the live game underneath it and appears to crash/quit it, causing a runaway recovery loop.
CrashRecoveryDismissRunningWarning() {
    global VISENYA_OK_BTN, ERROR_DIALOG_BOX
    if GetGameRect(&gx, &gy, &gw, &gh) {
        x1 := gx + gw * ERROR_DIALOG_BOX.x1, y1 := gy + gh * ERROR_DIALOG_BOX.y1
        x2 := gx + gw * ERROR_DIALOG_BOX.x2, y2 := gy + gh * ERROR_DIALOG_BOX.y2
        found := false
        try {
            result := OCR.FromRect(Round(x1), Round(y1), Round(x2 - x1), Round(y2 - y1), {scale: 3, grayscale: 1})
            clean := RegExReplace(StrUpper(result.Text), "[^A-Z]")
            found := FuzzyContains(clean, "VISENYA", 1) || FuzzyContains(clean, "LAUNCH", 1)
        } catch {
            found := false
        }
        if found {
            ElevatedClick(VISENYA_OK_BTN.x, VISENYA_OK_BTN.y)
            LogMsg("Crash recovery: dismissed Visenya's 'already running' warning.")
        }
    }
    SetTimer(CrashRecoveryVerify, -500)
}

CrashRecoveryVerify() {
    global crashRecoveryInProgress, TARGET_PROCESS
    if ProcessExist(TARGET_PROCESS)
        LogMsg("Crash recovery: " TARGET_PROCESS " is back up.")
    else
        LogMsg("Crash recovery: " TARGET_PROCESS " still not running - will retry after cooldown.")
    crashRecoveryInProgress := false
}

TestNow() {
    global TARGET_PROCESS, abilityColor, abilityX, abilityY, abilityTolerance, ERROR_DIALOG_BOX, STARTUP_PRESS_BOX, LOGIN_SCREEN_BOX
    if (abilityColor = "") {
        LogMsg("TEST: ability pixel -> not calibrated yet")
    } else {
        c := PixelGetColor(abilityX, abilityY, "RGB Alt")
        found := ColorClose(c, abilityColor, abilityTolerance)
        LogMsg("TEST: ability pixel at " abilityX "," abilityY " -> " (found ? "MATCH" : "no match") " (current 0x" Format("{:06X}", c) " vs saved 0x" abilityColor ")")
    }
    if !GetGameRect(&gx, &gy, &gw, &gh) {
        LogMsg("TEST: " TARGET_PROCESS " window not found.")
        return
    }
    LogMsg("TEST: game window at " gx "," gy "  size " gw "x" gh)
    TestOcrBox("match bar", gx + gw * 0.2, gy, gx + gw * 0.8, gy + gh * 0.25, "SUMMARY")
    TestOcrBox("matchmake menu", gx + gw * 0.03, gy + gh * 0.44, gx + gw * 0.20, gy + gh * 0.52, "MATCHMAKE")
    TestOcrBox("error dialog", gx + gw * ERROR_DIALOG_BOX.x1, gy + gh * ERROR_DIALOG_BOX.y1, gx + gw * ERROR_DIALOG_BOX.x2, gy + gh * ERROR_DIALOG_BOX.y2, "ERROR")
    TestOcrBox("startup press-enter", gx + gw * STARTUP_PRESS_BOX.x1, gy + gh * STARTUP_PRESS_BOX.y1, gx + gw * STARTUP_PRESS_BOX.x2, gy + gh * STARTUP_PRESS_BOX.y2, "PRESS")
    TestOcrBox("login screen", gx + gw * LOGIN_SCREEN_BOX.x1, gy + gh * LOGIN_SCREEN_BOX.y1, gx + gw * LOGIN_SCREEN_BOX.x2, gy + gh * LOGIN_SCREEN_BOX.y2, "LOGIN")
}

; read-only check, unlike DetectMatchBar()/DetectLobby() - doesn't touch seen-state or send any
; keys, so "Test Now" can be clicked safely without risking an in-progress match getting escaped
; out of.
TestOcrBox(name, x1, y1, x2, y2, keyword) {
    try {
        result := OCR.FromRect(Round(x1), Round(y1), Round(x2 - x1), Round(y2 - y1), {scale: 3, grayscale: 1})
        clean := RegExReplace(StrUpper(result.Text), "[^A-Z]")
        found := FuzzyContains(clean, keyword, 2)
        LogMsg("TEST: " name " OCR -> read '" result.Text "' -> " (found ? "FOUND" : "not found"))
    } catch as e {
        LogMsg("TEST: " name " OCR error: " e.Message)
    }
}

; --------------------------------------------------------- monkey finder ----
CaptureNames() {
    global lastCapturedNames, pendingNames, pendingCounts, wmNameTxt, wmLogEdit, NAME_BOXES, LOBBY_HEADER_BOX, monkeyDecided
    global lobbyFirstSeenAt, lobbyIdleTimeoutSec
    if !GetGameRect(&gx, &gy, &gw, &gh)
        return
    ; gate: only trust the name boxes on the actual lobby screen - confirm the "LOBBY" header is present
    ; first, otherwise this ends up reading random gameplay HUD text whenever it overlaps a box
    hx1 := gx + gw * LOBBY_HEADER_BOX.x1, hy1 := gy + gh * LOBBY_HEADER_BOX.y1
    hx2 := gx + gw * LOBBY_HEADER_BOX.x2, hy2 := gy + gh * LOBBY_HEADER_BOX.y2
    headerResult := OCR.FromRect(Round(hx1), Round(hy1), Round(hx2 - hx1), Round(hy2 - hy1), {scale: 3, grayscale: 1})
    cleanHeader := SubStr(RegExReplace(StrUpper(headerResult.Text), "[^A-Z]"), 1, 5)
    gateOk := (cleanHeader != "" && LevenshteinDistance(cleanHeader, "LOBBY") <= 3)
    global lastGateLog
    if (A_TickCount - lastGateLog > 4000) {
        LogMsg("Monkey Finder gate check: box " Round(hx1) "," Round(hy1) " " Round(hx2 - hx1) "x" Round(hy2 - hy1) " read '" headerResult.Text "' -> " (gateOk ? "PASS" : "fail"))
        lastGateLog := A_TickCount
    }
    if !gateOk {
        ; not on the lobby screen right now - clear everything, including names already captured,
        ; so a brand new lobby (different players) can't get judged using last match's leftover roster
        if (lastCapturedNames[1] != "" || lastCapturedNames[2] != "" || lastCapturedNames[3] != "" || lastCapturedNames[4] != "" || lastCapturedNames[5] != "") {
            lastCapturedNames := ["", "", "", "", ""]
            try wmNameTxt.Text := BuildNameSummary()
        }
        pendingNames := ["", "", "", "", ""]
        pendingCounts := [0, 0, 0, 0, 0]
        monkeyDecided := false
        lobbyFirstSeenAt := 0
        return
    }

    ; idle-lobby timeout: if players aren't readying up (visible in-game as each player's row
    ; flipping color/checkmark once they're ready), the lobby can just sit here indefinitely.
    ; Bail out and re-queue after lobbyIdleTimeoutSec regardless of the filter decision - there's
    ; no point staying for a streamer/filter match if the lobby itself never actually starts.
    if (lobbyFirstSeenAt = 0)
        lobbyFirstSeenAt := A_TickCount
    else if (lobbyIdleTimeoutSec > 0 && A_TickCount - lobbyFirstSeenAt > lobbyIdleTimeoutSec * 1000) {
        LogMsg("Monkey Finder: lobby has been idle for over " lobbyIdleTimeoutSec "s - leaving and re-queuing.")
        LeaveLobbyAndRequeue(gx, gy, gw, gh)
        lobbyFirstSeenAt := 0
        return
    }
    changed := false
    for i, box in NAME_BOXES {
        x1 := gx + gw * box.x1, y1 := gy + gh * box.y1
        x2 := gx + gw * box.x2, y2 := gy + gh * box.y2
        ; upscale + grayscale before recognizing - the in-game font is small/stylized and reads much better blown up
        result := OCR.FromRect(Round(x1), Round(y1), Round(x2 - x1), Round(y2 - y1), {scale: 3, grayscale: 1})
        text := Trim(StrReplace(result.Text, "`r", ""), " `t`n")
        if (text = "" || text = lastCapturedNames[i])
            continue
        ; accept on the first clean read - lobby countdowns are often only a few seconds long, and
        ; requiring a repeat read (to filter OCR flicker) costs time we usually don't have. A wrong
        ; name here just gets corrected on the next poll anyway, since it's compared every cycle.
        pendingNames[i] := text
        pendingCounts[i] := 1
        lastCapturedNames[i] := text
        pendingNames[i] := "", pendingCounts[i] := 0
        changed := true
        label := "Recording " FormatTime(A_Now, "yyyy-MM-dd HHmmss")
        ; newest-first prepend - the old version accidentally sandwiched the ENTIRE prior log
        ; between a duplicate copy of itself on every single capture (wmLogEdit.Value appeared on
        ; both sides of the concatenation), so the box's content roughly doubled on every name
        ; read and quickly became huge enough that scrolling stopped working.
        ; the READ of wmLogEdit.Value (not just the write) has to be inside the try - this control
        ; is destroyed the moment the user closes the Monkey Finder settings popup, and reading a
        ; destroyed control's .Value throws. That exception used to escape uncaught here, aborting
        ; the rest of CaptureNames() for that cycle - including the "decide stay or leave" logic
        ; further down, which never got a chance to run. Confirmed live: a lobby gate-PASS followed
        ; immediately by this exact exception, with no "leaving and re-queuing" line ever following
        ; it, consistent with every report of a non-matching lobby just not getting left.
        try {
            newLog := label " (" box.label "):`r`n" text "`r`n`r`n" wmLogEdit.Value
            if (StrLen(newLog) > 20000)
                newLog := SubStr(newLog, 1, 15000)
            wmLogEdit.Value := newLog
        }
    }
    if changed
        try wmNameTxt.Text := BuildNameSummary()

    ; once all 5 are known, decide whether to stay or leave - only once per lobby appearance
    if !monkeyDecided {
        allKnown := true
        for nm in lastCapturedNames
            if (nm = "")
                allKnown := false
        if allKnown {
            monkeyDecided := true
            matchedNames := []
            if MonkeyFilterMatches(&matchedNames) {
                LogMsg("Monkey Finder: filter matched among the 5 names - staying in this match.")
                RecordMatchedNames(matchedNames)
                try PlayVoiceboardSequence()
            } else {
                LogMsg("Monkey Finder: no filter match among all 5 names - leaving and re-queuing.")
                LeaveLobbyAndRequeue(gx, gy, gw, gh)
            }
        }
    }
}

; fires the leave sequence, then actually checks whether it worked instead of assuming it did.
; Reported issue: something (a stray click on a name, an Enter landing on the wrong item, or
; some other popup) occasionally ate a step of the sequence mid-flight, leaving the lobby screen
; still up - so one blind attempt isn't trustworthy. This retries, with a leading Escape on each
; retry to close whatever unexpected menu might be sitting open, and gives up loudly (rather than
; silently) if it truly can't get out.
; Timing is deliberately tight: a real lobby can have only ~10s between "all 5 names known" and
; the match actually launching (names only finish OCR-reading once every slot is filled, which can
; itself eat a big chunk of that window), so every extra millisecond here is time this can't afford
; to spend double-checking. SendGameKeyTimed's own internal timing is untouched (that's proven,
; reliable input delivery) - only the inter-step/settle waits added for retry-verification are cut.
LeaveLobbyAndRequeue(gx, gy, gw, gh) {
    global monkeyDecided
    maxAttempts := 3
    Loop maxAttempts {
        attempt := A_Index
        if (attempt > 1) {
            ; closes whatever unexpected menu/popup might be open from the previous failed attempt
            SendGameKeyTimed("Escape")
            Sleep(250)
        }
        SendGameKeyTimed("Escape")
        Sleep(150)
        SendGameKeyTimed("Enter")
        Sleep(150)
        SendGameKeyTimed("Right")
        Sleep(150)
        SendGameKeyTimed("Enter")
        Sleep(700)  ; let the menu transition settle before checking what's actually on screen
        if !GetGameRect(&vgx, &vgy, &vgw, &vgh) || !IsLobbyScreenVisible(vgx, vgy, vgw, vgh) {
            if (attempt > 1)
                LogMsg("Monkey Finder: left successfully on retry " attempt ".")
            return
        }
        LogMsg("Monkey Finder: still on the lobby screen after the leave sequence (attempt " attempt "/" maxAttempts ") - something interrupted it. Retrying.")
    }
    LogMsg("Monkey Finder: couldn't leave after " maxAttempts " attempts - will try again next check.")
    monkeyDecided := false  ; let the next poll re-evaluate and retry, instead of giving up for this lobby entirely
}

; factored out of CaptureNames's own LOBBY gate check so the retry logic above can reuse it to
; verify the leave actually worked, without duplicating the OCR/fuzzy-match logic.
IsLobbyScreenVisible(gx, gy, gw, gh) {
    global LOBBY_HEADER_BOX
    hx1 := gx + gw * LOBBY_HEADER_BOX.x1, hy1 := gy + gh * LOBBY_HEADER_BOX.y1
    hx2 := gx + gw * LOBBY_HEADER_BOX.x2, hy2 := gy + gh * LOBBY_HEADER_BOX.y2
    try {
        result := OCR.FromRect(Round(hx1), Round(hy1), Round(hx2 - hx1), Round(hy2 - hy1), {scale: 3, grayscale: 1})
        clean := SubStr(RegExReplace(StrUpper(result.Text), "[^A-Z]"), 1, 5)
        return (clean != "" && LevenshteinDistance(clean, "LOBBY") <= 3)
    } catch {
        return false
    }
}

; standard edit-distance: how many single-character changes turn s1 into s2. Used so a slightly
; misread OCR result ("LODDY") can still count as a match for "LOBBY" instead of requiring perfection.
LevenshteinDistance(s1, s2) {
    len1 := StrLen(s1), len2 := StrLen(s2)
    prev := []
    Loop len2 + 1
        prev.Push(A_Index - 1)
    Loop len1 {
        i := A_Index
        cur := [i]
        Loop len2 {
            j := A_Index
            cost := (SubStr(s1, i, 1) = SubStr(s2, j, 1)) ? 0 : 1
            cur.Push(Min(prev[j + 1] + 1, cur[j] + 1, prev[j] + cost))
        }
        prev := cur
    }
    return prev[len2 + 1]
}

; true if any substring of haystack the same length as needle is within maxDist edits of it -
; lets a short OCR'd keyword (e.g. "SUMMARY") match even if it's embedded in a longer noisy read
; alongside other text/icons on the same line, and tolerates OCR misreads the same way the LOBBY
; header gate does.
FuzzyContains(haystack, needle, maxDist) {
    n := StrLen(needle), h := StrLen(haystack)
    if (h < n)
        return LevenshteinDistance(haystack, needle) <= maxDist
    Loop h - n + 1 {
        if (LevenshteinDistance(SubStr(haystack, A_Index, n), needle) <= maxDist)
            return true
    }
    return false
}

; matchedOut (if given) is filled with every one of the 5 captured names that matched any filter
; word, deduplicated - used so callers can record exactly who triggered a "stay" decision.
MonkeyFilterMatches(&matchedOut := "") {
    global monkeyFilters, lastCapturedNames
    matchedOut := []
    trimmed := Trim(monkeyFilters)
    if (trimmed = "")
        return true   ; no filters configured - default to staying, don't leave blindly
    found := false
    for f in StrSplit(trimmed, " ") {
        if (f = "")
            continue
        for nm in lastCapturedNames {
            if (nm = "" || !InStr(nm, f, false))  ; explicit case-insensitive - matches regardless of the name's or filter's casing
                continue
            found := true
            alreadyIn := false
            for existing in matchedOut
                if (existing = nm)
                    alreadyIn := true
            if !alreadyIn
                matchedOut.Push(nm)
        }
    }
    return found
}

; appends any genuinely new matched names to the cumulative on-disk list (MATCHED_NAMES_FILE),
; skipping ones already recorded in a previous match/session - this is what "Export matched names"
; in the Monkey Finder settings reads from.
RecordMatchedNames(names) {
    global matchedNamesSeen, MATCHED_NAMES_FILE
    for nm in names {
        if !matchedNamesSeen.Has(nm) {
            matchedNamesSeen[nm] := true
            try FileAppend(nm "`r`n", MATCHED_NAMES_FILE, "UTF-8")
        }
    }
}
