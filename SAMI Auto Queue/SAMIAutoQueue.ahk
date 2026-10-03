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
APP_VERSION := "1.1.0"
UPDATE_REPO := "samichehade1-star/sami-auto-queue"
UPDATE_ASSET_NAME := "SAMIAutoQueue.zip"

SETTINGS_INI := A_ScriptDir "\autoqueue_settings.ini"
MATCHED_NAMES_FILE := A_ScriptDir "\matched_names.txt"

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
global lastErrorDialogErrLog := 0, lastErrorDialogLog := 0
; ScanLoop (500ms) and MonkeyLoop (600ms) are independent timers, but OCR.ahk's WaitForAsync waits
; via Sleep(0)/Sleep(-1), which pumps messages - so the OTHER timer can fire and issue its own OCR
; call WHILE one is already in flight. The OCR engine isn't built for that: a second concurrent
; RecognizeAsync kills the first one with "AsyncInfo failed with status error ..." (seen constantly
; in the log, aborting CaptureNames mid-roster and causing slow/missed name captures). This lock
; makes the two timers mutually exclusive around any OCR call so only one is ever in flight.
global ocrBusy := false
global startupPressSeen := false, loginScreenSeen := false
global lastStartupErrLog := 0, lastStartupLog := 0
global lastLoginErrLog := 0, lastLoginLog := 0
global lastErrLog := 0
global lastMonkeyErrLog := 0
global lastGateLog := 0
global lastNoWinLog := 0
global lastMatchBarErrLog := 0, lastMatchBarLog := 0
global lastLobbyErrLog := 0, lastLobbyLog := 0

; ability icon - calibrated by clicking it live on screen (fraction of the game window) + its exact color
global abilityX := IniRead(SETTINGS_INI, "settings", "abilityx", "0") + 0
global abilityY := IniRead(SETTINGS_INI, "settings", "abilityy", "0") + 0
global abilityColor := IniRead(SETTINGS_INI, "settings", "abilitycolor", "")
global abilityTolerance := IniRead(SETTINGS_INI, "settings", "abilitytolerance", "20") + 0
global pickingPixel := false
global lastUserHwnd := 0

global mainGui, wv
global toggleHk, keyHk, pixelStatusTxt, tolEdit, queueCooldownEdit, filterEdit, wmNameTxt, wmLogEdit
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
mainGui.Show("w380 h386")

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
        ToggleAll: ToggleAllFeatures,
        OpenQueueSettings: OpenQueueSettings,
        OpenKillerSettings: OpenKillerSettings,
        OpenMonkeySettings: OpenMonkeySettings,
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

A_TrayMenu.Delete()
A_TrayMenu.Add("Show window", (*) => ShowWin())
A_TrayMenu.Add()
A_TrayMenu.Add("Exit", (*) => ExitApp())
A_TrayMenu.Default := "Show window"
A_IconTip := "SAMI - Auto Queue"

SetTimer(ScanLoop, 500)
SetTimer(MonkeyLoop, 600)
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
    global queueOn, killerOn, monkeyOn, masterRunning, activityLog, updateAvailable, updateVersionStr, killerPressCount
    return '{"queueOn":' (queueOn ? "true" : "false")
        . ',"killerOn":' (killerOn ? "true" : "false")
        . ',"monkeyOn":' (monkeyOn ? "true" : "false")
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
    global mainGui, DARK_BG, DARK_EDIT, DARK_TEXT, DARK_DIM, ACCENT, readyKey, abilityTolerance
    global keyHk, pixelStatusTxt, tolEdit
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

    g.OnEvent("Close", (*) => g.Destroy())
    g.Show()
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

LogMsg(m) {
    global activityLog
    activityLog .= "[" FormatTime(A_Now, "HH:mm:ss") "] " m "`n"
    if (StrLen(activityLog) > 20000)
        activityLog := SubStr(activityLog, -15000)
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

ScanLoop() {
    global masterRunning, queueOn, killerOn, lastNoWinLog, TARGET_PROCESS, handsSeen, matchSeen, lobbySeen, errorDialogSeen
    global startupPressSeen, loginScreenSeen, ocrBusy
    if !masterRunning || (!queueOn && !killerOn)
        return
    if !GetGameRect(&gx, &gy, &gw, &gh) {
        if (A_TickCount - lastNoWinLog > 30000) {
            LogMsg(TARGET_PROCESS " isn't running - standing by.")
            lastNoWinLog := A_TickCount
        }
        handsSeen := false, matchSeen := false, lobbySeen := false, errorDialogSeen := false
        startupPressSeen := false, loginScreenSeen := false
        return
    }
    if killerOn
        try DetectHands()   ; pixel-based, not OCR - doesn't need the lock
    if queueOn && !ocrBusy {
        ocrBusy := true
        try DetectErrorDialog(gx, gy, gw, gh)
        try DetectStartupPress(gx, gy, gw, gh)
        try DetectLoginScreen(gx, gy, gw, gh)
        try DetectMatchBar(gx, gy, gw, gh)
        try DetectLobby(gx, gy, gw, gh)
        ocrBusy := false
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
    if (found && !startupPressSeen) {
        LogMsg("Startup splash screen detected -> Enter.")
        SendGameKeyTimed("Enter")
    }
    startupPressSeen := found
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
    if (found && !loginScreenSeen) {
        LogMsg("Login screen detected -> Enter.")
        SendGameKeyTimed("Enter")
    }
    loginScreenSeen := found
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
    if (found && !errorDialogSeen) {
        LogMsg("Error dialog detected (" result.Text ") -> Enter to dismiss.")
        SendGameKeyTimed("Enter")
    }
    errorDialogSeen := found
}

; pixel-color match instead of ImageSearch - full-image matching kept failing on this icon
; (lighting/blur made it only ~80% similar, not the ~99% ImageSearch needs). A single calibrated
; pixel + color tolerance is far more forgiving of that kind of noise.
; Uses a FIXED absolute screen coordinate, not a fraction of the game window's rect recomputed
; each check - a known-working reference script for this exact game does the same, and recomputing
; from WinGetClientPos turned out to be unreliable for an unfocused window.
DetectHands() {
    global handsSeen, readyKey, abilityX, abilityY, abilityColor, abilityTolerance, killerPressCount
    if (abilityColor = "" || (abilityX = 0 && abilityY = 0))
        return
    found := false
    try found := ColorClose(PixelGetColor(abilityX, abilityY, "RGB Alt"), abilityColor, abilityTolerance)
    if (found && !handsSeen) {
        SendKeySpec(readyKey)
        killerPressCount++
        LogMsg("Ability pixel matched -> sent " PrettyKey(readyKey) ". (count: " killerPressCount ")")
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
    global matchSeen, lastQueueAction, queueCooldownSec, lastMatchBarErrLog, lastMatchBarLog
    x1 := gx + gw * 0.2, y1 := gy
    x2 := gx + gw * 0.8, y2 := gy + gh * 0.25
    found := false
    try {
        result := OCR.FromRect(Round(x1), Round(y1), Round(x2 - x1), Round(y2 - y1), {scale: 3, grayscale: 1})
        clean := RegExReplace(StrUpper(result.Text), "[^A-Z]")
        found := FuzzyContains(clean, "SUMMARY", 2)
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
    if found {
        if !matchSeen {
            remaining := queueCooldownSec * 1000 - (A_TickCount - lastQueueAction)
            if (remaining > 0) {
                LogMsg("Match summary bar seen, but still cooling down (" Round(remaining / 1000, 1) "s left) - not acting yet.")
            } else {
                LogMsg("Match summary bar seen -> Escape.")
                SendGameKeyTimed("Escape")
                Sleep(2000)
                SendGameKeyTimed("Right")
                Sleep(300)
                SendGameKeyTimed("Enter")
                LogMsg("-> Right -> Enter.")
                lastQueueAction := A_TickCount
                matchSeen := true
            }
        }
    } else {
        matchSeen := false
    }
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
                LogMsg("Lobby menu seen -> Enter.")
                SendGameKeyTimed("Enter")
                lastQueueAction := A_TickCount
                lobbySeen := true
            }
        }
    } else {
        lobbySeen := false
    }
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
MonkeyLoop() {
    global masterRunning, monkeyOn, lastMonkeyErrLog, ocrBusy
    if !masterRunning || !monkeyOn || ocrBusy
        return
    ocrBusy := true
    try {
        CaptureNames()
    } catch as e {
        if (A_TickCount - lastMonkeyErrLog > 5000) {
            LogMsg("Monkey Finder error: " e.Message " (" e.What ", line " e.Line ")")
            lastMonkeyErrLog := A_TickCount
        }
    }
    ocrBusy := false
}

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
        newLog := label " (" box.label "):`r`n" text "`r`n`r`n" wmLogEdit.Value
        if (StrLen(newLog) > 20000)
            newLog := SubStr(newLog, 1, 15000)
        try wmLogEdit.Value := newLog
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
LeaveLobbyAndRequeue(gx, gy, gw, gh) {
    global monkeyDecided
    maxAttempts := 3
    Loop maxAttempts {
        attempt := A_Index
        if (attempt > 1) {
            ; closes whatever unexpected menu/popup might be open from the previous failed attempt
            SendGameKeyTimed("Escape")
            Sleep(400)
        }
        SendGameKeyTimed("Escape")
        Sleep(250)
        SendGameKeyTimed("Enter")
        Sleep(250)
        SendGameKeyTimed("Right")
        Sleep(250)
        SendGameKeyTimed("Enter")
        Sleep(1200)  ; let the menu transition settle before checking what's actually on screen
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
