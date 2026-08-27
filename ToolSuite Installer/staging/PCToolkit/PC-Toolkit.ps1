# ==================================================================
#  PC Toolkit — Xbox / Microsoft Store repair + credential & security
#  cleanup, single-window GUI with one button per action.
# ==================================================================

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ------------------------------------------------------------------
# Self-elevate to Administrator
# ------------------------------------------------------------------
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell.exe -Verb RunAs -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", $PSCommandPath
    )
    exit
}

$ErrorActionPreference = 'SilentlyContinue'

# ==================================================================
# UI
# ==================================================================
$form = New-Object System.Windows.Forms.Form
$form.Text = "PC Toolkit"
$form.Size = New-Object System.Drawing.Size(560, 720)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedSingle"
$form.MaximizeBox = $false

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Multiline = $true
$logBox.ScrollBars = "Vertical"
$logBox.ReadOnly = $true
$logBox.Font = New-Object System.Drawing.Font("Consolas", 9)
$logBox.Location = New-Object System.Drawing.Point(10, 500)
$logBox.Size = New-Object System.Drawing.Size(524, 170)
$logBox.Anchor = "Top,Bottom,Left,Right"

function Write-Log($text, $color = "Black") {
    $logBox.AppendText("$text`r`n")
    $logBox.SelectionStart = $logBox.Text.Length
    $logBox.ScrollToCaret()
    [System.Windows.Forms.Application]::DoEvents()
}

function Confirm-Action($message) {
    $result = [System.Windows.Forms.MessageBox]::Show($message, "Confirm", "YesNo", "Warning")
    return $result -eq "Yes"
}

function Remove-FolderSafe($Path) {
    if (Test-Path $Path) {
        try { Remove-Item -Recurse -Force -ErrorAction Stop $Path; Write-Log "  Removed: $Path" }
        catch { Write-Log "  Skipped (in use): $Path" }
    }
}

function Remove-RegistryKeySafe($Key) {
    if (Test-Path $Key) {
        try { Remove-Item $Key -Recurse -Force -ErrorAction Stop; Write-Log "  Removed key: $Key" }
        catch { Write-Log "  Skipped: $Key" }
    }
}

function Get-CurrentSid { (whoami /user /fo table /nh).Trim().Split()[-1] }

function Run-Action($name, [scriptblock]$action) {
    $form.Cursor = "WaitCursor"
    Write-Log "`r`n=== $name ==="
    try { & $action } catch { Write-Log "  ERROR: $_" }
    Write-Log "=== Done ==="
    $form.Cursor = "Default"
}

# ==================================================================
# ACTIONS
# ==================================================================

function Action-ResetStoreCache {
    Run-Action "Reset Microsoft Store Cache" {
        Write-Log "Running WSReset..."
        Start-Process "WSReset.exe" -Wait
    }
}

function Action-ReinstallStore {
    Run-Action "Reinstall / Re-register Microsoft Store" {
        $pkg = Get-AppxPackage -AllUsers Microsoft.WindowsStore
        if ($pkg) {
            foreach ($p in $pkg) {
                Write-Log "Re-registering $($p.PackageFullName)..."
                Add-AppxPackage -DisableDevelopmentMode -Register "$($p.InstallLocation)\AppXManifest.xml"
            }
            Write-Log "Microsoft Store re-registered."
        } else {
            Write-Log "Store package not found for this user, attempting to re-provision from Windows image..."
            Get-AppxProvisionedPackage -Online | Where-Object DisplayName -eq "Microsoft.WindowsStore" | ForEach-Object {
                Add-AppxProvisionedPackage -Online -PackagePath $_.PackagePath -SkipLicense
            }
        }
    }
}

function Action-RepairXboxApp {
    Run-Action "Repair Xbox App" {
        Get-Process -Name "XboxApp" -ErrorAction SilentlyContinue | Stop-Process -Force
        Get-AppxPackage Microsoft.XboxApp -AllUsers | Reset-AppxPackage
        Write-Log "Xbox App reset."
    }
}

function Action-RepairGamingServices {
    Run-Action "Repair Gaming Services" {
        Get-Process -Name "GamingServices" -ErrorAction SilentlyContinue | Stop-Process -Force
        Get-AppxPackage Microsoft.GamingServices -AllUsers | Reset-AppxPackage
        Write-Log "Gaming Services reset."
    }
}

function Action-RepairGameBar {
    Run-Action "Repair Game Bar / Xbox Overlay" {
        Get-Process -Name "GameBar" -ErrorAction SilentlyContinue | Stop-Process -Force
        Get-AppxPackage Microsoft.XboxGamingOverlay -AllUsers | Reset-AppxPackage
        Write-Log "Game Bar / Overlay reset."
    }
}

function Action-OpenWindowsUpdate {
    Run-Action "Open Windows Update" {
        Start-Process "ms-settings:windowsupdate"
    }
}

function Action-ClearMSCredentials {
    if (-not (Confirm-Action "Remove saved Microsoft/Xbox credentials from Credential Manager?")) { return }
    Run-Action "Clear Microsoft/Xbox Credentials" {
        cmdkey /list | Select-String "Target:" | ForEach-Object {
            if ($_ -match "Target:\s*(.+)") {
                $target = $Matches[1].Trim()
                if ($target -match "microsoft|xbl|xbox|live|auth|msa") {
                    cmdkey /delete:$target | Out-Null
                    Write-Log "  Deleted credential: $target"
                }
            }
        }
    }
}

function Action-ClearAllCredentials {
    if (-not (Confirm-Action "Remove ALL saved Windows credentials (every app/site), not just Microsoft? This cannot be undone.")) { return }
    Run-Action "Clear ALL Saved Credentials" {
        cmdkey /list | Select-String "Target:" | ForEach-Object {
            if ($_ -match "Target:\s*(.+)") {
                $target = $Matches[1].Trim()
                cmdkey /delete:$target | Out-Null
                Write-Log "  Deleted credential: $target"
            }
        }
    }
}

function Action-ClearStoreCache {
    Run-Action "Clear Microsoft Store Cache Folders" {
        Get-ChildItem "$env:LOCALAPPDATA\Packages" -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match "^Microsoft\.WindowsStore_" } |
            ForEach-Object {
                Remove-FolderSafe "$($_.FullName)\LocalCache"
                Remove-FolderSafe "$($_.FullName)\LocalState"
            }
    }
}

function Action-ClearXboxCache {
    Run-Action "Clear Xbox Cache Folders" {
        Get-ChildItem "$env:LOCALAPPDATA\Packages" -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match "^Microsoft\.(XboxIdentityProvider|XboxApp|GamingApp|GamingServices|XboxGamingOverlay)_" } |
            ForEach-Object {
                Remove-FolderSafe "$($_.FullName)\AC"
                Remove-FolderSafe "$($_.FullName)\LocalCache"
                Remove-FolderSafe "$($_.FullName)\LocalState"
            }
        Remove-FolderSafe "$env:LOCALAPPDATA\Microsoft\TokenBroker"
        Remove-FolderSafe "$env:LOCALAPPDATA\Microsoft\IdentityCache"
    }
}

function Action-ClearWebCredentials {
    if (-not (Confirm-Action "Remove saved Microsoft/Xbox entries from the Web Credentials vault?")) { return }
    Run-Action "Clear Web Credentials" {
        try {
            $vault = New-Object -ComObject "Microsoft.Vault.Vault"
            $web = $vault.GetVaults() | Where-Object { $_.Name -eq "Web Credentials" }
            if ($web) {
                $store = $vault.OpenVault($web.VaultID)
                $targets = "xbox","xsts","passport","msa","login.live","microsoft"
                foreach ($item in $store.GetItems()) {
                    if ($targets | Where-Object { $item.Resource.ToLower().Contains($_) }) {
                        Write-Log "  Deleted web credential: $($item.Resource)"
                        $store.Remove($item)
                    }
                }
            } else {
                Write-Log "  No Web Credentials vault found."
            }
        } catch { Write-Log "  Web credential vault not accessible: $_" }
    }
}

function Action-ClearEventLogs {
    if (-not (Confirm-Action "Clear all Windows Event Logs? This removes system/application history.")) { return }
    Run-Action "Clear Windows Event Logs" {
        foreach ($log in wevtutil.exe el) { wevtutil.exe cl "$log" 2>$null }
        Write-Log "  All event logs cleared."
    }
}

function Action-ClearActivityHistory {
    if (-not (Confirm-Action "Clear local activity history (ShellBags, MRU lists, UserAssist, AppCompatCache, BAM, mount points)?")) { return }
    Run-Action "Clear Activity History" {
        Remove-RegistryKeySafe "HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\BagMRU"
        Remove-RegistryKeySafe "HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\Bags"
        Remove-RegistryKeySafe "HKCU:\Software\Microsoft\Windows\Shell\BagMRU"
        Remove-RegistryKeySafe "HKCU:\Software\Microsoft\Windows\Shell\Bags"
        Remove-Item "HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache" -ErrorAction SilentlyContinue
        Remove-Item "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\RunMRU" -ErrorAction SilentlyContinue
        Remove-RegistryKeySafe "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\ComDlg32\OpenSavePidlMRU"
        Remove-RegistryKeySafe "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\ComDlg32\LastVisitedPidlMRU"
        Remove-RegistryKeySafe "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist"
        Remove-Item "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\AppCompatCache" -Recurse -Force -ErrorAction SilentlyContinue
        $sid = Get-CurrentSid
        Remove-RegistryKeySafe "Registry::HKEY_USERS\$sid\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Compatibility Assistant\Store"
        Remove-Item "HKLM:\SYSTEM\CurrentControlSet\Services\bam\UserSettings\$sid" -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item "Registry::HKEY_USERS\$sid\Software\Microsoft\Windows\CurrentVersion\Explorer\MountPoints2" -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item "$env:APPDATA\Microsoft\Windows\Recent\*" -Recurse -Force -ErrorAction SilentlyContinue
        Write-Log "  Activity history cleared."
    }
}

function Action-ClearPrefetch {
    Run-Action "Clear Prefetch & Minidump" {
        Remove-Item "$env:SystemRoot\Prefetch\*.pf" -Force -ErrorAction SilentlyContinue
        Remove-Item "$env:SystemRoot\Minidump\*" -Recurse -Force -ErrorAction SilentlyContinue
        Write-Log "  Prefetch and Minidump cleared."
    }
}

function Action-FullSecurityRefresh {
    if (-not (Confirm-Action "Run the FULL security refresh: event logs, activity history, and prefetch/minidump. Continue?")) { return }
    Action-ClearEventLogsInternal
    Action-ClearActivityHistoryInternal
    Action-ClearPrefetch
}
# Internal (non-confirming) wrappers used only by Full Security Refresh, since the
# outer confirmation above already covers them.
function Action-ClearEventLogsInternal {
    Run-Action "Clear Windows Event Logs" {
        foreach ($log in wevtutil.exe el) { wevtutil.exe cl "$log" 2>$null }
        Write-Log "  All event logs cleared."
    }
}
function Action-ClearActivityHistoryInternal {
    Run-Action "Clear Activity History" {
        Remove-RegistryKeySafe "HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\BagMRU"
        Remove-RegistryKeySafe "HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\Bags"
        Remove-RegistryKeySafe "HKCU:\Software\Microsoft\Windows\Shell\BagMRU"
        Remove-RegistryKeySafe "HKCU:\Software\Microsoft\Windows\Shell\Bags"
        Remove-Item "HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache" -ErrorAction SilentlyContinue
        Remove-Item "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\RunMRU" -ErrorAction SilentlyContinue
        Remove-RegistryKeySafe "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\ComDlg32\OpenSavePidlMRU"
        Remove-RegistryKeySafe "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\ComDlg32\LastVisitedPidlMRU"
        Remove-RegistryKeySafe "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist"
        Remove-Item "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\AppCompatCache" -Recurse -Force -ErrorAction SilentlyContinue
        $sid = Get-CurrentSid
        Remove-RegistryKeySafe "Registry::HKEY_USERS\$sid\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Compatibility Assistant\Store"
        Remove-Item "HKLM:\SYSTEM\CurrentControlSet\Services\bam\UserSettings\$sid" -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item "Registry::HKEY_USERS\$sid\Software\Microsoft\Windows\CurrentVersion\Explorer\MountPoints2" -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item "$env:APPDATA\Microsoft\Windows\Recent\*" -Recurse -Force -ErrorAction SilentlyContinue
        Write-Log "  Activity history cleared."
    }
}

# ==================================================================
# LAYOUT — group boxes with one button per action
# ==================================================================
function New-ActionButton($parent, $text, $x, $y, [scriptblock]$onClick) {
    $btn = New-Object System.Windows.Forms.Button
    $btn.Text = $text
    $btn.Location = New-Object System.Drawing.Point($x, $y)
    $btn.Size = New-Object System.Drawing.Size(250, 30)
    $btn.Add_Click($onClick)
    $parent.Controls.Add($btn)
    return $btn
}

$grpRepair = New-Object System.Windows.Forms.GroupBox
$grpRepair.Text = "Repair"
$grpRepair.Location = New-Object System.Drawing.Point(10, 10)
$grpRepair.Size = New-Object System.Drawing.Size(524, 190)
$form.Controls.Add($grpRepair)

New-ActionButton $grpRepair "Reset Store Cache (WSReset)" 15 25 { Action-ResetStoreCache }
New-ActionButton $grpRepair "Reinstall Microsoft Store" 265 25 { Action-ReinstallStore }
New-ActionButton $grpRepair "Repair Xbox App" 15 60 { Action-RepairXboxApp }
New-ActionButton $grpRepair "Repair Gaming Services" 265 60 { Action-RepairGamingServices }
New-ActionButton $grpRepair "Repair Game Bar / Overlay" 15 95 { Action-RepairGameBar }
New-ActionButton $grpRepair "Open Windows Update" 265 95 { Action-OpenWindowsUpdate }

$grpCreds = New-Object System.Windows.Forms.GroupBox
$grpCreds.Text = "Credentials && Cache"
$grpCreds.Location = New-Object System.Drawing.Point(10, 210)
$grpCreds.Size = New-Object System.Drawing.Size(524, 155)
$form.Controls.Add($grpCreds)

New-ActionButton $grpCreds "Clear Microsoft/Xbox Credentials" 15 25 { Action-ClearMSCredentials }
New-ActionButton $grpCreds "Clear ALL Saved Credentials" 265 25 { Action-ClearAllCredentials }
New-ActionButton $grpCreds "Clear Store Cache Folders" 15 60 { Action-ClearStoreCache }
New-ActionButton $grpCreds "Clear Xbox Cache Folders" 265 60 { Action-ClearXboxCache }
New-ActionButton $grpCreds "Clear Web Credentials (Vault)" 15 95 { Action-ClearWebCredentials }

$grpSecurity = New-Object System.Windows.Forms.GroupBox
$grpSecurity.Text = "Security Refresh"
$grpSecurity.Location = New-Object System.Drawing.Point(10, 375)
$grpSecurity.Size = New-Object System.Drawing.Size(524, 115)
$form.Controls.Add($grpSecurity)

New-ActionButton $grpSecurity "Clear Event Logs" 15 25 { Action-ClearEventLogs }
New-ActionButton $grpSecurity "Clear Activity History" 265 25 { Action-ClearActivityHistory }
New-ActionButton $grpSecurity "Clear Prefetch / Minidump" 15 60 { Action-ClearPrefetch }
New-ActionButton $grpSecurity "Full Security Refresh (all 3)" 265 60 { Action-FullSecurityRefresh }

$form.Controls.Add($logBox)
Write-Log "Ready. Choose an action above."

[System.Windows.Forms.Application]::Run($form)
