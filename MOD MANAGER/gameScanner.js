// gameScanner.js
// Finds every install of Dead by Daylight on disk across Steam, Epic Games,
// and Xbox/Microsoft Store (Game Pass), so mods can be deployed to every one
// of them at once. Pure Node (no Electron dependency) so it can be required
// and unit-tested outside the Electron runtime.

const fs = require('fs');
const os = require('os');
const path = require('path');

// --- Dead by Daylight's known identifiers on each platform ---
const DBD_CONFIG = {
    steamAppId: '381210',
    steamInstallDirName: 'Dead by Daylight',
    epicAppName: 'Dead by Daylight',
    xboxPackageName: 'DeadByDaylight',
    // relative path from an install root to the folder where base pak files
    // (and this app's renamed mod files) live
    pakFolderRelativeParts: ['DeadByDaylight', 'Content', 'Paks'],
    // maps each detected platform to the {platformCode} used in pak file names
    platformLabelForCode: {
        Steam: 'Steam',
        Epic: 'Epic Games',
        Xbox: 'Microsoft',
    },
};

function dirExists(p) {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function fileExists(p) {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}

function pakFolderFor(installRoot) {
    return path.join(installRoot, ...DBD_CONFIG.pakFolderRelativeParts);
}

/**
 * A folder existing structurally isn't enough to call it a real install —
 * stale/leftover folders (e.g. from a game that was moved to a different
 * drive, or a partial/failed install) can still have the right directory
 * shape with nothing actually in them. This checks that pakFolderPath
 * genuinely contains at least one .pak file before we trust it.
 *
 * (A stricter "must have many .pak files" version was tried and reverted —
 * modern UE5 games often load most content through .ucas/.utoc containers
 * with only a handful of actual .pak files as anchors, so a high count
 * threshold broke detection on real installs instead of just filtering
 * out empty leftovers. Duplicate/stale targets are instead handled by
 * remembering what the user has explicitly removed — see
 * dismissedTargetIds — rather than guessing from file counts.)
 */
function hasPakFiles(pakFolderPath) {
    if (!dirExists(pakFolderPath)) return false;
    try {
        return fs.readdirSync(pakFolderPath).some(f => f.toLowerCase().endsWith('.pak'));
    } catch {
        return false;
    }
}

// --------------------------------------------------------------------- //
// Steam
// --------------------------------------------------------------------- //

function defaultSteamRoots() {
    const roots = [];

    if (process.platform === 'win32') {
        try {
            // Regedit-free lookup: fall back to the two conventional install dirs.
            // (A registry read could be added via a native module if needed;
            // these defaults cover the overwhelming majority of installs.)
            roots.push('C:\\Program Files (x86)\\Steam');
            roots.push('C:\\Program Files\\Steam');
        } catch { /* ignore */ }
    } else {
        const home = os.homedir();
        roots.push(path.join(home, '.steam', 'steam'));
        roots.push(path.join(home, '.local', 'share', 'Steam'));
        roots.push(path.join(home, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam'));
    }

    return roots.filter(dirExists);
}

function parseVdfPaths(vdfText) {
    const paths = [];
    const re = /"path"\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(vdfText)) !== null) {
        paths.push(m[1].replace(/\\\\/g, '\\'));
    }
    return paths;
}

function findSteamLibraries(steamRoots) {
    const roots = steamRoots || defaultSteamRoots();
    const libraries = [];

    for (const root of roots) {
        if (dirExists(path.join(root, 'steamapps'))) {
            libraries.push(root);
        }
        const vdfPath = path.join(root, 'steamapps', 'libraryfolders.vdf');
        if (fileExists(vdfPath)) {
            try {
                const text = fs.readFileSync(vdfPath, 'utf8');
                for (const p of parseVdfPaths(text)) {
                    if (dirExists(p)) libraries.push(p);
                }
            } catch { /* ignore unreadable vdf */ }
        }
    }

    return [...new Set(libraries)];
}

function findSteamInstall(steamRoots) {
    const results = [];
    for (const library of findSteamLibraries(steamRoots)) {
        const common = path.join(library, 'steamapps', 'common');
        if (!dirExists(common)) continue;

        let installDirName = DBD_CONFIG.steamInstallDirName;

        const manifest = path.join(library, 'steamapps', `appmanifest_${DBD_CONFIG.steamAppId}.acf`);
        if (fileExists(manifest)) {
            try {
                const text = fs.readFileSync(manifest, 'utf8');
                const m = /"installdir"\s*"([^"]+)"/.exec(text);
                if (m) installDirName = m[1];
            } catch { /* ignore */ }
        }

        const installRoot = path.join(common, installDirName);
        if (dirExists(installRoot)) {
            const pakPath = pakFolderFor(installRoot);
            if (hasPakFiles(pakPath)) {
                results.push({ platform: 'Steam', installRoot, pakFolderPath: pakPath });
            }
        }
    }
    return results;
}

// --------------------------------------------------------------------- //
// Epic Games
// --------------------------------------------------------------------- //

function defaultEpicManifestDir() {
    if (process.platform === 'win32') {
        const p = 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests';
        return dirExists(p) ? p : null;
    }
    return null;
}

function findEpicInstall(manifestDir) {
    const dir = manifestDir !== undefined ? manifestDir : defaultEpicManifestDir();
    if (!dir || !dirExists(dir)) return [];

    const results = [];
    for (const fname of fs.readdirSync(dir)) {
        if (!fname.toLowerCase().endsWith('.item')) continue;
        let data;
        try {
            data = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8'));
        } catch { continue; }

        const appName = data.AppName || data.MainGameAppName || '';
        const displayName = data.DisplayName || '';
        const target = DBD_CONFIG.epicAppName.toLowerCase();

        if (
            target === appName.toLowerCase() ||
            target === displayName.toLowerCase() ||
            displayName.toLowerCase().includes(target)
        ) {
            const installRoot = data.InstallLocation || '';
            if (installRoot && dirExists(installRoot)) {
                const pakPath = pakFolderFor(installRoot);
                if (hasPakFiles(pakPath)) {
                    results.push({ platform: 'Epic', installRoot, pakFolderPath: pakPath });
                }
            }
        }
    }
    return results;
}

// --------------------------------------------------------------------- //
// Xbox / Microsoft Store (Game Pass)
// --------------------------------------------------------------------- //

/** Strip everything but letters/digits and lowercase, for loose name matching
 * (handles "Dead By Daylight" vs "DeadByDaylight" vs "dead-by-daylight" etc). */
function normalizeForMatch(str) {
    return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function listWindowsDriveRoots() {
    if (process.platform !== 'win32') return [];
    const drives = [];
    for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
        const letter = String.fromCharCode(code);
        const root = `${letter}:\\`;
        if (dirExists(root)) drives.push(root);
    }
    return drives;
}

function defaultXboxRoots() {
    if (process.platform === 'win32') {
        // XboxGames' install location is chosen by the user in the Xbox app
        // and is very often on a secondary drive, not C:. ModifiableWindowsApps
        // is Program-Files-based and (rarely) can also live on another drive.
        const roots = [];
        for (const drive of listWindowsDriveRoots()) {
            roots.push(path.join(drive, 'XboxGames'));
            roots.push(path.join(drive, 'Program Files', 'ModifiableWindowsApps'));
        }
        return roots.filter(dirExists);
    }
    return [];
}

function findXboxInstall(xboxRoots) {
    const roots = xboxRoots !== undefined ? xboxRoots : defaultXboxRoots();
    const target = normalizeForMatch(DBD_CONFIG.xboxPackageName);
    const results = [];

    for (const root of roots) {
        if (!dirExists(root)) continue;
        for (const entry of fs.readdirSync(root)) {
            if (normalizeForMatch(entry) !== target) continue;
            const entryPath = path.join(root, entry);
            if (!dirExists(entryPath)) continue;

            let installRoot = entryPath;
            const contentDir = path.join(entryPath, 'Content');
            if (dirExists(contentDir)) installRoot = contentDir;

            const pakPath = pakFolderFor(installRoot);
            if (hasPakFiles(pakPath)) {
                results.push({ platform: 'Xbox', installRoot, pakFolderPath: pakPath });
            }
        }
    }
    return results;
}

// --------------------------------------------------------------------- //
// Combined
// --------------------------------------------------------------------- //

/**
 * Detect every Dead by Daylight install across Steam, Epic, and Xbox.
 * Accepts optional root overrides (used by tests / advanced setups).
 * @returns {{platform: string, installRoot: string, pakFolderPath: string}[]}
 */
function detectGameInstalls(overrides = {}) {
    const found = [
        ...findSteamInstall(overrides.steamRoots),
        ...findEpicInstall(overrides.epicManifestDir),
        ...findXboxInstall(overrides.xboxRoots),
    ];

    const seen = new Set();
    const unique = [];
    for (const gi of found) {
        const key = path.normalize(gi.pakFolderPath).toLowerCase();
        if (!seen.has(key)) {
            unique.push(gi);
            seen.add(key);
        }
    }
    return unique;
}

module.exports = {
    DBD_CONFIG,
    findSteamLibraries,
    findSteamInstall,
    findEpicInstall,
    findXboxInstall,
    detectGameInstalls,
    pakFolderFor,
    hasPakFiles,
};
