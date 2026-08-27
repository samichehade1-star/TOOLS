// gameDetect.js — finds every installed game across Steam, Epic Games, and
// Xbox/Microsoft Store, so the user never has to hand-locate a launch exe.
// Generalized from the DBD-only scanner used elsewhere: this walks every
// manifest it finds rather than matching one hardcoded game.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function dirExists(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

function parseAcfField(text, field) {
    const m = new RegExp(`"${field}"\\s*"([^"]+)"`, 'i').exec(text);
    return m ? m[1] : null;
}

// Best-effort "which .exe is actually the game" guesser, for platforms
// (Epic/Xbox/Ubisoft) whose own launcher protocol is the primary/reliable
// launch path — this is only a convenience fallback shown pre-filled in the
// executable field, never required. Prefers a single exe sitting right at
// the install root (the common Steam/Epic "thin stub" layout that correctly
// initializes anti-cheat/platform code, unlike the raw shipping exe several
// folders deeper), and only falls back to a shallow recursive search,
// excluding known non-game utility exes, if nothing qualifies at the root.
const EXE_EXCLUDE_PATTERN = /^(unins|setup|redist|vc_?redist|dxsetup|directx|dotnet|easyanticheat|eac|battleye|be_installer|crashreporter|crashpad|installer|vcredist|prerequisites)/i;
const EXCLUDE_DIR_PATTERN = /^(_commonredist|redistributables?|easyanticheat|battleye|installer|__installer|vc_?redist)$/i;

function listCandidateExes(dir, depth, maxDepth, results) {
    if (depth > maxDepth) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (EXCLUDE_DIR_PATTERN.test(entry.name)) continue;
            listCandidateExes(path.join(dir, entry.name), depth + 1, maxDepth, results);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe') && !EXE_EXCLUDE_PATTERN.test(entry.name)) {
            const full = path.join(dir, entry.name);
            try { results.push({ path: full, size: fs.statSync(full).size, depth }); } catch { /* skip unreadable */ }
        }
    }
}

function guessExeInInstallRoot(installRoot) {
    if (!dirExists(installRoot)) return '';
    const rootLevel = [];
    listCandidateExes(installRoot, 0, 0, rootLevel);
    if (rootLevel.length === 1) return rootLevel[0].path;
    if (rootLevel.length > 1) {
        // several stubs at the root (rare) — the largest is the best guess
        rootLevel.sort((a, b) => b.size - a.size);
        return rootLevel[0].path;
    }
    // nothing at the root — shallow recursive search, largest file wins
    const deep = [];
    listCandidateExes(installRoot, 0, 3, deep);
    if (deep.length === 0) return '';
    deep.sort((a, b) => b.size - a.size);
    return deep[0].path;
}

// --------------------------------------------------------------------- Steam
function scanSteamGames() {
    const games = [];
    const roots = ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'].filter(dirExists);
    const libraries = new Set();
    for (const root of roots) {
        if (dirExists(path.join(root, 'steamapps'))) libraries.add(root);
        const vdfPath = path.join(root, 'steamapps', 'libraryfolders.vdf');
        if (fileExists(vdfPath)) {
            try {
                const text = fs.readFileSync(vdfPath, 'utf8');
                const re = /"path"\s*"([^"]+)"/g;
                let m;
                while ((m = re.exec(text)) !== null) {
                    const p = m[1].replace(/\\\\/g, '\\');
                    if (dirExists(p)) libraries.add(p);
                }
            } catch { /* unreadable vdf, skip */ }
        }
    }
    for (const lib of libraries) {
        const steamappsDir = path.join(lib, 'steamapps');
        if (!dirExists(steamappsDir)) continue;
        let entries = [];
        try { entries = fs.readdirSync(steamappsDir); } catch { continue; }
        for (const f of entries) {
            if (!/^appmanifest_\d+\.acf$/i.test(f)) continue;
            try {
                const text = fs.readFileSync(path.join(steamappsDir, f), 'utf8');
                const appId = parseAcfField(text, 'appid');
                const name = parseAcfField(text, 'name');
                const installdir = parseAcfField(text, 'installdir');
                if (!appId || !installdir) continue;
                const installRoot = path.join(steamappsDir, 'common', installdir);
                if (!dirExists(installRoot)) continue;
                games.push({
                    platform: 'Steam',
                    id: `steam-${appId}`,
                    name: name || installdir,
                    installRoot,
                    launch: { type: 'steam', steamAppId: appId },
                });
            } catch { /* unreadable manifest, skip */ }
        }
    }
    return games;
}

// ---------------------------------------------------------------- Epic Games
function scanEpicGames() {
    const dir = 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests';
    if (!dirExists(dir)) return [];
    const games = [];
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { return []; }
    for (const f of entries) {
        if (!f.toLowerCase().endsWith('.item')) continue;
        try {
            const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            const appName = data.AppName || data.MainGameAppName;
            const displayName = data.DisplayName || appName;
            const installRoot = data.InstallLocation;
            if (!appName || !installRoot || !dirExists(installRoot)) continue;
            games.push({
                platform: 'Epic Games',
                id: `epic-${appName}`,
                name: displayName,
                installRoot,
                // the launcher's own protocol handles finding+launching the right
                // exe itself — sidesteps ever having to guess which shipping exe
                // is the real one vs. a raw Binaries/Win64 stub that skips anti-cheat.
                // exePath here is just a pre-filled convenience fallback.
                launch: { type: 'epic', epicAppName: appName, exePath: guessExeInInstallRoot(installRoot) },
            });
        } catch { /* unreadable manifest, skip */ }
    }
    return games;
}

// ------------------------------------------------------------------ Ubisoft
// Ubisoft Connect (formerly Uplay) registers each install as a normal
// Windows "uninstall" entry rather than its own manifest file — every other
// major PC game-scanning tool (Playnite etc.) reads the same registry path.
async function scanUbisoftGames() {
    const script = [
        `$paths = @(`,
        `  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',`,
        `  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'`,
        `)`,
        `foreach ($base in $paths) {`,
        `  Get-ChildItem $base -ErrorAction SilentlyContinue |`,
        `    Where-Object { $_.PSChildName -like 'Uplay Install *' } |`,
        `    ForEach-Object {`,
        `      $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue`,
        `      $id = $_.PSChildName -replace 'Uplay Install ', ''`,
        `      if ($p.DisplayName -and $p.InstallLocation) {`,
        `        Write-Output "$id|$($p.DisplayName)|$($p.InstallLocation)"`,
        `      }`,
        `    }`,
        `}`,
    ].join('\n');
    const output = await runPowerShell(script);
    const games = [];
    const seen = new Set();
    for (const line of output.split(/\r?\n/)) {
        if (!line.includes('|')) continue;
        const [id, name, installRoot] = line.split('|');
        if (!id || !name || !installRoot || !dirExists(installRoot.trim())) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        games.push({
            platform: 'Ubisoft',
            id: `ubisoft-${id}`,
            name: name.trim(),
            installRoot: installRoot.trim(),
            // Ubisoft Connect's own protocol launches the right exe itself;
            // exePath here is just a pre-filled convenience fallback
            launch: { type: 'ubisoft', ubisoftId: id, exePath: guessExeInInstallRoot(installRoot.trim()) },
        });
    }
    return games;
}

// ------------------------------------------------------------------- Roblox
// Roblox has no library/manifest of its own — the client exe lives in a
// version-stamped folder (e.g. version-abcdef123456) that changes on every
// auto-update, and old version folders are frequently left behind uncleaned
// rather than replaced in place. A path saved once would go stale the next
// time Roblox updates, so this is exported and re-run fresh at launch time
// (see main.js's launch-game handler) instead of trusting a stored exePath —
// same "the exe changes, re-detect every time" shape as the folder-scan tool
// launch method already handles for the Nyxia/Visenya trainers.
function findRobloxPlayerExe() {
    const versionsRoot = path.join(process.env.LOCALAPPDATA || '', 'Roblox', 'Versions');
    if (!dirExists(versionsRoot)) return null;
    let entries = [];
    try { entries = fs.readdirSync(versionsRoot, { withFileTypes: true }); } catch { return null; }
    const candidates = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const exePath = path.join(versionsRoot, entry.name, 'RobloxPlayerBeta.exe');
        if (fileExists(exePath)) {
            try { candidates.push({ path: exePath, mtime: fs.statSync(exePath).mtimeMs }); } catch { /* skip unreadable */ }
        }
    }
    if (candidates.length === 0) return null;
    // several version folders can coexist (old ones don't always get cleaned
    // up) — the most recently modified one is the one actually in use
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates[0].path;
}

function scanRobloxGame() {
    const exePath = findRobloxPlayerExe();
    if (!exePath) return [];
    return [{
        platform: 'Roblox',
        id: 'roblox',
        name: 'Roblox',
        installRoot: path.dirname(exePath),
        launch: { type: 'roblox' },
    }];
}

// --------------------------------------------------------- Xbox / MS Store
function listWindowsDriveRoots() {
    const drives = [];
    for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
        const root = `${String.fromCharCode(code)}:\\`;
        if (dirExists(root)) drives.push(root);
    }
    return drives;
}

function psQuoteLocal(s) { return `'${String(s).replace(/'/g, "''")}'`; }

function runPowerShell(script) {
    return new Promise((resolve) => {
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], (error, stdout) => {
            resolve(error ? '' : (stdout || ''));
        });
    });
}

async function scanXboxGames() {
    const candidateFolders = [];
    for (const drive of listWindowsDriveRoots()) {
        const root = path.join(drive, 'XboxGames');
        if (!dirExists(root)) continue;
        let entries = [];
        try { entries = fs.readdirSync(root); } catch { continue; }
        for (const entry of entries) {
            const entryPath = path.join(root, entry);
            if (dirExists(entryPath)) candidateFolders.push({ name: entry, installRoot: entryPath });
        }
    }
    if (candidateFolders.length === 0) return [];

    // cheap pass first: PackageFamilyName + InstallLocation for every appx
    // package, so the slower per-package manifest lookup below only runs for
    // the handful that actually match one of our candidate game folders.
    const listing = await runPowerShell(
        `Get-AppxPackage | ForEach-Object { "$($_.PackageFamilyName)|$($_.InstallLocation)" }`
    );
    const pkgLines = listing.split(/\r?\n/).filter(Boolean);

    const games = [];
    for (const folder of candidateFolders) {
        const match = pkgLines.find(l => l.toLowerCase().endsWith('|' + folder.installRoot.toLowerCase()));
        if (!match) {
            games.push({ platform: 'Microsoft', id: `xbox-${folder.name}`, name: folder.name, installRoot: folder.installRoot, launch: { type: 'manual' } });
            continue;
        }
        const pfn = match.split('|')[0];
        const appIdScript = [
            `try {`,
            `  $pkg = Get-AppxPackage -PackageFamilyName ${psQuoteLocal(pfn)} | Select-Object -First 1`,
            `  $manifest = Get-AppxPackageManifest $pkg`,
            `  $app = $manifest.Package.Applications.Application | Select-Object -First 1`,
            `  Write-Output $app.Id`,
            `} catch { Write-Output 'App' }`,
        ].join('\n');
        const appId = (await runPowerShell(appIdScript)).trim() || 'App';
        games.push({
            platform: 'Microsoft',
            id: `xbox-${folder.name}`,
            name: folder.name,
            installRoot: folder.installRoot,
            launch: { type: 'xbox', xboxLaunchId: `${pfn}!${appId}` },
        });
    }
    return games;
}

// ------------------------------------------------------------------ combined
async function scanInstalledGames() {
    const [steam, epic, ubisoft, roblox, xbox] = await Promise.all([
        Promise.resolve(scanSteamGames()),
        Promise.resolve(scanEpicGames()),
        scanUbisoftGames(),
        Promise.resolve(scanRobloxGame()),
        scanXboxGames(),
    ]);
    return [...steam, ...epic, ...ubisoft, ...roblox, ...xbox].sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { scanInstalledGames, scanSteamGames, scanEpicGames, scanUbisoftGames, scanRobloxGame, scanXboxGames, findRobloxPlayerExe };
