const app = document.getElementById('app');
const pathMatch = window.location.pathname.match(/\/(\d{3,6})\/stock-count\/([a-z0-9-]+)/);
const STORE_NUMBER = pathMatch ? pathMatch[1] : '';
const VENDOR_SLUG = pathMatch ? pathMatch[2] : '';
const NOLOGIN_MODE = /\/nologin\/?$/.test(window.location.pathname);

let catalog = null;
let draft = null;
let summary = null;
let currentLocationIndex = 0;
let viewMode = 'entry';
let statusMessage = '';
let statusKind = '';
let saving = false;

function dashboardPath() {
    if (!STORE_NUMBER) return '/';
    return NOLOGIN_MODE ? `/${STORE_NUMBER}/nologin` : `/${STORE_NUMBER}`;
}

function apiQuery(base) {
    const sep = base.includes('?') ? '&' : '?';
    return `${window.location.origin}${base}${sep}store=${encodeURIComponent(STORE_NUMBER)}&vendor=${encodeURIComponent(VENDOR_SLUG)}`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatItemLabel(item) {
    if (item.itemCode) {
        return `<span class="stock-count-item-code">${escapeHtml(item.itemCode)}</span><span class="stock-count-item-name">${escapeHtml(item.name)}</span>`;
    }
    return `<span class="stock-count-item-name">${escapeHtml(item.name)}</span>`;
}

function formatSummaryItemLabel(item) {
    if (item.itemCode) {
        return `<span class="stock-count-item-code">${escapeHtml(item.itemCode)}</span><span class="stock-count-item-name">${escapeHtml(item.itemName)}</span>`;
    }
    return `<span class="stock-count-item-name">${escapeHtml(item.itemName)}</span>`;
}

function setStatus(message, kind = '') {
    statusMessage = message;
    statusKind = kind;
    render();
}

function getItemsForLocation(locationName) {
    if (!catalog) return [];
    return catalog.items.filter((item) => item.locations.includes(locationName));
}

function locationHasData(locationName) {
    const loc = draft?.locations?.[locationName];
    if (!loc || typeof loc !== 'object') return false;
    const itemKeys = new Set(getItemsForLocation(locationName).map((i) => i.key));
    return Object.entries(loc).some(
        ([key, counts]) =>
            itemKeys.has(key) &&
            counts &&
            typeof counts === 'object' &&
            Object.values(counts).some((n) => Number(n) > 0)
    );
}

function readFormValues() {
    const values = {};
    if (!catalog) return values;
    const locationName = catalog.locations[currentLocationIndex];
    for (const item of getItemsForLocation(locationName)) {
        const row = {};
        for (const col of item.columns) {
            const input = document.querySelector(`input[data-item="${item.key}"][data-col="${col.key}"]`);
            if (!input) continue;
            const raw = String(input.value || '').trim();
            if (!raw) continue;
            const n = Number(raw);
            if (Number.isFinite(n) && n >= 0) row[col.key] = n;
        }
        if (Object.keys(row).length) values[item.key] = row;
    }
    return values;
}

function fillFormFromDraft(locationName) {
    if (!catalog) return;
    const loc = draft?.locations?.[locationName] || {};
    for (const item of getItemsForLocation(locationName)) {
        const counts = loc[item.key] || {};
        for (const col of item.columns) {
            const input = document.querySelector(`input[data-item="${item.key}"][data-col="${col.key}"]`);
            if (!input) continue;
            const v = counts[col.key];
            input.value = v != null && Number(v) >= 0 ? String(v) : '';
        }
    }
}

async function saveCurrentLocation(showFeedback = true) {
    if (!catalog || saving || draft?.submittedAt) return false;
    const locationName = catalog.locations[currentLocationIndex];
    saving = true;
    try {
        const res = await fetch(apiQuery('/api/stock-count/draft'), {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ location: locationName, items: readFormValues() }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Failed to save counts.');
        }
        draft = data;
        if (showFeedback) setStatus(`Saved ${locationName}.`, 'success');
        return true;
    } catch (error) {
        setStatus(error.message || 'Save failed.', 'error');
        return false;
    } finally {
        saving = false;
    }
}

async function loadSummary() {
    const res = await fetch(apiQuery('/api/stock-count/summary'), { credentials: 'include' });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed to load summary.');
    summary = data;
    return data;
}

async function goToReview() {
    const ok = await saveCurrentLocation(false);
    if (!ok && !draft?.locations) return;
    try {
        await loadSummary();
        viewMode = 'review';
        setStatus('', '');
    } catch (error) {
        setStatus(error.message, 'error');
    }
}

async function submitCounts() {
    if (draft?.submittedAt) return;
    saving = true;
    render();
    try {
        const res = await fetch(apiQuery('/api/stock-count/submit'), {
            method: 'POST',
            credentials: 'include',
            headers: { Accept: 'application/json' },
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Submit failed.');
        }
        draft = { ...draft, submittedAt: data.submittedAt };
        summary = data;
        setStatus('Stock count submitted. Macromatix entry will be added in a future update.', 'success');
        viewMode = 'review';
    } catch (error) {
        setStatus(error.message, 'error');
    } finally {
        saving = false;
        render();
    }
}

function buildEntryView() {
    const locationName = catalog.locations[currentLocationIndex];
    const itemsAtLocation = getItemsForLocation(locationName);
    const rows = itemsAtLocation
        .map((item) => {
            const ariaName = item.itemCode ? `${item.itemCode} ${item.name}` : item.name;
            const cells = item.columns
                .map(
                    (col) =>
                        `<td data-label="${escapeHtml(col.label)}"><input type="number" min="0" step="any" class="stock-count-input" data-item="${escapeHtml(item.key)}" data-col="${escapeHtml(col.key)}" inputmode="decimal" aria-label="${escapeHtml(ariaName)} ${escapeHtml(col.label)}"${draft?.submittedAt ? ' disabled' : ''}></td>`
                )
                .join('');
            return `<tr><td class="stock-count-item-cell" data-label="Item">${formatItemLabel(item)}</td>${cells}</tr>`;
        })
        .join('');

    const emptyNote =
        itemsAtLocation.length === 0
            ? '<p class="stock-count-empty-location">No items to count at this location.</p>'
            : '';

    const locButtons = catalog.locations
        .map((loc, idx) => {
            const classes = ['stock-count-loc-btn'];
            if (idx === currentLocationIndex) classes.push('stock-count-loc-btn--active');
            if (locationHasData(loc)) classes.push('stock-count-loc-btn--done');
            return `<button type="button" class="${classes.join(' ')}" data-loc-index="${idx}">${escapeHtml(loc)}</button>`;
        })
        .join('');

    return `
        <div class="stock-count-locations" role="tablist" aria-label="Storage locations">${locButtons}</div>
        <div class="stock-count-panel" role="tabpanel">
            <h2>${escapeHtml(locationName)}</h2>
            <table class="stock-count-table stock-count-table--entry">
                <tbody>${rows}</tbody>
            </table>
            ${emptyNote}
            <div class="stock-count-review-note">Enter counts for each item. Values combine across all locations on review.</div>
        </div>
        <div class="stock-count-actions">
            <button type="button" class="stock-count-btn stock-count-btn--secondary" id="sc-prev" ${currentLocationIndex === 0 ? 'disabled' : ''}>Previous</button>
            <button type="button" class="stock-count-btn" id="sc-save-next" ${draft?.submittedAt ? 'disabled' : ''}>${currentLocationIndex >= catalog.locations.length - 1 ? 'Save' : 'Save & next'}</button>
            <button type="button" class="stock-count-btn stock-count-btn--secondary" id="sc-review" ${draft?.submittedAt ? '' : ''}>Review totals</button>
        </div>
    `;
}

function buildReviewView() {
    const items = summary?.items || [];
    const allColKeys = [];
    const colLabelByKey = new Map();
    for (const item of catalog.items) {
        for (const col of item.columns) {
            if (!colLabelByKey.has(col.key)) {
                colLabelByKey.set(col.key, col.label);
                allColKeys.push(col.key);
            }
        }
    }

    const header = allColKeys.map((k) => `<th>${escapeHtml(colLabelByKey.get(k))}</th>`).join('');
    const rows = items
        .map((item) => {
            const cells = allColKeys
                .map((k) => {
                    const v = item.columns?.[k];
                    return `<td data-label="${escapeHtml(colLabelByKey.get(k))}">${v != null && Number(v) > 0 ? escapeHtml(String(v)) : '—'}</td>`;
                })
                .join('');
            return `<tr><td class="stock-count-item-cell" data-label="Item">${formatSummaryItemLabel(item)}</td>${cells}</tr>`;
        })
        .join('');

    return `
        <div class="stock-count-panel">
            <h2>Review — all locations combined</h2>
            <table class="stock-count-table">
                <thead><tr><th>Item</th>${header}</tr></thead>
                <tbody>${rows}</tbody>
            </table>
            <div class="stock-count-review-note">Totals combine the same item across all storage locations.</div>
        </div>
        <div class="stock-count-actions">
            <button type="button" class="stock-count-btn stock-count-btn--secondary" id="sc-back-entry" ${draft?.submittedAt ? 'disabled' : ''}>Back to entry</button>
            <button type="button" class="stock-count-btn" id="sc-submit" ${draft?.submittedAt || saving ? 'disabled' : ''}>Submit stock count</button>
            <button type="button" class="stock-count-btn stock-count-btn--secondary" id="sc-done" ${draft?.submittedAt ? '' : 'disabled'}>Return to dashboard</button>
        </div>
    `;
}

function render() {
    if (!catalog) return;
    const statusHtml = statusMessage
        ? `<div class="stock-count-status${statusKind ? ` stock-count-status--${statusKind}` : ''}" role="status">${escapeHtml(statusMessage)}</div>`
        : '';

    app.innerHTML = `
        <div class="stock-count">
            <header class="stock-count-header">
                <div>
                    <h1>Stock count</h1>
                    <p class="stock-count-subtitle">Store ${escapeHtml(STORE_NUMBER)} · ${escapeHtml(catalog.label)}</p>
                </div>
                <a class="stock-count-back" href="${escapeHtml(dashboardPath())}">← Dashboard</a>
            </header>
            ${statusHtml}
            ${viewMode === 'review' ? buildReviewView() : buildEntryView()}
        </div>
    `;

    if (viewMode === 'entry') {
        fillFormFromDraft(catalog.locations[currentLocationIndex]);
    }

    bindEvents();
}

function bindEvents() {
    app.querySelectorAll('[data-loc-index]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const idx = Number(btn.getAttribute('data-loc-index'));
            if (!Number.isFinite(idx) || idx === currentLocationIndex) return;
            await saveCurrentLocation(false);
            currentLocationIndex = idx;
            viewMode = 'entry';
            statusMessage = '';
            render();
        });
    });

    const prev = document.getElementById('sc-prev');
    prev?.addEventListener('click', async () => {
        await saveCurrentLocation(false);
        currentLocationIndex = Math.max(0, currentLocationIndex - 1);
        render();
    });

    const saveNext = document.getElementById('sc-save-next');
    saveNext?.addEventListener('click', async () => {
        const ok = await saveCurrentLocation(true);
        if (!ok) return;
        if (currentLocationIndex < catalog.locations.length - 1) {
            currentLocationIndex += 1;
            statusMessage = '';
            render();
        }
    });

    document.getElementById('sc-review')?.addEventListener('click', () => void goToReview());
    document.getElementById('sc-back-entry')?.addEventListener('click', () => {
        viewMode = 'entry';
        statusMessage = '';
        render();
    });
    document.getElementById('sc-submit')?.addEventListener('click', () => void submitCounts());
    document.getElementById('sc-done')?.addEventListener('click', () => {
        window.location.href = dashboardPath();
    });
}

async function init() {
    document.body.classList.add('stock-count-page');
    if (!STORE_NUMBER || !VENDOR_SLUG) {
        app.textContent = 'Invalid stock count URL.';
        return;
    }

    try {
        const [catRes, draftRes] = await Promise.all([
            fetch(apiQuery('/api/stock-count/catalog'), { credentials: 'include' }),
            fetch(apiQuery('/api/stock-count/draft'), { credentials: 'include' }),
        ]);
        const catData = await catRes.json();
        const draftData = await draftRes.json();
        if (!catRes.ok || !catData.success) throw new Error(catData.error || 'Catalog not found.');
        if (!draftRes.ok || !draftData.success) throw new Error(draftData.error || 'Draft not found.');
        catalog = catData.catalog;
        draft = draftData;
        if (draft.submittedAt) {
            await loadSummary();
            viewMode = 'review';
        }
        document.title = `Stock Count — ${catalog.label}`;
        render();
    } catch (error) {
        app.innerHTML = `<div class="stock-count"><p class="stock-count-status stock-count-status--error">${escapeHtml(error.message)}</p><p><a class="stock-count-back" href="${escapeHtml(dashboardPath())}">← Dashboard</a></p></div>`;
    }
}

void init();
