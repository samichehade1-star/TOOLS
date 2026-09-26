const { app, BrowserWindow, ipcMain, dialog, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const yauzl = require('yauzl');
const Seven = require('node-7z');
const { createExtractorFromFile } = require('node-unrar-js');
// 7za lives outside the asar in a packaged build.
const path7za = require('7zip-bin').path7za.replace('app.asar', 'app.asar.unpacked');

const DEFAULT_GAME_ROOT = 'D:\\SteamLibrary\\steamapps\\common\\Halloween';
const MOD_EXTS = ['.pak', '.ucas', '.utoc', '.sig'];
const ARCHIVE_EXTS = ['.zip', '.rar', '.7z'];

// Everything the manager owns lives in %APPDATA%\Halloween Mod Manager —
// never inside the game folder, so a disabled mod leaves no trace there.
const dataDir = app.getPath('userData');
const storeDir = path.join(dataDir, 'mods');
const splashStoreDir = path.join(dataDir, 'splash');
const configPath = path.join(dataDir, 'config.json');
// Archives are unpacked here while a mod is being added; wiped on start and quit.
const stagingDir = path.join(os.tmpdir(), 'halloween-mod-manager-staging');

let config;
let win;

// ---------- config ----------

function loadConfig() {
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
        config = {};
    }
    config.gameRoot ??= DEFAULT_GAME_ROOT;
    config.mods ??= [];
    config.categories ??= [];
    config.customSplash ??= false;
    config.splashName ??= null;
    config.splashSource ??= null;
    config.splashScale ??= 100;
}

function saveConfig() {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// ---------- paths ----------

const modsDir = () => path.join(config.gameRoot, 'Ravage', 'Content', 'Paks', '~mods');
const paksDir = () => path.join(config.gameRoot, 'Ravage', 'Content', 'Paks');
const splashDir = () => path.join(config.gameRoot, 'Ravage', 'Content', 'Splash');
const modStore = (mod) => path.join(storeDir, mod.id);
const originalSplashPath = () => path.join(splashStoreDir, 'original.bmp');
const customSplashPath = () => path.join(splashStoreDir, 'custom.bmp');
const downloadsPath = () => config.downloadsPath || path.join(os.homedir(), 'Downloads');

function gameFound() {
    return fs.existsSync(paksDir());
}

// Keep whatever name the game already uses for its splash (Splash.bmp).
function splashFileName() {
    if (config.splashName) return config.splashName;
    try {
        const bmp = fs.readdirSync(splashDir()).find((f) => f.toLowerCase().endsWith('.bmp'));
        if (bmp) {
            config.splashName = bmp;
            saveConfig();
            return bmp;
        }
    } catch {}
    return 'Splash.bmp';
}
const gameSplashPath = () => path.join(splashDir(), splashFileName());

// ---------- helpers ----------

const extOf = (name) => path.extname(name).toLowerCase();
const isModFile = (name) => MOD_EXTS.includes(extOf(name));
const isArchive = (name) => ARCHIVE_EXTS.includes(extOf(name));
const stemOf = (name) => path.basename(name, path.extname(name));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function prettyName(stem) {
    return stem.replace(/_P$/i, '').replace(/[_]+/g, ' ').trim() || stem;
}

function friendlyError(err) {
    if (['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) {
        return 'The file is locked. Close the game and try again.';
    }
    return err.message;
}

function listModsDir() {
    try {
        return fs.readdirSync(modsDir(), { withFileTypes: true })
            .filter((d) => d.isFile() && isModFile(d.name))
            .map((d) => d.name);
    } catch {
        return [];
    }
}

function groupByStem(files) {
    const groups = new Map();
    for (const f of files) {
        const key = stemOf(f.name).toLowerCase();
        if (!groups.has(key)) groups.set(key, { stem: stemOf(f.name), files: [] });
        groups.get(key).files.push(f);
    }
    return [...groups.values()];
}

function ownerOf(fileName) {
    const lower = fileName.toLowerCase();
    return config.mods.find((m) => m.files.some((f) => f.toLowerCase() === lower));
}

const findMod = (id) => {
    const mod = config.mods.find((m) => m.id === id);
    if (!mod) throw new Error('Mod not found.');
    return mod;
};

// Run async jobs with a cap on how many are in flight at once.
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

// ---------- sync with the game folder ----------

// Anything sitting in ~mods that the manager doesn't know about yet gets
// copied into storage and tracked, so nothing has to be re-downloaded.
function importUnknownMods() {
    if (!gameFound()) return;
    const unknown = listModsDir()
        .filter((name) => !ownerOf(name))
        .map((name) => ({ name, src: path.join(modsDir(), name) }));
    if (!unknown.length) return;

    for (const group of groupByStem(unknown)) {
        const isIntro = /intro/i.test(group.stem) && !config.mods.some((m) => m.introMod);
        const mod = {
            id: newId(),
            name: isIntro ? 'Intro Changer' : prettyName(group.stem),
            files: group.files.map((f) => f.name),
            enabled: true,
            introMod: isIntro,
            categoryId: null,
            addedAt: Date.now(),
        };
        fs.mkdirSync(modStore(mod), { recursive: true });
        for (const f of group.files) fs.copyFileSync(f.src, path.join(modStore(mod), f.name));
        config.mods.push(mod);
    }
    saveConfig();
}

function modStatus(mod, present) {
    const inGame = mod.files.filter((f) => present.has(f.toLowerCase())).length;
    if (mod.enabled) return inGame === mod.files.length ? 'ok' : 'missing';
    return inGame === 0 ? 'ok' : 'leftover';
}

// ---------- enable / disable ----------
// Copies are async so big paks never freeze the window.

async function installMod(mod) {
    await fsp.mkdir(modsDir(), { recursive: true });
    await Promise.all(mod.files.map((f) => fsp.copyFile(path.join(modStore(mod), f), path.join(modsDir(), f))));
}

async function uninstallMod(mod) {
    await Promise.all(mod.files.map((f) => fsp.rm(path.join(modsDir(), f), { force: true })));
}

async function setEnabled(mod, enabled) {
    if (enabled) await installMod(mod);
    else await uninstallMod(mod);
    mod.enabled = enabled;
    saveConfig();

    if (mod.introMod) {
        if (enabled && config.customSplash) applyCustomSplash();
        if (!enabled) restoreOriginalSplash();
    }
}

// ---------- archives ----------
// Listing only reads each archive's index (a few KB), never the whole file.

function listZip(file) {
    return new Promise((resolve, reject) => {
        yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zip) => {
            if (err) return reject(err);
            const names = [];
            zip.on('entry', (e) => {
                if (!e.fileName.endsWith('/')) names.push(e.fileName);
                zip.readEntry();
            });
            zip.on('end', () => resolve(names));
            zip.on('error', reject);
            zip.readEntry();
        });
    });
}

async function listRar(file) {
    const extractor = await createExtractorFromFile({ filepath: file });
    return [...extractor.getFileList().fileHeaders].filter((h) => !h.flags.directory).map((h) => h.name);
}

function list7z(file) {
    return new Promise((resolve, reject) => {
        const names = [];
        const stream = Seven.list(file, { $bin: path7za });
        stream.on('data', (d) => d?.file && names.push(d.file));
        stream.on('end', () => resolve(names));
        stream.on('error', reject);
    });
}

async function listArchiveModFiles(file) {
    const ext = extOf(file);
    const names = ext === '.zip' ? await listZip(file) : ext === '.rar' ? await listRar(file) : await list7z(file);
    return names.filter(isModFile).map((n) => path.basename(n.replace(/\\/g, '/')));
}

function extractZip(file, out) {
    return new Promise((resolve, reject) => {
        yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zip) => {
            if (err) return reject(err);
            zip.on('entry', (e) => {
                if (e.fileName.endsWith('/') || !isModFile(e.fileName)) return zip.readEntry();
                zip.openReadStream(e, (err2, stream) => {
                    if (err2) return reject(err2);
                    const dest = fs.createWriteStream(path.join(out, path.basename(e.fileName)));
                    stream.pipe(dest);
                    dest.on('finish', () => zip.readEntry());
                    dest.on('error', reject);
                });
            });
            zip.on('end', resolve);
            zip.on('error', reject);
            zip.readEntry();
        });
    });
}

async function extractRar(file, out) {
    const extractor = await createExtractorFromFile({ filepath: file, targetPath: out });
    const { files } = extractor.extract({ files: (h) => isModFile(h.name) });
    for (const _ of files) { /* iterating performs the extraction */ }
}

function extract7z(file, out) {
    return new Promise((resolve, reject) => {
        const stream = Seven.extractFull(file, out, {
            $bin: path7za,
            recursive: true,
            $cherryPick: MOD_EXTS.map((e) => '*' + e),
        });
        stream.on('end', resolve);
        stream.on('error', reject);
    });
}

// Extracts only the mod files; returns [{ name, src }].
async function extractArchive(file) {
    const out = path.join(stagingDir, newId());
    await fsp.mkdir(out, { recursive: true });
    const ext = extOf(file);
    if (ext === '.zip') await extractZip(file, out);
    else if (ext === '.rar') await extractRar(file, out);
    else await extract7z(file, out);
    return walkModFiles(out);
}

async function walkModFiles(dir, depth = 0, out = []) {
    if (depth > 3 || out.length > 500) return out;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walkModFiles(full, depth + 1, out);
        else if (isModFile(entry.name)) out.push({ name: entry.name, src: full });
    }
    return out;
}

// ---------- adding / editing mods ----------

// Turns picked/dropped paths into sources: one per folder or archive, plus
// one for any loose files. Each source is { label, files: [{ name, src }] }.
async function inspectPaths(paths) {
    const sources = [];
    const loose = [];
    for (const p of paths) {
        const stat = await fsp.stat(p);
        if (stat.isDirectory()) sources.push({ label: path.basename(p), files: await walkModFiles(p) });
        else if (isArchive(p)) sources.push({ label: stemOf(p), files: await extractArchive(p) });
        else if (isModFile(p)) loose.push({ name: path.basename(p), src: p });
    }
    if (loose.length) sources.push({ label: null, files: loose });
    return sources.filter((src) => src.files.length);
}

function checkFileNames(files, ignoreModId) {
    const seen = new Set();
    for (const f of files) {
        const lower = f.name.toLowerCase();
        if (seen.has(lower)) throw new Error(`"${f.name}" is in the list twice.`);
        seen.add(lower);
        const owner = ownerOf(f.name);
        if (owner && owner.id !== ignoreModId) {
            throw new Error(`"${f.name}" already belongs to "${owner.name}". Two mods can't share a file name in ~mods.`);
        }
    }
}

// Create (no id) or update (id) a mod from the builder. files: [{ name, src? }]
// — entries with src are copied in (new or replacing), entries without are
// existing files that stay.
async function saveMod({ id, name, files, enable, categoryId = null }) {
    name = String(name || '').trim();
    if (!name) throw new Error('Give the mod a name.');
    if (!files?.length) throw new Error('Add at least one .pak / .ucas / .utoc file.');
    for (const f of files) {
        if (!isModFile(f.name)) throw new Error(`"${f.name}" is not a .pak / .ucas / .utoc / .sig file.`);
    }

    let mod = id ? findMod(id) : null;
    checkFileNames(files, mod?.id);

    if (!mod) {
        mod = { id: newId(), name, files: [], enabled: false, introMod: false, categoryId, addedAt: Date.now() };
        config.mods.push(mod);
    }
    const store = modStore(mod);
    await fsp.mkdir(store, { recursive: true });

    const keep = new Set(files.map((f) => f.name.toLowerCase()));
    for (const old of mod.files) {
        if (keep.has(old.toLowerCase())) continue;
        await fsp.rm(path.join(store, old), { force: true });
        if (mod.enabled) await fsp.rm(path.join(modsDir(), old), { force: true });
    }
    for (const f of files) {
        if (f.src) await fsp.copyFile(f.src, path.join(store, f.name));
    }
    mod.name = name;
    mod.files = files.map((f) => f.name);
    saveConfig();

    if ((mod.enabled || enable) && gameFound()) await setEnabled(mod, true);
    return mod.name;
}

// Drag-and-drop of folders / archives: each one becomes a mod right away.
async function addSources(sources, enable) {
    const added = [];
    const skipped = [];
    for (const src of sources) {
        try {
            added.push(await saveMod({ name: src.label, files: src.files, enable }));
        } catch (err) {
            skipped.push(`${src.label}: ${err.message}`);
        }
    }
    return { added, skipped };
}

// ---------- categories / order ----------

// order: [{ id, categoryId }] in display order. Categories are replaced wholesale.
function setOrganization({ categories, order }) {
    config.categories = (categories || []).map((c) => ({
        id: String(c.id),
        name: String(c.name || 'category').trim() || 'category',
        collapsed: !!c.collapsed,
    }));
    const validCats = new Set(config.categories.map((c) => c.id));
    const byId = new Map(config.mods.map((m) => [m.id, m]));
    const sorted = [];
    for (const { id, categoryId } of order || []) {
        const mod = byId.get(id);
        if (!mod) continue;
        mod.categoryId = validCats.has(categoryId) ? categoryId : null;
        sorted.push(mod);
        byId.delete(id);
    }
    // Anything the renderer didn't mention keeps its place at the end.
    for (const mod of byId.values()) {
        if (!validCats.has(mod.categoryId)) mod.categoryId = null;
        sorted.push(mod);
    }
    config.mods = sorted;
    saveConfig();
}

// ---------- downloads tab ----------

// path -> { mtimeMs, size, files } so unchanged archives are never re-read.
const scanCache = new Map();
let scanInFlight = null;

// Mod sites append "<id> <n> <timestamp> <hash>" and browsers add " (1)":
// "MatchTimer99 P 55 1 2026-09-24T16-50Z FgchNUlYK (1)" -> "MatchTimer99 P".
function cleanDownloadName(name) {
    const cleaned = name
        .replace(/\s*\(\d+\)$/, '')
        .replace(/\s+\d+\s+\d+\s+\d{4}-\d{2}-\d{2}T[\d-]+Z\s+\S+$/, '')
        .trim();
    return cleaned || name;
}

async function describeEntry(root, entry) {
    const full = path.join(root, entry.name);
    const stat = await fsp.stat(full);
    const kind = entry.isDirectory() ? 'folder' : isArchive(entry.name) ? extOf(entry.name).slice(1) : null;
    if (!kind) return null;

    const cached = scanCache.get(full);
    let files;
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        files = cached.files;
    } else {
        try {
            files = kind === 'folder' ? (await walkModFiles(full)).map((f) => f.name) : await listArchiveModFiles(full);
        } catch {
            files = [];
        }
        scanCache.set(full, { mtimeMs: stat.mtimeMs, size: stat.size, files });
    }
    if (!files.length) return null;
    return {
        kind,
        path: full,
        name: cleanDownloadName(kind === 'folder' ? entry.name : stemOf(entry.name)),
        files,
        mtimeMs: stat.mtimeMs,
    };
}

async function scanDownloadsNow() {
    const root = downloadsPath();
    let entries;
    try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return []; }

    const loose = entries.filter((e) => e.isFile() && isModFile(e.name)).map((e) => e.name);
    const candidates = entries.filter((e) => e.isDirectory() || (e.isFile() && isArchive(e.name)));
    const items = (await mapLimit(candidates, 4, (e) => describeEntry(root, e).catch(() => null))).filter(Boolean);

    for (const group of groupByStem(loose.map((name) => ({ name })))) {
        const paths = group.files.map((f) => path.join(root, f.name));
        const stats = await Promise.all(paths.map((p) => fsp.stat(p)));
        items.push({
            kind: 'loose',
            path: paths[0],
            paths,
            name: prettyName(group.stem),
            files: group.files.map((f) => f.name),
            mtimeMs: Math.max(...stats.map((s) => s.mtimeMs)),
        });
    }
    for (const item of items) {
        const owner = item.files.map(ownerOf).find(Boolean);
        item.addedAs = owner ? owner.name : null;
    }
    return items.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Overlapping requests share one scan.
function scanDownloads() {
    scanInFlight ??= scanDownloadsNow().finally(() => { scanInFlight = null; });
    return scanInFlight;
}

function insideDownloads(p) {
    const rel = path.relative(downloadsPath(), p);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function removeEmptyDirs(dir) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await removeEmptyDirs(path.join(dir, entry.name));
    }
    if (!(await fsp.readdir(dir)).length) await fsp.rmdir(dir);
}

// Moves a download into storage as a new mod (off until toggled on). Only
// the mod files are removed from Downloads; a folder is deleted only if
// nothing else is left in it.
async function importDownload({ kind, path: itemPath, paths, name }) {
    const all = kind === 'loose' ? paths : [itemPath];
    if (!all.every(insideDownloads)) throw new Error('That item is not in the downloads folder.');

    let files;
    if (kind === 'folder') files = await walkModFiles(itemPath);
    else if (kind === 'loose') files = paths.map((p) => ({ name: path.basename(p), src: p }));
    else files = await extractArchive(itemPath);

    const modName = await saveMod({ name, files, enable: false });

    if (kind === 'folder') {
        for (const f of files) await fsp.rm(f.src, { force: true });
        await removeEmptyDirs(itemPath);
    } else if (kind === 'loose') {
        for (const f of files) await fsp.rm(f.src, { force: true });
    } else {
        await fsp.rm(itemPath, { force: true });
    }
    scanCache.delete(itemPath);
    return modName;
}

let downloadsWatcher = null;
function watchDownloads() {
    downloadsWatcher?.close();
    downloadsWatcher = null;
    if (!fs.existsSync(downloadsPath())) return;
    let timer;
    try {
        downloadsWatcher = fs.watch(downloadsPath(), (_event, filename) => {
            // Browsers rewrite partial files constantly while downloading — ignore those.
            if (filename && /\.(crdownload|part|partial|tmp|opdownload|download)$/i.test(filename)) return;
            clearTimeout(timer);
            timer = setTimeout(() => win?.webContents.send('downloads-changed'), 1500);
        });
    } catch {}
}

// ---------- launching ----------

const STEAM_APP_ID = '3219630';

function findEpicLaunchUri() {
    const dir = 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests';
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.item')); } catch {}
    for (const f of files) {
        try {
            const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            if (/halloween/i.test(m.DisplayName || '')) {
                const id = [m.CatalogNamespace, m.CatalogItemId, m.AppName].map(encodeURIComponent).join('%3A');
                return `com.epicgames.launcher://apps/${id}?action=launch&silent=true`;
            }
        } catch {}
    }
    return null;
}

async function launchGame(platform) {
    config.launchPlatform = platform;
    saveConfig();
    if (platform === 'epic') {
        const uri = findEpicLaunchUri();
        if (!uri) throw new Error('Halloween was not found in your Epic Games library on this PC.');
        await shell.openExternal(uri);
    } else {
        await shell.openExternal(`steam://rungameid/${STEAM_APP_ID}`);
    }
}

// ---------- splash / intro image ----------

function readBmpSize(file) {
    const buf = Buffer.alloc(26);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, 26, 0); } finally { fs.closeSync(fd); }
    if (buf.toString('ascii', 0, 2) !== 'BM') return null;
    return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
}

// 24-bit bottom-up BMP: black canvas of width x height with the BGRA image
// (imgW x imgH) centered on it.
function encodeBmp24(bgra, imgW, imgH, width, height) {
    const rowSize = Math.ceil((width * 3) / 4) * 4;
    const pixelBytes = rowSize * height;
    const out = Buffer.alloc(54 + pixelBytes);
    out.write('BM', 0, 'ascii');
    out.writeUInt32LE(54 + pixelBytes, 2);
    out.writeUInt32LE(54, 10);
    out.writeUInt32LE(40, 14);
    out.writeInt32LE(width, 18);
    out.writeInt32LE(height, 22);
    out.writeUInt16LE(1, 26);
    out.writeUInt16LE(24, 28);
    out.writeUInt32LE(pixelBytes, 34);
    out.writeInt32LE(3780, 38);
    out.writeInt32LE(3780, 42);

    const offX = Math.floor((width - imgW) / 2);
    const offY = Math.floor((height - imgH) / 2);
    for (let y = 0; y < imgH; y++) {
        const srcRow = y * imgW * 4;
        const dstRow = 54 + (height - 1 - (y + offY)) * rowSize + offX * 3;
        for (let x = 0; x < imgW; x++) {
            const s = srcRow + x * 4;
            const d = dstRow + x * 3;
            out[d] = bgra[s];
            out[d + 1] = bgra[s + 1];
            out[d + 2] = bgra[s + 2];
        }
    }
    return out;
}

function backupOriginalSplash() {
    if (fs.existsSync(originalSplashPath())) return;
    if (!fs.existsSync(gameSplashPath())) return;
    fs.mkdirSync(splashStoreDir, { recursive: true });
    fs.copyFileSync(gameSplashPath(), originalSplashPath());
}

function applyCustomSplash() {
    if (!fs.existsSync(customSplashPath())) return;
    backupOriginalSplash();
    fs.mkdirSync(splashDir(), { recursive: true });
    fs.copyFileSync(customSplashPath(), gameSplashPath());
}

function restoreOriginalSplash() {
    if (fs.existsSync(originalSplashPath())) {
        fs.copyFileSync(originalSplashPath(), gameSplashPath());
    }
}

let splashTargetCache = null;
function splashTarget() {
    if (splashTargetCache) return splashTargetCache;
    backupOriginalSplash();
    const size = fs.existsSync(originalSplashPath()) && readBmpSize(originalSplashPath());
    if (size) splashTargetCache = size;
    return size || { width: 1920, height: 1080 };
}

// scale is a percent of "fit": 100 = whole image visible, <100 = smaller with
// black borders, >100 = zoomed in (edges cropped).
function renderSplash(sourcePath, scale) {
    const img = nativeImage.createFromPath(sourcePath);
    if (img.isEmpty()) throw new Error('Could not read that image. Use a PNG or JPEG.');

    const { width: W, height: H } = splashTarget();
    const { width: w, height: h } = img.getSize();
    const s = Math.min(W / w, H / h) * (scale / 100);

    // Crop to the part that will actually be visible before resizing.
    const visW = Math.min(w, Math.floor(W / s));
    const visH = Math.min(h, Math.floor(H / s));
    const cropped = img.crop({ x: Math.floor((w - visW) / 2), y: Math.floor((h - visH) / 2), width: visW, height: visH });
    const outW = Math.max(1, Math.min(W, Math.round(visW * s)));
    const outH = Math.max(1, Math.min(H, Math.round(visH * s)));
    const resized = cropped.resize({ width: outW, height: outH, quality: 'best' });
    const size = resized.getSize();
    return encodeBmp24(resized.toBitmap(), size.width, size.height, W, H);
}

function requireIntroModOn() {
    const introMod = config.mods.find((m) => m.introMod);
    if (!introMod) throw new Error('Pick which mod is the intro mod first.');
    if (!introMod.enabled) throw new Error(`Turn on "${introMod.name}" first — the custom intro only works while it's on.`);
}

// Stage a picked image as the source; nothing touches the game until applied.
function stageSplashSource(imagePath) {
    requireIntroModOn();
    if (nativeImage.createFromPath(imagePath).isEmpty()) {
        throw new Error('Could not read that image. Use a PNG or JPEG.');
    }
    fs.mkdirSync(splashStoreDir, { recursive: true });
    for (const f of fs.readdirSync(splashStoreDir)) {
        if (f.startsWith('source.')) fs.rmSync(path.join(splashStoreDir, f), { force: true });
    }
    const dest = path.join(splashStoreDir, 'source' + extOf(imagePath));
    fs.copyFileSync(imagePath, dest);
    config.splashSource = dest;
    config.splashScale = 100;
    saveConfig();
}

// ---------- intro history ----------
// Whenever the applied custom intro is replaced (new image, or restoring the
// original), it's kept here so the user can go back to it.

const HISTORY_MAX = 5;
const historyDir = () => path.join(splashStoreDir, 'history');
const historyBmp = (id) => path.join(historyDir(), id + '.bmp');
const historyThumb = (id) => path.join(historyDir(), id + '.png');

// Decodes an uncompressed 24/32-bit BMP (what the game and this app use)
// into a BGRA buffer, since nativeImage can't read BMP.
function decodeBmp(file) {
    const buf = fs.readFileSync(file);
    if (buf.toString('ascii', 0, 2) !== 'BM') throw new Error('Not a BMP file.');
    const dataOffset = buf.readUInt32LE(10);
    const width = buf.readInt32LE(18);
    const rawHeight = buf.readInt32LE(22);
    const height = Math.abs(rawHeight);
    const bpp = buf.readUInt16LE(28);
    if (bpp !== 24 && bpp !== 32) throw new Error(`Unsupported BMP (${bpp}-bit).`);
    const bytesPP = bpp / 8;
    const rowSize = Math.ceil((width * bytesPP) / 4) * 4;
    const bgra = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        const srcRow = dataOffset + (rawHeight > 0 ? height - 1 - y : y) * rowSize;
        for (let x = 0; x < width; x++) {
            const s = srcRow + x * bytesPP;
            const d = (y * width + x) * 4;
            bgra[d] = buf[s];
            bgra[d + 1] = buf[s + 1];
            bgra[d + 2] = buf[s + 2];
            bgra[d + 3] = 255;
        }
    }
    return { width, height, bgra };
}

function makeThumb(bmpPath, pngPath) {
    const { width, height, bgra } = decodeBmp(bmpPath);
    const img = nativeImage.createFromBitmap(bgra, { width, height });
    fs.writeFileSync(pngPath, img.resize({ width: 320, quality: 'good' }).toPNG());
}

function removeHistoryFiles(id) {
    fs.rmSync(historyBmp(id), { force: true });
    fs.rmSync(historyThumb(id), { force: true });
}

// Moves the currently applied custom intro (if any) into history.
function pushCurrentToHistory() {
    if (!fs.existsSync(customSplashPath())) return;
    fs.mkdirSync(historyDir(), { recursive: true });
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    fs.renameSync(customSplashPath(), historyBmp(id));
    try { makeThumb(historyBmp(id), historyThumb(id)); } catch {}
    config.splashHistory = [{ id, appliedAt: config.customAppliedAt || Date.now() }, ...(config.splashHistory || [])];
    while (config.splashHistory.length > HISTORY_MAX) removeHistoryFiles(config.splashHistory.pop().id);
}

function revertSplash(id) {
    requireIntroModOn();
    const item = (config.splashHistory || []).find((h) => h.id === id);
    if (!item || !fs.existsSync(historyBmp(id))) throw new Error('That backup no longer exists.');

    // Take the backup out first so pushing the current intro can't evict it.
    const staged = path.join(splashStoreDir, 'reverting.bmp');
    fs.renameSync(historyBmp(id), staged);
    fs.rmSync(historyThumb(id), { force: true });
    config.splashHistory = config.splashHistory.filter((h) => h.id !== id);

    pushCurrentToHistory();
    fs.renameSync(staged, customSplashPath());
    config.customSplash = true;
    config.customAppliedAt = item.appliedAt;
    saveConfig();
    applyCustomSplash();
}

function deleteHistory(id) {
    removeHistoryFiles(id);
    config.splashHistory = (config.splashHistory || []).filter((h) => h.id !== id);
    saveConfig();
}

function applySplash(scale) {
    requireIntroModOn();
    if (!config.splashSource || !fs.existsSync(config.splashSource)) throw new Error('Choose an image first.');
    const pct = Math.min(300, Math.max(25, Math.round(Number(scale) || 100)));
    const bmp = renderSplash(config.splashSource, pct);
    fs.mkdirSync(splashStoreDir, { recursive: true });
    pushCurrentToHistory();
    fs.writeFileSync(customSplashPath(), bmp);
    config.customSplash = true;
    config.customAppliedAt = Date.now();
    config.splashScale = pct;
    saveConfig();
    applyCustomSplash();
}

function resetSplash() {
    restoreOriginalSplash();
    pushCurrentToHistory();
    if (config.splashSource) fs.rmSync(config.splashSource, { force: true });
    config.customSplash = false;
    config.splashSource = null;
    config.splashScale = 100;
    saveConfig();
}

function historyState() {
    return (config.splashHistory || [])
        .filter((h) => fs.existsSync(historyBmp(h.id)))
        .map((h) => ({ ...h, thumb: fs.existsSync(historyThumb(h.id)) ? historyThumb(h.id) : null }));
}

// ---------- state for the UI ----------

function state() {
    const found = gameFound();
    const present = new Set(found ? listModsDir().map((n) => n.toLowerCase()) : []);
    const introMod = config.mods.find((m) => m.introMod);
    const hasSource = !!config.splashSource && fs.existsSync(config.splashSource);
    const splashFile = found && fs.existsSync(gameSplashPath()) ? gameSplashPath() : null;
    return {
        gameRoot: config.gameRoot,
        downloadsPath: downloadsPath(),
        launchPlatform: config.launchPlatform || 'steam',
        trainerPath: config.trainerPath || null,
        appearance: config.appearance || {},
        gameFound: found,
        modsDir: modsDir(),
        categories: config.categories,
        mods: config.mods.map((m) => ({ ...m, status: found ? modStatus(m, present) : 'ok' })),
        splash: {
            name: splashFileName(),
            file: splashFile,
            stamp: splashFile ? fs.statSync(splashFile).mtimeMs : 0,
            custom: config.customSplash,
            source: hasSource ? config.splashSource : null,
            sourceStamp: hasSource ? fs.statSync(config.splashSource).mtimeMs : 0,
            scale: config.splashScale,
            history: historyState(),
            target: found ? splashTarget() : { width: 1920, height: 1080 },
            introModId: introMod?.id ?? null,
            introModOn: !!introMod?.enabled,
        },
    };
}

// Wrap handlers so errors come back as { error } instead of rejecting.
function handle(channel, fn) {
    ipcMain.handle(channel, async (_e, ...args) => {
        try {
            const result = await fn(...args);
            return { ok: true, result, state: state() };
        } catch (err) {
            return { ok: false, error: friendlyError(err), state: state() };
        }
    });
}

handle('state', () => {
    importUnknownMods();
    return null;
});

handle('toggle', (id, enabled) => setEnabled(findMod(id), enabled));

handle('rename', (id, name) => {
    const mod = findMod(id);
    mod.name = String(name).trim() || mod.name;
    saveConfig();
});

handle('delete', async (id) => {
    const mod = findMod(id);
    const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Delete', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Delete mod',
        message: `Delete "${mod.name}"?`,
        detail: 'It will be removed from the game and from the manager. You would need to add it again to use it.',
    });
    if (response !== 0) return false;
    await uninstallMod(mod);
    if (mod.introMod) restoreOriginalSplash();
    await fsp.rm(modStore(mod), { recursive: true, force: true });
    config.mods = config.mods.filter((m) => m !== mod);
    saveConfig();
    return true;
});

handle('pick-files', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Pick mod files',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Mod files', extensions: ['pak', 'ucas', 'utoc', 'sig', 'zip', 'rar', '7z'] }],
    });
    if (canceled || !filePaths.length) return [];
    return (await inspectPaths(filePaths)).flatMap((src) => src.files);
});

handle('inspect-paths', (paths) => inspectPaths(paths));
handle('add-sources', (sources, enable) => addSources(sources, enable));
handle('save-mod', (mod) => saveMod(mod));
handle('set-organization', (org) => setOrganization(org));
handle('scan-downloads', () => scanDownloads());
handle('import-download', (item) => importDownload(item));
handle('open-downloads', () => shell.openPath(downloadsPath()));
handle('pick-downloads', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: 'Downloads folder', properties: ['openDirectory'] });
    if (canceled || !filePaths.length) return false;
    config.downloadsPath = filePaths[0];
    saveConfig();
    scanCache.clear();
    watchDownloads();
    return true;
});
handle('launch-game', (platform) => launchGame(platform));
handle('pick-trainer', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Pick the trainer',
        properties: ['openFile'],
        filters: [{ name: 'Programs', extensions: ['exe', 'bat', 'cmd', 'lnk'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (canceled || !filePaths.length) return false;
    config.trainerPath = filePaths[0];
    saveConfig();
    return true;
});
handle('clear-trainer', () => {
    config.trainerPath = null;
    saveConfig();
});
handle('launch-trainer', async () => {
    if (!config.trainerPath) throw new Error('No trainer set. Pick one in settings > trainer.');
    if (!fs.existsSync(config.trainerPath)) throw new Error(`Trainer not found: ${config.trainerPath}`);
    // openPath goes through the Windows shell, so trainers that need admin get the normal UAC prompt.
    const error = await shell.openPath(config.trainerPath);
    if (error) throw new Error(`Could not start the trainer: ${error}`);
});
handle('set-appearance', (appearance) => {
    config.appearance = appearance;
    saveConfig();
});

handle('set-intro-mod', (id) => {
    const wasOn = config.mods.find((m) => m.introMod)?.enabled;
    for (const m of config.mods) m.introMod = m.id === id;
    saveConfig();
    const now = config.mods.find((m) => m.introMod);
    if (wasOn && !now?.enabled) restoreOriginalSplash();
    if (now?.enabled && config.customSplash) applyCustomSplash();
});

handle('pick-splash', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Choose intro image',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
    });
    if (canceled || !filePaths.length) return false;
    stageSplashSource(filePaths[0]);
    return true;
});

handle('splash-from-path', (p) => stageSplashSource(p));
handle('apply-splash', (scale) => applySplash(scale));
handle('reset-splash', () => resetSplash());
handle('revert-splash', (id) => revertSplash(id));
handle('delete-splash-history', (id) => deleteHistory(id));

handle('pick-game-root', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Select the Halloween game folder',
        properties: ['openDirectory'],
    });
    if (canceled || !filePaths.length) return false;
    const root = filePaths[0];
    if (!fs.existsSync(path.join(root, 'Ravage', 'Content', 'Paks'))) {
        throw new Error('That folder does not look like the Halloween install (no Ravage\\Content\\Paks inside).');
    }
    config.gameRoot = root;
    config.splashName = null;
    splashTargetCache = null;
    saveConfig();
    // Push the stored on/off state onto the new install.
    for (const m of config.mods) await (m.enabled ? installMod(m) : uninstallMod(m));
    importUnknownMods();
    return true;
});

handle('fix-mod', (id) => {
    const mod = findMod(id);
    return mod.enabled ? installMod(mod) : uninstallMod(mod);
});

handle('open-mods-folder', () => shell.openPath(fs.existsSync(modsDir()) ? modsDir() : paksDir()));
handle('open-storage', () => {
    fs.mkdirSync(storeDir, { recursive: true });
    return shell.openPath(storeDir);
});

// ---------- updates (GitHub releases, same setup as FMP) ----------

const { autoUpdater } = require('electron-updater');
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

const UPDATE_CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
let lastUpdateStatus = { status: 'idle' };
let manualCheck = false;

function sendUpdateStatus(status, extra = {}) {
    lastUpdateStatus = { status, ...extra };
    win?.webContents.send('update-status', lastUpdateStatus);
}

autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
autoUpdater.on('update-available', (info) => sendUpdateStatus('available', { version: info.version }));
autoUpdater.on('update-not-available', () => sendUpdateStatus('not-available'));
autoUpdater.on('download-progress', (p) => sendUpdateStatus('downloading', { percent: Math.round(p.percent), version: lastUpdateStatus.version }));
autoUpdater.on('update-downloaded', (info) => sendUpdateStatus('downloaded', { version: info.version }));
autoUpdater.on('error', (err) => {
    // Background checks fail quietly (offline etc.); only a button press reports errors.
    if (manualCheck || lastUpdateStatus.status === 'downloading') sendUpdateStatus('error', { message: err?.message || String(err) });
    else sendUpdateStatus('idle');
});

async function checkForUpdates(manual) {
    if (!app.isPackaged) {
        if (manual) sendUpdateStatus('dev');
        return;
    }
    if (['checking', 'downloading', 'downloaded'].includes(lastUpdateStatus.status)) return;
    manualCheck = manual;
    try {
        await autoUpdater.checkForUpdates();
    } catch {
        // reported through the 'error' event
    }
}

ipcMain.handle('update-info', () => ({ version: app.getVersion(), ...lastUpdateStatus }));
ipcMain.handle('check-for-updates', () => checkForUpdates(true));
ipcMain.handle('download-update', async () => {
    try {
        await autoUpdater.downloadUpdate();
    } catch (err) {
        sendUpdateStatus('error', { message: err?.message || String(err) });
    }
});
ipcMain.handle('install-update', () => autoUpdater.quitAndInstall());

// ---------- window ----------

function createWindow() {
    win = new BrowserWindow({
        width: 1000,
        height: 780,
        minWidth: 760,
        minHeight: 520,
        backgroundColor: '#121212',
        frame: false,
        title: 'Halloween Mod Manager',
        icon: path.join(__dirname, 'assets', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    win.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.on('minimize-window', () => win?.minimize());
ipcMain.on('maximize-window', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
ipcMain.on('close-window', () => win?.close());

app.whenReady().then(() => {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    loadConfig();
    createWindow();
    watchDownloads();
    // Auto-check shortly after start (so it doesn't compete with startup), then every few hours.
    setTimeout(() => checkForUpdates(false), 5000);
    setInterval(() => checkForUpdates(false), UPDATE_CHECK_EVERY_MS);
});

app.on('will-quit', () => fs.rmSync(stagingDir, { recursive: true, force: true }));
app.on('window-all-closed', () => app.quit());
