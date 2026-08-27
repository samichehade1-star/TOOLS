// main.js - electron main process

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const yauzl = require('yauzl');
const yazl = require('yazl');
const AdmZip = require('adm-zip');
const Seven = require('node-7z');
const sevenBin = require('7zip-bin');
const pathTo7zip = sevenBin.path7za;
// the bundled 7za binary cannot read RAR archives at all (it only handles
// 7z/zip/tar) — node-unrar-js is a WASM-based unrar with no external binary
// dependency, used specifically for .rar files instead.
const { createExtractorFromFile } = require('node-unrar-js');

// supported mod archive extensions
const SUPPORTED_MOD_EXTENSIONS = ['.mmpackage', '.zip', '.7z', '.rar'];

/**
 * Check if a filename has a supported mod archive extension.
 * @param {string} filename
 * @returns {boolean}
 */
function isSupportedModFile(filename) {
    const lower = filename.toLowerCase();
    return SUPPORTED_MOD_EXTENSIONS.some(ext => lower.endsWith(ext));
}

/**
 * Strip any supported mod archive extension from a filename.
 * @param {string} filename
 * @returns {string}
 */
function stripModExtension(filename) {
    const lower = filename.toLowerCase();
    for (const ext of SUPPORTED_MOD_EXTENSIONS) {
        if (lower.endsWith(ext)) {
            return filename.slice(0, -ext.length);
        }
    }
    return filename;
}

/**
 * Check if file is a zip-based archive (.mmpackage or .zip)
 * @param {string} filename
 * @returns {boolean}
 */
function isZipArchive(filename) {
    const lower = filename.toLowerCase();
    return lower.endsWith('.mmpackage') || lower.endsWith('.zip');
}

/**
 * Check if file needs 7z extraction (.7z or .rar) — used at call sites that
 * don't care WHICH of the two, just that it's "not zip, needs a real
 * archive tool". Extraction/listing internally still routes .rar through
 * node-unrar-js and .7z through 7-Zip (see below) since the bundled 7za
 * binary cannot read RAR archives at all.
 * @param {string} filename
 * @returns {boolean}
 */
function is7zArchive(filename) {
    const lower = filename.toLowerCase();
    return lower.endsWith('.7z') || lower.endsWith('.rar');
}

function isRarArchive(filename) {
    return filename.toLowerCase().endsWith('.rar');
}
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const gameScanner = require('./gameScanner');
const crypto = require('crypto');

/**
 * Stable short id for a deploy target, derived from its pak folder path,
 * so the same detected install always maps to the same id across scans.
 */
function deployTargetId(pakFolderPath) {
    return crypto.createHash('md5').update(path.normalize(pakFolderPath).toLowerCase()).digest('hex').slice(0, 12);
}

async function persistSettings() {
    await fs.writeFile(settingsFilePath, JSON.stringify(appSettings, null, 2));
}

/**
 * Map the scanner's platform codes (Steam/Epic/Xbox) to the platform label
 * used throughout the rest of the app (matches the settings dropdown and
 * getPlatformCode()).
 */
function scannerPlatformToLabel(platformCode) {
    if (platformCode === 'Xbox') return 'Microsoft';
    if (platformCode === 'Epic') return 'Epic Games';
    return 'Steam';
}

/**
 * Merge newly-found installs into appSettings.deployTargets, deduping by
 * pak folder path. `found` entries must already carry a final platform
 * label (e.g. 'Steam', 'Microsoft', 'Epic Games') in `.platform`.
 * Returns the count of newly-added targets.
 */
function mergeDeployTargets(found) {
    if (!Array.isArray(appSettings.deployTargets)) appSettings.deployTargets = [];
    const existingIds = new Set(appSettings.deployTargets.map(t => t.id));
    let added = 0;
    for (const gi of found) {
        const id = deployTargetId(gi.pakFolderPath);
        if (!existingIds.has(id)) {
            appSettings.deployTargets.push({
                id,
                platform: gi.platform,
                pakFolderPath: gi.pakFolderPath,
                installRoot: gi.installRoot || '',
                autoDetected: !!gi.autoDetected,
            });
            existingIds.add(id);
            added++;
        }
    }
    return added;
}

/**
 * The list of targets mods should be deployed to. Falls back to the legacy
 * single pakFolderPath/platform settings for users who haven't run
 * auto-detect or added a target yet, so existing installs keep working.
 */
function getActiveDeployTargets() {
    if (Array.isArray(appSettings.deployTargets) && appSettings.deployTargets.length > 0) {
        return appSettings.deployTargets;
    }
    if (appSettings.pakFolderPath) {
        return [{
            id: deployTargetId(appSettings.pakFolderPath),
            platform: appSettings.platform || 'Steam',
            pakFolderPath: appSettings.pakFolderPath,
            installRoot: '',
            autoDetected: false,
        }];
    }
    return [];
}

async function extractRarArchive(source, extractTo) {
    await fs.ensureDir(extractTo);
    const extractor = await createExtractorFromFile({ filepath: source, targetPath: extractTo });
    const result = extractor.extract();
    // the library's extraction is generator-based/lazy — iterating is what
    // actually performs the file writes, so this loop is required even
    // though we don't need anything from each entry.
    for (const _file of result.files) { /* drain the iterator to force extraction */ }
}

async function extractArchive(source, extractTo) {
    if (isRarArchive(source)) {
        return extractRarArchive(source, extractTo);
    }
    // .7z via 7-Zip (the bundled 7za binary handles this format fine — it's
    // specifically RAR it can't read)
    return new Promise((resolve, reject) => {
        const stream = Seven.extractFull(source, extractTo, {
            $bin: pathTo7zip,
            recursive: true
        });
        stream.on('end', resolve);
        stream.on('error', reject);
    });
}

/** List every entry name inside a .zip/.mmpackage without extracting it. */
function peekZipEntries(filePath) {
    return new Promise((resolve, reject) => {
        yauzl.open(filePath, { lazyEntries: true }, (err, zipfile) => {
            if (err) return reject(err);
            const names = [];
            zipfile.on('entry', (entry) => {
                if (!/\/$/.test(entry.fileName)) names.push(entry.fileName);
                zipfile.readEntry();
            });
            zipfile.on('end', () => resolve(names));
            zipfile.on('error', reject);
            zipfile.readEntry();
        });
    });
}

/** List every entry name inside a .7z/.rar without extracting it. */
function peek7zEntries(filePath) {
    return new Promise((resolve, reject) => {
        const names = [];
        try {
            const stream = Seven.list(filePath, { $bin: pathTo7zip });
            stream.on('data', (data) => { if (data && data.file) names.push(data.file); });
            stream.on('end', () => resolve(names));
            stream.on('error', reject);
        } catch (err) {
            reject(err);
        }
    });
}

/** List every entry name inside a .rar without extracting it. */
async function peekRarEntries(filePath) {
    const extractor = await createExtractorFromFile({ filepath: filePath });
    const list = extractor.getFileList();
    return [...list.fileHeaders].map(h => h.name);
}

/**
 * Peeks inside an archive (without extracting) to check whether it actually
 * contains pakchunk files — this is what lets the Downloads tab show only
 * real mod archives instead of every zip/rar sitting in the folder.
 */
/** Lists raw entry paths inside an archive, routed to the right tool by extension. */
async function listArchiveEntries(filePath) {
    const fileName = path.basename(filePath);
    if (isZipArchive(fileName)) return peekZipEntries(filePath);
    if (isRarArchive(fileName)) return peekRarEntries(filePath);
    if (is7zArchive(fileName)) return peek7zEntries(filePath);
    return [];
}

async function archiveContainsPakFiles(filePath) {
    let entries = [];
    try {
        entries = await listArchiveEntries(filePath);
    } catch {
        return { hasPakFiles: false, pakFileNames: [] };
    }
    const pakFileNames = entries
        .map(e => path.basename(e.replace(/\\/g, '/')))
        .filter(name => /^pakchunk\d+(-[a-zA-Z0-9]+)?\.pak$/i.test(name));
    return { hasPakFiles: pakFileNames.length > 0, pakFileNames };
}

/**
 * Detects whether an archive contains multiple self-contained "variant"
 * subfolders, each with its own complete pakchunk set — the common pattern
 * for cosmetic mods that ship several color options in one download, each
 * in its own top-level folder. They typically share the exact same
 * pakchunk number (mutually exclusive slots — only one can ever be active
 * at a time), but the user may want to pull out several as separate
 * toggleable mods to switch between.
 */
async function analyzeArchiveVariants(filePath) {
    let entries = [];
    try {
        entries = await listArchiveEntries(filePath);
    } catch {
        return { isMultiVariant: false, variants: [] };
    }

    // group by each pak file's own direct parent folder (its full relative
    // path from the archive root) — not just the first path segment, since
    // some archives wrap all the variant folders in an extra outer folder
    // (e.g. "Galaxy Lockers [9.6.1]/Blue/..." instead of "Blue/..." right
    // at the root). Keying off the immediate parent handles either shape,
    // and any other nesting depth, without guessing how deep variants sit.
    const groups = {};
    for (const raw of entries) {
        const normalized = raw.replace(/\\/g, '/');
        const baseName = path.basename(normalized);
        if (!/^pakchunk\d+(-[a-zA-Z0-9]+)?\.pak$/i.test(baseName)) continue;
        const parentDir = path.dirname(normalized);
        if (parentDir === '.') continue; // pak sitting at the archive root — not a variant
        if (!groups[parentDir]) groups[parentDir] = [];
        groups[parentDir].push(baseName);
    }
    const variants = Object.entries(groups)
        .map(([folder, pakFileNames]) => ({ folder, displayName: path.basename(folder), pakFileNames }));
    return { isMultiVariant: variants.length > 1, variants };
}

/**
 * Creates a standalone zip in the mods folder containing just one variant's
 * files, flattened (the variant's folder prefix is stripped so the
 * resulting zip has pakchunk files directly at its root, matching what the
 * rest of the app expects of a mod archive). Extracts the whole source
 * archive to a temp folder first, since that works uniformly regardless of
 * whether the source is zip/7z/rar.
 */
async function createVariantZip(sourceFilePath, variantFolder, destZipName) {
    if (!appSettings.modFolderPath) throw new Error('set a mods folder in Settings first.');
    const tempDir = path.join(os.tmpdir(), 'disobeytop_variant_temp', Date.now().toString());
    await fs.ensureDir(tempDir);
    try {
        const fileName = path.basename(sourceFilePath);
        if (isZipArchive(fileName)) {
            await new Promise((resolve, reject) => {
                yauzl.open(sourceFilePath, { lazyEntries: true }, (err, zipfile) => {
                    if (err) return reject(err);
                    zipfile.on('entry', (entry) => {
                        if (/\/$/.test(entry.fileName)) { zipfile.readEntry(); return; }
                        const entryPath = path.join(tempDir, entry.fileName);
                        fs.ensureDir(path.dirname(entryPath)).then(() => {
                            zipfile.openReadStream(entry, (err, readStream) => {
                                if (err) return reject(err);
                                const writeStream = fs.createWriteStream(entryPath);
                                readStream.on('end', () => zipfile.readEntry());
                                readStream.pipe(writeStream);
                            });
                        }).catch(reject);
                    });
                    zipfile.on('end', resolve);
                    zipfile.on('error', reject);
                    zipfile.readEntry();
                });
            });
        } else {
            await extractArchive(sourceFilePath, tempDir);
        }

        const variantSourceDir = path.join(tempDir, variantFolder);
        if (!(await fs.pathExists(variantSourceDir))) {
            throw new Error(`variant folder "${variantFolder}" not found after extraction.`);
        }
        const filesInVariant = await fs.readdir(variantSourceDir);
        const pakFiles = filesInVariant.filter(f => /^pakchunk\d+(-[a-zA-Z0-9]+)?\.(pak|sig|ucas|utoc)$/i.test(f));
        if (pakFiles.length === 0) {
            throw new Error(`no pakchunk files found in variant "${variantFolder}".`);
        }

        const zip = new AdmZip();
        for (const f of pakFiles) {
            zip.addLocalFile(path.join(variantSourceDir, f));
        }
        const destPath = path.join(appSettings.modFolderPath, destZipName);
        if (await fs.pathExists(destPath)) {
            throw new Error(`a file named "${destZipName}" already exists in your mods folder.`);
        }
        zip.writeZip(destPath);
        return destPath;
    } finally {
        try { await fs.remove(tempDir); } catch { /* ignore */ }
    }
}

// --- application details ---
const APP_VERSION = '';
const https = require('https');


// --- paths ---
const appDataPath = path.join(os.homedir(), 'AppData', 'Local', 'Programs', '~fmpsumods');
const settingsFilePath = path.join(appDataPath, 'settings.json');
const installedModsFilePath = path.join(appDataPath, 'installed_mods.json');
const crashLogPath = path.join(appDataPath, 'crashlog.txt');
const backupPath = path.join(appDataPath, 'backups');

// --- crash reporter ---
process.on('uncaughtException', (error) => {
    const errorMessage = `\n=====================================================\nuncaught exception\ntimestamp: ${new Date().toISOString()}\nversion: ${APP_VERSION}\n-----------------------------------------------------\nerror: ${error.stack || error.toString()}\n=====================================================\n`;
    try {
        fs.appendFileSync(crashLogPath, errorMessage);
    } catch (logError) {
        console.error('failed to write to crash log:', logError);
    }
    dialog.showErrorBox('unhandled exception', `a critical error occurred. a crash log has been saved to:\n${crashLogPath}`);
    app.quit();
});



// --- main application logic ---
const BASE_PAK_FILES_TEMPLATE = [
    "global.ucas", "global.utoc",
    "pakchunk0-{platformCode}.pak", "pakchunk0-{platformCode}.sig", "pakchunk0-{platformCode}.ucas", "pakchunk0-{platformCode}.utoc",
    "pakchunk1-{platformCode}.pak", "pakchunk1-{platformCode}.sig", "pakchunk1-{platformCode}.ucas", "pakchunk1-{platformCode}.utoc",
    "pakchunk2-{platformCode}.pak", "pakchunk2-{platformCode}.sig", "pakchunk2-{platformCode}.ucas", "pakchunk2-{platformCode}.utoc",
    "pakchunk3-{platformCode}.pak", "pakchunk3-{platformCode}.sig", "pakchunk3-{platformCode}.ucas", "pakchunk3-{platformCode}.utoc",
    "pakchunk4-{platformCode}.pak", "pakchunk4-{platformCode}.sig", "pakchunk4-{platformCode}.ucas", "pakchunk4-{platformCode}.utoc",
    "pakchunk5-{platformCode}.pak", "pakchunk5-{platformCode}.sig", "pakchunk5-{platformCode}.ucas", "pakchunk5-{platformCode}.utoc",
    "pakchunk6-{platformCode}.pak", "pakchunk6-{platformCode}.sig", "pakchunk6-{platformCode}.ucas", "pakchunk6-{platformCode}.utoc",
    "pakchunk7-{platformCode}.pak", "pakchunk7-{platformCode}.sig", "pakchunk7-{platformCode}.ucas", "pakchunk7-{platformCode}.utoc",
    "pakchunk8-{platformCode}.pak", "pakchunk8-{platformCode}.sig", "pakchunk8-{platformCode}.ucas", "pakchunk8-{platformCode}.utoc",
    "pakchunk9-{platformCode}.pak", "pakchunk9-{platformCode}.sig", "pakchunk9-{platformCode}.ucas", "pakchunk9-{platformCode}.utoc",
    "pakchunk10-{platformCode}.pak", "pakchunk10-{platformCode}.sig", "pakchunk10-{platformCode}.ucas", "pakchunk10-{platformCode}.utoc",
    "pakchunk11-{platformCode}.pak", "pakchunk11-{platformCode}.sig", "pakchunk11-{platformCode}.ucas", "pakchunk11-{platformCode}.utoc",
    "pakchunk12-{platformCode}.pak", "pakchunk12-{platformCode}.sig", "pakchunk12-{platformCode}.ucas", "pakchunk12-{platformCode}.utoc",
    "pakchunk13-{platformCode}.pak", "pakchunk13-{platformCode}.sig", "pakchunk13-{platformCode}.ucas", "pakchunk13-{platformCode}.utoc",
    "pakchunk14-{platformCode}.pak", "pakchunk14-{platformCode}.sig", "pakchunk14-{platformCode}.ucas", "pakchunk14-{platformCode}.utoc",
    "pakchunk15-{platformCode}.pak", "pakchunk15-{platformCode}.sig", "pakchunk15-{platformCode}.ucas", "pakchunk15-{platformCode}.utoc",
    "pakchunk16-{platformCode}.pak", "pakchunk16-{platformCode}.sig", "pakchunk16-{platformCode}.ucas", "pakchunk16-{platformCode}.utoc",
    "pakchunk17-{platformCode}.pak", "pakchunk17-{platformCode}.sig", "pakchunk17-{platformCode}.ucas", "pakchunk17-{platformCode}.utoc",
    "pakchunk18-{platformCode}.pak", "pakchunk18-{platformCode}.sig", "pakchunk18-{platformCode}.ucas", "pakchunk18-{platformCode}.utoc",
    "pakchunk19-{platformCode}.pak", "pakchunk19-{platformCode}.sig", "pakchunk19-{platformCode}.ucas", "pakchunk19-{platformCode}.utoc",
    "pakchunk20-{platformCode}.pak", "pakchunk20-{platformCode}.sig", "pakchunk20-{platformCode}.ucas", "pakchunk20-{platformCode}.utoc",
    "pakchunk21-{platformCode}.pak", "pakchunk21-{platformCode}.sig", "pakchunk21-{platformCode}.ucas", "pakchunk21-{platformCode}.utoc",
    "pakchunk22-{platformCode}.pak", "pakchunk22-{platformCode}.sig", "pakchunk22-{platformCode}.ucas", "pakchunk22-{platformCode}.utoc",
    "pakchunk99-{platformCode}.pak", "pakchunk99-{platformCode}.sig", "pakchunk99-{platformCode}.ucas", "pakchunk99-{platformCode}.utoc",
    "pakchunk1002-{platformCode}.pak", "pakchunk1002-{platformCode}.sig", "pakchunk1002-{platformCode}.ucas", "pakchunk1002-{platformCode}.utoc",
    "pakchunk1004-{platformCode}.pak", "pakchunk1004-{platformCode}.sig", "pakchunk1004-{platformCode}.ucas", "pakchunk1004-{platformCode}.utoc",
    "pakchunk1006-{platformCode}.pak", "pakchunk1006-{platformCode}.sig", "pakchunk1006-{platformCode}.ucas", "pakchunk1006-{platformCode}.utoc",
    "pakchunk1007-{platformCode}.pak", "pakchunk1007-{platformCode}.sig", "pakchunk1007-{platformCode}.ucas", "pakchunk1007-{platformCode}.utoc",
    "pakchunk1008-{platformCode}.pak", "pakchunk1008-{platformCode}.sig", "pakchunk1008-{platformCode}.ucas", "pakchunk1008-{platformCode}.utoc",
    "pakchunk1009-{platformCode}.pak", "pakchunk1009-{platformCode}.sig", "pakchunk1009-{platformCode}.ucas", "pakchunk1009-{platformCode}.utoc",
    "pakchunk1010-{platformCode}.pak", "pakchunk1010-{platformCode}.sig", "pakchunk1010-{platformCode}.ucas", "pakchunk1010-{platformCode}.utoc",
    "pakchunk1011-{platformCode}.pak", "pakchunk1011-{platformCode}.sig", "pakchunk1011-{platformCode}.ucas", "pakchunk1011-{platformCode}.utoc",
    "pakchunk1014-{platformCode}.pak", "pakchunk1014-{platformCode}.sig", "pakchunk1014-{platformCode}.ucas", "pakchunk1014-{platformCode}.utoc",
    "pakchunk1015-{platformCode}.pak", "pakchunk1015-{platformCode}.sig", "pakchunk1015-{platformCode}.ucas", "pakchunk1015-{platformCode}.utoc",
    "pakchunk1016-{platformCode}.pak", "pakchunk1016-{platformCode}.sig", "pakchunk1016-{platformCode}.ucas", "pakchunk1016-{platformCode}.utoc",
    "pakchunk1017-{platformCode}.pak", "pakchunk1017-{platformCode}.sig", "pakchunk1017-{platformCode}.ucas", "pakchunk1017-{platformCode}.utoc",
    "pakchunk1018-{platformCode}.pak", "pakchunk1018-{platformCode}.sig", "pakchunk1018-{platformCode}.ucas", "pakchunk1018-{platformCode}.utoc",
    "pakchunk1020-{platformCode}.pak", "pakchunk1020-{platformCode}.sig", "pakchunk1020-{platformCode}.ucas", "pakchunk1020-{platformCode}.utoc",
    "pakchunk1024-{platformCode}.pak", "pakchunk1024-{platformCode}.sig", "pakchunk1024-{platformCode}.ucas", "pakchunk1024-{platformCode}.utoc",
    "pakchunk1025-{platformCode}.pak", "pakchunk1025-{platformCode}.sig", "pakchunk1025-{platformCode}.ucas", "pakchunk1025-{platformCode}.utoc",
    "pakchunk1027-{platformCode}.pak", "pakchunk1027-{platformCode}.sig", "pakchunk1027-{platformCode}.ucas", "pakchunk1027-{platformCode}.utoc",
    "pakchunk1029-{platformCode}.pak", "pakchunk1029-{platformCode}.sig", "pakchunk1029-{platformCode}.ucas", "pakchunk1029-{platformCode}.utoc",
    "pakchunk1030-{platformCode}.pak", "pakchunk1030-{platformCode}.sig", "pakchunk1030-{platformCode}.ucas", "pakchunk1030-{platformCode}.utoc",
    "pakchunk1032-{platformCode}.pak", "pakchunk1032-{platformCode}.sig", "pakchunk1032-{platformCode}.ucas", "pakchunk1032-{platformCode}.utoc",
    "pakchunk1033-{platformCode}.pak", "pakchunk1033-{platformCode}.sig", "pakchunk1033-{platformCode}.ucas", "pakchunk1033-{platformCode}.utoc",
    "pakchunk1034-{platformCode}.pak", "pakchunk1034-{platformCode}.sig", "pakchunk1034-{platformCode}.ucas", "pakchunk1034-{platformCode}.utoc",
    "pakchunk1035-{platformCode}.pak", "pakchunk1035-{platformCode}.sig", "pakchunk1035-{platformCode}.ucas", "pakchunk1035-{platformCode}.utoc",
    "pakchunk1036-{platformCode}.pak", "pakchunk1036-{platformCode}.sig", "pakchunk1036-{platformCode}.ucas", "pakchunk1036-{platformCode}.utoc",
    "pakchunk1037-{platformCode}.pak", "pakchunk1037-{platformCode}.sig", "pakchunk1037-{platformCode}.ucas", "pakchunk1037-{platformCode}.utoc",
    "pakchunk1038-{platformCode}.pak", "pakchunk1038-{platformCode}.sig", "pakchunk1038-{platformCode}.ucas", "pakchunk1038-{platformCode}.utoc",
    "pakchunk1039-{platformCode}.pak", "pakchunk1039-{platformCode}.sig", "pakchunk1039-{platformCode}.ucas", "pakchunk1039-{platformCode}.utoc",
    "pakchunk1040-{platformCode}.pak", "pakchunk1040-{platformCode}.sig", "pakchunk1040-{platformCode}.ucas", "pakchunk1040-{platformCode}.utoc",
    "pakchunk1501-{platformCode}.pak", "pakchunk1501-{platformCode}.sig", "pakchunk1501-{platformCode}.ucas", "pakchunk1501-{platformCode}.utoc",
    "pakchunk1502-{platformCode}.pak", "pakchunk1502-{platformCode}.sig", "pakchunk1502-{platformCode}.ucas", "pakchunk1502-{platformCode}.utoc",
    "pakchunk1503-{platformCode}.pak", "pakchunk1503-{platformCode}.sig", "pakchunk1503-{platformCode}.ucas", "pakchunk1503-{platformCode}.utoc",
    "pakchunk1504-{platformCode}.pak", "pakchunk1504-{platformCode}.sig", "pakchunk1504-{platformCode}.ucas", "pakchunk1504-{platformCode}.utoc",
    "pakchunk1505-{platformCode}.pak", "pakchunk1505-{platformCode}.sig", "pakchunk1505-{platformCode}.ucas", "pakchunk1505-{platformCode}.utoc",
    "pakchunk1506-{platformCode}.pak", "pakchunk1506-{platformCode}.sig", "pakchunk1506-{platformCode}.ucas", "pakchunk1506-{platformCode}.utoc",
    "pakchunk1507-{platformCode}.pak", "pakchunk1507-{platformCode}.sig", "pakchunk1507-{platformCode}.ucas", "pakchunk1507-{platformCode}.utoc",
    "pakchunk1508-{platformCode}.pak", "pakchunk1508-{platformCode}.sig", "pakchunk1508-{platformCode}.ucas", "pakchunk1508-{platformCode}.utoc",
    "pakchunk1509-{platformCode}.pak", "pakchunk1509-{platformCode}.sig", "pakchunk1509-{platformCode}.ucas", "pakchunk1509-{platformCode}.utoc",
    "pakchunk1510-{platformCode}.pak", "pakchunk1510-{platformCode}.sig", "pakchunk1510-{platformCode}.ucas", "pakchunk1510-{platformCode}.utoc",
    "pakchunk1511-{platformCode}.pak", "pakchunk1511-{platformCode}.sig", "pakchunk1511-{platformCode}.ucas", "pakchunk1511-{platformCode}.utoc",
    "pakchunk1512-{platformCode}.pak", "pakchunk1512-{platformCode}.sig", "pakchunk1512-{platformCode}.ucas", "pakchunk1512-{platformCode}.utoc",
    "pakchunk1513-{platformCode}.pak", "pakchunk1513-{platformCode}.sig", "pakchunk1513-{platformCode}.ucas", "pakchunk1513-{platformCode}.utoc",
    "pakchunk1514-{platformCode}.pak", "pakchunk1514-{platformCode}.sig", "pakchunk1514-{platformCode}.ucas", "pakchunk1514-{platformCode}.utoc",
    "pakchunk1515-{platformCode}.pak", "pakchunk1515-{platformCode}.sig", "pakchunk1515-{platformCode}.ucas", "pakchunk1515-{platformCode}.utoc",
    "pakchunk1516-{platformCode}.pak", "pakchunk1516-{platformCode}.sig", "pakchunk1516-{platformCode}.ucas", "pakchunk1516-{platformCode}.utoc",
    "pakchunk1517-{platformCode}.pak", "pakchunk1517-{platformCode}.sig", "pakchunk1517-{platformCode}.ucas", "pakchunk1517-{platformCode}.utoc",
    "pakchunk1518-{platformCode}.pak", "pakchunk1518-{platformCode}.sig", "pakchunk1518-{platformCode}.ucas", "pakchunk1518-{platformCode}.utoc",
    "pakchunk1519-{platformCode}.pak", "pakchunk1519-{platformCode}.sig", "pakchunk1519-{platformCode}.ucas", "pakchunk1519-{platformCode}.utoc",
    "pakchunk1520-{platformCode}.pak", "pakchunk1520-{platformCode}.sig", "pakchunk1520-{platformCode}.ucas", "pakchunk1520-{platformCode}.utoc",
    "pakchunk1521-{platformCode}.pak", "pakchunk1521-{platformCode}.sig", "pakchunk1521-{platformCode}.ucas", "pakchunk1521-{platformCode}.utoc",
    "pakchunk1522-{platformCode}.pak", "pakchunk1522-{platformCode}.sig", "pakchunk1522-{platformCode}.ucas", "pakchunk1522-{platformCode}.utoc",
    "pakchunk1523-{platformCode}.pak", "pakchunk1523-{platformCode}.sig", "pakchunk1523-{platformCode}.ucas", "pakchunk1523-{platformCode}.utoc",
    "pakchunk1524-{platformCode}.pak", "pakchunk1524-{platformCode}.sig", "pakchunk1524-{platformCode}.ucas", "pakchunk1524-{platformCode}.utoc",
    "pakchunk1525-{platformCode}.pak", "pakchunk1525-{platformCode}.sig", "pakchunk1525-{platformCode}.ucas", "pakchunk1525-{platformCode}.utoc",
    "pakchunk1526-{platformCode}.pak", "pakchunk1526-{platformCode}.sig", "pakchunk1526-{platformCode}.ucas", "pakchunk1526-{platformCode}.utoc",
    "pakchunk1527-{platformCode}.pak", "pakchunk1527-{platformCode}.sig", "pakchunk1527-{platformCode}.ucas", "pakchunk1527-{platformCode}.utoc",
    "pakchunk1528-{platformCode}.pak", "pakchunk1528-{platformCode}.sig", "pakchunk1528-{platformCode}.ucas", "pakchunk1528-{platformCode}.utoc",
    "pakchunk1529-{platformCode}.pak", "pakchunk1529-{platformCode}.sig", "pakchunk1529-{platformCode}.ucas", "pakchunk1529-{platformCode}.utoc",
    "pakchunk1530-{platformCode}.pak", "pakchunk1530-{platformCode}.sig", "pakchunk1530-{platformCode}.ucas", "pakchunk1530-{platformCode}.utoc",
    "pakchunk1531-{platformCode}.pak", "pakchunk1531-{platformCode}.sig", "pakchunk1531-{platformCode}.ucas", "pakchunk1531-{platformCode}.utoc",
    "pakchunk1532-{platformCode}.pak", "pakchunk1532-{platformCode}.sig", "pakchunk1532-{platformCode}.ucas", "pakchunk1532-{platformCode}.utoc",
    "pakchunk1533-{platformCode}.pak", "pakchunk1533-{platformCode}.sig", "pakchunk1533-{platformCode}.ucas", "pakchunk1533-{platformCode}.utoc",
    "pakchunk1534-{platformCode}.pak", "pakchunk1534-{platformCode}.sig", "pakchunk1534-{platformCode}.ucas", "pakchunk1534-{platformCode}.utoc",
    "pakchunk1535-{platformCode}.pak", "pakchunk1535-{platformCode}.sig", "pakchunk1535-{platformCode}.ucas", "pakchunk1535-{platformCode}.utoc",
    "pakchunk1536-{platformCode}.pak", "pakchunk1536-{platformCode}.sig", "pakchunk1536-{platformCode}.ucas", "pakchunk1536-{platformCode}.utoc",
    "pakchunk1537-{platformCode}.pak", "pakchunk1537-{platformCode}.sig", "pakchunk1537-{platformCode}.ucas", "pakchunk1537-{platformCode}.utoc",
    "pakchunk1538-{platformCode}.pak", "pakchunk1538-{platformCode}.sig", "pakchunk1538-{platformCode}.ucas", "pakchunk1538-{platformCode}.utoc",
    "pakchunk1539-{platformCode}.pak", "pakchunk1539-{platformCode}.sig", "pakchunk1539-{platformCode}.ucas", "pakchunk1539-{platformCode}.utoc",
    "pakchunk1540-{platformCode}.pak", "pakchunk1540-{platformCode}.sig", "pakchunk1540-{platformCode}.ucas", "pakchunk1540-{platformCode}.utoc",
    "pakchunk1541-{platformCode}.pak", "pakchunk1541-{platformCode}.sig", "pakchunk1541-{platformCode}.ucas", "pakchunk1541-{platformCode}.utoc",
    "pakchunk1542-{platformCode}.pak", "pakchunk1542-{platformCode}.sig", "pakchunk1542-{platformCode}.ucas", "pakchunk1542-{platformCode}.utoc",
    "pakchunk1543-{platformCode}.pak", "pakchunk1543-{platformCode}.sig", "pakchunk1543-{platformCode}.ucas", "pakchunk1543-{platformCode}.utoc",
    "pakchunk1544-{platformCode}.pak", "pakchunk1544-{platformCode}.sig", "pakchunk1544-{platformCode}.ucas", "pakchunk1544-{platformCode}.utoc",
    "pakchunk1545-{platformCode}.pak", "pakchunk1545-{platformCode}.sig", "pakchunk1545-{platformCode}.ucas", "pakchunk1545-{platformCode}.utoc",
    "pakchunk1546-{platformCode}.pak", "pakchunk1546-{platformCode}.sig", "pakchunk1546-{platformCode}.ucas", "pakchunk1546-{platformCode}.utoc",
    "pakchunk2000-{platformCode}.pak", "pakchunk2000-{platformCode}.sig", "pakchunk2000-{platformCode}.ucas", "pakchunk2000-{platformCode}.utoc",
    "pakchunk2001-{platformCode}.pak", "pakchunk2001-{platformCode}.sig", "pakchunk2001-{platformCode}.ucas", "pakchunk2001-{platformCode}.utoc",
    "pakchunk2003-{platformCode}.pak", "pakchunk2003-{platformCode}.sig", "pakchunk2003-{platformCode}.ucas", "pakchunk2003-{platformCode}.utoc",
    "pakchunk2006-{platformCode}.pak", "pakchunk2006-{platformCode}.sig", "pakchunk2006-{platformCode}.ucas", "pakchunk2006-{platformCode}.utoc",
    "pakchunk2007-{platformCode}.pak", "pakchunk2007-{platformCode}.sig", "pakchunk2007-{platformCode}.ucas", "pakchunk2007-{platformCode}.utoc",
    "pakchunk2008-{platformCode}.pak", "pakchunk2008-{platformCode}.sig", "pakchunk2008-{platformCode}.ucas", "pakchunk2008-{platformCode}.utoc",
    "pakchunk2010-{platformCode}.pak", "pakchunk2010-{platformCode}.sig", "pakchunk2010-{platformCode}.ucas", "pakchunk2010-{platformCode}.utoc",
    "pakchunk2011-{platformCode}.pak", "pakchunk2011-{platformCode}.sig", "pakchunk2011-{platformCode}.ucas", "pakchunk2011-{platformCode}.utoc",
    "pakchunk2012-{platformCode}.pak", "pakchunk2012-{platformCode}.sig", "pakchunk2012-{platformCode}.ucas", "pakchunk2012-{platformCode}.utoc",
    "pakchunk2016-{platformCode}.pak", "pakchunk2016-{platformCode}.sig", "pakchunk2016-{platformCode}.ucas", "pakchunk2016-{platformCode}.utoc",
    "pakchunk2017-{platformCode}.pak", "pakchunk2017-{platformCode}.sig", "pakchunk2017-{platformCode}.ucas", "pakchunk2017-{platformCode}.utoc",
    "pakchunk2018-{platformCode}.pak", "pakchunk2018-{platformCode}.sig", "pakchunk2018-{platformCode}.ucas", "pakchunk2018-{platformCode}.utoc",
    "pakchunk2019-{platformCode}.pak", "pakchunk2019-{platformCode}.sig", "pakchunk2019-{platformCode}.ucas", "pakchunk2019-{platformCode}.utoc",
    "pakchunk2020-{platformCode}.pak", "pakchunk2020-{platformCode}.sig", "pakchunk2020-{platformCode}.ucas", "pakchunk2020-{platformCode}.utoc",
    "pakchunk2021-{platformCode}.pak", "pakchunk2021-{platformCode}.sig", "pakchunk2021-{platformCode}.ucas", "pakchunk2021-{platformCode}.utoc",
    "pakchunk2022-{platformCode}.pak", "pakchunk2022-{platformCode}.sig", "pakchunk2022-{platformCode}.ucas", "pakchunk2022-{platformCode}.utoc",
    "pakchunk2023-{platformCode}.pak", "pakchunk2023-{platformCode}.sig", "pakchunk2023-{platformCode}.ucas", "pakchunk2023-{platformCode}.utoc",
    "pakchunk2024-{platformCode}.pak", "pakchunk2024-{platformCode}.sig", "pakchunk2024-{platformCode}.ucas", "pakchunk2024-{platformCode}.utoc",
    "pakchunk2025-{platformCode}.pak", "pakchunk2025-{platformCode}.sig", "pakchunk2025-{platformCode}.ucas", "pakchunk2025-{platformCode}.utoc",
    "pakchunk2026-{platformCode}.pak", "pakchunk2026-{platformCode}.sig", "pakchunk2026-{platformCode}.ucas", "pakchunk2026-{platformCode}.utoc",
    "pakchunk2027-{platformCode}.pak", "pakchunk2027-{platformCode}.sig", "pakchunk2027-{platformCode}.ucas", "pakchunk2027-{platformCode}.utoc",
    "pakchunk2028-{platformCode}.pak", "pakchunk2028-{platformCode}.sig", "pakchunk2028-{platformCode}.ucas", "pakchunk2028-{platformCode}.utoc",
    "pakchunk2029-{platformCode}.pak", "pakchunk2029-{platformCode}.sig", "pakchunk2029-{platformCode}.ucas", "pakchunk2029-{platformCode}.utoc",
    "pakchunk2030-{platformCode}.pak", "pakchunk2030-{platformCode}.sig", "pakchunk2030-{platformCode}.ucas", "pakchunk2030-{platformCode}.utoc",
    "pakchunk2031-{platformCode}.pak", "pakchunk2031-{platformCode}.sig", "pakchunk2031-{platformCode}.ucas", "pakchunk2031-{platformCode}.utoc",
    "pakchunk2032-{platformCode}.pak", "pakchunk2032-{platformCode}.sig", "pakchunk2032-{platformCode}.ucas", "pakchunk2032-{platformCode}.utoc",
    "pakchunk2033-{platformCode}.pak", "pakchunk2033-{platformCode}.sig", "pakchunk2033-{platformCode}.ucas", "pakchunk2033-{platformCode}.utoc",
    "pakchunk2034-{platformCode}.pak", "pakchunk2034-{platformCode}.sig", "pakchunk2034-{platformCode}.ucas", "pakchunk2034-{platformCode}.utoc",
    "pakchunk2035-{platformCode}.pak", "pakchunk2035-{platformCode}.sig", "pakchunk2035-{platformCode}.ucas", "pakchunk2035-{platformCode}.utoc",
    "pakchunk2036-{platformCode}.pak", "pakchunk2036-{platformCode}.sig", "pakchunk2036-{platformCode}.ucas", "pakchunk2036-{platformCode}.utoc",
    "pakchunk2037-{platformCode}.pak", "pakchunk2037-{platformCode}.sig", "pakchunk2037-{platformCode}.ucas", "pakchunk2037-{platformCode}.utoc",
    "pakchunk2038-{platformCode}.pak", "pakchunk2038-{platformCode}.sig", "pakchunk2038-{platformCode}.ucas", "pakchunk2038-{platformCode}.utoc",
    "pakchunk2039-{platformCode}.pak", "pakchunk2039-{platformCode}.sig", "pakchunk2039-{platformCode}.ucas", "pakchunk2039-{platformCode}.utoc",
    "pakchunk2040-{platformCode}.pak", "pakchunk2040-{platformCode}.sig", "pakchunk2040-{platformCode}.ucas", "pakchunk2040-{platformCode}.utoc",
    "pakchunk2041-{platformCode}.pak", "pakchunk2041-{platformCode}.sig", "pakchunk2041-{platformCode}.ucas", "pakchunk2041-{platformCode}.utoc",
    "pakchunk2042-{platformCode}.pak", "pakchunk2042-{platformCode}.sig", "pakchunk2042-{platformCode}.ucas", "pakchunk2042-{platformCode}.utoc",
    "pakchunk2043-{platformCode}.pak", "pakchunk2043-{platformCode}.sig", "pakchunk2043-{platformCode}.ucas", "pakchunk2043-{platformCode}.utoc",
    "pakchunk2044-{platformCode}.pak", "pakchunk2044-{platformCode}.sig", "pakchunk2044-{platformCode}.ucas", "pakchunk2044-{platformCode}.utoc",
    "pakchunk2045-{platformCode}.pak", "pakchunk2045-{platformCode}.sig", "pakchunk2045-{platformCode}.ucas", "pakchunk2045-{platformCode}.utoc",
    "pakchunk2046-{platformCode}.pak", "pakchunk2046-{platformCode}.sig", "pakchunk2046-{platformCode}.ucas", "pakchunk2046-{platformCode}.utoc",
    "pakchunk2047-{platformCode}.pak", "pakchunk2047-{platformCode}.sig", "pakchunk2047-{platformCode}.ucas", "pakchunk2047-{platformCode}.utoc",
    "pakchunk2048-{platformCode}.pak", "pakchunk2048-{platformCode}.sig", "pakchunk2048-{platformCode}.ucas", "pakchunk2048-{platformCode}.utoc",
    "pakchunk2049-{platformCode}.pak", "pakchunk2049-{platformCode}.sig", "pakchunk2049-{platformCode}.ucas", "pakchunk2049-{platformCode}.utoc",
    "pakchunk2050-{platformCode}.pak", "pakchunk2050-{platformCode}.sig", "pakchunk2050-{platformCode}.ucas", "pakchunk2050-{platformCode}.utoc",
    "pakchunk2051-{platformCode}.pak", "pakchunk2051-{platformCode}.sig", "pakchunk2051-{platformCode}.ucas", "pakchunk2051-{platformCode}.utoc",
    "pakchunk2052-{platformCode}.pak", "pakchunk2052-{platformCode}.sig", "pakchunk2052-{platformCode}.ucas", "pakchunk2052-{platformCode}.utoc",
    "pakchunk2053-{platformCode}.pak", "pakchunk2053-{platformCode}.sig", "pakchunk2053-{platformCode}.ucas", "pakchunk2053-{platformCode}.utoc",
    "pakchunk2054-{platformCode}.pak", "pakchunk2054-{platformCode}.sig", "pakchunk2054-{platformCode}.ucas", "pakchunk2054-{platformCode}.utoc",
    "pakchunk2055-{platformCode}.pak", "pakchunk2055-{platformCode}.sig", "pakchunk2055-{platformCode}.ucas", "pakchunk2055-{platformCode}.utoc",
    "pakchunk2056-{platformCode}.pak", "pakchunk2056-{platformCode}.sig", "pakchunk2056-{platformCode}.ucas", "pakchunk2056-{platformCode}.utoc",
    "pakchunk2057-{platformCode}.pak", "pakchunk2057-{platformCode}.sig", "pakchunk2057-{platformCode}.ucas", "pakchunk2057-{platformCode}.utoc",
    "pakchunk2058-{platformCode}.pak", "pakchunk2058-{platformCode}.sig", "pakchunk2058-{platformCode}.ucas", "pakchunk2058-{platformCode}.utoc",
    "pakchunk2059-{platformCode}.pak", "pakchunk2059-{platformCode}.sig", "pakchunk2059-{platformCode}.ucas", "pakchunk2059-{platformCode}.utoc",
    "pakchunk2060-{platformCode}.pak", "pakchunk2060-{platformCode}.sig", "pakchunk2060-{platformCode}.ucas", "pakchunk2060-{platformCode}.utoc",
    "pakchunk2061-{platformCode}.pak", "pakchunk2061-{platformCode}.sig", "pakchunk2061-{platformCode}.ucas", "pakchunk2061-{platformCode}.utoc",
    "pakchunk2062-{platformCode}.pak", "pakchunk2062-{platformCode}.sig", "pakchunk2062-{platformCode}.ucas", "pakchunk2062-{platformCode}.utoc",
    "pakchunk2063-{platformCode}.pak", "pakchunk2063-{platformCode}.sig", "pakchunk2063-{platformCode}.ucas", "pakchunk2063-{platformCode}.utoc",
    "pakchunk2064-{platformCode}.pak", "pakchunk2064-{platformCode}.sig", "pakchunk2064-{platformCode}.ucas", "pakchunk2064-{platformCode}.utoc",
    "pakchunk2065-{platformCode}.pak", "pakchunk2065-{platformCode}.sig", "pakchunk2065-{platformCode}.ucas", "pakchunk2065-{platformCode}.utoc",
    "pakchunk2066-{platformCode}.pak", "pakchunk2066-{platformCode}.sig", "pakchunk2066-{platformCode}.ucas", "pakchunk2066-{platformCode}.utoc",
    "pakchunk2067-{platformCode}.pak", "pakchunk2067-{platformCode}.sig", "pakchunk2067-{platformCode}.ucas", "pakchunk2067-{platformCode}.utoc",
    "pakchunk2068-{platformCode}.pak", "pakchunk2068-{platformCode}.sig", "pakchunk2068-{platformCode}.ucas", "pakchunk2068-{platformCode}.utoc",
    "pakchunk2069-{platformCode}.pak", "pakchunk2069-{platformCode}.sig", "pakchunk2069-{platformCode}.ucas", "pakchunk2069-{platformCode}.utoc",
    "pakchunk2070-{platformCode}.pak", "pakchunk2070-{platformCode}.sig", "pakchunk2070-{platformCode}.ucas", "pakchunk2070-{platformCode}.utoc",
    "pakchunk2800-{platformCode}.pak", "pakchunk2800-{platformCode}.sig", "pakchunk2800-{platformCode}.ucas", "pakchunk2800-{platformCode}.utoc",
    "pakchunk2801-{platformCode}.pak", "pakchunk2801-{platformCode}.sig", "pakchunk2801-{platformCode}.ucas", "pakchunk2801-{platformCode}.utoc",
    "pakchunk2802-{platformCode}.pak", "pakchunk2802-{platformCode}.sig", "pakchunk2802-{platformCode}.ucas", "pakchunk2802-{platformCode}.utoc",
    "pakchunk3501-{platformCode}.pak", "pakchunk3501-{platformCode}.sig", "pakchunk3501-{platformCode}.ucas", "pakchunk3501-{platformCode}.utoc",
    "pakchunk3502-{platformCode}.pak", "pakchunk3502-{platformCode}.sig", "pakchunk3502-{platformCode}.ucas", "pakchunk3502-{platformCode}.utoc",
    "pakchunk3503-{platformCode}.pak", "pakchunk3503-{platformCode}.sig", "pakchunk3503-{platformCode}.ucas", "pakchunk3503-{platformCode}.utoc",
    "pakchunk3504-{platformCode}.pak", "pakchunk3504-{platformCode}.sig", "pakchunk3504-{platformCode}.ucas", "pakchunk3504-{platformCode}.utoc",
    "pakchunk3505-{platformCode}.pak", "pakchunk3505-{platformCode}.sig", "pakchunk3505-{platformCode}.ucas", "pakchunk3505-{platformCode}.utoc",
    "pakchunk3506-{platformCode}.pak", "pakchunk3506-{platformCode}.sig", "pakchunk3506-{platformCode}.ucas", "pakchunk3506-{platformCode}.utoc",
    "pakchunk3507-{platformCode}.pak", "pakchunk3507-{platformCode}.sig", "pakchunk3507-{platformCode}.ucas", "pakchunk3507-{platformCode}.utoc",
    "pakchunk3508-{platformCode}.pak", "pakchunk3508-{platformCode}.sig", "pakchunk3508-{platformCode}.ucas", "pakchunk3508-{platformCode}.utoc",
    "pakchunk3509-{platformCode}.pak", "pakchunk3509-{platformCode}.sig", "pakchunk3509-{platformCode}.ucas", "pakchunk3509-{platformCode}.utoc",
    "pakchunk3511-{platformCode}.pak", "pakchunk3511-{platformCode}.sig", "pakchunk3511-{platformCode}.ucas", "pakchunk3511-{platformCode}.utoc",
    "pakchunk3512-{platformCode}.pak", "pakchunk3512-{platformCode}.sig", "pakchunk3512-{platformCode}.ucas", "pakchunk3512-{platformCode}.utoc",
    "pakchunk3513-{platformCode}.pak", "pakchunk3513-{platformCode}.sig", "pakchunk3513-{platformCode}.ucas", "pakchunk3513-{platformCode}.utoc",
    "pakchunk3514-{platformCode}.pak", "pakchunk3514-{platformCode}.sig", "pakchunk3514-{platformCode}.ucas", "pakchunk3514-{platformCode}.utoc",
    "pakchunk3515-{platformCode}.pak", "pakchunk3515-{platformCode}.sig", "pakchunk3515-{platformCode}.ucas", "pakchunk3515-{platformCode}.utoc",
    "pakchunk3516-{platformCode}.pak", "pakchunk3516-{platformCode}.sig", "pakchunk3516-{platformCode}.ucas", "pakchunk3516-{platformCode}.utoc",
    "pakchunk3517-{platformCode}.pak", "pakchunk3517-{platformCode}.sig", "pakchunk3517-{platformCode}.ucas", "pakchunk3517-{platformCode}.utoc",
    "pakchunk3518-{platformCode}.pak", "pakchunk3518-{platformCode}.sig", "pakchunk3518-{platformCode}.ucas", "pakchunk3518-{platformCode}.utoc",
    "pakchunk3519-{platformCode}.pak", "pakchunk3519-{platformCode}.sig", "pakchunk3519-{platformCode}.ucas", "pakchunk3519-{platformCode}.utoc",
    "pakchunk3520-{platformCode}.pak", "pakchunk3520-{platformCode}.sig", "pakchunk3520-{platformCode}.ucas", "pakchunk3520-{platformCode}.utoc",
    "pakchunk3521-{platformCode}.pak", "pakchunk3521-{platformCode}.sig", "pakchunk3521-{platformCode}.ucas", "pakchunk3521-{platformCode}.utoc",
    "pakchunk3522-{platformCode}.pak", "pakchunk3522-{platformCode}.sig", "pakchunk3522-{platformCode}.ucas", "pakchunk3522-{platformCode}.utoc",
    "pakchunk3523-{platformCode}.pak", "pakchunk3523-{platformCode}.sig", "pakchunk3523-{platformCode}.ucas", "pakchunk3523-{platformCode}.utoc",
    "pakchunk3524-{platformCode}.pak", "pakchunk3524-{platformCode}.sig", "pakchunk3524-{platformCode}.ucas", "pakchunk3524-{platformCode}.utoc",
    "pakchunk3525-{platformCode}.pak", "pakchunk3525-{platformCode}.sig", "pakchunk3525-{platformCode}.ucas", "pakchunk3525-{platformCode}.utoc",
    "pakchunk3526-{platformCode}.pak", "pakchunk3526-{platformCode}.sig", "pakchunk3526-{platformCode}.ucas", "pakchunk3526-{platformCode}.utoc",
    "pakchunk3527-{platformCode}.pak", "pakchunk3527-{platformCode}.sig", "pakchunk3527-{platformCode}.ucas", "pakchunk3527-{platformCode}.utoc",
    "pakchunk3528-{platformCode}.pak", "pakchunk3528-{platformCode}.sig", "pakchunk3528-{platformCode}.ucas", "pakchunk3528-{platformCode}.utoc",
    "pakchunk3529-{platformCode}.pak", "pakchunk3529-{platformCode}.sig", "pakchunk3529-{platformCode}.ucas", "pakchunk3529-{platformCode}.utoc",
    "pakchunk3530-{platformCode}.pak", "pakchunk3530-{platformCode}.sig", "pakchunk3530-{platformCode}.ucas", "pakchunk3530-{platformCode}.utoc",
    "pakchunk3531-{platformCode}.pak", "pakchunk3531-{platformCode}.sig", "pakchunk3531-{platformCode}.ucas", "pakchunk3531-{platformCode}.utoc",
    "pakchunk3532-{platformCode}.pak", "pakchunk3532-{platformCode}.sig", "pakchunk3532-{platformCode}.ucas", "pakchunk3532-{platformCode}.utoc",
    "pakchunk3533-{platformCode}.pak", "pakchunk3533-{platformCode}.sig", "pakchunk3533-{platformCode}.ucas", "pakchunk3533-{platformCode}.utoc",
    "pakchunk3534-{platformCode}.pak", "pakchunk3534-{platformCode}.sig", "pakchunk3534-{platformCode}.ucas", "pakchunk3534-{platformCode}.utoc",
    "pakchunk3536-{platformCode}.pak", "pakchunk3536-{platformCode}.sig", "pakchunk3536-{platformCode}.ucas", "pakchunk3536-{platformCode}.utoc",
    "pakchunk3537-{platformCode}.pak", "pakchunk3537-{platformCode}.sig", "pakchunk3537-{platformCode}.ucas", "pakchunk3537-{platformCode}.utoc",
    "pakchunk3538-{platformCode}.pak", "pakchunk3538-{platformCode}.sig", "pakchunk3538-{platformCode}.ucas", "pakchunk3538-{platformCode}.utoc",
    "pakchunk3539-{platformCode}.pak", "pakchunk3539-{platformCode}.sig", "pakchunk3539-{platformCode}.ucas", "pakchunk3539-{platformCode}.utoc",
    "pakchunk3701-{platformCode}.pak", "pakchunk3701-{platformCode}.sig", "pakchunk3701-{platformCode}.ucas", "pakchunk3701-{platformCode}.utoc",
    "pakchunk3702-{platformCode}.pak", "pakchunk3702-{platformCode}.sig", "pakchunk3702-{platformCode}.ucas", "pakchunk3702-{platformCode}.utoc",
    "pakchunk3703-{platformCode}.pak", "pakchunk3703-{platformCode}.sig", "pakchunk3703-{platformCode}.ucas", "pakchunk3703-{platformCode}.utoc",
    "pakchunk3704-{platformCode}.pak", "pakchunk3704-{platformCode}.sig", "pakchunk3704-{platformCode}.ucas", "pakchunk3704-{platformCode}.utoc",
    "pakchunk3705-{platformCode}.pak", "pakchunk3705-{platformCode}.sig", "pakchunk3705-{platformCode}.ucas", "pakchunk3705-{platformCode}.utoc",
    "pakchunk3706-{platformCode}.pak", "pakchunk3706-{platformCode}.sig", "pakchunk3706-{platformCode}.ucas", "pakchunk3706-{platformCode}.utoc",
    "pakchunk3707-{platformCode}.pak", "pakchunk3707-{platformCode}.sig", "pakchunk3707-{platformCode}.ucas", "pakchunk3707-{platformCode}.utoc",
    "pakchunk3708-{platformCode}.pak", "pakchunk3708-{platformCode}.sig", "pakchunk3708-{platformCode}.ucas", "pakchunk3708-{platformCode}.utoc",
    "pakchunk3709-{platformCode}.pak", "pakchunk3709-{platformCode}.sig", "pakchunk3709-{platformCode}.ucas", "pakchunk3709-{platformCode}.utoc",
    "pakchunk3710-{platformCode}.pak", "pakchunk3710-{platformCode}.sig", "pakchunk3710-{platformCode}.ucas", "pakchunk3710-{platformCode}.utoc",
    "pakchunk3712-{platformCode}.pak", "pakchunk3712-{platformCode}.sig", "pakchunk3712-{platformCode}.ucas", "pakchunk3712-{platformCode}.utoc",
    "pakchunk3713-{platformCode}.pak", "pakchunk3713-{platformCode}.sig", "pakchunk3713-{platformCode}.ucas", "pakchunk3713-{platformCode}.utoc",
    "pakchunk3714-{platformCode}.pak", "pakchunk3714-{platformCode}.sig", "pakchunk3714-{platformCode}.ucas", "pakchunk3714-{platformCode}.utoc",
    "pakchunk3715-{platformCode}.pak", "pakchunk3715-{platformCode}.sig", "pakchunk3715-{platformCode}.ucas", "pakchunk3715-{platformCode}.utoc",
    "pakchunk3716-{platformCode}.pak", "pakchunk3716-{platformCode}.sig", "pakchunk3716-{platformCode}.ucas", "pakchunk3716-{platformCode}.utoc",
    "pakchunk3717-{platformCode}.pak", "pakchunk3717-{platformCode}.sig", "pakchunk3717-{platformCode}.ucas", "pakchunk3717-{platformCode}.utoc",
    "pakchunk3718-{platformCode}.pak", "pakchunk3718-{platformCode}.sig", "pakchunk3718-{platformCode}.ucas", "pakchunk3718-{platformCode}.utoc",
    "pakchunk3719-{platformCode}.pak", "pakchunk3719-{platformCode}.sig", "pakchunk3719-{platformCode}.ucas", "pakchunk3719-{platformCode}.utoc",
    "pakchunk3720-{platformCode}.pak", "pakchunk3720-{platformCode}.sig", "pakchunk3720-{platformCode}.ucas", "pakchunk3720-{platformCode}.utoc",
    "pakchunk3721-{platformCode}.pak", "pakchunk3721-{platformCode}.sig", "pakchunk3721-{platformCode}.ucas", "pakchunk3721-{platformCode}.utoc",
    "pakchunk3722-{platformCode}.pak", "pakchunk3722-{platformCode}.sig", "pakchunk3722-{platformCode}.ucas", "pakchunk3722-{platformCode}.utoc",
    "pakchunk3723-{platformCode}.pak", "pakchunk3723-{platformCode}.sig", "pakchunk3723-{platformCode}.ucas", "pakchunk3723-{platformCode}.utoc",
    "pakchunk3724-{platformCode}.pak", "pakchunk3724-{platformCode}.sig", "pakchunk3724-{platformCode}.ucas", "pakchunk3724-{platformCode}.utoc",
    "pakchunk3725-{platformCode}.pak", "pakchunk3725-{platformCode}.sig", "pakchunk3725-{platformCode}.ucas", "pakchunk3725-{platformCode}.utoc",
    "pakchunk3726-{platformCode}.pak", "pakchunk3726-{platformCode}.sig", "pakchunk3726-{platformCode}.ucas", "pakchunk3726-{platformCode}.utoc",
    "pakchunk3727-{platformCode}.pak", "pakchunk3727-{platformCode}.sig", "pakchunk3727-{platformCode}.ucas", "pakchunk3727-{platformCode}.utoc",
    "pakchunk3728-{platformCode}.pak", "pakchunk3728-{platformCode}.sig", "pakchunk3728-{platformCode}.ucas", "pakchunk3728-{platformCode}.utoc",
    "pakchunk3729-{platformCode}.pak", "pakchunk3729-{platformCode}.sig", "pakchunk3729-{platformCode}.ucas", "pakchunk3729-{platformCode}.utoc",
    "pakchunk3730-{platformCode}.pak", "pakchunk3730-{platformCode}.sig", "pakchunk3730-{platformCode}.ucas", "pakchunk3730-{platformCode}.utoc",
    "pakchunk3731-{platformCode}.pak", "pakchunk3731-{platformCode}.sig", "pakchunk3731-{platformCode}.ucas", "pakchunk3731-{platformCode}.utoc",
    "pakchunk3732-{platformCode}.pak", "pakchunk3732-{platformCode}.sig", "pakchunk3732-{platformCode}.ucas", "pakchunk3732-{platformCode}.utoc",
    "pakchunk3733-{platformCode}.pak", "pakchunk3733-{platformCode}.sig", "pakchunk3733-{platformCode}.ucas", "pakchunk3733-{platformCode}.utoc",
    "pakchunk3734-{platformCode}.pak", "pakchunk3734-{platformCode}.sig", "pakchunk3734-{platformCode}.ucas", "pakchunk3734-{platformCode}.utoc",
    "pakchunk3735-{platformCode}.pak", "pakchunk3735-{platformCode}.sig", "pakchunk3735-{platformCode}.ucas", "pakchunk3535-{platformCode}.utoc",
    "pakchunk3736-{platformCode}.pak", "pakchunk3736-{platformCode}.sig", "pakchunk3736-{platformCode}.ucas", "pakchunk3736-{platformCode}.utoc",
    "pakchunk3737-{platformCode}.pak", "pakchunk3737-{platformCode}.sig", "pakchunk3737-{platformCode}.ucas", "pakchunk3737-{platformCode}.utoc",
    "pakchunk3738-{platformCode}.pak", "pakchunk3738-{platformCode}.sig", "pakchunk3738-{platformCode}.ucas", "pakchunk3738-{platformCode}.utoc",
    "pakchunk3739-{platformCode}.pak", "pakchunk3739-{platformCode}.sig", "pakchunk3739-{platformCode}.ucas", "pakchunk3739-{platformCode}.utoc",
    "pakchunk3740-{platformCode}.pak", "pakchunk3740-{platformCode}.sig", "pakchunk3740-{platformCode}.ucas", "pakchunk3740-{platformCode}.utoc",
    "pakchunk3742-{platformCode}.pak", "pakchunk3742-{platformCode}.sig", "pakchunk3742-{platformCode}.ucas", "pakchunk3742-{platformCode}.utoc",
    "pakchunk3743-{platformCode}.pak", "pakchunk3743-{platformCode}.sig", "pakchunk3743-{platformCode}.ucas", "pakchunk3743-{platformCode}.utoc",
    "pakchunk3744-{platformCode}.pak", "pakchunk3744-{platformCode}.sig", "pakchunk3744-{platformCode}.ucas", "pakchunk3744-{platformCode}.utoc",
    "pakchunk3745-{platformCode}.pak", "pakchunk3745-{platformCode}.sig", "pakchunk3745-{platformCode}.ucas", "pakchunk3745-{platformCode}.utoc",
    "pakchunk4001-{platformCode}.pak", "pakchunk4001-{platformCode}.sig", "pakchunk4001-{platformCode}.ucas", "pakchunk4001-{platformCode}.utoc",
    "pakchunk4100-{platformCode}.pak", "pakchunk4100-{platformCode}.sig", "pakchunk4100-{platformCode}.ucas", "pakchunk4100-{platformCode}.utoc",
    "pakchunk4101-{platformCode}.pak", "pakchunk4101-{platformCode}.sig", "pakchunk4101-{platformCode}.ucas", "pakchunk4101-{platformCode}.utoc",
    "pakchunk4102-{platformCode}.pak", "pakchunk4102-{platformCode}.sig", "pakchunk4102-{platformCode}.ucas", "pakchunk4102-{platformCode}.utoc",
    "pakchunk4103-{platformCode}.pak", "pakchunk4103-{platformCode}.sig", "pakchunk4103-{platformCode}.ucas", "pakchunk4103-{platformCode}.utoc",
    "pakchunk4104-{platformCode}.pak", "pakchunk4104-{platformCode}.sig", "pakchunk4104-{platformCode}.ucas", "pakchunk4104-{platformCode}.utoc",
    "pakchunk4105-{platformCode}.pak", "pakchunk4105-{platformCode}.sig", "pakchunk4105-{platformCode}.ucas", "pakchunk4105-{platformCode}.utoc",
    "pakchunk4106-{platformCode}.pak", "pakchunk4106-{platformCode}.sig", "pakchunk4106-{platformCode}.ucas", "pakchunk4106-{platformCode}.utoc",
    "pakchunk4107-{platformCode}.pak", "pakchunk4107-{platformCode}.sig", "pakchunk4107-{platformCode}.ucas", "pakchunk4107-{platformCode}.utoc",
    "pakchunk4108-{platformCode}.pak", "pakchunk4108-{platformCode}.sig", "pakchunk4108-{platformCode}.ucas", "pakchunk4108-{platformCode}.utoc",
    "pakchunk4109-{platformCode}.pak", "pakchunk4109-{platformCode}.sig", "pakchunk4109-{platformCode}.ucas", "pakchunk4109-{platformCode}.utoc",
    "pakchunk4110-{platformCode}.pak", "pakchunk4110-{platformCode}.sig", "pakchunk4110-{platformCode}.ucas", "pakchunk4110-{platformCode}.utoc",
    "pakchunk4111-{platformCode}.pak", "pakchunk4111-{platformCode}.sig", "pakchunk4111-{platformCode}.ucas", "pakchunk4111-{platformCode}.utoc",
    "pakchunk4112-{platformCode}.pak", "pakchunk4112-{platformCode}.sig", "pakchunk4112-{platformCode}.ucas", "pakchunk4112-{platformCode}.utoc",
    "pakchunk4113-{platformCode}.pak", "pakchunk4113-{platformCode}.sig", "pakchunk4113-{platformCode}.ucas", "pakchunk4113-{platformCode}.utoc",
    "pakchunk4114-{platformCode}.pak", "pakchunk4114-{platformCode}.sig", "pakchunk4114-{platformCode}.ucas", "pakchunk4114-{platformCode}.utoc",
    "pakchunk4115-{platformCode}.pak", "pakchunk4115-{platformCode}.sig", "pakchunk4115-{platformCode}.ucas", "pakchunk4115-{platformCode}.utoc",
    "pakchunk4116-{platformCode}.pak", "pakchunk4116-{platformCode}.sig", "pakchunk4116-{platformCode}.ucas", "pakchunk4116-{platformCode}.utoc",
    "pakchunk4117-{platformCode}.pak", "pakchunk4117-{platformCode}.sig", "pakchunk4117-{platformCode}.ucas", "pakchunk4117-{platformCode}.utoc",
    "pakchunk4118-{platformCode}.pak", "pakchunk4118-{platformCode}.sig", "pakchunk4118-{platformCode}.ucas", "pakchunk4118-{platformCode}.utoc",
    "pakchunk4119-{platformCode}.pak", "pakchunk4119-{platformCode}.sig", "pakchunk4119-{platformCode}.ucas", "pakchunk4119-{platformCode}.utoc",
    "pakchunk4120-{platformCode}.pak", "pakchunk4120-{platformCode}.sig", "pakchunk4120-{platformCode}.ucas", "pakchunk4120-{platformCode}.utoc",
    "pakchunk4121-{platformCode}.pak", "pakchunk4121-{platformCode}.sig", "pakchunk4121-{platformCode}.ucas", "pakchunk4121-{platformCode}.utoc",
    "pakchunk4900-{platformCode}.pak", "pakchunk4900-{platformCode}.sig", "pakchunk4900-{platformCode}.ucas", "pakchunk4900-{platformCode}.utoc",
    "pakchunk4999-{platformCode}.pak", "pakchunk4999-{platformCode}.sig", "pakchunk4999-{platformCode}.ucas", "pakchunk4999-{platformCode}.utoc",
    "pakchunk5001-{platformCode}.pak", "pakchunk5001-{platformCode}.sig", "pakchunk5001-{platformCode}.ucas", "pakchunk5001-{platformCode}.utoc",
    "pakchunk5003-{platformCode}.pak", "pakchunk5003-{platformCode}.sig", "pakchunk5003-{platformCode}.ucas", "pakchunk5003-{platformCode}.utoc",
    "pakchunk5004-{platformCode}.pak", "pakchunk5004-{platformCode}.sig", "pakchunk5004-{platformCode}.ucas", "pakchunk5004-{platformCode}.utoc",
    "pakchunk5005-{platformCode}.pak", "pakchunk5005-{platformCode}.sig", "pakchunk5005-{platformCode}.ucas", "pakchunk5005-{platformCode}.utoc",
    "pakchunk5995-{platformCode}.pak", "pakchunk5995-{platformCode}.sig", "pakchunk5995-{platformCode}.ucas", "pakchunk5995-{platformCode}.utoc",
    "pakchunk5996-{platformCode}.pak", "pakchunk5996-{platformCode}.sig", "pakchunk5996-{platformCode}.ucas", "pakchunk5996-{platformCode}.utoc",
    "pakchunk5998-{platformCode}.pak", "pakchunk5998-{platformCode}.sig", "pakchunk5998-{platformCode}.ucas", "pakchunk5998-{platformCode}.utoc",
    "pakchunk5999-{platformCode}.pak", "pakchunk5999-{platformCode}.sig", "pakchunk5999-{platformCode}.ucas", "pakchunk5999-{platformCode}.utoc",
    "pakchunk6000-{platformCode}.pak", "pakchunk6000-{platformCode}.sig", "pakchunk6000-{platformCode}.ucas", "pakchunk6000-{platformCode}.utoc"
];


let mainWindow;
let appSettings = {
    modFolderPath: '',
    pakFolderPath: '', // legacy single target, kept for backward compatibility
    language: 'english',
    platform: 'steam', // legacy, kept for backward compatibility
    deployTargets: [], // [{ id, platform, pakFolderPath, installRoot, autoDetected }, ...]
    downloadsWatchPath: '', // empty = use the OS default Downloads folder
    trainerZipPath: '', // zip containing the trainer .exe, re-extracted fresh on every launch
    spooferZipPath: '', // zip containing the spoofer .exe, re-extracted fresh on every launch
    // per-platform overrides for the game's launch executable — only needed
    // when auto-detection (via deployTargets) picks the wrong file
    gameLaunchPaths: { Steam: '', 'Epic Games': '', Microsoft: '' }
};

// Relative to a deploy target's installRoot, where each platform's real
// launch executable lives. Steam has no entry — Steam games are launched via
// the steam:// protocol instead (more reliable than invoking the exe
// directly, since it needs the Steam client's API layer initialized).
// - Epic: same Unreal Engine layout as Steam — a thin stub exe sits at the
//   root of the install folder (NOT the one under DeadByDaylight\Binaries\Win64,
//   which is the raw shipping exe and skips platform/anti-cheat init).
// - Microsoft (Xbox/Game Pass): the package is MSIX, so the shipping exe
//   can't be run directly (breaks its app-identity, same failure mode as
//   copying notepad.exe elsewhere) — "gamelaunchhelper.exe" in the install's
//   Content folder is the same helper the Xbox app itself uses to launch it.
const GAME_LAUNCH_RELATIVE_EXE = {
    'Epic Games': 'DeadByDaylight.exe',
    'Microsoft': 'gamelaunchhelper.exe',
};

/**
 * Resolve the exe to launch the game with for a given platform label
 * ('Steam' | 'Epic Games' | 'Microsoft'): a user-set override in Settings
 * wins if present, otherwise it's derived from the matching deploy target's
 * installRoot using the known layout for that platform.
 */
function resolveGameLaunchPath(platformLabel) {
    const override = appSettings.gameLaunchPaths && appSettings.gameLaunchPaths[platformLabel];
    if (override) return override;
    const relExe = GAME_LAUNCH_RELATIVE_EXE[platformLabel];
    if (!relExe) return null;
    const target = (appSettings.deployTargets || []).find(t => t.platform === platformLabel);
    if (!target) return null;
    return path.join(target.installRoot, relExe);
}
let installedMods = {}; // { modName: { originalFiles: [], installedFiles: [] } }

function createWindow() {
    const preloadPath = path.join(__dirname, 'preload.js');
    console.log(`main: preload script path: ${preloadPath}`); // log preload path

    mainWindow = new BrowserWindow({
        width: 1100,
        height: 750,
        minWidth: 800,
        minHeight: 600,
        frame: false, // <--- important: this removes the default title bar
        webPreferences: {
            preload: preloadPath, // ensure preload script is loaded
            nodeIntegration: false, // keep false for security
            contextIsolation: true, // keep true for security
            sandbox: false // disabled sandbox for debugging ipc issues
        },
        icon: path.join(__dirname, 'build/icon.ico') // set application icon
    });

    // define the application menu (optional, but good practice)
    const template = [
        {
            label: 'file',
            submenu: [
                { role: 'quit' }
            ]
        },
        {
            label: 'edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'delete' },
                { type: 'separator' },
                { role: 'selectAll' }
            ]
        },
        {
            label: 'view',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' },
                { // add devtools toggle back for debugging
                    label: 'toggle developer tools',
                    accelerator: process.platform === 'darwin' ? 'alt+command+i' : 'ctrl+shift+i',
                    click(item, focusedWindow) {
                        if (focusedWindow) focusedWindow.webContents.toggleDevTools();
                    }
                }
            ]
        },
        {
            label: 'window',
            submenu: [
                { role: 'minimize' },
                { role: 'zoom' },
                { role: 'close' }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);

    mainWindow.loadFile('index.html');

    // add a listener for when the renderer process has finished loading
    mainWindow.webContents.on('did-finish-load', () => {
        console.log("main: renderer process has finished loading.");
        logToConsole('renderer process loaded.', 'system');
        // optionally open devtools on start for easier debugging
        // mainWindow.webContents.openDevTools();
    });
}

// function to log messages to the console tab
function logToConsole(message, type = 'info') {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('log-message', { message, type, timestamp: new Date().toLocaleTimeString() });
    }
}

// initialize settings and installed mods on app ready
app.whenReady().then(async () => {
    logToConsole('application started.', 'system');

    // ensure app data directory exist
    await fs.ensureDir(appDataPath);

    // load settings
    try {
        if (await fs.pathExists(settingsFilePath)) {
            const data = await fs.readFile(settingsFilePath, 'utf8');
            appSettings = { ...appSettings, ...JSON.parse(data) };
            logToConsole('settings loaded successfully.', 'system');
        } else {
            // save default settings if file doesn't exist
            await fs.writeFile(settingsFilePath, JSON.stringify(appSettings, null, 2));
            logToConsole('default settings created.', 'system');
        }
    } catch (error) {
        logToConsole(`error loading settings: ${error.message}`, 'error');
    }

    // one-time migration: fold a legacy single pakFolderPath into deployTargets
    // so existing users automatically keep their current setup as one target —
    // but only if it's actually a real install, not a stale/empty leftover path.
    if (!Array.isArray(appSettings.deployTargets)) appSettings.deployTargets = [];
    if (appSettings.deployTargets.length === 0 && appSettings.pakFolderPath && gameScanner.hasPakFiles(appSettings.pakFolderPath)) {
        mergeDeployTargets([{
            platform: appSettings.platform || 'Steam', // legacy setting is already a final label
            installRoot: '',
            pakFolderPath: appSettings.pakFolderPath,
        }]);
        await persistSettings();
        logToConsole('migrated legacy pak folder path into deploy targets.', 'system');
    }

    // prune any existing deploy target (from migration, an earlier auto-detect,
    // or manual entry) that no longer has real pak files — catches stale/moved
    // installs (e.g. a game that used to be on one drive and got moved) so they
    // don't linger as phantom targets indefinitely.
    if (Array.isArray(appSettings.deployTargets) && appSettings.deployTargets.length > 0) {
        const before = appSettings.deployTargets.length;
        const stale = appSettings.deployTargets.filter(t => !gameScanner.hasPakFiles(t.pakFolderPath));
        appSettings.deployTargets = appSettings.deployTargets.filter(t => gameScanner.hasPakFiles(t.pakFolderPath));
        if (stale.length > 0) {
            for (const t of stale) {
                logToConsole(`removed stale deploy target (no pak files found): [${t.platform}] ${t.pakFolderPath}`, 'warn');
            }
            await persistSettings();
        }
    }

    // load installed mods
    try {
        if (await fs.pathExists(installedModsFilePath)) {
            const data = await fs.readFile(installedModsFilePath, 'utf8');
            installedMods = JSON.parse(data);
            // migrate old records (pre per-target disabled_mods rework): they only
            // ever existed while a mod was actively deployed, so treat them as enabled
            let migrated = 0;
            for (const [modName, record] of Object.entries(installedMods)) {
                if (!record.filesByTarget) {
                    record.filesByTarget = record.installedFilesByTarget || {};
                    delete record.installedFilesByTarget;
                    record.enabled = true;
                    migrated++;
                }
            }
            if (migrated > 0) {
                await fs.writeFile(installedModsFilePath, JSON.stringify(installedMods, null, 2));
                logToConsole(`migrated ${migrated} mod record(s) to the new toggle format.`, 'system');
            }
            logToConsole('installed mods data loaded successfully.', 'system');
        } else {
            // save empty installed mods if file doesn't exist
            await fs.writeFile(installedModsFilePath, JSON.stringify(installedMods, null, 2));
            logToConsole('empty installed mods data created.', 'system');
        }
    } catch (error) {
        logToConsole(`error loading installed mods: ${error.message}`, 'error');
    }

    // watch the mods library for newly-dropped archives
    setupModsWatcher();
    setupDownloadsWatcher();
    await loadModProfiles();

    createWindow();

    // reconcile toggle state with what's actually deployed, in case
    // anything changed outside the app (manual file edits, a crash mid-toggle, etc.)
    await reconcileModState();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// ipc handlers for window controls
ipcMain.on('minimize-window', () => {
    console.log("main: received minimize-window ipc."); // debug log
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.minimize();
        logToConsole('window minimize request processed.', 'system');
    } else {
        logToConsole('failed to minimize window: mainwindow is invalid or destroyed.', 'error');
    }
});

ipcMain.on('maximize-window', () => {
    console.log("main: received maximize-window ipc."); // debug log
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
            logToConsole('window unmaximized processed.', 'system');
        } else {
            mainWindow.maximize();
            logToConsole('window maximized processed.', 'system');
        }
    } else {
        logToConsole('failed to maximize/unmaximize window: mainwindow is invalid or destroyed.', 'error');
    }
});

ipcMain.on('close-window', () => {
    console.log("main: received close-window ipc."); // debug log
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.close();
        logToConsole('window close request processed.', 'system');
    } else {
        logToConsole('failed to close window: mainwindow is invalid or destroyed.', 'error');
    }
});


// handle opening folder dialog
ipcMain.handle('open-folder-dialog', async (event) => {
    logToConsole('opening folder selection dialog...', 'info');
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
    if (!canceled && filePaths.length > 0) {
        logToConsole(`folder selected: ${filePaths[0]}`, 'info');
        return filePaths[0];
    }
    logToConsole('folder selection canceled.', 'info');
    return null;
});

// handle opening file dialog
ipcMain.handle('open-discord-invite', async () => {
    const url = 'https://fmp.su';
    logToConsole(`opening: ${url}`, 'info');
    await shell.openExternal(url);
});

ipcMain.handle('open-file-dialog', async (event, filters) => {
    logToConsole(`opening file selection dialog with filters: ${JSON.stringify(filters)}`, 'info');
    const options = {
        properties: ['openFile', 'multiSelections'], // allow multiple file selections
        filters: filters
    };
    if (appSettings.modFolderPath) {
        options.defaultPath = appSettings.modFolderPath;
    }
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, options);
    if (!canceled && filePaths.length > 0) {
        logToConsole(`files selected: ${filePaths.join(', ')}`, 'info');
        return filePaths; // return array of file paths
    }
    logToConsole('file selection canceled.', 'info');
    return null;
});


// handle saving settings
ipcMain.handle('save-settings', async (event, settings) => {
    try {
        appSettings = { ...appSettings, ...settings };
        await fs.writeFile(settingsFilePath, JSON.stringify(appSettings, null, 2));
        logToConsole('settings saved successfully.', 'system');
        return { success: true };
    } catch (error) {
        logToConsole(`error saving settings: ${error.message}`, 'error');
        return { success: false, error: error.message };
    }
});

// handle loading settings
ipcMain.handle('load-settings', async () => {
    logToConsole('loading settings...', 'info');
    return appSettings;
});

/**
 * Extract a zip's contents to destDir, retrying with backoff if a target file
 * is transiently locked. Some self-deleting exes don't delete themselves
 * instantly — they exit and leave a helper (a spawned script waiting on the
 * PID, or the OS's own delete-pending handle) to remove the file a moment
 * later. Re-extracting immediately after closing the game/tool can race that
 * cleanup and hit EBUSY/EPERM on the old file.
 */
async function extractZipWithRetry(zip, destDir, label) {
    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            zip.extractAllTo(destDir, true);
            return;
        } catch (error) {
            const isLockError = /EBUSY|EPERM|EACCES/i.test(error.message || '');
            if (!isLockError || attempt === maxAttempts) {
                throw error;
            }
            logToConsole(`${label} exe still in use by the previous run, retrying extraction (${attempt}/${maxAttempts})...`, 'info');
            await new Promise(r => setTimeout(r, 500));
        }
    }
}

/**
 * Extract a tool zip (trainer/spoofer) fresh into the SAME folder the zip
 * lives in, then launch the .exe found inside. This is deliberate, not
 * arbitrary: these tools often keep companion data (auth/config files) sitting
 * next to the zip, outside the zip itself, that the exe reads on startup.
 * Extracting to an isolated scratch/temp folder strips the exe away from that
 * data and it silently fails. The exe self-deletes after each run, so the zip
 * is the durable source of truth and every launch re-extracts from it.
 */
const trainerDebugLogPath = path.join(appDataPath, 'trainer-debug.log');

/**
 * Append a timestamped line to a dedicated debug log on disk (separate from
 * the in-app console tab, which isn't persisted anywhere readable outside
 * the running window). Used to build a full timeline of a trainer/spoofer
 * launch attempt that survives after the fact, regardless of whether anyone
 * was watching the console tab live.
 */
async function appendDebugLog(message) {
    const line = `${new Date().toISOString()} ${message}\n`;
    try {
        await fs.appendFile(trainerDebugLogPath, line);
    } catch { /* best-effort */ }
}

// Tracks folders with a currently-confirmed-running launch, so a second
// click can't stack a duplicate instance on top of one that's still alive.
// This matters beyond tidiness: these tools authenticate using a shared
// session/license token (the auth file sitting next to the zip) — two live
// copies fighting over the same token is a very plausible reason a perfectly
// good launch gets killed a few seconds after a second click, since the
// verification check only confirms "something is running in this folder,"
// not "the specific instance THIS click started."
const activeToolRuns = new Map(); // destDir -> runningAs

// Thrown for permanent config problems (missing zip, no exe in it, etc.) —
// retrying those automatically would just fail the same way 4 times in a
// row for no benefit, so the retry loop below skips straight past them.
class NonRetryableError extends Error {}
class CancelledError extends NonRetryableError {}

// Folders (destDir) with a cancellation flagged — checked between retries
// so clicking cancel during the backoff wait actually stops things promptly
// instead of waiting out the rest of it.
const cancelRequested = new Set();

function consumeCancelFlag(destDir) {
    if (destDir && cancelRequested.has(destDir)) {
        cancelRequested.delete(destDir);
        return true;
    }
    return false;
}

/** Sleeps up to ms, but returns early (true) the moment a cancel is flagged for destDir. */
async function sleepOrCancel(ms, destDir) {
    const step = 250;
    let waited = 0;
    while (waited < ms) {
        if (destDir && cancelRequested.has(destDir)) return true;
        const chunk = Math.min(step, ms - waited);
        await new Promise(r => setTimeout(r, chunk));
        waited += chunk;
    }
    return !!(destDir && cancelRequested.has(destDir));
}

/**
 * Extract+launch, retrying automatically — and indefinitely — if the tool
 * never actually starts (nothing appears running in its folder a few
 * seconds after launch), instead of making the user notice and click
 * launch again themselves. Config problems (missing zip, no exe in it,
 * etc.) still fail immediately via NonRetryableError — no amount of
 * retrying fixes a bad path.
 *
 * Does NOT retry just because the tool later disappears from its folder —
 * that used to be treated as a crash (a ~14s "danger window" after startup)
 * but these tools commonly rename themselves or hand off to a different
 * process shortly after launching, which looks identical to "died" to a
 * check that only confirms "something is running in this folder." That
 * produced false-positive retries that stacked duplicate elevated launches
 * on top of a perfectly fine running tool while the UI sat on "launching..."
 * indefinitely. See attemptExtractAndLaunch: success is now declared as
 * soon as the startup check confirms something is running at all.
 */
async function extractAndLaunchToolFromZip(zipPath, label) {
    const destDir = zipPath ? path.dirname(zipPath) : null;
    if (destDir) cancelRequested.delete(destDir); // clear any stale flag from a previous run
    for (let attempt = 1; ; attempt++) {
        if (consumeCancelFlag(destDir)) {
            await appendDebugLog(`${label} launch cancelled by user before attempt ${attempt}`);
            throw new CancelledError(`${label} launch cancelled.`);
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('tool-launch-progress', { label, attempt, status: 'trying' });
        }
        try {
            const result = await attemptExtractAndLaunch(zipPath, label, attempt);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('tool-launch-progress', { label, attempt, status: 'succeeded' });
            }
            return result;
        } catch (error) {
            await appendDebugLog(`attempt ${attempt} failed: ${error.message}`);
            if (error instanceof NonRetryableError) {
                throw error; // config problem, or a cancel — retrying won't help either way
            }
            // Backs off up to 20s between attempts so this doesn't hammer
            // fmp.su's server if it's genuinely down, while still trying
            // often enough to catch it the moment it recovers.
            const delayMs = Math.min(2000 * attempt, 20000);
            logToConsole(`${label} attempt ${attempt} didn't stick (${error.message}). Retrying automatically in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1})...`, 'warn');
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('tool-launch-progress', { label, attempt, status: 'waiting', delayMs, nextAttempt: attempt + 1 });
            }
            const cancelledDuringWait = await sleepOrCancel(delayMs, destDir);
            if (cancelledDuringWait) {
                consumeCancelFlag(destDir);
                await appendDebugLog(`${label} launch cancelled by user during retry backoff`);
                throw new CancelledError(`${label} launch cancelled.`);
            }
        }
    }
}

async function attemptExtractAndLaunch(zipPath, label, attempt) {
    await appendDebugLog(`=== ${label} launch attempt started (try ${attempt}) ===`);
    if (!zipPath) {
        await appendDebugLog(`FAIL: no zip path configured`);
        throw new NonRetryableError(`set the ${label} zip path in settings first.`);
    }
    if (!(await fs.pathExists(zipPath))) {
        await appendDebugLog(`FAIL: zip not found at ${zipPath}`);
        throw new NonRetryableError(`${label} zip not found at: ${zipPath}`);
    }
    const destDir = path.dirname(zipPath);

    const trackedRunningAs = activeToolRuns.get(destDir);
    if (trackedRunningAs) {
        const stillAlive = await findRunningProcessInDir(destDir, 1);
        if (stillAlive) {
            await appendDebugLog(`REFUSED: ${label} is already running as "${stillAlive}" — refusing to launch a duplicate (two copies can conflict over the same license/session and get both kicked).`);
            throw new NonRetryableError(`${label} is already running (as "${stillAlive}"). Launching a second copy risks conflicting with it over the same license/session and getting both kicked. If you don't see its window, check behind this one or Alt-Tab — don't click launch again.`);
        }
        activeToolRuns.delete(destDir); // it actually exited — stale entry, clear it
    }

    const zip = new AdmZip(zipPath);
    const exeEntry = zip.getEntries().find(e => !e.isDirectory && e.entryName.toLowerCase().endsWith('.exe'));
    if (!exeEntry) {
        await appendDebugLog(`FAIL: no .exe entry found in zip`);
        throw new NonRetryableError(`no .exe found inside the ${label} zip.`);
    }
    await appendDebugLog(`extracting into ${destDir}, exe entry: ${exeEntry.entryName}`);
    logToConsole(`extracting ${label} zip into: ${destDir}`, 'info');
    await extractZipWithRetry(zip, destDir, label);
    const exePath = path.join(destDir, exeEntry.entryName);
    if (!(await fs.pathExists(exePath))) {
        await appendDebugLog(`FAIL: extracted exe missing at ${exePath} right after extraction`);
        throw new Error(`extraction reported success but ${exePath} is missing — antivirus may have quarantined it. check your AV's quarantine/threat history.`);
    }
    await appendDebugLog(`extraction confirmed on disk: ${exePath} (${(await fs.stat(exePath)).size} bytes)`);
    logToConsole(`launching ${label} (as administrator): ${exePath}`, 'info');
    try {
        await launchElevated(exePath, destDir);
        await appendDebugLog(`launchElevated() returned without error`);
    } catch (launchError) {
        await appendDebugLog(`FAIL: launchElevated() threw: ${launchError.message}`);
        throw launchError;
    }

    // Don't just trust that the launch command didn't error — actually check
    // whether something is still running from this folder. These tools
    // commonly rename themselves and run resident with no window, which
    // looks identical to "silently failed and exited" unless we check.
    let runningAs = null;
    for (let i = 0; i < 6; i++) {
        const name = await findRunningProcessInDir(destDir, 1);
        await appendDebugLog(`startup check #${i + 1}: ${name ? `running as "${name}"` : 'NOT running'}`);
        if (name) { runningAs = name; break; }
        await new Promise(r => setTimeout(r, 500));
    }
    if (!runningAs) {
        await appendDebugLog(`=== FAILED: nothing running from ${destDir} shortly after launch ===`);
        throw new Error(`${label} was launched but nothing is running from "${destDir}" a few seconds later. This usually means: the UAC prompt was denied or never appeared, antivirus/SmartScreen blocked it, or it requires the game to already be running.`);
    }

    // Success is declared here, as soon as something is confirmed running —
    // NOT after watching it survive a longer window first. A ~14s
    // "danger window" used to sit here, treating any later disappearance as
    // a crash and retrying indefinitely, but these tools commonly rename
    // themselves or hand off to a different process shortly after launch,
    // which looks identical to "died" to a check that only confirms
    // "something is running in this folder" — the tool was fine and its
    // window stayed open the whole time. Retrying only happens now for a
    // real failure (the startup check above finding nothing at all).
    await appendDebugLog(`confirmed running as "${runningAs}"`);
    activeToolRuns.set(destDir, runningAs);

    // Keep watching a while longer anyway, unawaited, purely for the debug
    // log's sake and to keep activeToolRuns accurate for the duplicate-launch
    // guard above — this does NOT affect success/failure or trigger retries.
    (async () => {
        for (let i = 1; i <= 24; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const name = await findRunningProcessInDir(destDir, 1);
            await appendDebugLog(`background watch t+${i}s (informational only): ${name ? `still running as "${name}"` : 'no longer running from this folder (may just have handed off elsewhere)'}`);
            if (name) { activeToolRuns.set(destDir, name); } else { activeToolRuns.delete(destDir); break; }
        }
        await appendDebugLog(`=== background watch ended ===`);
    })();

    const confirmation = `${label} confirmed running as "${runningAs}" — its window should now be in front. If you don't see it, check behind this window or Alt-Tab.`;
    logToConsole(confirmation, 'success');
    return { exePath, confirmation };
}

/**
 * Poll for any running process whose executable path is inside `dir`,
 * for up to timeoutMs. Used to verify a launched tool is actually still
 * alive (rather than trusting the launch command didn't error), since tools
 * that rename themselves and run with no window are indistinguishable from
 * "silently exited" without an actual process check.
 */
async function findRunningProcessInDir(dir, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const psCommand = `(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${dir.replace(/'/g, "''")}\\*' } | Select-Object -First 1 -ExpandProperty Name)`;
    while (Date.now() < deadline) {
        const name = await new Promise((resolve) => {
            execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], (error, stdout) => {
                resolve(error ? null : (stdout || '').trim() || null);
            });
        });
        if (name) return name;
        await new Promise(r => setTimeout(r, 500));
    }
    return null;
}

/**
 * Launch an exe elevated (UAC "run as administrator"), with an explicit
 * working directory so it can find files sitting next to it via relative
 * paths. shell.openPath only elevates when the target's own manifest
 * requests it — a lot of trainer/cheat stubs don't declare that and just
 * silently exit the moment they detect they're not elevated, which looks
 * identical to "nothing happened." Forcing the runas verb via PowerShell's
 * Start-Process sidesteps both that and any missing-manifest gap, and also
 * surfaces a real error if the user cancels the UAC prompt (shell.openPath
 * gives no signal for that at all).
 *
 * It DOES have a real window (confirmed: title "Launcher", normal on-screen
 * position, not minimized) — it just never gets focus, because Windows
 * blocks a lower-privilege window (the mod manager) from stealing foreground
 * away to hand it to a higher-privilege one (the elevated tool). It opens
 * directly behind the mod manager and looks invisible unless you Alt-Tab.
 * Since this PowerShell instance is itself elevated (same integrity level as
 * the launched tool), it CAN force-activate that window — so after starting
 * the process, and again after any self-rename settles, it calls
 * WScript.Shell's AppActivate on every process now running from workingDir
 * to bring the real UI to the front automatically.
 */
function launchElevated(exePath, workingDir) {
    return new Promise((resolve, reject) => {
        const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;
        const dirEscaped = workingDir.replace(/'/g, "''");
        const psCommand = [
            `$p = Start-Process -FilePath ${psQuote(exePath)} -WorkingDirectory ${psQuote(workingDir)} -Verb RunAs -PassThru`,
            `$shell = New-Object -ComObject WScript.Shell`,
            `Start-Sleep -Milliseconds 1200`,
            `try { $shell.AppActivate($p.Id) | Out-Null } catch {}`,
            `Start-Sleep -Milliseconds 800`,
            `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${dirEscaped}\\*' } | ForEach-Object { try { $shell.AppActivate($_.ProcessId) | Out-Null } catch {} }`,
        ].join('; ');
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`elevation was cancelled or failed (${(stderr || error.message).trim()})`));
                return;
            }
            resolve();
        });
    });
}

ipcMain.handle('launch-trainer', async () => {
    try {
        const { confirmation } = await extractAndLaunchToolFromZip(appSettings.trainerZipPath, 'trainer');
        return { success: true, message: confirmation };
    } catch (error) {
        logToConsole(`error launching trainer: ${error.message}`, 'error');
        return { success: false, error: error.message };
    }
});

ipcMain.handle('launch-spoofer', async () => {
    try {
        const { confirmation } = await extractAndLaunchToolFromZip(appSettings.spooferZipPath, 'spoofer');
        return { success: true, message: confirmation };
    } catch (error) {
        logToConsole(`error launching spoofer: ${error.message}`, 'error');
        return { success: false, error: error.message };
    }
});

// stops an in-progress trainer/spoofer launch's automatic retries — the
// exe from whatever attempt is currently running is left alone (it may
// still be alive and useful), this just stops us from re-extracting and
// re-launching another copy on its behalf
ipcMain.handle('cancel-tool-launch', async (event, label) => {
    const zipPath = label === 'trainer' ? appSettings.trainerZipPath : appSettings.spooferZipPath;
    if (!zipPath) return { success: false };
    const destDir = path.dirname(zipPath);
    cancelRequested.add(destDir);
    logToConsole(`cancelling ${label} launch retries...`, 'info');
    return { success: true };
});

// what to tell the user to browse to, in settings, if auto-detection picked
// the wrong exe (or none) for a given platform
const GAME_LAUNCH_HINT = {
    'Steam': `select "DeadByDaylight.exe" in the root of the game's install folder (steamapps\\common\\Dead by Daylight\\DeadByDaylight.exe) — only needed if the Steam client itself can't be reached.`,
    'Epic Games': `select "DeadByDaylight.exe" in the root of the game's install folder — NOT the one inside "DeadByDaylight\\Binaries\\Win64", which skips anti-cheat/platform init and won't launch correctly.`,
    'Microsoft': `select "gamelaunchhelper.exe" — it sits directly inside the game's install folder (the same "Content" folder shown as this platform's location in settings). Don't pick the "...-WinGDK-Shipping.exe" — running it directly breaks the game's Store app identity and it will fail to start.`,
};

ipcMain.handle('launch-game', async (event, platformLabel) => {
    try {
        if (platformLabel === 'Steam') {
            const override = appSettings.gameLaunchPaths && appSettings.gameLaunchPaths.Steam;
            if (override) {
                if (!(await fs.pathExists(override))) {
                    throw new Error(`steam launch path not found: ${override}. ${GAME_LAUNCH_HINT.Steam}`);
                }
                logToConsole(`launching game (Steam, via configured exe): ${override}`, 'info');
                const openError = await shell.openPath(override);
                if (openError) throw new Error(`failed to launch: ${openError}`);
            } else {
                const steamUrl = `steam://rungameid/${gameScanner.DBD_CONFIG.steamAppId}`;
                logToConsole(`launching game (Steam, via ${steamUrl})`, 'info');
                await shell.openExternal(steamUrl);
            }
            return { success: true };
        }

        const exePath = resolveGameLaunchPath(platformLabel);
        const hint = GAME_LAUNCH_HINT[platformLabel] || '';
        if (!exePath) {
            throw new Error(`no ${platformLabel} game install found. add it under settings > game install locations, or manually set the ${platformLabel} launch path there. ${hint}`);
        }
        if (!(await fs.pathExists(exePath))) {
            throw new Error(`launch executable not found: ${exePath}. ${hint}`);
        }
        logToConsole(`launching game (${platformLabel}): ${exePath}`, 'info');
        const openError = await shell.openPath(exePath);
        if (openError) {
            throw new Error(`failed to launch: ${openError}`);
        }
        return { success: true };
    } catch (error) {
        logToConsole(`error launching game (${platformLabel}): ${error.message}`, 'error');
        return { success: false, error: error.message };
    }
});


// handle getting installed mods
ipcMain.handle('get-installed-mods', async () => {
    logToConsole('retrieving installed mods data.', 'info');
    return installedMods;
});

// handle mod conflict detection
ipcMain.handle('get-mod-conflicts', async () => {
    // map: "targetId::installed file name" -> [modName, ...] so the same
    // filename in two different game folders isn't flagged as a conflict.
    // only currently-enabled mods can actually conflict on disk.
    const fileToMods = {};
    for (const [modName, modData] of Object.entries(installedMods)) {
        if (!modData.enabled) continue;
        const filesByTarget = modData.filesByTarget || {};
        for (const [targetId, files] of Object.entries(filesByTarget)) {
            for (const fileObj of files) {
                const key = `${targetId}::${fileObj.installed}`;
                if (!fileToMods[key]) fileToMods[key] = [];
                fileToMods[key].push(modName);
            }
        }
    }
    // find files installed by more than one mod in the same target
    const conflicts = [];
    for (const [key, mods] of Object.entries(fileToMods)) {
        if (mods.length > 1) {
            conflicts.push({ file: key.split('::')[1], mods });
        }
    }
    return conflicts;
});

// --- mod profiles: named snapshots of "which mods are currently enabled",
// so a user can flip between different mod loadouts without re-toggling
// everything by hand each time. Stored as plain JSON: { profileName: [modName, ...] }
const modProfilesFilePath = path.join(appDataPath, 'mod_profiles.json');
let modProfiles = {};

async function loadModProfiles() {
    try {
        if (await fs.pathExists(modProfilesFilePath)) {
            modProfiles = JSON.parse(await fs.readFile(modProfilesFilePath, 'utf8'));
        }
    } catch (error) {
        logToConsole(`error loading mod profiles: ${error.message}`, 'error');
        modProfiles = {};
    }
}

async function saveModProfilesFile() {
    await fs.writeFile(modProfilesFilePath, JSON.stringify(modProfiles, null, 2));
}

ipcMain.handle('save-mod-profile', async (event, profileName) => {
    if (!profileName || !profileName.trim()) {
        return { success: false, error: 'profile name is required.' };
    }
    const name = profileName.trim();
    const enabledMods = Object.entries(installedMods).filter(([, r]) => r.enabled).map(([n]) => n);
    modProfiles[name] = enabledMods;
    try {
        await saveModProfilesFile();
        logToConsole(`saved mod profile '${name}' with ${enabledMods.length} mod(s).`, 'success');
        return { success: true, profiles: modProfiles };
    } catch (error) {
        logToConsole(`failed to save mod profile '${name}': ${error.message}`, 'error');
        return { success: false, error: error.message };
    }
});

ipcMain.handle('load-mod-profile', async (event, profileName) => {
    const targetModNames = modProfiles[profileName];
    if (!targetModNames) {
        return { success: false, error: 'profile not found.' };
    }
    logToConsole(`loading mod profile '${profileName}' (${targetModNames.length} mod(s))...`, 'info');

    try {
        const libraryFiles = await listLibraryModFiles();
        const libraryByName = {};
        for (const entry of libraryFiles) libraryByName[entry.name] = entry;

        const currentlyEnabled = new Set(Object.entries(installedMods).filter(([, r]) => r.enabled).map(([n]) => n));
        const shouldBeEnabled = new Set(targetModNames);

        let enabledCount = 0, disabledCount = 0, missingCount = 0;

        // disable anything currently on that shouldn't be in this profile
        for (const modName of currentlyEnabled) {
            if (!shouldBeEnabled.has(modName)) {
                await performUninstall(modName);
                disabledCount++;
            }
        }
        // enable anything this profile wants that isn't already on
        for (const modName of shouldBeEnabled) {
            if (currentlyEnabled.has(modName)) continue; // already on
            const entry = libraryByName[modName];
            if (!entry) {
                logToConsole(`profile '${profileName}' references '${modName}', which is no longer in the mod library — skipping.`, 'warn');
                missingCount++;
                continue;
            }
            await performInstall(modName, entry.fullPath);
            enabledCount++;
        }

        logToConsole(`profile '${profileName}' loaded: ${enabledCount} enabled, ${disabledCount} disabled, ${missingCount} missing.`, 'success');
        return { success: true, enabledCount, disabledCount, missingCount };
    } catch (error) {
        logToConsole(`failed to load mod profile '${profileName}': ${error.message}`, 'error');
        return { success: false, error: error.message };
    }
});

ipcMain.handle('list-mod-profiles', async () => {
    return Object.keys(modProfiles).map(name => ({ name, modCount: (modProfiles[name] || []).length }));
});

ipcMain.handle('delete-mod-profile', async (event, profileName) => {
    if (!(profileName in modProfiles)) {
        return { success: false, error: 'profile not found.' };
    }
    delete modProfiles[profileName];
    await saveModProfilesFile();
    logToConsole(`deleted mod profile '${profileName}'.`, 'info');
    return { success: true };
});

// handle getting mod history
ipcMain.handle('get-mod-history', async (event, modName) => {
    let history = {};
    try { history = JSON.parse(await fs.readFile(modHistoryFilePath, 'utf8')); } catch { history = {}; }
    return history[modName] || [];
});

// handle reading metadata.json from a mod archive (.mmpackage, .zip, .7z, .rar)
ipcMain.handle('read-mod-metadata', async (event, modName) => {
    try {
        const modPath = path.join(appSettings.modFolderPath, modName);
        let metadata = null;

        if (isZipArchive(modName)) {
            // Use yauzl for zip-based archives
            await new Promise((resolve, reject) => {
                yauzl.open(modPath, { lazyEntries: true }, (err, zipfile) => {
                    if (err) return resolve(); // no metadata if error
                    let found = false;
                    zipfile.on('entry', entry => {
                        if (entry.fileName === 'metadata.json') {
                            found = true;
                            zipfile.openReadStream(entry, (err, readStream) => {
                                if (err) return resolve();
                                let data = '';
                                readStream.on('data', chunk => data += chunk);
                                readStream.on('end', () => {
                                    try {
                                        metadata = JSON.parse(data);
                                    } catch { }
                                    resolve();
                                });
                            });
                        } else {
                            zipfile.readEntry();
                        }
                    });
                    zipfile.on('end', () => {
                        if (!found) resolve();
                    });
                    zipfile.on('error', () => resolve());
                    zipfile.readEntry();
                });
            });
        } else if (is7zArchive(modName)) {
            // Use node-7z to extract metadata.json from 7z/rar archives
            const tempMetaDir = path.join(os.tmpdir(), 'disobeytop_meta_temp', stripModExtension(modName));
            try {
                await fs.emptyDir(tempMetaDir);
                await new Promise((resolve, reject) => {
                    const extractStream = Seven.extractFull(modPath, tempMetaDir, {
                        $bin: pathTo7zip,
                        $cherryPick: ['metadata.json'],
                        recursive: true
                    });
                    extractStream.on('end', () => resolve());
                    extractStream.on('error', () => resolve()); // skip if no metadata
                });
                const metaPath = path.join(tempMetaDir, 'metadata.json');
                if (await fs.pathExists(metaPath)) {
                    const data = await fs.readFile(metaPath, 'utf8');
                    try { metadata = JSON.parse(data); } catch { }
                }
            } catch { } finally {
                try { await fs.remove(tempMetaDir); } catch { }
            }
        }

        return { success: true, metadata };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// handle getting available mods from mod folder
/**
 * List every supported mod archive sitting in the mods library folder.
 * The library itself is flat — a mod's on/off state is no longer tracked
 * here. Instead, each deploy target has its own `disabled_mods` sibling
 * folder next to the live pak files, and that's what actually determines
 * whether a mod is on or off (see performInstall/performUninstall below).
 */
async function listLibraryModFiles() {
    if (!appSettings.modFolderPath) return [];
    if (!(await fs.pathExists(appSettings.modFolderPath))) return [];
    const files = await fs.readdir(appSettings.modFolderPath);
    const results = [];
    for (const file of files) {
        if (isSupportedModFile(file)) {
            results.push({ name: file, dir: appSettings.modFolderPath, fullPath: path.join(appSettings.modFolderPath, file) });
        }
    }
    return results;
}

ipcMain.handle('get-available-mods', async (event) => {
    logToConsole(`scanning mod library: ${appSettings.modFolderPath}`, 'info');
    if (!appSettings.modFolderPath) {
        logToConsole('mod folder path is not set.', 'warn');
        return [];
    }
    try {
        // check the actual game files before reporting install state, so a
        // manual change (files added/removed by hand outside the app) is
        // always reflected rather than trusting a possibly-stale flag
        await reconcileModState();

        const libraryFiles = await listLibraryModFiles();
        logToConsole(`found ${libraryFiles.length} mod archive files (.mmpackage/.zip/.7z/.rar).`, 'info');
        // For each mod archive, try to extract metadata.json
        const mods = await Promise.all(libraryFiles.map(async entry => {
            const file = entry.name;
            const modPath = entry.fullPath;
            let metadata = null;
            try {
                if (isZipArchive(file)) {
                    // Use yauzl for .mmpackage and .zip
                    await new Promise((resolve, reject) => {
                        yauzl.open(modPath, { lazyEntries: true }, (err, zipfile) => {
                            if (err) return resolve(); // skip metadata if error
                            let found = false;
                            zipfile.on('entry', entry => {
                                if (entry.fileName === 'metadata.json') {
                                    found = true;
                                    zipfile.openReadStream(entry, (err, readStream) => {
                                        if (err) return resolve();
                                        let data = '';
                                        readStream.on('data', chunk => data += chunk);
                                        readStream.on('end', () => {
                                            try {
                                                metadata = JSON.parse(data);
                                            } catch { }
                                            resolve();
                                        });
                                    });
                                } else {
                                    zipfile.readEntry();
                                }
                            });
                            zipfile.on('end', () => {
                                if (!found) resolve();
                            });
                            zipfile.on('error', () => resolve());
                            zipfile.readEntry();
                        });
                    });
                } else if (is7zArchive(file)) {
                    // check for metadata.json in 7z/rar (routes to the right
                    // tool since the bundled 7za binary can't read rar at all)
                    const tempMetaDir = path.join(os.tmpdir(), 'disobeytop_meta_temp', stripModExtension(file));
                    try {
                        await fs.emptyDir(tempMetaDir);
                        if (isRarArchive(file)) {
                            const extractor = await createExtractorFromFile({ filepath: modPath, targetPath: tempMetaDir });
                            const result = extractor.extract({ files: ['metadata.json'] });
                            for (const _f of result.files) { /* drain to force extraction */ }
                        } else {
                            await new Promise((resolve) => {
                                const extractStream = Seven.extractFull(modPath, tempMetaDir, {
                                    $bin: pathTo7zip,
                                    $cherryPick: ['metadata.json'],
                                    recursive: true
                                });
                                extractStream.on('end', () => resolve());
                                extractStream.on('error', () => resolve());
                            });
                        }
                        const metaPath = path.join(tempMetaDir, 'metadata.json');
                        if (await fs.pathExists(metaPath)) {
                            const data = await fs.readFile(metaPath, 'utf8');
                            try { metadata = JSON.parse(data); } catch { }
                        }
                    } catch { } finally {
                        try { await fs.remove(tempMetaDir); } catch { }
                    }
                }
            } catch { }
            return {
                name: file,
                path: modPath,
                installed: !!(installedMods[file] && installedMods[file].enabled),
                metadata: metadata
            };
        }));
        return mods;
    } catch (error) {
        logToConsole(`error reading mod folder: ${error.message}`, 'error');
        return [];
    }
});

// NOTE: there used to be a convertArchivesToZip() function here that wrote a
// converted .zip into the mods folder and deleted the original .7z/.rar. The
// mods folder must never be written to or deleted from — it's read-only
// source material the app extracts from, nothing else. .7z/.rar archives are
// now extracted directly to a temp folder on demand instead (see
// extractModArchivePakFiles below), leaving the original file completely
// untouched.

let modsWatcher = null;
function setupModsWatcher() {
    if (modsWatcher) {
        modsWatcher.close();
        modsWatcher = null;
    }
    if (!appSettings.modFolderPath) return;
    try {
        modsWatcher = fs.watch(appSettings.modFolderPath, { persistent: true }, (eventType, filename) => {
            if (filename && isSupportedModFile(filename)) {
                // any newly dropped archive (zip/7z/rar/mmpackage) is off by
                // default simply by having no enabled registry entry — nothing
                // to convert or move, the mods folder is never written to
                setTimeout(() => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('mods-folder-changed');
                    }
                }, 500);
            }
        });
    } catch (err) {
        logToConsole('Failed to watch mods folder: ' + err.message, 'error');
    }
}

// Patch: update watcher if modFolderPath changes
ipcMain.handle('set-mod-folder-path', async (event, folderPath) => {
    appSettings.modFolderPath = folderPath;
    setupModsWatcher();
    return { success: true };
});

// --- multi-platform game install detection & deploy targets ---

// scan Steam / Epic / Xbox for every Dead by Daylight install and merge
// any newly-found ones into the deploy target list.
ipcMain.handle('detect-game-installs', async () => {
    logToConsole('scanning for Dead by Daylight installs (Steam, Epic, Xbox)...', 'info');
    try {
        const found = gameScanner.detectGameInstalls().map(gi => ({
            platform: scannerPlatformToLabel(gi.platform),
            installRoot: gi.installRoot,
            pakFolderPath: gi.pakFolderPath,
            autoDetected: true,
        }));
        const added = mergeDeployTargets(found);
        await persistSettings();
        logToConsole(`detected ${found.length} install(s) total, ${added} new.`, added > 0 ? 'success' : 'info');
        return { success: true, added, targets: appSettings.deployTargets };
    } catch (error) {
        logToConsole(`game detection failed: ${error.message}`, 'error');
        return { success: false, error: error.message, targets: appSettings.deployTargets };
    }
});

// manually add a deploy target (for platforms auto-detect can't reach)
ipcMain.handle('add-deploy-target', async (event, platform, pakFolderPath) => {
    if (!pakFolderPath) {
        return { success: false, error: 'no folder provided.', targets: appSettings.deployTargets };
    }
    const added = mergeDeployTargets([{ platform: platform || 'Steam', installRoot: '', pakFolderPath }]);
    await persistSettings();
    if (added > 0) {
        logToConsole(`added manual deploy target: [${platform}] ${pakFolderPath}`, 'success');
    } else {
        logToConsole('that folder is already a deploy target.', 'info');
    }
    return { success: true, added, targets: appSettings.deployTargets };
});

// remove a deploy target by id — just removes it, nothing more. If
// auto-detect finds the same path again later (e.g. re-running it, or the
// game reappearing at that location), it's free to add it back — removal
// here is just "not right now", not a permanent exclusion.
ipcMain.handle('remove-deploy-target', async (event, targetId) => {
    const before = appSettings.deployTargets.length;
    appSettings.deployTargets = appSettings.deployTargets.filter(t => t.id !== targetId);
    await persistSettings();
    logToConsole(`removed deploy target ${targetId}.`, 'info');
    return { success: appSettings.deployTargets.length < before, targets: appSettings.deployTargets };
});

// get the current deploy target list
ipcMain.handle('get-deploy-targets', async () => {
    return appSettings.deployTargets || [];
});

// --- Downloads tab: find real mod downloads, rename them in place, and
// move them into the mods library on request. This never touches the mods
// folder except via the explicit "move to mods folder" action below, which
// is the same kind of deliberate user-initiated add as Install Mods.

function getDownloadsPath() {
    return appSettings.downloadsWatchPath || path.join(os.homedir(), 'Downloads');
}

ipcMain.handle('get-downloads-path', async () => getDownloadsPath());

ipcMain.handle('set-downloads-path', async (event, folderPath) => {
    appSettings.downloadsWatchPath = folderPath || '';
    await persistSettings();
    setupDownloadsWatcher();
    return { success: true, downloadsPath: getDownloadsPath() };
});

ipcMain.handle('scan-downloads-for-mods', async () => {
    const downloadsPath = getDownloadsPath();
    if (!(await fs.pathExists(downloadsPath))) {
        return { success: false, error: `folder not found: ${downloadsPath}`, downloadsPath, mods: [] };
    }
    logToConsole(`scanning ${downloadsPath} for real mod downloads...`, 'info');

    let files;
    try {
        files = await fs.readdir(downloadsPath);
    } catch (err) {
        return { success: false, error: err.message, downloadsPath, mods: [] };
    }

    const candidates = files.filter(isSupportedModFile);
    const results = [];
    for (const file of candidates) {
        const filePath = path.join(downloadsPath, file);
        try {
            const stat = await fs.stat(filePath);
            if (!stat.isFile()) continue;
            const { hasPakFiles, pakFileNames } = await archiveContainsPakFiles(filePath);
            if (hasPakFiles) {
                const variantInfo = await analyzeArchiveVariants(filePath);
                results.push({
                    name: file,
                    path: filePath,
                    size: stat.size,
                    mtimeMs: stat.mtimeMs,
                    pakFileCount: pakFileNames.length,
                    samplePakNames: pakFileNames.slice(0, 3),
                    isMultiVariant: variantInfo.isMultiVariant,
                    variants: variantInfo.isMultiVariant ? variantInfo.variants : [],
                });
            }
        } catch (err) {
            logToConsole(`skipping ${file} during downloads scan: ${err.message}`, 'warn');
        }
    }
    results.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest downloads first
    logToConsole(`found ${results.length} real mod download(s) out of ${candidates.length} archive(s) scanned.`, 'success');
    return { success: true, downloadsPath, mods: results };
});

ipcMain.handle('create-variant-mods', async (event, filePath, selections) => {
    const results = [];
    const usedNames = new Set();
    for (const selection of selections || []) {
        // accept either a plain folder string (legacy) or {folder, name} with a
        // user-chosen rename from the downloads tab's variant picker
        const folder = typeof selection === 'string' ? selection : selection.folder;
        const requestedName = (typeof selection === 'object' && selection.name) ? selection.name : path.basename(folder);
        const baseSafeName = requestedName.replace(/[<>:"/\\|?*]/g, '_').trim() || path.basename(folder);

        // each selected variant must land as its own file — if two selected
        // variants resolve to the same name (duplicate/blank rename, or a
        // name already used by a previous run), auto-uniquify with a suffix
        // instead of failing and silently dropping that variant from the batch
        let safeName = `${baseSafeName}.zip`;
        let suffix = 2;
        while (usedNames.has(safeName) || await fs.pathExists(path.join(appSettings.modFolderPath || '', safeName))) {
            safeName = `${baseSafeName} (${suffix}).zip`;
            suffix++;
        }
        usedNames.add(safeName);

        try {
            const destPath = await createVariantZip(filePath, folder, safeName);
            results.push({ folder, success: true, path: destPath, zipName: safeName });
            logToConsole(`created variant mod '${safeName}' in the mods folder.`, 'success');
        } catch (err) {
            results.push({ folder, success: false, error: err.message });
            logToConsole(`failed to create variant mod for '${folder}': ${err.message}`, 'error');
        }
    }
    if (results.some(r => r.success) && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('mods-folder-changed');
    }
    return { results };
});

ipcMain.handle('rename-download-file', async (event, oldPath, newBaseName) => {
    const downloadsPath = getDownloadsPath();
    // safety: only ever rename a file that's actually directly inside the
    // downloads folder we scanned — never touch anything else
    if (path.dirname(path.normalize(oldPath)).toLowerCase() !== path.normalize(downloadsPath).toLowerCase()) {
        return { success: false, error: 'refusing to rename a file outside the downloads folder.' };
    }
    const safeName = (newBaseName || '').replace(/[<>:"/\\|?*]/g, '_').trim();
    if (!safeName) {
        return { success: false, error: 'enter a valid name.' };
    }
    const ext = path.extname(oldPath);
    const newPath = path.join(path.dirname(oldPath), safeName + ext);
    if (path.normalize(newPath).toLowerCase() === path.normalize(oldPath).toLowerCase()) {
        return { success: true, newPath: oldPath, newName: path.basename(oldPath) };
    }
    if (await fs.pathExists(newPath)) {
        return { success: false, error: 'a file with that name already exists.' };
    }
    try {
        await fs.rename(oldPath, newPath);
        logToConsole(`renamed download: ${path.basename(oldPath)} -> ${path.basename(newPath)}`, 'success');
        return { success: true, newPath, newName: path.basename(newPath) };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('move-download-to-library', async (event, filePath) => {
    if (!appSettings.modFolderPath) {
        return { success: false, error: 'set a mods folder in Settings first.' };
    }
    const downloadsPath = getDownloadsPath();
    if (path.dirname(path.normalize(filePath)).toLowerCase() !== path.normalize(downloadsPath).toLowerCase()) {
        return { success: false, error: 'refusing to move a file that isn\'t in the downloads folder.' };
    }
    await fs.ensureDir(appSettings.modFolderPath);
    const fileName = path.basename(filePath);
    const destPath = path.join(appSettings.modFolderPath, fileName);
    if (await fs.pathExists(destPath)) {
        return { success: false, error: 'a file with that name is already in your mods folder.' };
    }
    try {
        await fs.move(filePath, destPath);
        logToConsole(`moved '${fileName}' from Downloads into the mods folder.`, 'success');
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('mods-folder-changed');
        }
        return { success: true, newPath: destPath };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// same idea as move-download-to-library, but for files dragged in from
// anywhere (Desktop, a random Downloads subfolder, wherever the browser
// happened to save it) rather than only the configured Downloads folder —
// used when a mod archive is dropped directly onto the Mods tab.
ipcMain.handle('import-dropped-mod-file', async (event, filePath) => {
    if (typeof filePath !== 'string' || !filePath) {
        return { success: false, error: 'could not resolve a filesystem path for that file.' };
    }
    if (!appSettings.modFolderPath) {
        return { success: false, error: 'set a mods folder in Settings first.' };
    }
    await fs.ensureDir(appSettings.modFolderPath);
    const fileName = path.basename(filePath);
    const destPath = path.join(appSettings.modFolderPath, fileName);

    if (path.normalize(filePath).toLowerCase() === path.normalize(destPath).toLowerCase()) {
        return { success: true, newPath: filePath, moved: false }; // already there
    }
    if (await fs.pathExists(destPath)) {
        return { success: false, error: 'a file with that name already exists in your mods folder.' };
    }
    try {
        await fs.move(filePath, destPath); // fs-extra handles cross-drive moves automatically
        logToConsole(`moved '${fileName}' into the mods folder.`, 'success');
        return { success: true, newPath: destPath, moved: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

let downloadsWatcher = null;
function setupDownloadsWatcher() {
    if (downloadsWatcher) {
        downloadsWatcher.close();
        downloadsWatcher = null;
    }
    const downloadsPath = getDownloadsPath();
    if (!downloadsPath || !fs.existsSync(downloadsPath)) return;
    try {
        downloadsWatcher = fs.watch(downloadsPath, { persistent: true }, (eventType, filename) => {
            if (filename && isSupportedModFile(filename)) {
                setTimeout(() => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('downloads-folder-changed');
                    }
                }, 800); // give the download a moment to finish writing
            }
        });
    } catch (err) {
        logToConsole('Failed to watch downloads folder: ' + err.message, 'error');
    }
}

/**
 * helper to get platform code based on user-friendly platform name.
 * this maps 'steam', 'microsoft', 'epic games' to their common pak file suffixes.
 * @param {string} platform - the user-selected platform name.
 * @returns {string} the platform code used in pak file naming.
 */
function getPlatformCode(platform) {
    switch (platform.toLowerCase()) {
        case 'steam': return 'Windows';
        case 'microsoft': return 'WinGDK';
        case 'epic games': return 'EGS';
        default: return 'Windows';
    }
}

// helper to log mod history
const modHistoryFilePath = path.join(appDataPath, 'mod_history.json');
async function logModHistory(modName, action) {
    let history = {};
    try { history = JSON.parse(await fs.readFile(modHistoryFilePath, 'utf8')); } catch { history = {}; }
    if (!history[modName]) history[modName] = [];
    history[modName].push({ action, timestamp: new Date().toISOString() });
    await fs.writeFile(modHistoryFilePath, JSON.stringify(history, null, 2));
}

// handle installing a mod
/**
 * Extracts a mod archive to a temp folder and returns the list of matched
 * pakchunk files inside it. Handles the .7z/.rar -> .zip conversion the
 * app does on first install. May return an updated modName/modPath if
 * that conversion happened.
 */
async function extractModArchivePakFiles(modName, modPath) {
    const tempExtractionPath = path.join(os.tmpdir(), 'disobeytop_mod_temp', stripModExtension(modName));
    await fs.emptyDir(tempExtractionPath);

    if (isZipArchive(modName)) {
        const buffer = Buffer.alloc(4);
        let fd;
        try {
            fd = fs.openSync(modPath, 'r');
            fs.readSync(fd, buffer, 0, 4, 0);
        } finally {
            if (fd) fs.closeSync(fd);
        }
        if (buffer.toString('hex') !== '504b0304') {
            throw new Error('mod file is not a valid zip archive.');
        }
        await new Promise((resolve, reject) => {
            yauzl.open(modPath, { lazyEntries: true }, (err, zipfile) => {
                if (err) return reject(err);
                zipfile.on('entry', (entry) => {
                    if (/\/$/.test(entry.fileName)) {
                        zipfile.readEntry();
                        return;
                    }
                    const entryPath = path.join(tempExtractionPath, entry.fileName);
                    fs.ensureDir(path.dirname(entryPath)).then(() => {
                        zipfile.openReadStream(entry, (err, readStream) => {
                            if (err) return reject(err);
                            const writeStream = fs.createWriteStream(entryPath);
                            readStream.on('end', () => zipfile.readEntry());
                            readStream.pipe(writeStream);
                        });
                    }).catch(reject);
                });
                zipfile.on('end', resolve);
                zipfile.on('error', reject);
                zipfile.readEntry();
            });
        });
    } else if (is7zArchive(modName)) {
        // extract straight to a temp folder for this install only — the
        // mods folder itself is never written to, renamed, or deleted from.
        // modName/modPath stay exactly as they were (still the .7z/.rar).
        await extractArchive(modPath, tempExtractionPath);
    } else {
        throw new Error('unsupported mod archive format.');
    }

    async function walkDir(dir) {
        let results = [];
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results = results.concat(await walkDir(fullPath));
            } else {
                results.push(fullPath);
            }
        }
        return results;
    }
    const allExtractedFiles = await walkDir(tempExtractionPath);
    const pakFiles = [];
    for (const filePath of allExtractedFiles) {
        const file = path.basename(filePath);
        if (/^pakchunk\d+(-[a-zA-Z0-9]+)?\.(pak|sig|ucas|utoc)$/i.test(file)) {
            pakFiles.push({ file, filePath });
        } else {
            logToConsole(`skipping non-pakchunk file: ${file}`, 'info');
        }
    }

    return { modName, modPath, pakFiles, tempExtractionPath };
}

function renamedPakFileName(originalFile, platformCode) {
    const fileNameWithoutExt = path.parse(originalFile).name;
    const fileExt = path.parse(originalFile).ext;
    const platformCodeRegex = /-[a-zA-Z0-9]+$/;
    if (platformCodeRegex.test(fileNameWithoutExt)) {
        return `${fileNameWithoutExt.replace(platformCodeRegex, `-${platformCode}`)}${fileExt}`;
    }
    return `${fileNameWithoutExt}-${platformCode}${fileExt}`;
}

/**
 * Toggle a mod ON. If it's already been deployed to a target before and was
 * simply switched off (its renamed files are sitting in that target's
 * `disabled_mods` folder), the files are just moved back — no
 * re-extraction needed. Only a target that's never seen this mod before
 * (first install, or a newly-added platform) triggers extracting the
 * archive.
 */
async function performInstall(modName, modPath) {
    logToConsole(`enabling mod: ${modName}`, 'info');
    const deployTargets = getActiveDeployTargets();
    if (deployTargets.length === 0) {
        logToConsole('no deploy targets configured. cannot enable mod.', 'error');
        return { success: false, error: 'no game install locations configured. add or auto-detect one in settings.' };
    }

    let record = installedMods[modName];
    if (!record) {
        record = { originalName: modName, originalPath: modPath, enabled: false, filesByTarget: {} };
    }
    record.originalPath = modPath;

    let extraction = null; // lazily populated only if some target actually needs it
    let tempExtractionPath = null;

    try {
        for (const target of deployTargets) {
            const disabledDir = path.join(target.pakFolderPath, 'disabled_mods');
            const knownFiles = record.filesByTarget[target.id];

            if (knownFiles && knownFiles.length > 0) {
                // we've deployed to this target before — try moving files back
                // from disabled_mods instead of re-extracting
                let allRestored = true;
                for (const f of knownFiles) {
                    const mainPath = path.join(target.pakFolderPath, f.installed);
                    const disabledPath = path.join(disabledDir, f.installed);
                    if (await fs.pathExists(mainPath)) continue; // already there
                    if (await fs.pathExists(disabledPath)) {
                        await fs.ensureDir(target.pakFolderPath);
                        await fs.move(disabledPath, mainPath, { overwrite: true });
                        logToConsole(`restored ${f.installed} from disabled_mods in [${target.platform}] ${target.pakFolderPath}`, 'info');
                    } else {
                        allRestored = false; // files are gone entirely — need a fresh extraction
                    }
                }
                if (allRestored) continue; // this target is fully handled
            }

            // first time deploying to this target (or files went missing) — extract the archive
            if (!extraction) {
                extraction = await extractModArchivePakFiles(modName, modPath);
                tempExtractionPath = extraction.tempExtractionPath;
                if (extraction.pakFiles.length === 0) {
                    throw new Error('no pakchunk files found in this mod archive.');
                }
            }

            const platformCode = getPlatformCode(target.platform);
            record.filesByTarget[target.id] = [];
            await fs.ensureDir(target.pakFolderPath);
            for (const { file, filePath } of extraction.pakFiles) {
                const newFileName = renamedPakFileName(file, platformCode);
                await fs.copy(filePath, path.join(target.pakFolderPath, newFileName));
                record.filesByTarget[target.id].push({ original: file, installed: newFileName });
                logToConsole(`copied and renamed ${file} to ${newFileName} in [${target.platform}] ${target.pakFolderPath}`, 'info');
            }
        }

        record.enabled = true;
        installedMods[modName] = record;
        await fs.writeFile(installedModsFilePath, JSON.stringify(installedMods, null, 2));
        await logModHistory(modName, 'installed');
        logToConsole(`mod '${modName}' enabled.`, 'success');
        return { success: true };

    } catch (error) {
        logToConsole(`failed to enable mod '${modName}': ${error.message}`, 'error');
        return { success: false, error: error.message };
    } finally {
        if (tempExtractionPath) {
            try { await fs.remove(tempExtractionPath); } catch { /* ignore */ }
        }
    }
}

ipcMain.handle('install-mod', async (event, modName, modPath) => performInstall(modName, modPath));

/**
 * Toggle a mod OFF. Instead of deleting its deployed files, they're moved
 * into a `disabled_mods` folder sitting right next to the live paks in
 * each target — so turning it back on later is just a fast move back,
 * no re-extraction needed. The registry record is kept (not deleted) so
 * we remember which renamed files belong to this mod.
 */
async function performUninstall(modName) {
    logToConsole(`disabling mod: ${modName}`, 'info');

    const record = installedMods[modName];
    if (!record) {
        logToConsole(`mod '${modName}' not found in the mod registry.`, 'warn');
        return { success: false, error: 'mod not found.' };
    }

    // normalize legacy field name from before this rework
    const filesByTarget = record.filesByTarget || record.installedFilesByTarget || {};

    try {
        const targetsById = {};
        for (const t of appSettings.deployTargets || []) targetsById[t.id] = t;

        for (const [targetId, files] of Object.entries(filesByTarget)) {
            const target = targetsById[targetId];
            if (!target) {
                logToConsole(`deploy target ${targetId} no longer exists, skipping its files for '${modName}'.`, 'warn');
                continue;
            }
            const disabledDir = path.join(target.pakFolderPath, 'disabled_mods');
            await fs.ensureDir(disabledDir);
            for (const fileInfo of files) {
                const mainPath = path.join(target.pakFolderPath, fileInfo.installed);
                const disabledPath = path.join(disabledDir, fileInfo.installed);
                if (await fs.pathExists(mainPath)) {
                    await fs.move(mainPath, disabledPath, { overwrite: true });
                    logToConsole(`moved ${fileInfo.installed} into disabled_mods in [${target.platform}] ${target.pakFolderPath}`, 'info');
                } else {
                    logToConsole(`file not found during disable, skipping: ${mainPath}`, 'warn');
                }
            }
        }

        record.filesByTarget = filesByTarget;
        delete record.installedFilesByTarget; // drop legacy key once migrated
        record.enabled = false;
        installedMods[modName] = record;
        await fs.writeFile(installedModsFilePath, JSON.stringify(installedMods, null, 2));
        await logModHistory(modName, 'uninstalled');
        logToConsole(`mod '${modName}' disabled.`, 'success');
        return { success: true };
    } catch (error) {
        logToConsole(`failed to disable mod '${modName}': ${error.message}`, 'error');
        return { success: false, error: error.message };
    }
}

ipcMain.handle('uninstall-mod', async (event, modName) => performUninstall(modName));

/**
 * Actually deletes a mod's tracked files from disk — checks both the live
 * pak folder and disabled_mods for each target and removes whichever
 * exist. This ONLY ever touches filenames explicitly recorded in the
 * mod's own registry entry at install time; it never guesses based on
 * pakchunk numbering or scans for "anything unrecognized." Files this app
 * didn't deploy itself are never touched by this function.
 */
async function deleteTrackedFiles(record) {
    const targetsById = {};
    for (const t of appSettings.deployTargets || []) targetsById[t.id] = t;
    const filesByTarget = record.filesByTarget || record.installedFilesByTarget || {};
    let deletedCount = 0;

    for (const [targetId, files] of Object.entries(filesByTarget)) {
        const target = targetsById[targetId];
        if (!target) continue;
        const disabledDir = path.join(target.pakFolderPath, 'disabled_mods');

        for (const f of files) {
            const mainPath = path.join(target.pakFolderPath, f.installed);
            const disabledPath = path.join(disabledDir, f.installed);
            if (await fs.pathExists(mainPath)) {
                await fs.remove(mainPath);
                logToConsole(`deleted ${f.installed} from [${target.platform}] ${target.pakFolderPath}`, 'info');
                deletedCount++;
            }
            if (await fs.pathExists(disabledPath)) {
                await fs.remove(disabledPath);
                deletedCount++;
            }
        }
    }
    return deletedCount;
}

/**
 * Removes a mod from the library: deletes its deployed/tracked copies from
 * the actual game install (both the live pak folder and disabled_mods),
 * then drops it from the registry. The mods folder itself is never touched
 * — it's read-only source material, so the original archive stays exactly
 * where it was. If the user wants it back in their library, it'll show up
 * again next time they open Install Mods, since that scans the folder
 * directly rather than the registry.
 */
async function performDeleteMod(modName) {
    const record = installedMods[modName];
    if (record) {
        await deleteTrackedFiles(record);
    }
    delete installedMods[modName];
    await fs.writeFile(installedModsFilePath, JSON.stringify(installedMods, null, 2));
    logToConsole(`mod '${modName}' removed from the library (source file in the mods folder was left untouched).`, 'success');
    return { success: true };
}

ipcMain.handle('delete-mod', async (event, modName) => performDeleteMod(modName));

// --- archived mods: a way to set aside mods that don't work without
// losing them, so they stop cluttering Install Mods but can be restored
// anytime. Lives as a "_archived" subfolder inside the mods folder — moving
// a file there/back is an explicit, user-initiated action, same as
// everything else that touches the mods folder in this app.

function getArchivedModsDir() {
    return appSettings.modFolderPath ? path.join(appSettings.modFolderPath, '_archived') : null;
}

async function performArchiveMod(modName) {
    if (!appSettings.modFolderPath) {
        return { success: false, error: 'set a mods folder in Settings first.' };
    }
    const archivedDir = getArchivedModsDir();
    await fs.ensureDir(archivedDir);
    const destPath = path.join(archivedDir, modName);
    if (await fs.pathExists(destPath)) {
        return { success: false, error: 'a file with that name is already archived.' };
    }

    const record = installedMods[modName];
    const sourcePath = (record && record.originalPath) || path.join(appSettings.modFolderPath, modName);
    if (!(await fs.pathExists(sourcePath))) {
        return { success: false, error: 'could not find the mod file to archive.' };
    }

    // Actually remove any deployed copies from the game install before
    // archiving — whether the mod was currently enabled (live in the pak
    // folder) or already toggled off (sitting in disabled_mods). Archiving
    // means it shouldn't be in the game install at all until restored;
    // deleteTrackedFiles checks both locations, so this covers either state.
    if (record) {
        await deleteTrackedFiles(record);
    }
    delete installedMods[modName];
    await fs.writeFile(installedModsFilePath, JSON.stringify(installedMods, null, 2));

    try {
        await fs.move(sourcePath, destPath);
        logToConsole(`archived '${modName}'.`, 'success');
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mods-folder-changed');
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}
ipcMain.handle('archive-mod', async (event, modName) => performArchiveMod(modName));

ipcMain.handle('restore-archived-mod', async (event, modName) => {
    if (!appSettings.modFolderPath) return { success: false, error: 'set a mods folder in Settings first.' };
    const archivedDir = getArchivedModsDir();
    const sourcePath = path.join(archivedDir, modName);
    const destPath = path.join(appSettings.modFolderPath, modName);
    if (!(await fs.pathExists(sourcePath))) return { success: false, error: 'archived file not found.' };
    if (await fs.pathExists(destPath)) return { success: false, error: 'a file with that name already exists in the mods folder.' };
    try {
        await fs.move(sourcePath, destPath);
        logToConsole(`restored '${modName}' from the archive.`, 'success');
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mods-folder-changed');
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('get-archived-mods', async () => {
    const archivedDir = getArchivedModsDir();
    if (!archivedDir || !(await fs.pathExists(archivedDir))) return [];
    let files;
    try {
        files = await fs.readdir(archivedDir);
    } catch {
        return [];
    }
    const results = [];
    for (const file of files) {
        if (!isSupportedModFile(file)) continue;
        try {
            const stat = await fs.stat(path.join(archivedDir, file));
            if (stat.isFile()) results.push({ name: file, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch { /* ignore unreadable entries */ }
    }
    results.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return results;
});

ipcMain.handle('delete-archived-mod', async (event, modName) => {
    const archivedDir = getArchivedModsDir();
    if (!archivedDir) return { success: false, error: 'mods folder is not set.' };
    const filePath = path.join(archivedDir, modName);
    // safety: only ever delete something that's actually directly inside _archived
    if (path.dirname(path.normalize(filePath)).toLowerCase() !== path.normalize(archivedDir).toLowerCase()) {
        return { success: false, error: 'refusing to delete a file outside the archive folder.' };
    }
    try {
        if (await fs.pathExists(filePath)) await fs.remove(filePath);
        logToConsole(`permanently deleted archived mod '${modName}'.`, 'info');
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// copy one or more picked archive files into the mods library folder.
// they land off by default — nothing here deploys anything.
// NOTE: there used to be an import-mod-files handler here that copied
// externally-selected files INTO the mods folder. It was unreachable from
// the UI (the Install Mods flow uses the in-app picker that reads directly
// from the mods folder) and, more importantly, writing into that folder at
// all is off the table now — it's read-only source material.


/**
 * Reconciles each mod's `enabled` flag with what's actually sitting on
 * disk at every deploy target — this is what lets the app "detect which
 * mods are on" when it launches. For each target, a mod's renamed files
 * are either in the live pak folder (on) or in `disabled_mods` (off);
 * whichever is actually true wins, and any mismatch gets physically
 * corrected so every target agrees with the mod's registry state.
 */
async function reconcileModState() {
    logToConsole('reconciling mod on/off state with what\'s actually deployed...', 'info');
    try {
        const deployTargets = getActiveDeployTargets();
        const targetsById = {};
        for (const t of deployTargets) targetsById[t.id] = t;

        for (const [modName, record] of Object.entries(installedMods)) {
            const filesByTarget = record.filesByTarget || {};
            let sawEnabledSomewhere = false;
            let sawDisabledSomewhere = false;

            for (const [targetId, files] of Object.entries(filesByTarget)) {
                const target = targetsById[targetId];
                if (!target || !files || files.length === 0) continue;
                const disabledDir = path.join(target.pakFolderPath, 'disabled_mods');

                const first = files[0];
                const inMain = await fs.pathExists(path.join(target.pakFolderPath, first.installed));
                const inDisabled = await fs.pathExists(path.join(disabledDir, first.installed));

                if (inMain) sawEnabledSomewhere = true;
                if (inDisabled) sawDisabledSomewhere = true;

                // fix any per-file mismatch against this target's own state
                const targetIsEnabled = inMain || (!inMain && !inDisabled && record.enabled);
                for (const f of files) {
                    const mainPath = path.join(target.pakFolderPath, f.installed);
                    const disabledPath = path.join(disabledDir, f.installed);
                    const fileInMain = await fs.pathExists(mainPath);
                    const fileInDisabled = await fs.pathExists(disabledPath);
                    if (targetIsEnabled && !fileInMain && fileInDisabled) {
                        await fs.ensureDir(target.pakFolderPath);
                        await fs.move(disabledPath, mainPath, { overwrite: true });
                    } else if (!targetIsEnabled && fileInMain && !fileInDisabled) {
                        await fs.ensureDir(disabledDir);
                        await fs.move(mainPath, disabledPath, { overwrite: true });
                    }
                }
            }

            // update the registry's enabled flag to match reality
            const shouldBeEnabled = sawEnabledSomewhere || (!sawEnabledSomewhere && !sawDisabledSomewhere && record.enabled);
            if (shouldBeEnabled !== record.enabled) {
                logToConsole(`'${modName}' was ${record.enabled ? 'on' : 'off'} but its files say ${shouldBeEnabled ? 'on' : 'off'} — correcting.`, 'info');
                record.enabled = shouldBeEnabled;
            }
        }

        await fs.writeFile(installedModsFilePath, JSON.stringify(installedMods, null, 2));
        logToConsole('mod state reconciliation complete.', 'system');
    } catch (error) {
        logToConsole(`error reconciling mod state: ${error.message}`, 'error');
    }
}

// handle uninstalling all mods
ipcMain.handle('uninstall-all-mods', async (event) => {
    logToConsole('uninstalling all managed mods...', 'info');

    try {
        let modCount = 0;
        let fileCount = 0;

        // ONLY touch mods this app actually manages. This covers every
        // tracked mod regardless of its current enabled/disabled state —
        // deleteTrackedFiles checks both the live pak folder AND
        // disabled_mods for each target, so a mod sitting toggled-off there
        // gets cleaned up too instead of being silently skipped. Never scan
        // pak folders for "unrecognized" files and never use pakchunk
        // numbering to decide what's safe to remove — that's exactly the
        // kind of heuristic that can destroy base-game files.
        for (const [modName, record] of Object.entries(installedMods)) {
            const removed = await deleteTrackedFiles(record);
            if (removed > 0) {
                fileCount += removed;
                modCount++;
                logToConsole(`uninstalled '${modName}'.`, 'info');
            }
            record.enabled = false;
        }

        await fs.writeFile(installedModsFilePath, JSON.stringify(installedMods, null, 2));
        logToConsole(`uninstalled ${modCount} mod(s), removed ${fileCount} tracked file(s). base game files and untracked files were never touched.`, 'success');
        return { success: true, count: modCount };
    } catch (error) {
        logToConsole(`failed to uninstall all mods: ${error.message}`, 'error');
        return { success: false, error: error.message };
    }
});
