#Requires AutoHotkey v2.0
; one-shot elevated click helper - see ElevatedClick()/ElevatedClickSequence() in the main script for
; why this exists (UIPI blocks synthetic input from an unelevated process reaching an elevated window).
; CoordMode("Mouse","Screen") is explicit and load-bearing - confirmed live that omitting it was part
; of why earlier clicks silently did nothing even once the elevation issue was fixed.
; Accepts pairs of x y [x y ...] and clicks each in turn with a short internal Sleep between them - all
; within this ONE elevated process, not one elevated process per click. Confirmed live that chaining
; two separate *RunAs-launched processes from the unelevated parent (one click each) raced against each
; other: Run('*RunAs ...') itself has noticeable, variable elevation-broker latency, so a fixed delay
; between two external process launches wasn't reliably long enough and the second click (or both)
; silently failed to register. Doing both clicks inside one already-elevated process sidesteps that
; entirely since AHK's own Sleep() between them doesn't have that latency.
CoordMode("Mouse", "Screen")
try FileAppend("click_helper ran, A_IsAdmin=" A_IsAdmin "`n", A_ScriptDir "\runas_test.txt")
Loop A_Args.Length // 2 {
    i := (A_Index - 1) * 2 + 1
    x := A_Args[i]
    y := A_Args[i + 1]
    Click(x " " y)
    if (A_Index < A_Args.Length // 2)
        Sleep(800)
}
ExitApp()
