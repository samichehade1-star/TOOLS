const $ = (sel) => document.querySelector(sel);
let state = null;
let previewImg = null;
let previewKey = null;

// ---------- helpers ----------

function toast(msg, isError = false) {
    if (!msg) return;
    const el = $('#toast');
    el.textContent = msg;
    el.className = isError ? 'error' : '';
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.add('hidden'), isError ? 5000 : 2500);
}

async function run(promise, okMsg) {
    const res = await promise;
    state = res.state;
    render();
    if (!res.ok) toast(res.error, true);
    else if (okMsg) toast(typeof okMsg === 'function' ? okMsg(res.result) : okMsg);
    return res;
}

function fileUrl(p) {
    return 'file:///' + p.replace(/\\/g, '/').split('/').map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg))).join('/');
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- window + tabs ----------

$('#minimize-button').addEventListener('click', () => window.hmm.minimizeWindow());
$('#maximize-button').addEventListener('click', () => window.hmm.maximizeWindow());
$('#close-button').addEventListener('click', () => window.hmm.closeWindow());

function activateTab(name) {
    document.querySelectorAll('.tab-content').forEach((t) => t.classList.toggle('active', t.id === name + '-tab'));
    document.querySelectorAll('.tab-button[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    if (name === 'settings') drawPreview();
    if (name === 'downloads') refreshDownloads();
}
document.querySelectorAll('.tab-button[data-tab]').forEach((b) => b.addEventListener('click', () => activateTab(b.dataset.tab)));

// ---------- mods ----------

// "pakchunk99999999-Windows_P.pak" -> "99999999"; "No-Intro_P.pak" -> "No-Intro".
function shortName(file) {
    let stem = file.replace(/\.[^.]+$/, '').replace(/_P$/i, '');
    const m = stem.match(/^pakchunk[-_ ]?(.+)$/i);
    if (m) stem = m[1];
    return stem.replace(/-(Windows\w*|WinGDK\w*)$/i, '');
}
const shortNames = (files) => [...new Set(files.map(shortName))];

const UNCATEGORIZED = null;
const isCustomOrder = () => $('#mod-library-sort').value === 'custom' && !$('#mod-library-search').value.trim();

function modMatches(mod, q) {
    return !q || mod.name.toLowerCase().includes(q) || mod.files.some((f) => f.toLowerCase().includes(q));
}

function sortMods(mods) {
    const sort = $('#mod-library-sort').value;
    if (sort === 'recent') return [...mods].sort((a, b) => b.addedAt - a.addedAt);
    if (sort === 'alphabetical') return [...mods].sort((a, b) => a.name.localeCompare(b.name));
    return mods; // custom: saved order
}

function renderMods() {
    const list = $('#mod-list');
    list.innerHTML = '';
    $('#empty').classList.toggle('hidden', state.mods.length > 0);
    $('#game-missing').classList.toggle('hidden', state.gameFound);
    list.classList.toggle('custom-order', isCustomOrder());

    const q = $('#mod-library-search').value.trim().toLowerCase();
    const custom = isCustomOrder();
    const hasCategories = state.categories.length > 0;
    const groups = [{ id: UNCATEGORIZED, name: 'uncategorized' }, ...state.categories];

    for (const group of groups) {
        const mods = sortMods(state.mods.filter((m) => (m.categoryId ?? UNCATEGORIZED) === group.id && modMatches(m, q)));
        if (!hasCategories) {
            mods.forEach((mod) => list.appendChild(modCard(mod, custom)));
            continue;
        }
        // Hide empty groups while searching, and an empty "uncategorized" unless it can take drops.
        if (!mods.length && (q || (group.id === UNCATEGORIZED && !custom))) continue;
        list.appendChild(groupSection(group, mods, custom));
    }
}

function groupSection(group, mods, custom) {
    const section = document.createElement('section');
    section.className = 'mod-group' + (group.collapsed ? ' collapsed' : '');
    section.dataset.cat = group.id ?? '';
    const isReal = group.id !== UNCATEGORIZED;
    const on = mods.filter((m) => m.enabled).length;

    section.innerHTML = `
        <div class="mod-group-header">
            ${isReal && custom ? '<i class="fas fa-grip-vertical grip" title="Drag to reorder"></i>' : ''}
            ${isReal ? `<button class="icon-button collapse" title="Collapse"><i class="fas fa-chevron-down"></i></button>` : ''}
            <span class="mod-group-name">${escapeHtml(group.name)}</span>
            <span class="mod-group-count">${on}/${mods.length} on</span>
            ${isReal ? `
                <button class="icon-button rename-cat" title="Rename category"><i class="fas fa-pencil-alt"></i></button>
                <button class="icon-button delete delete-cat" title="Delete category (mods move to uncategorized)"><i class="fas fa-trash-alt"></i></button>` : ''}
        </div>
        <div class="mod-group-body"></div>`;

    const body = section.querySelector('.mod-group-body');
    mods.forEach((mod) => body.appendChild(modCard(mod, custom)));
    if (!mods.length) body.innerHTML = '<div class="group-placeholder">drag mods here</div>';

    if (isReal) {
        section.querySelector('.collapse').addEventListener('click', () => {
            updateCategory(group.id, { collapsed: !group.collapsed });
        });
        section.querySelector('.rename-cat').addEventListener('click', () => renameCategory(section, group));
        section.querySelector('.mod-group-name').addEventListener('dblclick', () => renameCategory(section, group));
        section.querySelector('.delete-cat').addEventListener('click', () => {
            const categories = state.categories.filter((c) => c.id !== group.id);
            const order = state.mods.map((m) => ({ id: m.id, categoryId: m.categoryId === group.id ? null : m.categoryId }));
            run(window.hmm.setOrganization({ categories, order }), `Deleted category "${group.name}"`);
        });
        if (custom) {
            const grip = section.querySelector('.grip');
            grip.addEventListener('mousedown', () => (section.draggable = true));
            section.addEventListener('dragstart', (e) => startDrag(e, 'cat', section));
            section.addEventListener('dragend', () => { section.draggable = false; });
        }
    }
    return section;
}

function modCard(mod, custom) {
    const item = document.createElement('div');
    item.className = 'mod-item ' + (mod.enabled ? 'mod-item-installed' : 'mod-item-not-installed');
    item.dataset.id = mod.id;
    let warn = '';
    if (mod.status === 'missing') warn = '<span class="mod-tag warn" title="Click to copy the files back in">files missing</span>';
    if (mod.status === 'leftover') warn = '<span class="mod-tag warn" title="Click to remove them">still in game folder</span>';

    item.innerHTML = `
        ${custom ? '<i class="fas fa-grip-vertical grip" title="Drag to reorder or move to another category"></i>' : ''}
        <div class="mod-main">
            <label class="toggle-switch" title="${mod.enabled ? 'Turn off (removes it from the game folder)' : 'Turn on'}">
                <input type="checkbox" ${mod.enabled ? 'checked' : ''} ${state.gameFound ? '' : 'disabled'}>
                <span class="slider"></span>
            </label>
            <div class="mod-text">
                <span class="mod-item-name">${escapeHtml(mod.name)}</span>
                <div class="mod-item-author" title="${escapeHtml(mod.files.join('\n'))}">${shortNames(mod.files).map(escapeHtml).join(', ')}</div>
            </div>
        </div>
        ${warn}
        ${mod.introMod ? '<span class="mod-tag">INTRO</span>' : ''}
        <button class="icon-button manage" title="Manage files"><i class="fas fa-folder-tree"></i></button>
        <button class="icon-button rename" title="Rename"><i class="fas fa-pencil-alt"></i></button>
        <button class="icon-button delete" title="Delete"><i class="fas fa-trash-alt"></i></button>`;

    const cb = item.querySelector('input');
    cb.addEventListener('change', async () => {
        cb.disabled = true;
        await run(window.hmm.toggle(mod.id, cb.checked), cb.checked ? `${mod.name} on` : `${mod.name} off: removed from the game folder`);
    });

    item.querySelector('.manage').addEventListener('click', () => openBuilder(mod));
    item.querySelector('.rename').addEventListener('click', () => startRename(item, mod));
    item.querySelector('.mod-item-name').addEventListener('dblclick', () => startRename(item, mod));
    item.querySelector('.delete').addEventListener('click', () => run(window.hmm.remove(mod.id), (deleted) => (deleted ? `Deleted ${mod.name}` : null)));
    item.querySelector('.mod-tag.warn')?.addEventListener('click', () => run(window.hmm.fixMod(mod.id), 'Fixed'));

    if (custom) {
        // Only the grip starts a drag, so clicking buttons / text never does.
        item.querySelector('.grip').addEventListener('mousedown', () => (item.draggable = true));
        item.addEventListener('dragstart', (e) => startDrag(e, 'mod', item));
        item.addEventListener('dragend', () => { item.draggable = false; });
    }
    return item;
}

// ---------- categories ----------

function saveOrganization(categories, okMsg) {
    const order = state.mods.map((m) => ({ id: m.id, categoryId: m.categoryId ?? null }));
    return run(window.hmm.setOrganization({ categories, order }), okMsg);
}

function updateCategory(id, patch) {
    return saveOrganization(state.categories.map((c) => (c.id === id ? { ...c, ...patch } : c)));
}

function renameCategory(section, group) {
    const nameEl = section.querySelector('.mod-group-name');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'mod-rename-input category-rename';
    input.value = group.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
        if (done) return;
        done = true;
        const name = input.value.trim();
        if (save && name && name !== group.name) updateCategory(group.id, { name });
        else renderMods();
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
}

$('#new-category-btn').addEventListener('click', async () => {
    const id = 'c' + Date.now().toString(36);
    $('#mod-library-sort').value = 'custom';
    $('#mod-library-search').value = '';
    const res = await saveOrganization([...state.categories, { id, name: 'new category', collapsed: false }]);
    if (!res.ok) return;
    const section = document.querySelector(`.mod-group[data-cat="${id}"]`);
    section?.scrollIntoView({ block: 'nearest' });
    if (section) renameCategory(section, state.categories.find((c) => c.id === id));
});

// ---------- drag to reorder ----------
// The dragged element is moved live in the DOM; on drop the new order is
// read back from the DOM and saved.

let dragging = null; // { type: 'mod' | 'cat', el }

function startDrag(e, type, el) {
    e.stopPropagation();
    dragging = { type, el };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-hmm-reorder', type);
    requestAnimationFrame(() => el.classList.add('dragging'));
}

function afterMidpoint(e, el) {
    const r = el.getBoundingClientRect();
    return e.clientY > r.top + r.height / 2;
}

$('#mod-list').addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    if (dragging.type === 'mod') {
        const overItem = e.target.closest('.mod-item');
        if (overItem && overItem !== dragging.el) {
            overItem.parentElement.insertBefore(dragging.el, afterMidpoint(e, overItem) ? overItem.nextSibling : overItem);
        } else if (!overItem) {
            const group = e.target.closest('.mod-group');
            const body = group?.querySelector('.mod-group-body');
            if (body && dragging.el.parentElement !== body) {
                body.querySelector('.group-placeholder')?.remove();
                body.appendChild(dragging.el);
            }
        }
    } else {
        const overGroup = e.target.closest('.mod-group');
        if (overGroup && overGroup !== dragging.el && overGroup.dataset.cat) {
            $('#mod-list').insertBefore(dragging.el, afterMidpoint(e, overGroup) ? overGroup.nextSibling : overGroup);
        }
    }
});

$('#mod-list').addEventListener('drop', (e) => {
    if (dragging) e.preventDefault();
});

document.addEventListener('dragend', () => {
    if (!dragging) return;
    dragging.el.classList.remove('dragging');
    dragging = null;

    const list = $('#mod-list');
    const byId = new Map(state.categories.map((c) => [c.id, c]));
    const categories = [...list.querySelectorAll('.mod-group')]
        .map((g) => byId.get(g.dataset.cat))
        .filter(Boolean);
    let order;
    if (list.querySelector('.mod-group')) {
        order = [...list.querySelectorAll('.mod-group')].flatMap((g) =>
            [...g.querySelectorAll('.mod-item')].map((el) => ({ id: el.dataset.id, categoryId: g.dataset.cat || null })));
    } else {
        order = [...list.querySelectorAll('.mod-item')].map((el) => ({ id: el.dataset.id, categoryId: null }));
    }
    // Keep any mods that weren't rendered (e.g. an empty uncategorized group is hidden).
    const seen = new Set(order.map((o) => o.id));
    for (const m of state.mods) if (!seen.has(m.id)) order.push({ id: m.id, categoryId: m.categoryId ?? null });
    run(window.hmm.setOrganization({ categories, order }));
});

function startRename(item, mod) {
    const nameEl = item.querySelector('.mod-item-name');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'mod-rename-input';
    input.value = mod.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (save) => {
        if (done) return;
        done = true;
        const name = input.value.trim();
        if (save && name && name !== mod.name) run(window.hmm.rename(mod.id, name));
        else renderMods();
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
}

const addedMsg = (r) => {
    if (!r) return null;
    const parts = [];
    if (r.added.length) parts.push(`Installed: ${r.added.join(', ')}`);
    if (r.skipped.length) parts.push(`Skipped: ${r.skipped.join(', ')}`);
    return parts.join(' | ');
};

$('#add-btn').addEventListener('click', () => openBuilder());
$('#open-mods').addEventListener('click', () => window.hmm.openModsFolder());
$('#mod-library-search').addEventListener('input', renderMods);
$('#mod-library-sort').addEventListener('change', renderMods);

// ---------- settings ----------

const scaleInput = $('#scale');

function renderSettings() {
    const s = state.splash;
    $('#game-root').value = state.gameRoot;
    $('#trainer-path').value = state.trainerPath || '';
    $('#clear-trainer').disabled = !state.trainerPath;
    $('#mods-dir').textContent = state.modsDir;
    $('#splash-name').textContent = s.name;

    const sel = $('#intro-mod');
    sel.innerHTML = '<option value="">none</option>' +
        state.mods.map((m) => `<option value="${m.id}" ${m.id === s.introModId ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('');

    const introMod = state.mods.find((m) => m.id === s.introModId);
    const off = $('#intro-off');
    off.textContent = !introMod
        ? 'Choose which mod is the intro mod above.'
        : `"${introMod.name}" is off. Turn it on in the mods tab to use a custom intro.`;
    off.classList.toggle('hidden', !!introMod?.enabled);

    const usable = !!introMod?.enabled && state.gameFound;
    $('#pick-splash').disabled = !usable;
    $('#apply-splash').disabled = !usable || !s.source;
    scaleInput.disabled = !s.source;
    document.querySelectorAll('.presets button').forEach((b) => (b.disabled = !s.source));
    $('#reset-splash').disabled = !s.custom && !s.source;
    $('#undo-splash').disabled = !usable || !s.history.length;
    renderSplashHistory(s.history, usable);

    if (document.activeElement !== scaleInput) scaleInput.value = s.scale;
    $('#scale-val').textContent = scaleInput.value + '%';

    // Show the staged image if there is one, otherwise the splash currently in the game.
    const key = s.source ? s.source + s.sourceStamp : s.file ? s.file + s.stamp : null;
    if (key !== previewKey) {
        previewKey = key;
        previewImg = null;
        if (key) {
            const img = new Image();
            img.onload = () => { previewImg = img; drawPreview(); };
            img.src = s.source ? `${fileUrl(s.source)}?v=${s.sourceStamp}` : `${fileUrl(s.file)}?v=${s.stamp}`;
        }
    }
    drawPreview();
}

// Mirrors renderSplash() in main.js so the preview matches the result.
function drawPreview() {
    if (!state) return;
    const canvas = $('#preview');
    const { width: W, height: H } = state.splash.target;
    canvas.width = 480;
    canvas.height = Math.round((480 * H) / W);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const staged = !!state.splash.source;
    $('#preview-label').textContent = staged ? 'preview (not applied yet)' : state.splash.file ? 'current in game' : 'no splash found';
    if (!previewImg) return;

    const w = previewImg.naturalWidth;
    const h = previewImg.naturalHeight;
    const scale = staged ? Number(scaleInput.value) / 100 : 1;
    const s = Math.min(W / w, H / h) * scale * (canvas.width / W);
    const dw = w * s;
    const dh = h * s;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(previewImg, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
}

// The scale at which the image covers the whole screen with no black bars.
function fillScale() {
    if (!previewImg) return 100;
    const { width: W, height: H } = state.splash.target;
    const w = previewImg.naturalWidth;
    const h = previewImg.naturalHeight;
    return Math.round((Math.max(W / w, H / h) / Math.min(W / w, H / h)) * 100);
}

scaleInput.addEventListener('input', () => {
    $('#scale-val').textContent = scaleInput.value + '%';
    drawPreview();
});
document.querySelectorAll('.presets button').forEach((b) => {
    b.addEventListener('click', () => {
        scaleInput.value = b.dataset.scale === 'fill' ? Math.min(300, fillScale()) : b.dataset.scale;
        scaleInput.dispatchEvent(new Event('input'));
    });
});

const loadedMsg = (picked) => (picked === false ? null : 'Image loaded. Adjust the size, then apply.');
$('#intro-mod').addEventListener('change', (e) => run(window.hmm.setIntroMod(e.target.value || null)));
$('#pick-splash').addEventListener('click', () => run(window.hmm.pickSplash(), loadedMsg));
$('#apply-splash').addEventListener('click', () => run(window.hmm.applySplash(Number(scaleInput.value)), 'Intro applied to the game'));
$('#reset-splash').addEventListener('click', () => run(window.hmm.resetSplash(), 'Original intro restored. The one you had is in previous intros.'));
$('#undo-splash').addEventListener('click', () => {
    const last = state.splash.history[0];
    if (last) run(window.hmm.revertSplash(last.id), 'Previous intro restored');
});

function renderSplashHistory(history, usable) {
    $('#splash-history-wrap').classList.toggle('hidden', !history.length);
    const box = $('#splash-history');
    box.innerHTML = '';
    for (const h of history) {
        const card = document.createElement('div');
        card.className = 'history-card';
        const when = new Date(h.appliedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        card.innerHTML = `
            <button class="history-use" ${usable ? '' : 'disabled'} title="${usable ? 'Put this intro back in the game' : 'Turn on the intro mod first'}">
                ${h.thumb ? `<img src="${fileUrl(h.thumb)}" alt="">` : '<div class="history-nothumb"><i class="fas fa-image"></i></div>'}
                <span class="history-when">${escapeHtml(when)}</span>
                <span class="history-hover"><i class="fas fa-rotate-left"></i> use this</span>
            </button>
            <button class="icon-button delete history-del" title="Delete this backup"><i class="fas fa-times"></i></button>`;
        card.querySelector('.history-use').addEventListener('click', () => run(window.hmm.revertSplash(h.id), 'Intro restored from backup'));
        card.querySelector('.history-del').addEventListener('click', () => run(window.hmm.deleteSplashHistory(h.id), 'Backup deleted'));
        box.appendChild(card);
    }
}
$('#pick-root').addEventListener('click', () => run(window.hmm.pickGameRoot(), (changed) => (changed ? 'Game folder updated' : null)));
$('#open-storage').addEventListener('click', () => window.hmm.openStorage());

// ---------- mod builder ----------
// Used for "install mods" (build a mod from loose pakchunks, name it) and for
// managing an existing mod's files. files: [{ name, src }] — src is null for
// files already in storage.

let builder = null;

function openBuilder(mod = null, prefill = null) {
    builder = {
        id: mod?.id ?? null,
        files: mod ? mod.files.map((name) => ({ name, src: null })) : [],
    };
    $('#builder-title').textContent = mod ? 'manage mod' : 'new mod';
    $('#builder-name').value = mod?.name ?? prefill?.name ?? '';
    $('#builder-enable').checked = true;
    $('#builder-enable-row').classList.toggle('hidden', !!mod?.enabled);
    if (prefill?.files) addBuilderFiles(prefill.files);
    renderBuilder();
    $('#builder').classList.remove('hidden');
    $('#builder-name').focus();
}

function closeBuilder() {
    builder = null;
    $('#builder').classList.add('hidden');
}

function addBuilderFiles(files) {
    for (const f of files) {
        const i = builder.files.findIndex((x) => x.name.toLowerCase() === f.name.toLowerCase());
        if (i >= 0) builder.files[i] = f;
        else builder.files.push(f);
    }
    // Suggest a name from the first pakchunk if the user hasn't typed one.
    const nameInput = $('#builder-name');
    if (!nameInput.value.trim() && builder.files.length) {
        nameInput.value = builder.files[0].name.replace(/\.[^.]+$/, '').replace(/_P$/i, '');
    }
    renderBuilder();
}

function renderBuilder() {
    const box = $('#builder-files');
    $('#builder-count').textContent = builder.files.length ? `(${builder.files.length})` : '';
    if (!builder.files.length) {
        box.innerHTML = '<div class="placeholder">no files yet. Click add files or drop them here.</div>';
        return;
    }
    const order = { '.pak': 0, '.ucas': 1, '.utoc': 2, '.sig': 3 };
    const ext = (n) => n.slice(n.lastIndexOf('.')).toLowerCase();
    builder.files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || order[ext(a.name)] - order[ext(b.name)]);
    box.innerHTML = '';
    builder.files.forEach((f, i) => {
        const row = document.createElement('div');
        row.className = 'builder-file';
        row.innerHTML = `
            <i class="fas fa-file" style="color:var(--secondary-text-dark)"></i>
            <span class="fname" title="${escapeHtml(f.src || f.name)}">${escapeHtml(f.name)}</span>
            ${f.src ? '<span class="ftag">new</span>' : ''}
            <button class="icon-button delete" title="Remove from this mod"><i class="fas fa-times"></i></button>`;
        row.querySelector('button').addEventListener('click', () => {
            builder.files.splice(i, 1);
            renderBuilder();
        });
        box.appendChild(row);
    });
}

$('#builder-add-files').addEventListener('click', async () => {
    const res = await window.hmm.pickFiles();
    if (!res.ok) return toast(res.error, true);
    if (builder) addBuilderFiles(res.result);
});
$('#builder-close').addEventListener('click', closeBuilder);
$('#builder-cancel').addEventListener('click', closeBuilder);
$('#builder').addEventListener('mousedown', (e) => { if (e.target.id === 'builder') closeBuilder(); });
$('#builder-save').addEventListener('click', async () => {
    const payload = {
        id: builder.id,
        name: $('#builder-name').value,
        files: builder.files,
        enable: $('#builder-enable').checked,
    };
    const res = await run(window.hmm.saveMod(payload), (name) => (payload.id ? `Saved ${name}` : `Added ${name}`));
    if (res.ok) closeBuilder();
});
$('#builder-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#builder-save').click(); });

// ---------- downloads tab ----------

let downloads = [];

async function refreshDownloads() {
    const res = await window.hmm.scanDownloads();
    if (res.state) state = res.state;
    downloads = res.ok ? res.result : [];
    renderDownloads();
}

function renderDownloads() {
    $('#downloads-path-text').textContent = state?.downloadsPath ?? '';
    const pending = downloads.filter((d) => !d.addedAs).length;
    const badge = $('#downloads-count');
    badge.textContent = pending;
    badge.classList.toggle('hidden', !pending);

    const list = $('#downloads-list');
    list.innerHTML = '';
    $('#no-downloads').classList.toggle('hidden', downloads.length > 0);
    const icons = { folder: 'fa-folder', zip: 'fa-file-zipper', rar: 'fa-file-zipper', '7z': 'fa-file-zipper', loose: 'fa-file' };
    const kinds = { folder: 'folder', zip: 'zip', rar: 'rar', '7z': '7z', loose: 'loose files' };

    for (const d of downloads) {
        const card = document.createElement('div');
        card.className = 'download-card' + (d.addedAs ? ' added' : '');
        card.innerHTML = `
            <i class="fas ${icons[d.kind]} download-card-icon"></i>
            <div class="download-card-info">
                <div class="download-card-name"><input type="text" value="${escapeHtml(d.name)}" title="Name the mod before adding it"></div>
                <div class="download-card-meta">${kinds[d.kind]} · ${d.files.length} file${d.files.length === 1 ? '' : 's'}: ${shortNames(d.files).map(escapeHtml).join(', ')}</div>
                ${d.addedAs ? `<div class="download-card-meta" style="color:var(--accent-color)">already in your mods as "${escapeHtml(d.addedAs)}"</div>` : ''}
            </div>
            <div class="download-card-actions">
                <button class="primary-button add" ${d.addedAs ? 'disabled' : ''}><i class="fas fa-file-import"></i> add to mods</button>
            </div>`;
        const input = card.querySelector('input');
        card.querySelector('.add').addEventListener('click', async (e) => {
            e.currentTarget.disabled = true;
            const res = await run(window.hmm.importDownload({ ...d, name: input.value }), (name) => `Added ${name}. Turn it on in the mods tab.`);
            if (res.ok) refreshDownloads();
            else e.currentTarget.disabled = false;
        });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') card.querySelector('.add').click(); });
        list.appendChild(card);
    }
}

$('#rescan-downloads').addEventListener('click', refreshDownloads);
$('#open-downloads').addEventListener('click', () => window.hmm.openDownloads());
$('#change-downloads').addEventListener('click', async () => {
    await run(window.hmm.pickDownloads(), (changed) => (changed ? 'Downloads folder changed' : null));
    refreshDownloads();
});
window.hmm.onDownloadsChanged(refreshDownloads);

// ---------- appearance (ported from FMP's theme + layout editor) ----------

const THEME_PRESETS = {
    pumpkin: { background: '#121212', sidebar: '#1e1e1e', modCardOn: '#2e2116', modCardOff: '#1e1e1e', text: '#e0e0e0', accent: '#ff7a1a', hover: '#e06208', border: '#2c2c2c', titleBar: '#1e1e1e' },
    blood: { background: '#0e0909', sidebar: '#1a1010', modCardOn: '#3a1117', modCardOff: '#1a1212', text: '#eadede', accent: '#d0142c', hover: '#a50f22', border: '#2e1a1c', titleBar: '#1a1010' },
    toxic: { background: '#0b0f0a', sidebar: '#141a12', modCardOn: '#1f3314', modCardOff: '#151b13', text: '#e2eadc', accent: '#7ddc1f', hover: '#5fb00f', border: '#243020', titleBar: '#141a12' },
    ghost: { background: '#0f1216', sidebar: '#1a1f26', modCardOn: '#26303c', modCardOff: '#1a1f26', text: '#e6ecf2', accent: '#c9d6e3', hover: '#9fb2c6', border: '#2a323c', titleBar: '#1a1f26' },
    fmp: { background: '#121212', sidebar: '#1e1e1e', modCardOn: '#2d2440', modCardOff: '#1e1e1e', text: '#e0e0e0', accent: '#bb86fc', hover: '#a252f8', border: '#2c2c2c', titleBar: '#1e1e1e' },
};
const DEFAULT_THEME = THEME_PRESETS.pumpkin;
const THEME_KEY_TO_CSS_VAR = {
    background: '--bg-color-dark',
    sidebar: '--sidebar-color',
    modCardOn: '--mod-card-on-color',
    modCardOff: '--mod-card-off-color',
    text: '--primary-text-dark',
    accent: '--accent-color',
    hover: '--accent-hover',
    border: '--border-color-dark',
    titleBar: '--title-bar-color',
};
const DEFAULT_LAYOUT = { fontSize: 15, textGlow: false, glowIntensity: 45, glowColor: DEFAULT_THEME.accent };

let appearance = { theme: { ...DEFAULT_THEME }, layout: { ...DEFAULT_LAYOUT } };

// Black or white text, whichever has the better WCAG contrast on this background.
function getContrastTextColors(hexColor) {
    let hex = (hexColor || '#1e1e1e').replace('#', '');
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    const [r, g, b] = [0, 2, 4].map((i) => (parseInt(hex.substr(i, 2), 16) || 0) / 255);
    const toLinear = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const luminance = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
    return 1.05 / (luminance + 0.05) > (luminance + 0.05) / 0.05
        ? { main: '#f5f5f5', secondary: '#d7d7d7' }
        : { main: '#141414', secondary: '#272727' };
}

function applyTheme(theme) {
    const merged = { ...DEFAULT_THEME, ...theme };
    const root = document.documentElement.style;
    for (const [key, cssVar] of Object.entries(THEME_KEY_TO_CSS_VAR)) root.setProperty(cssVar, merged[key]);
    // The surface color follows the sidebar so cards/sections match the chosen palette.
    root.setProperty('--surface-color-dark', merged.sidebar);

    const on = getContrastTextColors(merged.modCardOn);
    const off = getContrastTextColors(merged.modCardOff);
    root.setProperty('--mod-card-on-text-color', on.main);
    root.setProperty('--mod-card-on-text-secondary', on.secondary);
    root.setProperty('--mod-card-off-text-color', off.main);
    root.setProperty('--mod-card-off-text-secondary', off.secondary);
    root.setProperty('--toggle-knob-on-color', getContrastTextColors(merged.accent).main);

    document.querySelectorAll('#theme-color-grid input[type="color"]').forEach((input) => {
        input.value = merged[input.dataset.themeKey];
    });
    return merged;
}

function applyLayoutSettings(layout) {
    const merged = { ...DEFAULT_LAYOUT, ...layout };
    merged.fontSize = Math.max(12, Math.min(22, Number(merged.fontSize) || 15));
    document.documentElement.style.fontSize = `${merged.fontSize}px`;
    $('#font-size-slider').value = merged.fontSize;
    $('#font-size-value').textContent = `${merged.fontSize}px`;

    document.body.classList.toggle('text-glow-on', !!merged.textGlow);
    $('#text-glow-toggle').checked = !!merged.textGlow;
    const glowPx = (Math.max(0, Math.min(100, merged.glowIntensity)) / 100) * 24;
    document.documentElement.style.setProperty('--glow-size', `${glowPx}px`);
    document.documentElement.style.setProperty('--glow-color', merged.glowColor);
    $('#glow-intensity-slider').value = merged.glowIntensity;
    $('#glow-intensity-value').textContent = `${merged.glowIntensity}%`;
    $('#glow-color-picker').value = merged.glowColor;
    $('#glow-intensity-row').style.display = merged.textGlow ? 'flex' : 'none';
    $('#glow-color-row').style.display = merged.textGlow ? 'flex' : 'none';
    return merged;
}

function applyAppearance() {
    appearance.theme = applyTheme(appearance.theme);
    appearance.layout = applyLayoutSettings(appearance.layout);
    drawPreview();
}

const saveAppearance = () => window.hmm.setAppearance(appearance);

// Live preview on input, persist on release (same pattern as FMP).
document.querySelectorAll('#theme-color-grid input[type="color"]').forEach((input) => {
    input.addEventListener('input', () => {
        appearance.theme[input.dataset.themeKey] = input.value;
        applyAppearance();
    });
    input.addEventListener('change', saveAppearance);
});
document.querySelectorAll('.theme-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
        const preset = THEME_PRESETS[btn.dataset.preset];
        appearance.theme = { ...preset };
        appearance.layout.glowColor = preset.accent;
        applyAppearance();
        saveAppearance();
    });
});
$('#reset-theme-button').addEventListener('click', () => {
    appearance = { theme: { ...DEFAULT_THEME }, layout: { ...DEFAULT_LAYOUT } };
    applyAppearance();
    saveAppearance();
});
$('#font-size-slider').addEventListener('input', (e) => {
    appearance.layout.fontSize = Number(e.target.value);
    applyAppearance();
});
$('#font-size-slider').addEventListener('change', saveAppearance);
$('#text-glow-toggle').addEventListener('change', (e) => {
    appearance.layout.textGlow = e.target.checked;
    applyAppearance();
    saveAppearance();
});
$('#glow-intensity-slider').addEventListener('input', (e) => {
    appearance.layout.glowIntensity = Number(e.target.value);
    applyAppearance();
});
$('#glow-intensity-slider').addEventListener('change', saveAppearance);
$('#glow-color-picker').addEventListener('input', (e) => {
    appearance.layout.glowColor = e.target.value;
    applyAppearance();
});
$('#glow-color-picker').addEventListener('change', saveAppearance);

// ---------- updates ----------

let update = { status: 'idle' };

function renderUpdate() {
    const text = $('#update-status-text');
    const action = $('#update-action');
    const banner = $('#update-banner');
    const check = $('#check-updates');
    const v = update.version ? ` v${update.version}` : '';
    const messages = {
        idle: '',
        dev: 'Updates only work in the installed app (this is the dev build).',
        checking: 'Checking GitHub for updates...',
        'not-available': "You're on the latest version.",
        available: `Update${v} is available.`,
        downloading: `Downloading update${v}... ${update.percent ?? 0}%`,
        downloaded: `Update${v} is ready. Restart to install it.`,
        error: `Update check failed: ${update.message || 'unknown error'}`,
    };
    text.textContent = messages[update.status] ?? '';
    check.disabled = ['checking', 'downloading'].includes(update.status);

    const actions = { available: 'download update', downloaded: 'restart & install' };
    action.classList.toggle('hidden', !actions[update.status]);
    action.innerHTML = update.status === 'downloaded'
        ? '<i class="fas fa-power-off"></i> restart & install'
        : '<i class="fas fa-download"></i> download update';

    const bannerText = { available: `update${v}`, downloading: `downloading ${update.percent ?? 0}%`, downloaded: 'restart to update' };
    banner.classList.toggle('hidden', !bannerText[update.status]);
    $('#update-banner-text').textContent = bannerText[update.status] ?? '';
}

function updateAction() {
    if (update.status === 'available') window.hmm.downloadUpdate();
    else if (update.status === 'downloaded') window.hmm.installUpdate();
    else activateTab('settings');
}

window.hmm.onUpdateStatus((data) => {
    const was = update.status;
    update = data;
    renderUpdate();
    if (data.status === 'available' && was !== 'available') toast(`Update v${data.version} is available. Click the update button in the sidebar.`);
});
$('#check-updates').addEventListener('click', () => window.hmm.checkForUpdates());
$('#update-action').addEventListener('click', updateAction);
$('#update-banner').addEventListener('click', updateAction);
window.hmm.updateInfo().then((info) => {
    $('#app-version').textContent = info.version;
    update = info;
    renderUpdate();
});

// ---------- launch ----------

$('#launch-trainer').addEventListener('click', () => {
    if (!state.trainerPath) {
        activateTab('settings');
        return toast('Set the trainer path first (settings > trainer).', true);
    }
    run(window.hmm.launchTrainer(), 'Launching trainer...');
});
$('#pick-trainer').addEventListener('click', () => run(window.hmm.pickTrainer(), (picked) => (picked ? 'Trainer set' : null)));
$('#clear-trainer').addEventListener('click', () => run(window.hmm.clearTrainer(), 'Trainer cleared'));
$('#launch-game').addEventListener('click', () => run(window.hmm.launchGame($('#launch-platform').value), 'Launching Halloween...'));

// ---------- drag & drop ----------

let dragDepth = 0;
const overlay = $('#drag-overlay');
const builderOpen = () => !$('#builder').classList.contains('hidden');
const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth++;
    if (builderOpen()) { $('#builder-files').classList.add('over'); return; }
    overlay.textContent = $('#settings-tab').classList.contains('active') ? 'drop an image for the intro, or mods to install' : 'drop mods to install';
    overlay.classList.add('show');
});
window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    if (--dragDepth <= 0) {
        dragDepth = 0;
        overlay.classList.remove('show');
        $('#builder-files').classList.remove('over');
    }
});
window.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.remove('show');
    $('#builder-files').classList.remove('over');
    const paths = [...e.dataTransfer.files].map((f) => window.hmm.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;

    const image = paths.find((p) => /\.(png|jpe?g)$/i.test(p));
    if (image && !builderOpen() && $('#settings-tab').classList.contains('active')) {
        if ($('#pick-splash').disabled) toast('Turn on the intro mod first.', true);
        else run(window.hmm.splashFromPath(image), loadedMsg);
        return;
    }

    const res = await window.hmm.inspectPaths(paths);
    if (!res.ok) return toast(res.error, true);
    const sources = res.result;
    if (!sources.length) return toast('No .pak / .ucas / .utoc files in what you dropped.', true);

    // Builder open: everything dropped goes into the mod being built.
    if (builderOpen()) return addBuilderFiles(sources.flatMap((s) => s.files));

    // Folders and zips become mods straight away (named after the folder/zip).
    // Loose pakchunks open the builder so the user can name and group them.
    const packaged = sources.filter((s) => s.label);
    const loose = sources.find((s) => !s.label);
    if (packaged.length) await run(window.hmm.addSources(packaged, true), addedMsg);
    if (loose) openBuilder(null, { files: loose.files });
});

// ---------- boot ----------

function render() {
    renderMods();
    renderSettings();
    $('#downloads-path-text').textContent = state.downloadsPath;
    if (document.activeElement !== $('#launch-platform')) $('#launch-platform').value = state.launchPlatform;
}

run(window.hmm.state()).then(() => {
    const saved = state.appearance || {};
    appearance = { theme: { ...DEFAULT_THEME, ...saved.theme }, layout: { ...DEFAULT_LAYOUT, ...saved.layout } };
    applyAppearance();
    refreshDownloads();
});
