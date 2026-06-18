const app = document.getElementById('app');
const pathMatch = window.location.pathname.match(/\/(teststore|\d{3,6})\/daily-stock-count\/?$/i);
const STORE_NUMBER = pathMatch ? pathMatch[1].toLowerCase() : '';
const DAILY_COUNT_STORE_KEY = 'daily-count-store';

let catalog = null;
let accessibleStores = [];
let showStorePicker = false;
let draft = null;
let currentLocationIndex = 0;
let viewMode = 'entry';
let openCounts = [];
let startResolution = 'create';
let openBatchValue = null;
let mmxSessionId = '';
let mmxVariances = [];
let statusMessage = '';
let statusKind = '';
let saving = false;
let processing = false;
let processingStageLabel = 'Sending to Macromatix…';
let mmxProcessingError = null;
let mmxProcessingSuccess = null;
let mmxPollInFlight = null;
let needsMmxCredentials = false;
let startupComplete = false;
let startupProbing = false;

const MMX_PIPELINE_POLL_MS = 2000;
const MMX_STATUS_PROBE_MS = 90000;

function dashboardPath() {
    return STORE_NUMBER ? `/${STORE_NUMBER}` : '/';
}

function micPath() {
    return STORE_NUMBER ? `/MIC/${STORE_NUMBER}` : '/overview';
}

function overviewPath() {
    return '/overview';
}

function rememberDailyCountStore(storeNum) {
    if (!storeNum) return;
    try {
        sessionStorage.setItem(DAILY_COUNT_STORE_KEY, String(storeNum).toLowerCase());
    } catch {
        /* ignore */
    }
}

function buildStorePickerHtml() {
    if (!showStorePicker || accessibleStores.length < 2) {
        return `<p class="stock-count-subtitle">Store ${escapeHtml(STORE_NUMBER)}</p>`;
    }
    const options = accessibleStores
        .map((store) => {
            const num = String(store.storeNumber || '').toLowerCase();
            const name = String(store.storeName || '').trim();
            const label = name ? `${num} — ${name}` : num;
            const selected = num === STORE_NUMBER ? ' selected' : '';
            return `<option value="${escapeHtml(num)}"${selected}>${escapeHtml(label)}</option>`;
        })
        .join('');
    return `
        <label class="stock-count-store-picker">
            <span class="stock-count-store-picker-label">Store</span>
            <select id="daily-count-store-select" class="stock-count-store-select" aria-label="Select store">
                ${options}
            </select>
        </label>`;
}

function apiQuery(base, params = {}) {
    const url = new URL(base, window.location.origin);
    url.searchParams.set('store', STORE_NUMBER);
    for (const [key, value] of Object.entries(params)) {
        if (value != null && value !== '') url.searchParams.set(key, value);
    }
    return url.toString();
}

async function fetchJson(url, options = {}) {
    const { timeoutMs, ...fetchOptions } = options;
    const headers = { Accept: 'application/json', ...(fetchOptions.headers || {}) };
    let controller;
    let timeoutId;
    if (timeoutMs > 0) {
        controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }
    const res = await fetch(url, {
        ...fetchOptions,
        headers,
        credentials: 'include',
        signal: controller?.signal,
    }).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
    });
    const text = await res.text();
    let data = {};
    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        throw new Error(`Invalid server response (HTTP ${res.status}).`);
    }
    if (!res.ok || data.success === false) {
        const err = new Error(data.error || `Request failed (${res.status})`);
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return { res, data };
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function getCurrentLocationName() {
    return catalog?.locations?.[currentLocationIndex] || '';
}

function getItemsForLocation(locationName) {
    if (!catalog) return [];
    return catalog.items.filter((item) => item.locations.includes(locationName));
}

function resolveUnitSlots(item) {
    if (Array.isArray(item.unitSlots) && item.unitSlots.length === 3) return item.unitSlots;
    const cols = Array.isArray(item.columns) ? item.columns : [];
    const slots = cols.map((col) => ({ key: col.key, label: col.label, na: false }));
    while (slots.length < 3) slots.push({ key: null, label: 'N/a', na: true });
    return slots.slice(0, 3);
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
    const locationName = getCurrentLocationName();
    for (const item of getItemsForLocation(locationName)) {
        const row = {};
        for (const col of item.columns) {
            const input = document.querySelector(
                `input[data-item="${CSS.escape(item.key)}"][data-col="${CSS.escape(col.key)}"]`
            );
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
    const loc = draft?.locations?.[locationName];
    if (!loc) return;
    for (const item of getItemsForLocation(locationName)) {
        const counts = loc[item.key];
        if (!counts) continue;
        for (const col of item.columns) {
            const input = document.querySelector(
                `input[data-item="${CSS.escape(item.key)}"][data-col="${CSS.escape(col.key)}"]`
            );
            if (!input) continue;
            const value = counts[col.key];
            input.value = value != null && Number.isFinite(Number(value)) ? String(value) : '';
        }
    }
}

let autoSaveTimer = null;
function scheduleAutoSave() {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => void saveCurrentLocation(false), 450);
}

async function saveCurrentLocation(force = false) {
    if (!catalog || viewMode === 'variances') return;
    const locationName = getCurrentLocationName();
    const values = readFormValues();
    if (!force && !Object.keys(values).length) return;
    saving = true;
    try {
        const { data } = await fetchJson(apiQuery('/api/daily-stock-count/draft'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ location: locationName, items: values }),
        });
        draft = data;
        statusMessage = '';
    } catch (error) {
        statusMessage = error.message;
        statusKind = 'error';
    } finally {
        saving = false;
        render();
    }
}

async function setStartChoice(resolution, batchValue = null) {
    startResolution = resolution;
    openBatchValue = batchValue;
    const { data } = await fetchJson(apiQuery('/api/daily-stock-count/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolution, openBatchValue: batchValue }),
    });
    draft = data;
    startupComplete = true;
    render();
}

function buildStartupProbeOverlay() {
    if (!startupProbing) return '';
    return `
        <div class="stock-count-processing" role="status" aria-live="polite">
            <div class="stock-count-processing-card stock-count-processing-card--wait stock-count-processing-card--compact">
                <h2>Checking Macromatix…</h2>
                <p class="stock-count-mmx-wait-body">Looking for open daily counts.</p>
            </div>
        </div>`;
}

function buildOpenCountModal() {
    if (startupComplete || !openCounts.length) return '';
    const list = openCounts
        .map(
            (row) =>
                `<li><strong>${escapeHtml(row.countTitle || 'Open count')}</strong>${row.batch ? ` · batch ${escapeHtml(row.batch)}` : ''}</li>`
        )
        .join('');
    return `
        <div class="stock-count-processing stock-count-processing--fullscreen" role="alertdialog" aria-modal="true">
            <div class="stock-count-processing-card stock-count-processing-card--fullscreen">
                <h2>Open count in Macromatix</h2>
                <p class="stock-count-mmx-wait-body">An in-progress count was found. Choose how to continue:</p>
                <ul class="daily-count-open-list">${list}</ul>
                <div class="stock-count-actions stock-count-actions--variances">
                    <button type="button" class="stock-count-btn stock-count-btn--secondary" id="dc-overwrite">Overwrite</button>
                    <button type="button" class="stock-count-btn stock-count-btn--mmx" id="dc-delete">Delete old count</button>
                </div>
            </div>
        </div>`;
}

function buildCredentialsGate() {
    if (!needsMmxCredentials) return '';
    return `
        <div class="stock-count-credentials-wrap">
            <div class="stock-count-panel stock-count-panel--credentials">
                <h2>Macromatix login required</h2>
                <p class="stock-count-review-note">Complete Create account with your Macromatix username and password to run daily counts from the app.</p>
                <div class="stock-count-actions stock-count-actions--credentials">
                    <a class="stock-count-btn stock-count-btn--mmx stock-count-btn--link" href="/Create-Account/details">Create account</a>
                    <a class="stock-count-btn stock-count-btn--secondary stock-count-btn--link" href="${escapeHtml(overviewPath())}">Back to overview</a>
                </div>
            </div>
        </div>`;
}

function buildEntryRowHtml(item) {
    const label = item.displayName || item.name;
    const ariaName = item.itemCode ? `${item.itemCode} ${item.name}` : item.name;
    const slots = resolveUnitSlots(item).slice(0, 3);
    const slotCells = slots
        .map((slot) => {
            if (slot.na) return `<td class="stock-count-grid-cell stock-count-grid-cell--na" aria-hidden="true"></td>`;
            return `<td class="stock-count-grid-cell"><label class="stock-count-unit-slot"><input type="text" class="stock-count-input" data-item="${escapeHtml(item.key)}" data-col="${escapeHtml(slot.key)}" inputmode="decimal" autocomplete="off" placeholder="${escapeHtml(slot.label)}" aria-label="${escapeHtml(ariaName)} ${escapeHtml(slot.label)}"></label></td>`;
        })
        .join('');
    return `<tr class="stock-count-grid-row"><th scope="row" class="stock-count-grid-name">${escapeHtml(label)}</th>${slotCells}</tr>`;
}

function buildEntryView() {
    const locationName = getCurrentLocationName();
    const itemsAtLocation = getItemsForLocation(locationName);
    const rows = itemsAtLocation.map((item) => buildEntryRowHtml(item)).join('');
    const locButtons = (catalog?.locations || [])
        .map((loc, idx) => {
            const classes = ['stock-count-loc-btn'];
            if (idx === currentLocationIndex) classes.push('stock-count-loc-btn--active');
            if (locationHasData(loc)) classes.push('stock-count-loc-btn--done');
            return `<button type="button" role="tab" aria-selected="${idx === currentLocationIndex ? 'true' : 'false'}" class="${classes.join(' ')}" data-loc-index="${idx}">${escapeHtml(loc)}</button>`;
        })
        .join('');

    return `
        <div class="stock-count-locations" role="tablist">${locButtons}</div>
        <div class="stock-count-panel">
            <h2>${escapeHtml(locationName)}</h2>
            <table class="stock-count-table stock-count-table--entry stock-count-table--connected"><tbody>${rows}</tbody></table>
            <div class="stock-count-review-note">Enter counts by location tab. Changes save automatically.</div>
        </div>
        <div class="stock-count-actions">
            <a class="stock-count-btn stock-count-btn--secondary stock-count-btn--link" href="${escapeHtml(micPath())}">Back to Overview</a>
            <button type="button" class="stock-count-btn stock-count-btn--mmx" id="dc-submit" ${saving || processing || !startupComplete ? 'disabled' : ''}>Submit to Macromatix</button>
        </div>`;
}

function formatVarianceQty(value) {
    return window.VarianceDisplay?.formatVarianceQty(value) ?? '—';
}

function varianceDateLabel() {
    const key = draft?.dateKey;
    if (!key) return '';
    try {
        const [y, m, d] = key.split('-').map(Number);
        const date = new Date(y, m - 1, d);
        return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch {
        return key;
    }
}

function buildVarianceView() {
    const display = window.VarianceDisplay;
    const count = mmxVariances.length;
    const tableHtml = display
        ? display.buildTableHtml(mmxVariances, {
              catalog,
              escapeHtml,
              captureId: 'dc-variance-capture',
              meta: {
                  title: 'Confirm count — red variances',
                  storeLabel: `Store ${STORE_NUMBER}`,
                  dateLabel: varianceDateLabel(),
                  countLabel: `${count} red variance${count === 1 ? '' : 's'}`,
                  note: 'Review before applying. Do not apply if counts need correcting — use Recount instead.',
              },
          })
        : '';
    const emptyHtml =
        '<p class="stock-count-empty-location">No red variances — you can apply the count.</p>';

    return `
        <div class="stock-count-panel stock-count-panel--variances">
            <h2>Confirm count</h2>
            ${tableHtml || emptyHtml}
            <div class="stock-count-review-note">Review variances, recount if needed, then apply in Macromatix. Use Screenshot to share this summary.</div>
        </div>
        <div class="stock-count-actions stock-count-actions--variances stock-count-actions--variances-tools">
            <button type="button" class="stock-count-btn stock-count-btn--secondary" id="dc-recount">Recount</button>
            <button type="button" class="stock-count-btn stock-count-btn--secondary" id="dc-screenshot" ${count ? '' : 'disabled'}>Screenshot</button>
            <button type="button" class="stock-count-btn stock-count-btn--mmx" id="dc-apply">Apply count</button>
        </div>`;
}

function buildProcessingOverlay() {
    if (!processing && !mmxProcessingError && !mmxProcessingSuccess) return '';
    if (mmxProcessingSuccess) {
        return `<div class="stock-count-processing stock-count-processing--fullscreen"><div class="stock-count-processing-card stock-count-processing-card--success stock-count-processing-card--fullscreen"><h2>Complete</h2><p>Daily count applied in Macromatix.</p><button type="button" class="stock-count-btn stock-count-btn--primary" id="dc-dismiss-success">Close</button></div></div>`;
    }
    if (mmxProcessingError) {
        return `<div class="stock-count-processing stock-count-processing--fullscreen"><div class="stock-count-processing-card stock-count-processing-card--error stock-count-processing-card--fullscreen"><h2>Failed</h2><p>${escapeHtml(mmxProcessingError)}</p><button type="button" class="stock-count-btn stock-count-btn--secondary" id="dc-dismiss-error">Close</button></div></div>`;
    }
    return `<div class="stock-count-processing stock-count-processing--fullscreen"><div class="stock-count-processing-card stock-count-processing-card--wait stock-count-processing-card--fullscreen"><h2>${escapeHtml(processingStageLabel)}</h2><p class="stock-count-mmx-wait-body">Stay on this screen until variances appear or the count is applied.</p></div></div>`;
}

function render() {
    if (needsMmxCredentials) {
        app.innerHTML = `<div class="stock-count"><header class="stock-count-header"><h1>Daily count</h1></header>${buildCredentialsGate()}</div>`;
        return;
    }
    if (!catalog) return;

    const statusHtml = statusMessage
        ? `<div class="stock-count-status stock-count-status--${statusKind || 'info'}">${escapeHtml(statusMessage)}</div>`
        : '';

    app.innerHTML = `
        <div class="stock-count">
            <header class="stock-count-header">
                <div class="nav-back-host" id="daily-nav-back"></div>
                <div>
                    <h1>Daily count</h1>
                    ${buildStorePickerHtml()}
                </div>
            </header>
            ${statusHtml}
            ${viewMode === 'variances' ? buildVarianceView() : buildEntryView()}
        </div>
        ${buildStartupProbeOverlay()}
        ${buildOpenCountModal()}
        ${buildProcessingOverlay()}
    `;

    window.DashboardNavBack?.mountBackButton(document.getElementById('daily-nav-back'), {
        fallback: micPath(),
    });

    if (viewMode === 'entry') fillFormFromDraft(getCurrentLocationName());
    bindEvents();
}

function bindEvents() {
    const storeSelect = document.getElementById('daily-count-store-select');
    storeSelect?.addEventListener('change', () => {
        const next = String(storeSelect.value || '').toLowerCase();
        if (!next || next === STORE_NUMBER) return;
        rememberDailyCountStore(next);
        window.location.assign(`/${next}/daily-stock-count`);
    });

    app.querySelectorAll('[data-loc-index]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const idx = Number(btn.getAttribute('data-loc-index'));
            if (!Number.isFinite(idx) || idx === currentLocationIndex) return;
            if (autoSaveTimer) {
                clearTimeout(autoSaveTimer);
                autoSaveTimer = null;
            }
            await saveCurrentLocation(true);
            currentLocationIndex = idx;
            render();
        });
    });
    app.querySelectorAll('.stock-count-input').forEach((input) => {
        input.addEventListener('input', scheduleAutoSave);
    });
    document.getElementById('dc-submit')?.addEventListener('click', () => void submitToMmx());
    document.getElementById('dc-recount')?.addEventListener('click', () => void recount());
    document.getElementById('dc-screenshot')?.addEventListener('click', () => void screenshotVariances());
    document.getElementById('dc-apply')?.addEventListener('click', () => void applyCount());
    document.getElementById('dc-overwrite')?.addEventListener('click', () =>
        void setStartChoice('overwrite', openCounts[0]?.value || null)
    );
    document.getElementById('dc-delete')?.addEventListener('click', () =>
        void setStartChoice('delete', openCounts[0]?.value || null)
    );
    document.getElementById('dc-dismiss-success')?.addEventListener('click', () => {
        mmxProcessingSuccess = false;
        processing = false;
        viewMode = 'entry';
        render();
    });
    document.getElementById('dc-dismiss-error')?.addEventListener('click', () => {
        mmxProcessingError = null;
        processing = false;
        render();
    });
}

async function pollPipeline() {
    if (mmxPollInFlight) return mmxPollInFlight;
    mmxPollInFlight = (async () => {
        try {
            const { data } = await fetchJson(apiQuery('/api/daily-stock-count/pipeline-status'));
            processingStageLabel = data.stepLabel || data.stage || processingStageLabel;
            if (data.stage === 'prepared' && data.sessionId) {
                mmxSessionId = data.sessionId;
                mmxVariances = data.variances || [];
                processing = false;
                viewMode = 'variances';
                render();
                return;
            }
            if (data.stage === 'completed' || data.ordersComplete) {
                processing = false;
                mmxProcessingSuccess = true;
                render();
                return;
            }
            if (data.stage === 'prepare-failed' || data.lastError) {
                processing = false;
                mmxProcessingError = data.lastError || 'Prepare failed';
                render();
                return;
            }
            if (data.inProgress) {
                setTimeout(() => void pollPipeline(), MMX_PIPELINE_POLL_MS);
            }
        } catch (error) {
            processing = false;
            mmxProcessingError = error.message;
            render();
        } finally {
            mmxPollInFlight = null;
        }
    })();
    return mmxPollInFlight;
}

async function submitToMmx() {
    if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
    }
    await saveCurrentLocation(true);
    processing = true;
    mmxProcessingError = null;
    mmxProcessingSuccess = false;
    processingStageLabel = 'Sending to Macromatix…';
    render();
    try {
        await fetchJson(apiQuery('/api/daily-stock-count/submit'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        await pollPipeline();
    } catch (error) {
        processing = false;
        mmxProcessingError = error.message;
        render();
    }
}

async function applyCount() {
    if (!mmxSessionId) return;
    processing = true;
    processingStageLabel = 'Applying count…';
    render();
    try {
        await fetchJson(apiQuery('/api/daily-stock-count/apply'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: mmxSessionId }),
        });
        processing = false;
        mmxProcessingSuccess = true;
        mmxSessionId = '';
        viewMode = 'entry';
        render();
    } catch (error) {
        processing = false;
        mmxProcessingError = error.message;
        render();
    }
}

async function screenshotVariances() {
    const target = document.getElementById('dc-variance-capture');
    const btn = document.getElementById('dc-screenshot');
    if (!target || !window.VarianceDisplay?.shareCapture) return;
    const prevLabel = btn?.textContent || 'Screenshot';
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Capturing…';
    }
    statusMessage = '';
    try {
        const datePart = draft?.dateKey || new Date().toISOString().slice(0, 10);
        const result = await window.VarianceDisplay.shareCapture(target, {
            filename: `daily-count-${STORE_NUMBER}-${datePart}.png`,
            title: `Daily count variances — store ${STORE_NUMBER}`,
        });
        statusMessage =
            result.mode === 'shared'
                ? 'Variance screenshot shared.'
                : 'Variance screenshot downloaded.';
        statusKind = 'info';
    } catch (error) {
        if (error?.name === 'AbortError') return;
        statusMessage = error.message || 'Could not capture screenshot.';
        statusKind = 'error';
    } finally {
        if (btn) {
            btn.disabled = !mmxVariances.length;
            btn.textContent = prevLabel;
        }
        render();
    }
}

async function recount() {
    mmxPollInFlight = null;
    processing = false;
    mmxProcessingError = null;
    try {
        const { data } = await fetchJson(apiQuery('/api/daily-stock-count/recount'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: mmxSessionId }),
        });
        if (data.draft) draft = data.draft;
        mmxSessionId = '';
        mmxVariances = [];
        viewMode = 'entry';
        statusMessage = '';
        statusKind = '';
        render();
    } catch (error) {
        statusMessage = error.message;
        statusKind = 'error';
        render();
    }
}

async function resolveStartupFromMmxStatus() {
    try {
        const { data: mmxData } = await fetchJson(apiQuery('/api/daily-stock-count/mmx-status'), {
            timeoutMs: MMX_STATUS_PROBE_MS,
        });
        openCounts = mmxData.openCounts || [];
        if (openCounts.length) {
            startupComplete = false;
            return;
        }
        await setStartChoice('create');
    } catch (error) {
        if (error.name === 'AbortError') {
            if (draft?.resolution) {
                startupComplete = true;
                return;
            }
            await setStartChoice('create');
            return;
        }
        if (error.status === 403 && error.data?.needsMmxCredentials) {
            needsMmxCredentials = true;
            return;
        }
        if (draft?.resolution) {
            startupComplete = true;
            return;
        }
        await setStartChoice('create');
    }
}

async function finishStartup() {
    startupProbing = true;
    render();
    try {
        await resolveStartupFromMmxStatus();
    } catch (error) {
        statusMessage = error.message;
        statusKind = 'error';
        startupComplete = Boolean(draft?.resolution);
    } finally {
        startupProbing = false;
        render();
    }
}

async function loadStorePickerContext() {
    try {
        const { data: profile } = await fetchJson('/api/me');
        showStorePicker = Boolean(profile?.canViewCrossStoreAccounts);
        if (!showStorePicker) return;
        const { data: storesData } = await fetchJson('/api/stores');
        accessibleStores = Array.isArray(storesData?.stores) ? storesData.stores : [];
        if (STORE_NUMBER) rememberDailyCountStore(STORE_NUMBER);
    } catch {
        showStorePicker = false;
        accessibleStores = [];
    }
}

async function init() {
    document.documentElement.classList.add('stock-count-page');
    document.body.classList.add('stock-count-page');
    if (!STORE_NUMBER) {
        app.textContent = 'Invalid daily stock count URL.';
        return;
    }

    try {
        await loadStorePickerContext();
        const { data: catData } = await fetchJson(apiQuery('/api/daily-stock-count/catalog'));
        catalog = catData.catalog;
        const { data: draftData } = await fetchJson(apiQuery('/api/daily-stock-count/draft'));
        draft = draftData;

        if (draft?.resolution) {
            startupComplete = true;
            render();
            return;
        }

        render();
        void finishStartup();
    } catch (error) {
        app.innerHTML = `<div class="stock-count"><p class="stock-count-status stock-count-status--error">${escapeHtml(error.message)}</p></div>`;
    }
}

init();
