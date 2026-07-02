(function (global) {
    let backdrop = null;
    let pageHost = null;
    let historyBackdrop = null;
    let previewBackdrop = null;
    let progressBackdrop = null;
    let progressState = null;
    let historyStoreNumber = null;
    let historyGridData = null;
    let historyWeekStart = null;
    let historyDateBounds = null;
    let historyEditState = null;
    let pendingSubmitStores = [];
    let previewData = null;
    let previewActiveStore = null;
    let previewAdjustmentsSaveTimer = null;
    let pendingSubmitTarget = null;
    let statusPayload = null;
    let storeAreaByNumber = {};
    let activeArea = '';
    let lifelenzBackdrop = null;
    let lifelenzStatus = { configured: false, updatedAt: null };
    let sessionLifeLenzCredentials = null;
    let backfillProgressBackdrop = null;
    let backfillProgressRunning = false;
    let canManageBackfill = false;

    const ADMIN_AREAS = ['VIC-1', 'WA-1', 'QLD-1'];

    function areaLabel(name) {
        return global.AreaDisplay?.label?.(name) ?? String(name ?? '').trim();
    }
    const FORECAST_AREA_STORAGE_KEY = 'admin-forecast-area';
    const FORECAST_TARGET_SCOPE_KEY = 'admin-forecast-target-scope';
    const FORECAST_TARGET_WEEK_KEY = 'admin-forecast-target-week';
    const FORECAST_TARGET_DAY_KEY = 'admin-forecast-target-day';
    const FORECAST_WEEK_LABELS = ['This week', 'Next week', 'Week after'];

    const WEEKDAYS = [
        { value: 1, label: 'Mon' },
        { value: 2, label: 'Tue' },
        { value: 3, label: 'Wed' },
        { value: 4, label: 'Thu' },
        { value: 5, label: 'Fri' },
        { value: 6, label: 'Sat' },
        { value: 0, label: 'Sun' },
    ];

    // LifeLenz day-part buckets in sidebar order (mirrors lifelenz/src/lifelenzDayParts.js).
    const LIFELENZ_DAY_PARTS = [
        { key: 'overnightFirst', label: 'OVERNIGHT', hours: [5] },
        { key: 'breakfast', label: 'BREAKFAST', hours: [6, 7, 8, 9] },
        { key: 'morning', label: 'MORNING', hours: [10, 11] },
        { key: 'lunch', label: 'LUNCH', hours: [12, 13] },
        { key: 'afternoon', label: 'AFTERNOON', hours: [14, 15, 16] },
        { key: 'dinner', label: 'DINNER', hours: [17, 18, 19] },
        { key: 'afterDinner', label: 'AFTER DINNER', hours: [20, 21] },
        { key: 'lateNight', label: 'LATE NIGHT', hours: [22, 23] },
        { key: 'overnightSecond', label: 'OVERNIGHT', hours: [0, 1, 2, 3, 4] },
    ];
    const DAY_PART_HOURS = new Map(LIFELENZ_DAY_PARTS.map((part) => [part.key, part.hours]));

    function addDaysToIso(iso, days) {
        const parts = String(iso || '').split('-').map(Number);
        if (parts.length < 3) return iso;
        const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
        dt.setUTCDate(dt.getUTCDate() + Number(days) || 0);
        return dt.toISOString().slice(0, 10);
    }

    function clampWeekStart(iso) {
        if (!iso || !historyDateBounds) return iso;
        let weekStart = iso;
        const weekEnd = addDaysToIso(weekStart, 6);
        if (weekEnd > historyDateBounds.newest) {
            weekStart = addDaysToIso(historyDateBounds.newest, -6);
        }
        if (weekStart < historyDateBounds.oldest) weekStart = historyDateBounds.oldest;
        return weekStart;
    }

    function syncForecastTargetFields(root, scope, ids = {}) {
        if (!root) return;
        const weekWrap = root.querySelector(ids.weekWrap || '#admin-forecast-target-week-wrap');
        const dayWrap = root.querySelector(ids.dayWrap || '#admin-forecast-target-day-wrap');
        if (weekWrap) weekWrap.hidden = scope !== 'week';
        if (dayWrap) dayWrap.hidden = scope !== 'day';
    }

    function getForecastTargetPayloadFromRoot(root, ids = {}) {
        const scope =
            root?.querySelector(ids.scope || '#admin-forecast-target-scope')?.value || 'week-after';
        const payload = { targetScope: scope };
        if (scope === 'week') {
            payload.weekStart = String(
                root?.querySelector(ids.weekStart || '#admin-forecast-target-week-start')?.value || ''
            ).trim();
        } else if (scope === 'day') {
            payload.date = String(
                root?.querySelector(ids.day || '#admin-forecast-target-day')?.value || ''
            ).trim();
        }
        return payload;
    }

    function getForecastTargetPayload() {
        return getForecastTargetPayloadFromRoot(getRoot());
    }

    const PREVIEW_TARGET_IDS = {
        scope: '#admin-forecast-preview-target-scope',
        weekWrap: '#admin-forecast-preview-target-week-wrap',
        weekStart: '#admin-forecast-preview-target-week-start',
        dayWrap: '#admin-forecast-preview-target-day-wrap',
        day: '#admin-forecast-preview-target-day',
    };

    function getPreviewTargetPayload() {
        const root = previewBackdrop;
        return getForecastTargetPayloadFromRoot(root, PREVIEW_TARGET_IDS);
    }

    function getActiveForecastTargetPayload() {
        if (previewBackdrop && !previewBackdrop.hidden) {
            return getPreviewTargetPayload();
        }
        return pendingSubmitTarget || getForecastTargetPayload();
    }

    function validateForecastTargetPayload(payload) {
        if (payload.targetScope === 'week' && !payload.weekStart) {
            return 'Choose a week starting date for the custom week target.';
        }
        if (payload.targetScope === 'day' && !payload.date) {
            return 'Choose a day for the single-day forecast target.';
        }
        return '';
    }

    function validateForecastTarget() {
        return validateForecastTargetPayload(getForecastTargetPayload());
    }

    function validatePreviewTarget() {
        return validateForecastTargetPayload(getPreviewTargetPayload());
    }

    function renderForecastTargetControls(root, payload) {
        const scopeEl = root.querySelector('#admin-forecast-target-scope');
        const weekStartEl = root.querySelector('#admin-forecast-target-week-start');
        const dayEl = root.querySelector('#admin-forecast-target-day');
        if (!scopeEl) return;

        const weeks = payload?.targetWeeks || [];
        const savedScope = sessionStorage.getItem(FORECAST_TARGET_SCOPE_KEY) || 'week-after';
        scopeEl.value = savedScope;
        syncForecastTargetFields(root, savedScope);

        if (weekStartEl) {
            weekStartEl.value =
                sessionStorage.getItem(FORECAST_TARGET_WEEK_KEY) || weeks[0] || weekStartEl.value || '';
        }
        if (dayEl) {
            dayEl.value = sessionStorage.getItem(FORECAST_TARGET_DAY_KEY) || dayEl.value || '';
        }
    }

    function renderPreviewTargetControls(root, payload) {
        const scopeEl = root.querySelector(PREVIEW_TARGET_IDS.scope);
        const weekStartEl = root.querySelector(PREVIEW_TARGET_IDS.weekStart);
        const dayEl = root.querySelector(PREVIEW_TARGET_IDS.day);
        if (!scopeEl) return;

        const main = getForecastTargetPayload();
        const weeks = payload?.targetWeeks || statusPayload?.targetWeeks || [];
        scopeEl.value = main.targetScope || 'week-after';
        syncForecastTargetFields(root, scopeEl.value, PREVIEW_TARGET_IDS);

        if (weekStartEl) {
            weekStartEl.value = main.weekStart || weeks[0] || weekStartEl.value || '';
        }
        if (dayEl) {
            dayEl.value = main.date || dayEl.value || '';
        }
        updatePreviewTargetHint(root);
    }

    function updatePreviewTargetHint(root) {
        const hint = root?.querySelector('#admin-forecast-preview-target-hint');
        if (!hint) return;
        const payload = getPreviewTargetPayload();
        const desc = describeForecastTarget(payload);
        const weeks = statusPayload?.targetWeeks || [];
        const partial =
            payload.targetScope === 'this-week' ||
            (payload.targetScope === 'week' && payload.weekStart && payload.weekStart === weeks[0]);
        hint.textContent = partial
            ? `${desc}. Current week updates start from tomorrow only.`
            : desc;
    }

    function resetPreviewForTargetChange() {
        previewData = null;
        previewActiveStore = null;
        const root = previewBackdrop;
        if (!root) return;
        root.querySelector('#admin-forecast-preview-stores').innerHTML = '';
        root.querySelector('#admin-forecast-preview-stores').hidden = true;
        root.querySelector('#admin-forecast-preview-adjustments').hidden = true;
        const submitBtn = root.querySelector('#admin-forecast-preview-submit');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Submit forecast';
        }
        const targetErr = validatePreviewTarget();
        if (targetErr) {
            root.querySelector('#admin-forecast-preview-error').textContent = targetErr;
            root.querySelector('#admin-forecast-preview-body').innerHTML = '';
            return;
        }
        root.querySelector('#admin-forecast-preview-error').textContent = '';
        void reloadPreviewForTarget();
    }

    function describeForecastTarget(payload) {
        const target = payload || getForecastTargetPayload();
        const weeks = statusPayload?.targetWeeks || [];
        if (target.targetScope === 'this-week' && weeks[0]) {
            return `This week from tomorrow (${formatShortDate(addDaysToIso(weeks[0], 1))} – ${formatShortDate(addDaysToIso(weeks[0], 6))})`;
        }
        if (target.targetScope === 'next-week' && weeks[1]) {
            return `Next week (${formatShortDate(weeks[1])} – ${formatShortDate(addDaysToIso(weeks[1], 6))})`;
        }
        if (target.targetScope === 'week-after' && weeks[2]) {
            return `Week after (${formatShortDate(weeks[2])} – ${formatShortDate(addDaysToIso(weeks[2], 6))})`;
        }
        if (target.targetScope === 'week' && target.weekStart) {
            const isCurrent = target.weekStart === weeks[0];
            const end = formatShortDate(addDaysToIso(target.weekStart, 6));
            return isCurrent
                ? `This week from tomorrow (${formatShortDate(addDaysToIso(target.weekStart, 1))} – ${end})`
                : `Week starting ${formatShortDate(target.weekStart)} (7 days)`;
        }
        if (target.targetScope === 'day' && target.date) {
            return `Single day ${formatShortDate(target.date)}`;
        }
        return 'Selected forecast target';
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function normalizeAreaKey(value) {
        return String(value || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');
    }

    function storeAreaKey(storeNumber) {
        return normalizeAreaKey(storeAreaByNumber[String(storeNumber)] || '');
    }

    function pickDefaultArea(storeNumbers) {
        const saved = sessionStorage.getItem(FORECAST_AREA_STORAGE_KEY);
        if (saved && ADMIN_AREAS.includes(saved)) {
            const key = normalizeAreaKey(saved);
            if (storeNumbers.some((s) => storeAreaKey(s) === key)) return saved;
        }
        for (const name of ADMIN_AREAS) {
            const key = normalizeAreaKey(name);
            if (storeNumbers.some((s) => storeAreaKey(s) === key)) return name;
        }
        return ADMIN_AREAS[0];
    }

    function storesInActiveArea(storeNumbers) {
        const key = normalizeAreaKey(activeArea);
        if (!key) return storeNumbers.slice();
        return storeNumbers.filter((s) => storeAreaKey(s) === key);
    }

    function formatMoney(value) {
        if (value == null || !Number.isFinite(Number(value))) return '-';
        return '$' + Number(value).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }

    function getRoot() {
        return pageHost || backdrop;
    }

    function isInline() {
        return Boolean(pageHost);
    }

    const FORECAST_MODAL_HTML = `
            <div class="admin-modal admin-modal--wide" role="dialog" aria-modal="true">
                <h2>Forecast tool</h2>
                <p class="admin-accounts-meta">Uses 5 weeks of stored hourly sales (trimmed weekday averages + hourly shape), then writes to Macromatix and LifeLenz when configured. Choose this week, next week, the week after, a custom week starting date, or a single day before preview/submit.</p>
                <div class="admin-settings-segmented-tabs admin-accounts-browse-scope admin-accounts-org-nav admin-forecast-area-nav">
                    <div class="admin-accounts-scope-row-wrap">
                        <span class="admin-accounts-scope-row-label">Area</span>
                        <nav class="admin-accounts-scope-row admin-accounts-scope-row--equal admin-forecast-area-tabs" id="admin-forecast-area-tabs" role="tablist" aria-label="Select area"></nav>
                    </div>
                </div>
                <div class="admin-modal-toolbar admin-forecast-toolbar">
                    <div class="admin-forecast-target-wrap" id="admin-forecast-target-wrap">
                        <label class="admin-forecast-target-scope-label">Forecast target
                            <select id="admin-forecast-target-scope">
                                <option value="this-week">This week</option>
                                <option value="next-week">Next week</option>
                                <option value="week-after" selected>Week after</option>
                                <option value="week">Week starting…</option>
                                <option value="day">Single day</option>
                            </select>
                        </label>
                        <label class="admin-forecast-target-week-start-label" id="admin-forecast-target-week-wrap" hidden>Week starting
                            <input type="date" id="admin-forecast-target-week-start" />
                        </label>
                        <label class="admin-forecast-target-day-label" id="admin-forecast-target-day-wrap" hidden>Day
                            <input type="date" id="admin-forecast-target-day" />
                        </label>
                    </div>
                    <button type="button" class="mic-settings-btn admin-btn-primary" id="admin-forecast-submit-all">Submit all in scope</button>
                    <button type="button" class="mic-settings-btn" id="admin-forecast-setup-lifelenz">Setup LifeLenz</button>
                    <span class="admin-forecast-lifelenz-status" id="admin-forecast-lifelenz-status">LifeLenz: checking…</span>
                    <span id="admin-forecast-busy" hidden>MMX busy…</span>
                </div>
                <div id="admin-forecast-body"></div>
                <p id="admin-forecast-error" class="admin-modal-error" role="alert"></p>
                <div class="admin-modal-actions">
                    <button type="button" id="admin-forecast-close">Close</button>
                </div>
            </div>`;

    function bindPanel(root) {
        if (root.dataset.adminForecastBound) return;
        root.dataset.adminForecastBound = '1';
        root.querySelector('#admin-forecast-close')?.addEventListener('click', close);
        root.querySelector('#admin-forecast-submit-all')?.addEventListener('click', () => {
            void runAll();
        });
        root.querySelector('#admin-forecast-setup-lifelenz')?.addEventListener('click', () => {
            void openLifeLenzSetup();
        });
        root.querySelector('#admin-forecast-target-scope')?.addEventListener('change', (event) => {
            syncForecastTargetFields(getRoot(), event.target.value);
            sessionStorage.setItem(FORECAST_TARGET_SCOPE_KEY, event.target.value);
        });
        root.querySelector('#admin-forecast-target-week-start')?.addEventListener('change', (event) => {
            sessionStorage.setItem(FORECAST_TARGET_WEEK_KEY, event.target.value);
        });
        root.querySelector('#admin-forecast-target-day')?.addEventListener('change', (event) => {
            sessionStorage.setItem(FORECAST_TARGET_DAY_KEY, event.target.value);
        });
        root.querySelector('#admin-forecast-area-tabs')?.addEventListener('click', (event) => {
            const tab = event.target.closest('[data-forecast-area]');
            if (!tab) return;
            activeArea = tab.getAttribute('data-forecast-area') || '';
            sessionStorage.setItem(FORECAST_AREA_STORAGE_KEY, activeArea);
            const surface = getRoot();
            if (statusPayload && surface) {
                renderAreaTabs(surface);
                renderTable(surface, statusPayload);
            }
        });
    }

    function ensureBackdrop() {
        if (pageHost) {
            if (!pageHost.querySelector('.admin-modal')) {
                pageHost.innerHTML = FORECAST_MODAL_HTML;
                bindPanel(pageHost);
            }
            return pageHost;
        }
        if (backdrop) return backdrop;
        backdrop = document.createElement('div');
        backdrop.className = 'admin-modal-backdrop';
        backdrop.hidden = true;
        backdrop.innerHTML = FORECAST_MODAL_HTML;
        document.body.appendChild(backdrop);
        backdrop.addEventListener('click', (event) => {
            if (event.target === backdrop) close();
        });
        bindPanel(backdrop);
        return backdrop;
    }

    function ensureHistoryBackdrop() {
        if (historyBackdrop) return historyBackdrop;
        historyBackdrop = document.createElement('div');
        historyBackdrop.className = 'admin-modal-backdrop admin-modal-backdrop--stacked';
        historyBackdrop.hidden = true;
        historyBackdrop.innerHTML = `
            <div class="admin-modal admin-modal--wide admin-modal--history" role="dialog" aria-modal="true">
                <h2 id="admin-forecast-history-title">Sales history</h2>
                <p class="admin-accounts-meta" id="admin-forecast-history-meta"></p>
                <div class="admin-forecast-history-toolbar" id="admin-forecast-history-toolbar">
                    <label class="admin-forecast-week-start-label">Week starting
                        <input type="date" id="admin-forecast-history-week-start" />
                    </label>
                    <div class="admin-forecast-history-nav">
                        <button type="button" class="mic-settings-btn" id="admin-forecast-history-prev-week" title="Previous week">← Prev</button>
                        <button type="button" class="mic-settings-btn" id="admin-forecast-history-next-week" title="Next week">Next →</button>
                        <button type="button" class="mic-settings-btn admin-btn-primary" id="admin-forecast-history-backfill" hidden>Backfill data</button>
                    </div>
                </div>
                <div id="admin-forecast-history-edit" class="admin-forecast-history-edit" hidden></div>
                <div id="admin-forecast-history-body"></div>
                <p id="admin-forecast-history-error" class="admin-modal-error" role="alert"></p>
                <div class="admin-modal-actions">
                    <button type="button" id="admin-forecast-history-close">Close</button>
                </div>
            </div>`;
        document.body.appendChild(historyBackdrop);
        historyBackdrop.addEventListener('click', (event) => {
            if (event.target === historyBackdrop) closeHistory();
        });
        historyBackdrop.querySelector('#admin-forecast-history-close')?.addEventListener('click', closeHistory);
        historyBackdrop.querySelector('#admin-forecast-history-week-start')?.addEventListener('change', (event) => {
            if (!historyStoreNumber) return;
            historyWeekStart = clampWeekStart(event.target.value);
            event.target.value = historyWeekStart;
            void loadHistoryGrid(historyStoreNumber, historyWeekStart);
        });
        historyBackdrop.querySelector('#admin-forecast-history-prev-week')?.addEventListener('click', () => {
            if (!historyStoreNumber || !historyWeekStart) return;
            historyWeekStart = clampWeekStart(addDaysToIso(historyWeekStart, -7));
            void loadHistoryGrid(historyStoreNumber, historyWeekStart);
        });
        historyBackdrop.querySelector('#admin-forecast-history-next-week')?.addEventListener('click', () => {
            if (!historyStoreNumber || !historyWeekStart) return;
            historyWeekStart = clampWeekStart(addDaysToIso(historyWeekStart, 7));
            void loadHistoryGrid(historyStoreNumber, historyWeekStart);
        });
        historyBackdrop.querySelector('#admin-forecast-history-backfill')?.addEventListener('click', () => {
            if (historyStoreNumber) void runForecastBackfill([historyStoreNumber], { refreshHistory: true });
        });
        historyBackdrop.querySelector('#admin-forecast-history-edit')?.addEventListener('click', (event) => {
            const btn = event.target.closest('[data-history-edit-action]');
            if (!btn) return;
            const action = btn.getAttribute('data-history-edit-action');
            if (action === 'cancel') closeHistoryEditForm();
            else if (action === 'save') void submitHistoryEditForm();
            else if (action === 'delete') void deleteHistoryEditDay();
        });
        return historyBackdrop;
    }

    function close() {
        if (isInline()) return;
        if (backdrop) backdrop.hidden = true;
        closeHistory();
        closePreview();
        closeLifeLenzSetup();
        closeProgress(false);
    }

    function ensureLifeLenzBackdrop() {
        if (lifelenzBackdrop) return lifelenzBackdrop;
        lifelenzBackdrop = document.createElement('div');
        lifelenzBackdrop.className = 'admin-modal-backdrop admin-modal-backdrop--stacked';
        lifelenzBackdrop.hidden = true;
        lifelenzBackdrop.innerHTML = `
            <div class="admin-modal admin-modal--lifelenz-setup" role="dialog" aria-modal="true" aria-labelledby="admin-forecast-lifelenz-title">
                <div class="admin-modal-header">
                    <h2 id="admin-forecast-lifelenz-title">Setup LifeLenz</h2>
                    <button type="button" class="admin-modal-close" id="admin-forecast-lifelenz-close" aria-label="Close">×</button>
                </div>
                <p class="admin-forecast-lifelenz-privacy">
                    Your LifeLenz login is encrypted with AES-256-GCM on this server and is never shared with developers.
                    It is only used to submit forecasts on your behalf.
                </p>
                <form id="admin-forecast-lifelenz-form" class="admin-forecast-lifelenz-form">
                    <label>
                        LifeLenz email
                        <input name="email" type="email" autocomplete="email" required>
                    </label>
                    <label>
                        LifeLenz password
                        <input name="password" type="password" autocomplete="current-password" required>
                    </label>
                    <fieldset class="admin-forecast-lifelenz-save">
                        <legend>Credential storage</legend>
                        <label><input type="radio" name="saveMode" value="save" checked> Save encrypted on this server</label>
                        <label><input type="radio" name="saveMode" value="once"> Use once (not stored)</label>
                    </fieldset>
                </form>
                <div id="admin-forecast-lifelenz-stores" class="admin-forecast-lifelenz-stores" hidden></div>
                <p id="admin-forecast-lifelenz-error" class="admin-modal-error" role="alert"></p>
                <div class="admin-modal-actions admin-modal-actions--lifelenz">
                    <button type="button" class="mic-settings-btn" id="admin-forecast-lifelenz-remove" hidden>Remove saved login</button>
                    <button type="submit" form="admin-forecast-lifelenz-form" class="mic-settings-btn admin-btn-primary" id="admin-forecast-lifelenz-submit">Verify &amp; connect</button>
                </div>
            </div>`;
        document.body.appendChild(lifelenzBackdrop);
        lifelenzBackdrop.addEventListener('click', (event) => {
            if (event.target === lifelenzBackdrop) closeLifeLenzSetup();
        });
        lifelenzBackdrop.querySelector('#admin-forecast-lifelenz-close')?.addEventListener('click', closeLifeLenzSetup);
        lifelenzBackdrop.querySelector('#admin-forecast-lifelenz-remove')?.addEventListener('click', () => {
            void removeLifeLenzCredentials();
        });
        lifelenzBackdrop.querySelector('#admin-forecast-lifelenz-form')?.addEventListener('submit', (event) => {
            event.preventDefault();
            void submitLifeLenzSetup();
        });
        return lifelenzBackdrop;
    }

    function setLifeLenzSubmitAsVerify(root) {
        const submitBtn = root.querySelector('#admin-forecast-lifelenz-submit');
        if (!submitBtn) return;
        submitBtn.type = 'submit';
        submitBtn.setAttribute('form', 'admin-forecast-lifelenz-form');
        submitBtn.disabled = false;
        submitBtn.hidden = false;
        submitBtn.textContent = 'Verify & connect';
        submitBtn.onclick = null;
    }

    function setLifeLenzSubmitAsClose(root) {
        const submitBtn = root.querySelector('#admin-forecast-lifelenz-submit');
        if (!submitBtn) return;
        submitBtn.type = 'button';
        submitBtn.removeAttribute('form');
        submitBtn.disabled = false;
        submitBtn.hidden = false;
        submitBtn.textContent = 'Close';
        submitBtn.onclick = () => closeLifeLenzSetup();
    }

    function resetLifeLenzSetupDialog(root) {
        if (!root) return;
        root.querySelector('#admin-forecast-lifelenz-form').hidden = false;
        setLifeLenzSubmitAsVerify(root);
        root.querySelector('#admin-forecast-lifelenz-stores').hidden = true;
        root.querySelector('#admin-forecast-lifelenz-stores').innerHTML = '';
        root.querySelector('#admin-forecast-lifelenz-error').textContent = '';
    }

    function closeLifeLenzSetup() {
        if (lifelenzBackdrop) {
            resetLifeLenzSetupDialog(lifelenzBackdrop);
            lifelenzBackdrop.hidden = true;
        }
    }

    function renderLifeLenzStatusChip(root) {
        const chip = root?.querySelector('#admin-forecast-lifelenz-status');
        if (!chip) return;
        if (lifelenzStatus.configured || sessionLifeLenzCredentials) {
            chip.textContent = sessionLifeLenzCredentials && !lifelenzStatus.configured
                ? 'LifeLenz: session only'
                : 'LifeLenz: connected';
            chip.className = 'admin-forecast-lifelenz-status admin-forecast-lifelenz-status--ok';
        } else {
            chip.textContent = 'LifeLenz: not configured';
            chip.className = 'admin-forecast-lifelenz-status admin-forecast-lifelenz-status--warn';
        }
    }

    async function fetchLifeLenzStatus() {
        const res = await fetch('/api/admin/forecast/lifelenz/status', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) return { configured: false, updatedAt: null };
        lifelenzStatus = { configured: Boolean(data.configured), updatedAt: data.updatedAt || null };
        return lifelenzStatus;
    }

    async function refreshLifeLenzStatus(root) {
        await fetchLifeLenzStatus();
        renderLifeLenzStatusChip(root || backdrop);
    }

    async function openLifeLenzSetup() {
        const root = ensureLifeLenzBackdrop();
        root.hidden = false;
        resetLifeLenzSetupDialog(root);
        root.querySelector('#admin-forecast-lifelenz-remove').hidden = !lifelenzStatus.configured;
        await refreshLifeLenzStatus(ensureBackdrop());
    }

    async function submitLifeLenzSetup() {
        const root = ensureLifeLenzBackdrop();
        const form = root.querySelector('#admin-forecast-lifelenz-form');
        const data = Object.fromEntries(new FormData(form).entries());
        const save = data.saveMode === 'save';
        root.querySelector('#admin-forecast-lifelenz-error').textContent = '';
        root.querySelector('#admin-forecast-lifelenz-submit').disabled = true;
        root.querySelector('#admin-forecast-lifelenz-submit').textContent = 'Verifying…';
        try {
            const res = await fetch('/api/admin/forecast/lifelenz/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ email: data.email, password: data.password, save }),
            });
            const payload = await res.json().catch(() => ({}));
            if (!res.ok || !payload.success) {
                const fallback =
                    res.status === 404
                        ? 'Verify API not found - restart the dashboard server.'
                        : `LifeLenz verification failed (HTTP ${res.status}).`;
                throw new Error(payload.error || fallback);
            }
            if (!save) {
                sessionLifeLenzCredentials = { email: data.email, password: data.password };
            } else {
                sessionLifeLenzCredentials = null;
            }
            await refreshLifeLenzStatus(ensureBackdrop());
            const storeRows = payload.stores || [];
            const storesEl = root.querySelector('#admin-forecast-lifelenz-stores');
            storesEl.hidden = false;
            storesEl.innerHTML =
                '<p class="admin-accounts-meta admin-forecast-lifelenz-connected">Connected. Stores you can access in LifeLenz:</p>' +
                `<p class="admin-accounts-meta">${escapeHtml(String(storeRows.length))} store${storeRows.length === 1 ? '' : 's'} found.</p>` +
                '<ul>' +
                storeRows.map((row) => `<li>${escapeHtml(row.label || row.storeNumber)}</li>`).join('') +
                '</ul>' +
                '<p class="admin-accounts-meta admin-forecast-lifelenz-schedule-note">Schedule text in LifeLenz is cosmetic only - forecasts match by store number.</p>';
            root.querySelector('#admin-forecast-lifelenz-form').hidden = true;
            setLifeLenzSubmitAsClose(root);
            root.querySelector('#admin-forecast-lifelenz-remove').hidden = !save;
        } catch (error) {
            root.querySelector('#admin-forecast-lifelenz-error').textContent = error.message;
            setLifeLenzSubmitAsVerify(root);
        }
    }

    async function removeLifeLenzCredentials() {
        const root = ensureLifeLenzBackdrop();
        root.querySelector('#admin-forecast-lifelenz-error').textContent = '';
        const res = await fetch('/api/admin/forecast/lifelenz/credentials', {
            method: 'DELETE',
            credentials: 'same-origin',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            root.querySelector('#admin-forecast-lifelenz-error').textContent = data.error || 'Could not remove credentials.';
            return;
        }
        sessionLifeLenzCredentials = null;
        await refreshLifeLenzStatus(ensureBackdrop());
        root.querySelector('#admin-forecast-lifelenz-remove').hidden = true;
        closeLifeLenzSetup();
    }

    function hasLifeLenzForSubmit() {
        return Boolean(lifelenzStatus.configured || sessionLifeLenzCredentials);
    }

    function ensurePreviewBackdrop() {
        if (previewBackdrop) return previewBackdrop;
        previewBackdrop = document.createElement('div');
        previewBackdrop.className = 'admin-modal-backdrop admin-modal-backdrop--stacked';
        previewBackdrop.hidden = true;
        previewBackdrop.innerHTML = `
            <div class="admin-modal admin-modal--wide admin-modal--forecast-preview" role="dialog" aria-modal="true">
                <div class="admin-forecast-preview-header">
                    <h2 id="admin-forecast-preview-title">Forecast preview</h2>
                    <p class="admin-accounts-meta" id="admin-forecast-preview-meta"></p>
                </div>
                <div class="admin-forecast-preview-target" id="admin-forecast-preview-target-panel">
                    <div class="admin-forecast-target-wrap" id="admin-forecast-preview-target-wrap">
                        <label class="admin-forecast-target-scope-label">Update timeframe
                            <select id="admin-forecast-preview-target-scope">
                                <option value="this-week">This week (from tomorrow)</option>
                                <option value="next-week">Next week</option>
                                <option value="week-after" selected>Week after</option>
                                <option value="week">Week starting…</option>
                                <option value="day">Single day</option>
                            </select>
                        </label>
                        <label class="admin-forecast-target-week-start-label" id="admin-forecast-preview-target-week-wrap" hidden>Week starting
                            <input type="date" id="admin-forecast-preview-target-week-start" />
                        </label>
                        <label class="admin-forecast-target-day-label" id="admin-forecast-preview-target-day-wrap" hidden>Day
                            <input type="date" id="admin-forecast-preview-target-day" />
                        </label>
                    </div>
                    <p class="admin-accounts-meta" id="admin-forecast-preview-target-hint"></p>
                </div>
                <div class="admin-forecast-store-tabs" id="admin-forecast-preview-stores" hidden></div>
                <div class="admin-forecast-preview-scroll">
                    <div id="admin-forecast-preview-adjustments" class="admin-forecast-preview-adjustments" hidden></div>
                    <div class="admin-forecast-preview-body-wrap">
                        <div id="admin-forecast-preview-body"></div>
                    </div>
                    <p id="admin-forecast-preview-error" class="admin-modal-error" role="alert"></p>
                    <p id="admin-forecast-preview-lifelenz-note" class="admin-accounts-meta admin-forecast-preview-lifelenz-note" hidden></p>
                </div>
                <div class="admin-modal-actions admin-modal-actions--split">
                    <button type="button" class="mic-settings-btn" id="admin-forecast-preview-cancel">Cancel</button>
                    <button type="button" class="mic-settings-btn admin-btn-primary" id="admin-forecast-preview-submit">Submit forecast</button>
                </div>
            </div>`;
        document.body.appendChild(previewBackdrop);
        previewBackdrop.addEventListener('click', (event) => {
            if (event.target === previewBackdrop) closePreview();
        });
        previewBackdrop.querySelector('#admin-forecast-preview-cancel')?.addEventListener('click', closePreview);
        previewBackdrop.querySelector('#admin-forecast-preview-submit')?.addEventListener('click', () => {
            void confirmSubmit();
        });
        previewBackdrop.querySelector('#admin-forecast-preview-target-scope')?.addEventListener('change', (event) => {
            syncForecastTargetFields(previewBackdrop, event.target.value, PREVIEW_TARGET_IDS);
            updatePreviewTargetHint(previewBackdrop);
            resetPreviewForTargetChange();
        });
        previewBackdrop.querySelector('#admin-forecast-preview-target-week-start')?.addEventListener('change', () => {
            updatePreviewTargetHint(previewBackdrop);
            resetPreviewForTargetChange();
        });
        previewBackdrop.querySelector('#admin-forecast-preview-target-day')?.addEventListener('change', () => {
            updatePreviewTargetHint(previewBackdrop);
            resetPreviewForTargetChange();
        });
        previewBackdrop.querySelector('#admin-forecast-preview-stores')?.addEventListener('click', (event) => {
            const tab = event.target.closest('[data-preview-store]');
            if (!tab || !previewData) return;
            renderPreviewStore(tab.getAttribute('data-preview-store'));
        });
        previewBackdrop.querySelector('#admin-forecast-preview-adjustments')?.addEventListener('click', (event) => {
            const btn = event.target.closest('[data-adjust-action]');
            if (!btn || !previewActiveStore) return;
            const action = btn.getAttribute('data-adjust-action');
            if (action === 'add') void addPreviewAdjustment();
            else if (action === 'clear') void clearPreviewAdjustments();
            else if (action === 'remove') {
                const idx = Number(btn.getAttribute('data-adjust-index'));
                void removePreviewAdjustment(idx);
            }
        });
        return previewBackdrop;
    }

    function weekdayLabel(value) {
        return WEEKDAYS.find((wd) => wd.value === Number(value))?.label || '';
    }

    function formatShortDate(iso) {
        if (!iso) return '-';
        const [y, m, d] = String(iso).split('-').map(Number);
        if (!y || !m || !d) return iso;
        return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
    }

    async function consumeSseStream(response, onEvent) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const chunks = buffer.split('\n\n');
            buffer = chunks.pop() || '';
            for (const chunk of chunks) {
                if (!chunk.trim()) continue;
                let eventName = 'message';
                let dataLine = '';
                for (const line of chunk.split('\n')) {
                    if (line.startsWith('event: ')) eventName = line.slice(7).trim();
                    else if (line.startsWith('data: ')) dataLine = line.slice(6);
                }
                if (!dataLine) continue;
                onEvent(eventName, JSON.parse(dataLine));
            }
        }
    }

    async function runStoresWithProgress(storeNumbers, onEvent) {
        const body = { storeNumbers, streamProgress: true, ...getActiveForecastTargetPayload() };
        if (sessionLifeLenzCredentials) {
            body.lifelenzCredentials = {
                email: sessionLifeLenzCredentials.email,
                password: sessionLifeLenzCredentials.password,
            };
        }
        const res = await fetch('/api/admin/forecast/run', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'text/event-stream',
            },
            credentials: 'same-origin',
            body: JSON.stringify(body),
        });
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('text/event-stream') && res.body) {
            let finalPayload = null;
            await consumeSseStream(res, (eventName, data) => {
                if (eventName === 'progress') onEvent?.('progress', data);
                else if (eventName === 'platform-started') onEvent?.('platform-started', data);
                else if (eventName === 'lifelenz-started') onEvent?.('lifelenz-started', data);
                else if (eventName === 'complete' || eventName === 'error') finalPayload = data;
                else if (eventName === 'started') onEvent?.('started', data);
            });
            if (finalPayload && !finalPayload.success) {
                return finalPayload;
            }
            return finalPayload;
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Forecast run failed.');
        return data;
    }

    function initProgressState(storeNumbers, previewSnapshot) {
        const source = previewSnapshot || previewData;
        return {
            storeNumbers: storeNumbers.slice(),
            stores: storeNumbers.map((storeNumber) => {
                const preview = (source?.previews || []).find(
                    (row) => row.ok && String(row.storeNumber) === String(storeNumber)
                );
                const dayTemplate = (preview?.plan || []).map((day) => ({
                    date: day.date,
                    weekday: day.weekday,
                    forecastTotal: day.forecastTotal,
                    status: 'pending',
                    error: null,
                }));
                return {
                    storeNumber: String(storeNumber),
                    storeName: preview?.storeName || String(storeNumber),
                    status: 'pending',
                    mmxStatus: 'pending',
                    lifelenzStatus: 'pending',
                    error: null,
                    mmxError: null,
                    lifelenzError: null,
                    lifelenzLiveLabel: null,
                    days: (preview?.plan || []).map((day) => ({
                        date: day.date,
                        weekday: day.weekday,
                        forecastTotal: day.forecastTotal,
                        hourly: (day.hourly || []).map((slot) => ({
                            hour: slot.hour,
                            forecast: slot.forecast,
                            status: 'pending',
                            readValue: null,
                            error: null,
                        })),
                        status: 'pending',
                        error: null,
                    })),
                    lifelenzDays: dayTemplate.slice(),
                };
            }),
            activeStore: storeNumbers[0] ? String(storeNumbers[0]) : null,
            activeDate: null,
            activeLifelenzDate: null,
            phase: 'both',
            lifelenzLiveLabel: null,
            complete: false,
            results: null,
            error: null,
        };
    }

    function findProgressLifelenzDay(store, date) {
        return (store?.lifelenzDays || []).find((day) => day.date === date);
    }

    function findProgressStore(state, storeNumber) {
        return (state?.stores || []).find((row) => String(row.storeNumber) === String(storeNumber));
    }

    function findProgressDay(store, date) {
        return (store?.days || []).find((day) => day.date === date);
    }

    function findProgressHour(day, hour, label) {
        if (!day?.hourly?.length) return null;
        const byHour = day.hourly.find((slot) => Number(slot.hour) === Number(hour));
        if (byHour) return byHour;
        if (label) {
            return day.hourly.find((slot) => formatHourLabel(slot.hour) === label);
        }
        return null;
    }

    function applyHourProgress(day, payload) {
        if (!day) return;
        const slot = findProgressHour(day, payload.hour, payload.label);
        if (!slot) return;
        if (payload.type === 'hour-entering') {
            slot.status = 'entering';
            slot.error = null;
        } else if (payload.type === 'hour-verifying') {
            slot.status = 'verifying';
        } else if (payload.type === 'hour-confirmed') {
            slot.status = 'confirmed';
            slot.readValue = payload.read ?? slot.readValue;
            slot.error = null;
        } else if (payload.type === 'hour-failed') {
            slot.status = 'failed';
            slot.readValue = payload.read ?? slot.readValue;
            slot.error = payload.reason || 'Failed';
        }
    }

    function applyProgressEvent(state, payload) {
        if (!state || !payload?.type) return;

        if (payload.platform === 'lifelenz') {
            if (payload.type === 'session-start') {
                state.lifelenzLiveLabel = 'Signing in to LifeLenz…';
                return;
            }
            const store = findProgressStore(state, payload.storeNumber);
            if (payload.type === 'store-start' && store) {
                store.lifelenzStatus = 'active';
                store.status = 'active';
                state.activeStore = String(payload.storeNumber);
                state.lifelenzLiveLabel = `Store ${payload.storeNumber} - starting LifeLenz entry…`;
            } else if (payload.type === 'day-start' && store) {
                state.activeStore = String(payload.storeNumber);
                state.activeLifelenzDate = payload.date;
                const day = findProgressLifelenzDay(store, payload.date);
                if (day) day.status = 'filling';
                state.lifelenzLiveLabel = `Entering ${formatShortDate(payload.date)} day parts…`;
            } else if (payload.type === 'daypart-entering') {
                state.lifelenzLiveLabel = payload.phase
                    ? `Overnight quirk (${payload.phase})…`
                    : `Entering ${payload.label || 'day part'}${payload.value != null ? ` · ${payload.value}` : ''}…`;
                if (store) store.lifelenzLiveLabel = state.lifelenzLiveLabel;
            } else if (payload.type === 'day-complete' && store) {
                const day = findProgressLifelenzDay(store, payload.date);
                if (day) day.status = 'done';
                state.lifelenzLiveLabel = `Saved ${formatShortDate(payload.date)} in LifeLenz`;
            } else if (payload.type === 'store-complete' && store) {
                store.lifelenzStatus = payload.ok === false ? 'error' : 'done';
                if (payload.error) store.lifelenzError = payload.error;
            } else if (payload.type === 'store-error' && store) {
                store.lifelenzStatus = 'error';
                store.lifelenzError = payload.error || 'LifeLenz submit failed';
            }
            return;
        }

        const store = findProgressStore(state, payload.storeNumber);
        if (!store && !/^store-(complete|error|start|done)$/.test(payload.type)) return;

        if (payload.type === 'store-start') {
            store.mmxStatus = 'active';
            store.status = 'active';
            state.activeStore = String(payload.storeNumber);
            if (payload.dayCount && !store.days.length) {
                store.days = Array.from({ length: payload.dayCount }, (_, i) => ({
                    date: `day-${i + 1}`,
                    weekday: null,
                    forecastTotal: null,
                    hourly: [],
                    status: 'pending',
                    error: null,
                }));
            }
        } else if (payload.type === 'day-start') {
            state.activeStore = String(payload.storeNumber);
            state.activeDate = payload.date;
            let day = findProgressDay(store, payload.date);
            if (!day) {
                day = {
                    date: payload.date,
                    weekday: payload.weekday,
                    forecastTotal: payload.forecastTotal,
                    hourly: (payload.hourly || []).map((slot) => ({
                        hour: slot.hour,
                        forecast: slot.forecast,
                        status: 'pending',
                        readValue: null,
                        error: null,
                    })),
                    status: 'pending',
                    error: null,
                };
                store.days.push(day);
            } else {
                day.weekday = payload.weekday ?? day.weekday;
                day.forecastTotal = payload.forecastTotal ?? day.forecastTotal;
                if (payload.hourly?.length) {
                    day.hourly = payload.hourly.map((slot) => ({
                        hour: slot.hour,
                        forecast: slot.forecast,
                        status: 'pending',
                        readValue: null,
                        error: null,
                    }));
                }
            }
            day.status = 'filling';
        } else if (payload.type === 'day-filling') {
            state.activeDate = payload.date;
            const day = findProgressDay(store, payload.date);
            if (day) day.status = 'filling';
        } else if (payload.type === 'day-verifying') {
            state.activeDate = payload.date;
            const day = findProgressDay(store, payload.date);
            if (day) day.status = 'verifying';
        } else if (payload.type === 'hour-entering' || payload.type === 'hour-verifying' || payload.type === 'hour-confirmed' || payload.type === 'hour-failed') {
            state.activeDate = payload.date;
            applyHourProgress(findProgressDay(store, payload.date), payload);
        } else if (payload.type === 'day-saving') {
            state.activeDate = payload.date;
            const day = findProgressDay(store, payload.date);
            if (day) day.status = 'saving';
        } else if (payload.type === 'day-done') {
            const day = findProgressDay(store, payload.date);
            if (day) {
                day.status = 'done';
                day.fill = payload.fill;
                day.savedAs = payload.savedAs;
            }
        } else if (payload.type === 'store-done') {
            store.mmxStatus = 'done';
        } else if (payload.type === 'store-complete') {
            store.mmxStatus = payload.ok === false ? 'error' : 'done';
            if (payload.error) store.mmxError = payload.error;
        } else if (payload.type === 'store-error') {
            store.mmxStatus = 'error';
            store.mmxError = payload.error || 'Submit failed';
            const activeDay = findProgressDay(store, state.activeDate);
            if (activeDay && activeDay.status !== 'done') {
                activeDay.status = 'error';
                activeDay.error = store.mmxError;
            }
        }
    }

    function ensureProgressBackdrop() {
        if (progressBackdrop && !progressBackdrop.querySelector('.admin-forecast-progress-body')) {
            progressBackdrop.remove();
            progressBackdrop = null;
        }
        if (progressBackdrop) return progressBackdrop;
        progressBackdrop = document.createElement('div');
        progressBackdrop.className = 'admin-modal-backdrop admin-modal-backdrop--stacked admin-modal-backdrop--progress';
        progressBackdrop.hidden = true;
        progressBackdrop.innerHTML = `
            <div class="admin-modal admin-modal--wide admin-modal--forecast-progress" role="dialog" aria-modal="true">
                <div class="admin-forecast-progress-body">
                    <div id="admin-forecast-progress-working" class="admin-forecast-progress-stage">
                        <h2 id="admin-forecast-progress-title">Submitting forecast</h2>
                        <p class="admin-accounts-meta" id="admin-forecast-progress-meta"></p>
                        <div class="admin-forecast-progress-unified">
                            <div class="admin-forecast-progress-week">
                                <div class="admin-forecast-progress-week-head" aria-hidden="true">
                                    <span>Day</span>
                                    <span>MMX hours</span>
                                    <span>LifeLenz</span>
                                </div>
                                <ol class="admin-forecast-progress-week-rows" id="admin-forecast-progress-week-rows"></ol>
                            </div>
                            <div class="admin-forecast-progress-detail-split">
                                <section class="admin-forecast-progress-detail-pane">
                                    <h3 class="admin-forecast-progress-pane-title">Macromatix hours</h3>
                                    <div class="admin-forecast-progress-detail" id="admin-forecast-progress-mmx-detail"></div>
                                </section>
                                <section class="admin-forecast-progress-detail-pane">
                                    <h3 class="admin-forecast-progress-pane-title">LifeLenz day parts</h3>
                                    <div class="admin-forecast-progress-detail admin-forecast-progress-detail--lifelenz" id="admin-forecast-progress-lifelenz-detail"></div>
                                </section>
                            </div>
                        </div>
                    </div>
                    <div id="admin-forecast-progress-done" class="admin-forecast-progress-stage admin-forecast-progress-done" hidden>
                        <div class="admin-forecast-progress-done-header">
                            <h2 id="admin-forecast-progress-done-title">Forecast entered</h2>
                            <p class="admin-accounts-meta admin-forecast-progress-done-meta" id="admin-forecast-progress-done-meta"></p>
                        </div>
                        <div id="admin-forecast-progress-done-results" class="admin-forecast-progress-done-results"></div>
                        <div id="admin-forecast-progress-manual-actions" class="admin-forecast-progress-manual-actions" hidden></div>
                    </div>
                </div>
                <p id="admin-forecast-progress-error" class="admin-modal-error" role="alert"></p>
                <div class="admin-modal-actions admin-modal-actions--progress">
                    <button type="button" class="mic-settings-btn admin-btn-primary" id="admin-forecast-progress-close" disabled aria-disabled="true">Submitting…</button>
                </div>
            </div>`;
        document.body.appendChild(progressBackdrop);
        progressBackdrop.querySelector('#admin-forecast-progress-close')?.addEventListener('click', () => {
            if (!progressState?.complete && !progressState?.error) return;
            void closeProgress(true);
        });
        return progressBackdrop;
    }

    function closeProgress(refreshMain = false) {
        if (progressBackdrop) progressBackdrop.hidden = true;
        progressState = null;
        pendingSubmitTarget = null;
        if (refreshMain) {
            const mainRoot = ensureBackdrop();
            void refresh(mainRoot);
        }
    }

    function progressDayStatusLabel(status) {
        if (status === 'filling') return 'Entering sales…';
        if (status === 'verifying') return 'Confirming sales…';
        if (status === 'saving') return 'Saving…';
        if (status === 'done') return 'Saved';
        if (status === 'error') return 'Failed';
        return 'Pending';
    }

    function hourStatusLabel(status) {
        if (status === 'entering') return 'Entering…';
        if (status === 'verifying') return 'Confirming…';
        if (status === 'confirmed') return 'Confirmed';
        if (status === 'failed') return 'Failed';
        return 'Pending';
    }

    function hourStatusTitle(slot) {
        if (slot?.error) return String(slot.error);
        if (slot?.readValue != null && Number.isFinite(Number(slot.readValue))) {
            return `Read $${Math.round(Number(slot.readValue))}`;
        }
        return '';
    }

    function setProgressCloseEnabled(root, enabled, { label = 'Done' } = {}) {
        const btn = root.querySelector('#admin-forecast-progress-close');
        if (!btn) return;
        btn.disabled = !enabled;
        btn.textContent = label;
        btn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    }

    function activeHourLiveMessage(day) {
        if (!day?.hourly?.length) return progressDayStatusLabel(day?.status);
        const active =
            [...day.hourly].reverse().find((slot) => slot.status === 'entering' || slot.status === 'verifying') ||
            day.hourly.find((slot) => slot.status === 'entering' || slot.status === 'verifying');
        if (active) {
            const label = formatHourLabel(active.hour);
            return active.status === 'verifying'
                ? `Confirming sales for ${label}…`
                : `Entering sales for ${label}…`;
        }
        if (day.status === 'verifying') return 'Double-checking all hours…';
        if (day.status === 'saving') return 'Saving day to Macromatix…';
        const confirmed = day.hourly.filter((slot) => slot.status === 'confirmed').length;
        if (confirmed) return `${confirmed} of ${day.hourly.length} hours confirmed`;
        return progressDayStatusLabel(day.status);
    }

    function buildProgressDayDetailHtml(day) {
        if (!day) {
            return '<p class="admin-accounts-meta">Waiting for the next day…</p>';
        }
        const rows = (day.hourly || [])
            .map((slot) => {
                const status = slot.status || 'pending';
                const cls = `admin-forecast-progress-hour-row admin-forecast-progress-hour-row--${status}`;
                const title = hourStatusTitle(slot);
                return `<tr class="${cls}" data-hour="${escapeHtml(String(slot.hour))}">
                    <th scope="row">${escapeHtml(formatHourLabel(slot.hour))}</th>
                    <td class="admin-history-num">${formatMoney(slot.forecast)}</td>
                    <td class="admin-forecast-progress-hour-status"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(hourStatusLabel(status))}</td>
                </tr>`;
            })
            .join('');
        return `
            <div class="admin-forecast-progress-detail-head">
                <span class="admin-forecast-progress-detail-date">${escapeHtml(formatShortDate(day.date))}</span>
                <span class="admin-forecast-progress-detail-weekday">${escapeHtml(weekdayLabel(day.weekday))}</span>
                <span class="admin-forecast-progress-detail-total">${formatMoney(day.forecastTotal)}</span>
            </div>
            <p class="admin-forecast-progress-detail-status admin-forecast-progress-live">${escapeHtml(activeHourLiveMessage(day))}</p>
            <div class="admin-forecast-progress-hour-wrap">
                <table class="admin-table admin-forecast-progress-hour-table">
                    <thead><tr><th scope="col">Hour</th><th scope="col">Forecast</th><th scope="col">Status</th></tr></thead>
                    <tbody>${rows || '<tr><td colspan="3">No hourly values</td></tr>'}</tbody>
                </table>
            </div>`;
    }

    function patchProgressDayDetail(detailEl, day) {
        if (!day) {
            detailEl.dataset.activeDate = '';
            detailEl.innerHTML = '<p class="admin-accounts-meta">Waiting for the next day…</p>';
            return;
        }
        if (detailEl.dataset.activeDate !== day.date) {
            detailEl.dataset.activeDate = day.date;
            detailEl.innerHTML = buildProgressDayDetailHtml(day);
            return;
        }
        const liveEl = detailEl.querySelector('.admin-forecast-progress-live');
        if (liveEl) liveEl.textContent = activeHourLiveMessage(day);
        for (const slot of day.hourly || []) {
            const row = detailEl.querySelector(`tr[data-hour="${String(slot.hour)}"]`);
            if (!row) continue;
            const status = slot.status || 'pending';
            row.className = `admin-forecast-progress-hour-row admin-forecast-progress-hour-row--${status}`;
            const statusEl = row.querySelector('.admin-forecast-progress-hour-status');
            if (!statusEl) continue;
            statusEl.textContent = hourStatusLabel(status);
            const title = hourStatusTitle(slot);
            if (title) statusEl.setAttribute('title', title);
            else statusEl.removeAttribute('title');
        }
    }

    function mmxDayColumnSummary(day) {
        if (!day) return '-';
        if (day.status === 'done') return `Saved · ${formatMoney(day.forecastTotal)}`;
        if (day.status === 'error') return day.error || 'Failed';
        if (day.hourly?.length) {
            const confirmed = day.hourly.filter((slot) => slot.status === 'confirmed').length;
            const active = day.hourly.some((slot) => slot.status === 'entering' || slot.status === 'verifying');
            if (active || confirmed) return `${confirmed}/${day.hourly.length} hrs`;
        }
        if (day.status === 'pending') {
            return day.forecastTotal != null ? `${formatMoney(day.forecastTotal)} · Pending` : 'Pending';
        }
        return progressDayStatusLabel(day.status);
    }

    function lifelenzDayColumnSummary(day, { isActive, liveLabel } = {}) {
        if (!day) return '-';
        if (day.status === 'error') return day.error || 'Failed';
        if (day.status === 'done') return `Saved · ${formatMoney(day.forecastTotal)}`;
        if (isActive && liveLabel && day.status === 'filling') {
            if (/quirk/i.test(liveLabel)) return 'Overnight quirk…';
            if (liveLabel.length > 32) return `${liveLabel.slice(0, 30)}…`;
            return liveLabel;
        }
        return progressDayStatusLabel(day.status);
    }

    function lifelenzDayDetailMessage(day, liveLabel) {
        if (!day) return 'Waiting for LifeLenz…';
        if (day.status === 'done') return `Saved in LifeLenz · ${formatMoney(day.forecastTotal)}`;
        if (day.status === 'error') return day.error || 'LifeLenz entry failed';
        if (day.status === 'filling' && liveLabel) return liveLabel;
        return progressDayStatusLabel(day.status);
    }

    function buildLifelenzDayDetailHtml(day, liveLabel) {
        if (!day) {
            return '<p class="admin-accounts-meta">Waiting for LifeLenz…</p>';
        }
        return `
            <div class="admin-forecast-progress-detail-head">
                <span class="admin-forecast-progress-detail-date">${escapeHtml(formatShortDate(day.date))}</span>
                <span class="admin-forecast-progress-detail-weekday">${escapeHtml(weekdayLabel(day.weekday))}</span>
                <span class="admin-forecast-progress-detail-total">${formatMoney(day.forecastTotal)}</span>
            </div>
            <p class="admin-forecast-progress-detail-status admin-forecast-progress-live">${escapeHtml(lifelenzDayDetailMessage(day, liveLabel))}</p>`;
    }

    function patchLifelenzDayDetail(detailEl, day, liveLabel) {
        if (!detailEl) return;
        if (!day) {
            detailEl.dataset.activeDate = '';
            detailEl.innerHTML = '<p class="admin-accounts-meta">Waiting for LifeLenz…</p>';
            return;
        }
        if (detailEl.dataset.activeDate !== day.date) {
            detailEl.dataset.activeDate = day.date;
            detailEl.innerHTML = buildLifelenzDayDetailHtml(day, liveLabel);
            return;
        }
        const liveEl = detailEl.querySelector('.admin-forecast-progress-live');
        if (liveEl) liveEl.textContent = lifelenzDayDetailMessage(day, liveLabel);
    }

    function patchProgressWeekRows(weekEl, store, state) {
        if (!weekEl) return;
        const mmxDays = store?.days || [];
        const llDays = store?.lifelenzDays || [];
        const llByDate = new Map(llDays.map((day) => [day.date, day]));
        const liveLabel = store?.lifelenzLiveLabel || state?.lifelenzLiveLabel || '';

        mmxDays.forEach((mmxDay, index) => {
            const llDay = llByDate.get(mmxDay.date) || llDays[index];
            const isActive =
                mmxDay.date === state?.activeDate || mmxDay.date === state?.activeLifelenzDate;
            let row = weekEl.children[index];
            if (!row || row.dataset.date !== mmxDay.date) {
                row = document.createElement('li');
                row.dataset.date = mmxDay.date;
                row.className = 'admin-forecast-progress-week-row';
                row.innerHTML =
                    '<span class="admin-forecast-progress-week-day"></span>' +
                    '<span class="admin-forecast-progress-week-mmx"></span>' +
                    '<span class="admin-forecast-progress-week-ll"></span>';
                if (weekEl.children[index]) weekEl.replaceChild(row, weekEl.children[index]);
                else weekEl.appendChild(row);
            }

            const rowStatus =
                mmxDay.status === 'error' || llDay?.status === 'error'
                    ? 'error'
                    : mmxDay.status === 'done' && (!llDay || llDay.status === 'done')
                      ? 'done'
                      : isActive ||
                          mmxDay.status === 'filling' ||
                          mmxDay.status === 'verifying' ||
                          mmxDay.status === 'saving' ||
                          llDay?.status === 'filling'
                        ? 'active'
                        : mmxDay.status || 'pending';

            row.className = `admin-forecast-progress-week-row admin-forecast-progress-week-row--${rowStatus}${isActive ? ' is-active' : ''}`;
            row.querySelector('.admin-forecast-progress-week-day').textContent =
                weekdayLabel(mmxDay.weekday) || formatShortDate(mmxDay.date);
            row.querySelector('.admin-forecast-progress-week-mmx').textContent = mmxDayColumnSummary(mmxDay);
            row.querySelector('.admin-forecast-progress-week-ll').textContent = lifelenzDayColumnSummary(llDay, {
                isActive: llDay?.date === state?.activeLifelenzDate,
                liveLabel,
            });
        });

        while (weekEl.children.length > mmxDays.length) {
            weekEl.removeChild(weekEl.lastChild);
        }
    }

    function formatHourLabel(hour) {
        const h = Number(hour);
        if (!Number.isFinite(h)) return '';
        const normalized = ((h % 24) + 24) % 24;
        if (normalized === 0 || normalized === 24) return '12:00 AM';
        if (normalized === 12) return '12:00 PM';
        if (normalized < 12) return `${normalized}:00 AM`;
        return `${normalized - 12}:00 PM`;
    }

    function renderProgressWorking() {
        const root = ensureProgressBackdrop();
        const state = progressState;
        if (!state || state.complete) return;

        root.querySelector('#admin-forecast-progress-working').hidden = false;
        root.querySelector('#admin-forecast-progress-done').hidden = true;
        setProgressCloseEnabled(root, false, { label: 'Submitting…' });
        root.querySelector('#admin-forecast-progress-error').textContent = '';

        const activeStore = findProgressStore(state, state.activeStore) || state.stores[0];
        const mmxDone = state.stores.filter((s) => s.mmxStatus === 'done').length;
        const llDone = state.stores.filter((s) => s.lifelenzStatus === 'done').length;

        root.querySelector('#admin-forecast-progress-title').textContent = 'Submitting forecast';
        root.querySelector('#admin-forecast-progress-meta').textContent = activeStore
            ? `Store ${activeStore.storeNumber}${activeStore.storeName !== activeStore.storeNumber ? ' · ' + activeStore.storeName : ''} · MMX ${mmxDone}/${state.stores.length} · LifeLenz ${llDone}/${state.stores.length}`
            : 'Starting…';

        const focusMmxDay =
            findProgressDay(activeStore, state.activeDate) ||
            activeStore?.days.find((d) => d.status === 'filling' || d.status === 'verifying' || d.status === 'saving') ||
            activeStore?.days.find((d) => d.status === 'pending') ||
            activeStore?.days[activeStore?.days.length - 1];

        const focusLlDay =
            (state.activeLifelenzDate && findProgressLifelenzDay(activeStore, state.activeLifelenzDate)) ||
            activeStore?.lifelenzDays?.find((d) => d.status === 'filling') ||
            activeStore?.lifelenzDays?.find((d) => d.status === 'pending') ||
            null;

        const globalLiveLabel = activeStore?.lifelenzLiveLabel || state.lifelenzLiveLabel || '';
        const llLiveLabel =
            focusLlDay?.status === 'filling' && focusLlDay.date === state.activeLifelenzDate
                ? globalLiveLabel
                : !state.activeLifelenzDate && focusLlDay?.status === 'pending' && globalLiveLabel
                  ? globalLiveLabel
                  : '';

        patchProgressWeekRows(root.querySelector('#admin-forecast-progress-week-rows'), activeStore, state);
        patchProgressDayDetail(root.querySelector('#admin-forecast-progress-mmx-detail'), focusMmxDay);
        patchLifelenzDayDetail(root.querySelector('#admin-forecast-progress-lifelenz-detail'), focusLlDay, llLiveLabel);
    }

    function sumLifeLenzDayParts(appliedDay) {
        if (!appliedDay?.dayParts?.length) return null;
        return appliedDay.dayParts.reduce((sum, row) => sum + (Number(row.adjusted) || 0), 0);
    }

    function resolveCompletePlanForStore(storeNumber, state) {
        const preview = (previewData?.previews || []).find(
            (row) => row.ok && String(row.storeNumber) === String(storeNumber)
        );
        if (preview?.plan?.length) return preview.plan;
        const storeState = findProgressStore(state, storeNumber);
        if (storeState?.days?.length) {
            return storeState.days.map((day) => ({
                date: day.date,
                weekday: day.weekday,
                forecastTotal: day.forecastTotal,
            }));
        }
        return [];
    }

    function completeAmountCell(ok, amount, { failedLabel = 'Failed' } = {}) {
        if (ok === false) {
            return `<td class="admin-history-num admin-forecast-progress-done-cell--bad">${escapeHtml(failedLabel)}</td>`;
        }
        if (amount == null || !Number.isFinite(Number(amount))) {
            return '<td class="admin-history-num">-</td>';
        }
        return `<td class="admin-history-num">${formatMoney(amount)}</td>`;
    }

    function buildProgressCompleteResultsHtml(state, payload) {
        const mmxResults = payload?.mmx || payload?.results || [];
        const lifelenzResults = payload?.lifelenz || [];
        const lifelenzSkipped = payload?.lifelenzSkipped === true;
        const storeNumbers =
            state?.storeNumbers ||
            [...new Set([...mmxResults, ...lifelenzResults].map((row) => String(row.storeNumber)))];

        return storeNumbers
            .map((storeNumber) => {
                const plan = resolveCompletePlanForStore(storeNumber, state);
                const mmxRow = mmxResults.find((row) => String(row.storeNumber) === String(storeNumber));
                const llRow = lifelenzResults.find((row) => String(row.storeNumber) === String(storeNumber));
                const storeState = findProgressStore(state, storeNumber);
                const storeName =
                    mmxRow?.storeName || llRow?.storeName || storeState?.storeName || storeNumber;
                const llByDate = new Map(
                    (llRow?.lifelenz || []).map((day) => [day.date, sumLifeLenzDayParts(day)])
                );

                const colCount = lifelenzSkipped ? 3 : 4;

                const bodyRows = plan
                    .map((day) => {
                        const llAmount = lifelenzSkipped
                            ? null
                            : llRow?.ok
                              ? llByDate.get(day.date) ?? day.forecastTotal
                              : null;
                        return `<tr>
                            <th scope="row">${escapeHtml(weekdayLabel(day.weekday) || '-')}</th>
                            <td>${escapeHtml(formatShortDate(day.date))}</td>
                            ${completeAmountCell(mmxRow?.ok, day.forecastTotal)}
                            ${
                                lifelenzSkipped
                                    ? ''
                                    : completeAmountCell(llRow?.ok, llAmount, { failedLabel: 'Failed' })
                            }
                        </tr>`;
                    })
                    .join('');

                const weekMmx = plan.reduce((sum, day) => sum + (Number(day.forecastTotal) || 0), 0);
                let weekLl = 0;
                if (!lifelenzSkipped && llRow?.ok) {
                    weekLl = plan.reduce((sum, day) => {
                        const value = llByDate.get(day.date);
                        return sum + (Number(value ?? day.forecastTotal) || 0);
                    }, 0);
                }

                const llHead = lifelenzSkipped
                    ? ''
                    : '<th scope="col">LifeLenz</th>';
                const llFoot = lifelenzSkipped
                    ? ''
                    : completeAmountCell(llRow?.ok, weekLl);

                const errors = [];
                if (mmxRow && !mmxRow.ok) errors.push(`Macromatix: ${mmxRow.error || 'Failed'}`);
                if (!lifelenzSkipped && llRow && !llRow.ok) {
                    errors.push(`LifeLenz: ${llRow.error || 'Failed'}`);
                }

                return `<section class="admin-forecast-progress-done-store">
                    <h3>${escapeHtml(storeNumber)}${storeName !== storeNumber ? ` · ${escapeHtml(storeName)}` : ''}</h3>
                    ${
                        errors.length
                            ? `<p class="admin-modal-error admin-forecast-progress-done-error">${escapeHtml(errors.join(' · '))}</p>`
                            : ''
                    }
                    <div class="admin-forecast-progress-done-table-wrap">
                        <table class="admin-table admin-forecast-progress-done-table">
                            <thead>
                                <tr>
                                    <th scope="col">Day</th>
                                    <th scope="col">Date</th>
                                    <th scope="col">Macromatix</th>
                                    ${llHead}
                                </tr>
                            </thead>
                            <tbody>${bodyRows || `<tr><td colspan="${colCount}">No forecast days</td></tr>`}</tbody>
                            <tfoot>
                                <tr>
                                    <th scope="row" colspan="2">Week total</th>
                                    ${completeAmountCell(mmxRow?.ok, weekMmx)}
                                    ${llFoot}
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </section>`;
            })
            .join('');
    }

    function renderProgressComplete(payload) {
        const root = ensureProgressBackdrop();
        const state = progressState;
        if (state) state.complete = true;
        root.querySelector('#admin-forecast-progress-working').hidden = true;
        root.querySelector('#admin-forecast-progress-done').hidden = false;
        setProgressCloseEnabled(root, true, { label: 'Done' });

        const mmxResults = payload?.mmx || payload?.results || [];
        const lifelenzResults = payload?.lifelenz || [];
        const weekStart = (payload?.targetWeeks || previewData?.targetWeeks || [])[0];
        const lifelenzSkipped = payload?.lifelenzSkipped === true;
        const storeNumbers = state?.storeNumbers || mmxResults.map((row) => String(row.storeNumber));
        const firstStore = storeNumbers[0];
        const firstPreview = (previewData?.previews || []).find(
            (row) => row.ok && String(row.storeNumber) === String(firstStore)
        );
        const storeLabel = firstStore
            ? `${firstStore}${firstPreview?.storeName && firstPreview.storeName !== firstStore ? ` · ${firstPreview.storeName}` : ''}`
            : '';

        const mmxFailed = mmxResults.some((row) => !row.ok);
        const llFailed = !lifelenzSkipped && lifelenzResults.some((row) => !row.ok);
        const doneTitle = root.querySelector('#admin-forecast-progress-done-title');
        if (doneTitle) {
            doneTitle.textContent =
                mmxFailed || llFailed ? 'Forecast finished with errors' : 'Forecast entered';
        }

        root.querySelector('#admin-forecast-progress-done-meta').textContent = [
            weekStart ? `Week starting ${formatShortDate(weekStart)}` : '',
            storeNumbers.length === 1 ? storeLabel : `${storeNumbers.length} stores`,
        ]
            .filter(Boolean)
            .join(' · ');

        root.querySelector('#admin-forecast-progress-done-results').innerHTML = buildProgressCompleteResultsHtml(
            state,
            payload
        );

        const manualEl = root.querySelector('#admin-forecast-progress-manual-actions');
        const failedStores = new Set();
        for (const row of mmxResults) if (!row.ok) failedStores.add(String(row.storeNumber));
        for (const row of lifelenzResults) if (!row.ok) failedStores.add(String(row.storeNumber));
        if (manualEl && failedStores.size) {
            manualEl.hidden = false;
            manualEl.innerHTML = [...failedStores]
                .map(
                    (store) =>
                        `<button type="button" class="mic-settings-btn" data-manual-store="${escapeHtml(store)}" data-manual-week="${escapeHtml(weekStart || '')}">Manual entry guide - ${escapeHtml(store)}</button>`
                )
                .join(' ');
            manualEl.querySelectorAll('[data-manual-store]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    void openManualEntryGuide(
                        btn.getAttribute('data-manual-store'),
                        btn.getAttribute('data-manual-week')
                    );
                });
            });
        } else if (manualEl) {
            manualEl.hidden = true;
            manualEl.innerHTML = '';
        }

        if (state) {
            state.results = payload;
        }
        void (async () => {
            const surface = getRoot();
            if (!surface) return;
            try {
                statusPayload = await fetchStatus();
                renderAreaTabs(surface);
                renderTable(surface, statusPayload);
            } catch (_) {
                /* ignore refresh errors after submit */
            }
        })();
    }

    function openProgress(storeNumbers, previewSnapshot) {
        progressState = initProgressState(storeNumbers, previewSnapshot);
        const root = ensureProgressBackdrop();
        root.hidden = false;
        renderProgressWorking();
    }

    function handleProgressPayload(payload) {
        if (!progressState) return;
        applyProgressEvent(progressState, payload);
        renderProgressWorking();
    }

    function handleLifeLenzStarted(data) {
        if (!progressState) return;
        progressState.lifelenzLiveLabel = 'Signing in to LifeLenz…';
        renderProgressWorking();
    }

    function handlePlatformStarted(data) {
        if (!progressState) return;
        renderProgressWorking();
    }

    function closePreview() {
        if (previewBackdrop) previewBackdrop.hidden = true;
        pendingSubmitStores = [];
        pendingSubmitTarget = null;
        previewData = null;
        previewActiveStore = null;
    }

    function closeHistory() {
        if (historyBackdrop) historyBackdrop.hidden = true;
        historyStoreNumber = null;
        historyGridData = null;
        historyWeekStart = null;
        historyEditState = null;
        closeHistoryEditForm();
    }

    function formatSourceLabel(source) {
        const map = {
            'live-scrape': 'Live',
            import: 'Import',
            'import-cli': 'Import',
            'manual-ui': 'Manual',
            live: 'Live',
            'mmx-report-backfill': 'Backfilled',
            'mmx-backfill': 'Backfilled',
        };
        return map[String(source || '').trim()] || (source ? String(source) : '');
    }

    function isPastMissingHistoryDay(row, grid) {
        if (!row || row.hasData) return false;
        const asOf = String(grid?.asOf || historyDateBounds?.newest || '').trim();
        const date = String(row.date || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return false;
        return date < asOf;
    }

    async function saveHistoryDay(payload) {
        const root = ensureHistoryBackdrop();
        root.querySelector('#admin-forecast-history-error').textContent = '';
        const res = await fetch('/api/admin/forecast/history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not save history day.');
        if (data.dateBounds) historyDateBounds = data.dateBounds;
        closeHistoryEditForm();
        await loadHistoryGrid(historyStoreNumber, historyGridData?.weekStart || historyWeekStart);
        if (statusPayload && getRoot()) {
            const statusRes = await fetchStatus();
            statusPayload = statusRes;
            renderTable(getRoot(), statusPayload);
        }
    }

    async function submitInlineHistoryRow(rowIdx, container) {
        const row = historyGridData?.rows?.[rowIdx];
        if (!row || !historyStoreNumber || !container) return;
        const root = ensureHistoryBackdrop();
        const hourColumns = historyGridData?.hourColumns || [];
        const values = [];
        for (let hourIdx = 0; hourIdx < hourColumns.length; hourIdx += 1) {
            const col = hourColumns[hourIdx];
            if (col.hour < row.openHour || col.hour >= row.closeHour) continue;
            const input = container.querySelector(
                `input[data-history-inline-row="${rowIdx}"][data-hour-idx="${hourIdx}"]`
            );
            values.push(input ? Number(input.value) || 0 : 0);
        }
        if (!values.some((v) => v > 0)) {
            root.querySelector('#admin-forecast-history-error').textContent = 'Enter at least one hourly value.';
            return;
        }
        try {
            await saveHistoryDay({
                store: historyStoreNumber,
                date: row.date,
                openHour: row.openHour ?? historyGridData?.openHour,
                closeHour: row.closeHour ?? historyGridData?.closeHour,
                actual: values,
            });
        } catch (error) {
            root.querySelector('#admin-forecast-history-error').textContent = error.message;
        }
    }

    function closeHistoryEditForm() {
        historyEditState = null;
        const panel = historyBackdrop?.querySelector('#admin-forecast-history-edit');
        if (panel) {
            panel.hidden = true;
            panel.innerHTML = '';
        }
    }

    function openHistoryEditForm(dayRow) {
        const root = ensureHistoryBackdrop();
        const panel = root.querySelector('#admin-forecast-history-edit');
        if (!panel || !historyGridData) return;

        const isEdit = Boolean(dayRow?.date);
        historyEditState = {
            date: dayRow?.date || '',
            source: dayRow?.source || null,
            openHour: dayRow?.openHour ?? historyGridData.openHour,
            closeHour: dayRow?.closeHour ?? historyGridData.closeHour,
        };

        const hourColumns = historyGridData.hourColumns || [];
        const hourRows = hourColumns
            .map((col, idx) => {
                if (isEdit && dayRow && (col.hour < dayRow.openHour || col.hour >= dayRow.closeHour)) {
                    return '';
                }
                const val = isEdit && dayRow ? dayRow.values[idx] : '';
                return `<label class="admin-forecast-history-hour-input">
                <span>${escapeHtml(col.label)}</span>
                <input type="number" min="0" step="0.01" data-hour-idx="${idx}" data-hour="${col.hour}" value="${val != null && val !== '' ? escapeHtml(val) : ''}" />
            </label>`;
            })
            .filter(Boolean)
            .join('');

        const boundsHint = historyDateBounds
            ? historyDateBounds.archiveDays > historyDateBounds.hotDays
                ? `Browse ${historyDateBounds.archiveDays} days (${historyDateBounds.oldest} to ${historyDateBounds.newest}). Forecast uses the latest ${historyDateBounds.hotDays} days.`
                : `Allowed dates: ${historyDateBounds.oldest} to ${historyDateBounds.newest}`
            : 'Within the loaded date range';

        panel.hidden = false;
        panel.innerHTML = `
            <h3 class="admin-forecast-history-heading">${isEdit ? 'Edit history day' : 'Add history day'}</h3>
            <form class="admin-forecast-history-form" id="admin-forecast-history-form">
                <label>Date <input type="date" name="date" required value="${escapeHtml(historyEditState.date)}" ${isEdit ? 'readonly' : ''} min="${escapeHtml(historyDateBounds?.oldest || '')}" max="${escapeHtml(historyDateBounds?.newest || '')}" /></label>
                <p class="admin-accounts-meta">${escapeHtml(boundsHint)}</p>
                <p class="admin-accounts-meta">Enter hourly actual sales for each trading hour.</p>
                <div class="admin-forecast-history-hour-grid">${hourRows}</div>
                <div class="admin-modal-actions admin-modal-actions--split">
                    ${isEdit ? `<button type="button" class="mic-settings-btn admin-forecast-history-delete-btn" data-history-edit-action="delete">Delete</button>` : '<span></span>'}
                    <span class="admin-forecast-history-form-actions">
                        <button type="button" class="mic-settings-btn" data-history-edit-action="cancel">Cancel</button>
                        <button type="button" class="mic-settings-btn admin-btn-primary" data-history-edit-action="save">Save</button>
                    </span>
                </div>
            </form>`;
    }

    async function submitHistoryEditForm() {
        const root = ensureHistoryBackdrop();
        const form = root.querySelector('#admin-forecast-history-form');
        if (!form || !historyStoreNumber) return;
        root.querySelector('#admin-forecast-history-error').textContent = '';

        const date = String(form.querySelector('[name="date"]')?.value || '').trim();
        const payload = {
            store: historyStoreNumber,
            date,
            openHour: historyEditState?.openHour ?? historyGridData?.openHour,
            closeHour: historyEditState?.closeHour ?? historyGridData?.closeHour,
        };

        const values = [...form.querySelectorAll('[data-hour-idx]')].map((input) => Number(input.value) || 0);
        if (!values.some((v) => v > 0)) {
            root.querySelector('#admin-forecast-history-error').textContent = 'Enter at least one hourly value.';
            return;
        }
        payload.actual = values;

        try {
            await saveHistoryDay(payload);
        } catch (error) {
            root.querySelector('#admin-forecast-history-error').textContent = error.message;
        }
    }

    async function deleteHistoryEditDay() {
        const root = ensureHistoryBackdrop();
        if (!historyStoreNumber || !historyEditState?.date) return;
        const source = historyEditState.source;
        const force =
            source === 'live-scrape'
                ? global.confirm('Delete live-scraped history for this day? This cannot be undone.')
                : global.confirm('Delete this history day?');
        if (!force) return;

        root.querySelector('#admin-forecast-history-error').textContent = '';
        try {
            const params = new URLSearchParams({
                store: historyStoreNumber,
                date: historyEditState.date,
            });
            if (source === 'live-scrape') params.set('force', '1');
            const res = await fetch(`/api/admin/forecast/history?${params}`, {
                method: 'DELETE',
                credentials: 'same-origin',
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) throw new Error(data.error || 'Could not delete history day.');
            closeHistoryEditForm();
            await loadHistoryGrid(historyStoreNumber, historyGridData?.weekStart || historyWeekStart);
            if (statusPayload && getRoot()) {
                const statusRes = await fetchStatus();
                statusPayload = statusRes;
                renderTable(getRoot(), statusPayload);
            }
        } catch (error) {
            root.querySelector('#admin-forecast-history-error').textContent = error.message;
        }
    }

    function renderHistoryWeekGrid(container, grid) {
        if (!grid?.rows?.length) {
            container.innerHTML = '<p>No history for this week.</p>';
            return;
        }
        const hourHead = (grid.hourColumns || [])
            .map((col) => `<th class="admin-history-hour-col">${escapeHtml(col.label)}</th>`)
            .join('');
        const rows = (grid.rows || [])
            .map((row, rowIdx) => {
                const sourceLabel = row.source ? formatSourceLabel(row.source) : '';
                const badge = sourceLabel
                    ? `<span class="admin-forecast-history-source admin-forecast-history-source--${escapeHtml(String(row.source || '').replace(/[^a-z0-9-]/gi, ''))}">${escapeHtml(sourceLabel)}</span>`
                    : '';
                const pastMissing = isPastMissingHistoryDay(row, grid);
                const rowClass = row.hasData ? '' : ' admin-history-week-row--missing';
                const hourColumns = grid.hourColumns || [];
                const cells = (row.values || [])
                    .map((v, hourIdx) => {
                        const col = hourColumns[hourIdx];
                        const inHours = col && col.hour >= row.openHour && col.hour < row.closeHour;
                        if (pastMissing && inHours) {
                            return `<td class="admin-history-num admin-history-inline-cell">
                                <input type="number" min="0" step="0.01" class="admin-history-inline-input"
                                    data-history-inline-row="${rowIdx}" data-hour-idx="${hourIdx}"
                                    value="" placeholder="0" aria-label="${escapeHtml(col.label)}" />
                            </td>`;
                        }
                        const text = v == null ? '-' : formatMoney(v);
                        return `<td class="admin-history-num">${text}</td>`;
                    })
                    .join('');
                const totalText = row.dayTotal != null ? formatMoney(row.dayTotal) : '-';
                let actionCell;
                if (row.hasData) {
                    actionCell = `<button type="button" class="admin-forecast-history-col-edit" data-history-edit-row="${rowIdx}">Edit</button>`;
                } else if (pastMissing) {
                    actionCell = `<button type="button" class="admin-forecast-history-col-edit admin-forecast-history-col-save" data-history-inline-save data-inline-row="${rowIdx}">Save</button>`;
                } else {
                    actionCell = `<button type="button" class="admin-forecast-history-col-edit" data-history-edit-row="${rowIdx}">Fill</button>`;
                }
                return `<tr class="admin-history-week-row${rowClass}${pastMissing ? ' admin-history-week-row--inline-edit' : ''}" data-history-row="${rowIdx}">
                    <th scope="row" class="admin-history-day-label">
                        <span class="admin-history-col-label">${escapeHtml(row.weekdayLabel || '')}</span>
                        <span class="admin-accounts-meta">${escapeHtml(formatShortDate(row.date))}</span>
                        ${badge}
                    </th>
                    ${cells}
                    <td class="admin-history-num admin-history-total">${totalText}</td>
                    <td>${actionCell}</td>
                </tr>`;
            })
            .join('');
        container.innerHTML = `
            <div class="admin-history-grid-wrap admin-history-week-grid-wrap">
                <table class="admin-table admin-history-grid admin-history-week-grid">
                    <thead>
                        <tr>
                            <th scope="col" class="admin-history-day-col">Day</th>
                            ${hourHead}
                            <th scope="col">Total</th>
                            <th scope="col"></th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
        container.querySelectorAll('[data-history-edit-row]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = Number(btn.getAttribute('data-history-edit-row'));
                const row = grid.rows[idx];
                openHistoryEditForm(row);
            });
        });
        container.querySelectorAll('[data-history-inline-save]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = Number(btn.getAttribute('data-inline-row'));
                void submitInlineHistoryRow(idx, container);
            });
        });
    }

    async function fetchStores() {
        const res = await fetch('/api/stores', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        const map = {};
        for (const store of data.stores || []) {
            if (store?.storeNumber) map[String(store.storeNumber)] = String(store.area || '').trim();
        }
        storeAreaByNumber = map;
    }

    async function fetchStatus() {
        const res = await fetch('/api/admin/forecast/status', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not load forecast status.');
        return data;
    }

    async function fetchHistoryGrid(storeNumber, weekStart) {
        const params = new URLSearchParams({ store: storeNumber, includeForecast: '0' });
        if (weekStart) params.set('weekStart', weekStart);
        const res = await fetch(`/api/admin/forecast/history-grid?${params}`, { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not load history grid.');
        return data;
    }

    async function fetchPreview(storeNumbers) {
        const res = await fetch('/api/admin/forecast/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ storeNumbers, ...getActiveForecastTargetPayload() }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            if (res.status === 404) {
                throw new Error('Preview API not found. Restart the app server and try again.');
            }
            throw new Error(data.error || `Could not load forecast preview (${res.status}).`);
        }
        return data;
    }

    function dot(completed, pending) {
        if (pending) return '<span class="admin-status-dot admin-status-dot--pending" aria-hidden="true"></span>';
        const cls = completed ? 'admin-status-dot--ok' : 'admin-status-dot--bad';
        return `<span class="admin-status-dot ${cls}" aria-hidden="true"></span>`;
    }

    function weekTotalForGrid(grid) {
        if (grid?.weekTotal != null && Number.isFinite(Number(grid.weekTotal))) return Number(grid.weekTotal);
        return (grid?.dayTotals || []).reduce((sum, value) => sum + (Number(value) || 0), 0);
    }

    function formatShortDateTime(iso) {
        if (!iso) return '-';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return String(iso);
        const date = formatShortDate(
            `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        );
        const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        return `${date} ${time}`;
    }

    function formatUpdateBadge(day) {
        if (!day?.updatedAt) return '';
        const source = day.source === 'auto' ? 'Auto' : 'User';
        const who = day.source === 'auto' ? '' : day.updatedBy ? ` · ${day.updatedBy}` : '';
        return `<span class="admin-forecast-update-badge admin-forecast-update-badge--${escapeHtml(day.source || 'user')}">${escapeHtml(source)}${escapeHtml(who)} · ${escapeHtml(formatShortDateTime(day.updatedAt))}</span>`;
    }

    async function saveStoreAutoSubmit(storeNumber, enabled) {
        const root = getRoot();
        if (!root) return;
        root.querySelector('#admin-forecast-error').textContent = '';
        try {
            const res = await fetch('/api/admin/forecast/store-auto-submit', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ store: storeNumber, enabled }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) throw new Error(data.error || 'Could not save auto-submit setting.');
            if (statusPayload) {
                statusPayload.storeAutoSubmit = statusPayload.storeAutoSubmit || {};
                statusPayload.storeAutoSubmit[String(storeNumber)] = Boolean(enabled);
            }
        } catch (error) {
            root.querySelector('#admin-forecast-error').textContent = error.message;
            const input = root.querySelector(`[data-auto-submit-store="${storeNumber}"]`);
            if (input) input.checked = !enabled;
        }
    }

    function transposePreviewGrid(grid) {
        if (!grid?.columns?.length || !grid?.rows?.length) return null;
        return {
            hourColumns: grid.rows.map((r) => ({ hour: r.hour, label: r.label })),
            rows: grid.columns.map((col, colIdx) => ({
                date: col.date,
                weekday: col.weekday,
                weekdayLabel: col.weekdayLabel,
                values: grid.rows.map((row) => row.values[colIdx]),
                dayTotal: grid.dayTotals?.[colIdx],
            })),
            dayTotals: grid.dayTotals,
            weekTotal: grid.weekTotal,
        };
    }

    function overrideBadgeForCell(rules, date, hour) {
        let rule;
        if (hour != null) {
            rule = (rules || []).find((r) => r.scope === 'hour' && r.date === date && r.hour === hour);
        } else {
            rule = (rules || []).find((r) => r.scope === 'day' && r.date === date);
        }
        if (!rule) return '';
        const label = formatAdjustmentRuleLabel(rule, []);
        return `<span class="admin-forecast-override-badge" title="${escapeHtml(label)}">±</span>`;
    }

    function renderForecastGrid(container, grid, options = {}) {
        const { emptyMessage, mode = 'history', forecastDayUpdates = {} } = options;
        if (!grid?.columns?.length) {
            container.innerHTML = `<p>${escapeHtml(emptyMessage || 'No forecast data.')}</p>`;
            return;
        }
        const head = grid.columns
            .map((col) => {
                const badge =
                    mode === 'preview' && col.date ? formatUpdateBadge(forecastDayUpdates[col.date]) : '';
                return `<th><span class="admin-history-col-label">${escapeHtml(col.weekdayLabel || col.label || '')}</span><span class="admin-accounts-meta">${escapeHtml(col.date || '-')}</span>${badge}</th>`;
            })
            .join('');
        const rows = (grid.rows || [])
            .map((row) => {
                const cells = row.values.map((v) => `<td class="admin-history-num">${formatMoney(v)}</td>`).join('');
                return `<tr><th scope="row" class="admin-history-hour">${escapeHtml(row.label)}</th>${cells}</tr>`;
            })
            .join('');
        const totalCells = (grid.dayTotals || [])
            .map((v) => `<td class="admin-history-num admin-history-total">${formatMoney(v)}</td>`)
            .join('');
        const weekTotal = weekTotalForGrid(grid);
        const previewSummary =
            mode === 'preview'
                ? `<div class="admin-forecast-preview-summary">
                    <span class="admin-forecast-week-total-label">Week forecast total</span>
                    <span class="admin-forecast-week-total-value">${formatMoney(weekTotal)}</span>
                </div>`
                : '';
        const adjustmentSummary =
            mode === 'preview' && options.baseWeekTotal != null && options.adjustmentDelta != null
                ? `<div class="admin-forecast-preview-summary admin-forecast-preview-summary--adjustments">
                    <span class="admin-forecast-week-total-label">Base ${formatMoney(options.baseWeekTotal)}</span>
                    <span class="admin-forecast-week-total-label">Adjustments ${options.adjustmentDelta >= 0 ? '+' : ''}${formatMoney(options.adjustmentDelta)}</span>
                    <span class="admin-forecast-week-total-value">Adjusted ${formatMoney(weekTotal)}</span>
                </div>`
                : previewSummary;
        const wrapClass =
            mode === 'preview'
                ? 'admin-history-grid-wrap admin-forecast-preview-grid-wrap'
                : 'admin-history-grid-wrap';
        container.innerHTML = `
            ${options.baseWeekTotal != null && options.adjustmentDelta != null ? adjustmentSummary : previewSummary}
            <div class="${wrapClass}">
                <table class="admin-table admin-history-grid">
                    <thead>
                        <tr><th scope="col">Hour</th>${head}</tr>
                    </thead>
                    <tbody>${rows}</tbody>
                    <tfoot>
                        <tr><th scope="row">Day total</th>${totalCells}</tr>
                    </tfoot>
                </table>
            </div>`;
    }

    function renderPreviewWeekGrid(container, grid, options = {}) {
        const transposed = transposePreviewGrid(grid);
        if (!transposed?.rows?.length) {
            container.innerHTML = `<p>${escapeHtml(options.emptyMessage || 'No forecast data.')}</p>`;
            return;
        }
        const { forecastDayUpdates = {}, adjustments = [], onOverride } = options;
        const hourHead = (transposed.hourColumns || [])
            .map((col) => `<th class="admin-history-hour-col">${escapeHtml(col.label)}</th>`)
            .join('');
        const rows = transposed.rows
            .map((row) => {
                const updateBadge = row.date ? formatUpdateBadge(forecastDayUpdates[row.date]) : '';
                const cells = (transposed.hourColumns || [])
                    .map((col, idx) => {
                        const val = row.values[idx];
                        const badge = overrideBadgeForCell(adjustments, row.date, col.hour);
                        const overrideBtn =
                            onOverride != null
                                ? `<button type="button" class="admin-forecast-override-btn" data-override-scope="hour" data-override-date="${escapeHtml(row.date)}" data-override-hour="${col.hour}" title="Override hour">±</button>`
                                : '';
                        return `<td class="admin-history-num admin-forecast-cell-with-override">${badge}${val != null ? formatMoney(val) : '-'}${overrideBtn}</td>`;
                    })
                    .join('');
                const dayBadge = overrideBadgeForCell(adjustments, row.date, null);
                const dayOverrideBtn =
                    onOverride != null
                        ? `<button type="button" class="admin-forecast-override-btn" data-override-scope="day" data-override-date="${escapeHtml(row.date)}" title="Override day">Override</button>`
                        : '';
                return `<tr>
                    <th scope="row" class="admin-history-day-label">
                        <span class="admin-history-col-label">${escapeHtml(row.weekdayLabel || '')}</span>
                        <span class="admin-accounts-meta">${escapeHtml(formatShortDate(row.date))}</span>
                        ${updateBadge}
                    </th>
                    ${cells}
                    <td class="admin-history-num admin-history-total">${dayBadge}${row.dayTotal != null ? formatMoney(row.dayTotal) : '-'} ${dayOverrideBtn}</td>
                </tr>`;
            })
            .join('');
        const weekTotal = transposed.weekTotal ?? weekTotalForGrid(grid);
        const adjustmentSummary =
            options.baseWeekTotal != null && options.adjustmentDelta != null
                ? `<div class="admin-forecast-preview-summary admin-forecast-preview-summary--adjustments">
                    <span class="admin-forecast-week-total-label">Base ${formatMoney(options.baseWeekTotal)}</span>
                    <span class="admin-forecast-week-total-label">Adjustments ${options.adjustmentDelta >= 0 ? '+' : ''}${formatMoney(options.adjustmentDelta)}</span>
                    <span class="admin-forecast-week-total-value">Adjusted ${formatMoney(weekTotal)}</span>
                </div>`
                : `<div class="admin-forecast-preview-summary">
                    <span class="admin-forecast-week-total-label">Week forecast total</span>
                    <span class="admin-forecast-week-total-value">${formatMoney(weekTotal)}</span>
                </div>`;
        container.innerHTML = `
            ${adjustmentSummary}
            <div class="admin-history-grid-wrap admin-history-week-grid-wrap admin-forecast-preview-grid-wrap">
                <table class="admin-table admin-history-grid admin-history-week-grid">
                    <thead>
                        <tr>
                            <th scope="col" class="admin-history-day-col">Day</th>
                            ${hourHead}
                            <th scope="col">Total</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
        if (onOverride) {
            container.querySelectorAll('[data-override-scope]').forEach((btn) => {
                btn.addEventListener('click', (event) => {
                    event.stopPropagation();
                    onOverride({
                        scope: btn.getAttribute('data-override-scope'),
                        date: btn.getAttribute('data-override-date'),
                        hour: btn.getAttribute('data-override-hour'),
                        anchor: btn,
                    });
                });
            });
        }
    }

    let overridePopoverEl = null;

    function closeOverridePopover() {
        if (overridePopoverEl) {
            overridePopoverEl.remove();
            overridePopoverEl = null;
        }
    }

    function openOverridePopover({ scope, date, hour, anchor }, storeNumber) {
        closeOverridePopover();
        const pop = document.createElement('div');
        pop.className = 'admin-forecast-override-popover';
        pop.innerHTML = `
            <p class="admin-forecast-override-popover-title">${scope === 'hour' ? 'Hour override' : 'Day override'}</p>
            <fieldset class="admin-forecast-adjustments-mode">
                <label><input type="radio" name="overrideMode" value="percent" checked> %</label>
                <label><input type="radio" name="overrideMode" value="dollar"> $</label>
            </fieldset>
            <label>Value
                <input type="number" name="overrideValue" step="any" placeholder="e.g. 10 or -200" />
            </label>
            <div class="admin-forecast-override-popover-actions">
                <button type="button" class="mic-settings-btn" data-override-action="cancel">Cancel</button>
                <button type="button" class="mic-settings-btn admin-btn-primary" data-override-action="apply">Apply</button>
            </div>`;
        document.body.appendChild(pop);
        overridePopoverEl = pop;
        const rect = anchor.getBoundingClientRect();
        pop.style.top = `${rect.bottom + window.scrollY + 4}px`;
        pop.style.left = `${Math.min(rect.left + window.scrollX, window.innerWidth - 220)}px`;

        pop.querySelector('[data-override-action="cancel"]')?.addEventListener('click', closeOverridePopover);
        pop.querySelector('[data-override-action="apply"]')?.addEventListener('click', () => {
            void applyOverrideFromPopover(pop, { scope, date, hour: hour != null ? Number(hour) : undefined }, storeNumber);
        });
        setTimeout(() => {
            document.addEventListener(
                'click',
                function onDocClick(ev) {
                    if (!pop.contains(ev.target) && ev.target !== anchor) {
                        closeOverridePopover();
                        document.removeEventListener('click', onDocClick);
                    }
                },
                { once: true }
            );
        }, 0);
    }

    async function applyOverrideFromPopover(pop, target, storeNumber) {
        const mode = pop.querySelector('[name="overrideMode"]:checked')?.value || 'percent';
        const value = Number(pop.querySelector('[name="overrideValue"]')?.value);
        if (!Number.isFinite(value)) {
            const errEl = previewBackdrop?.querySelector('#admin-forecast-preview-error');
            if (errEl) errEl.textContent = 'Enter a valid override value.';
            return;
        }
        closeOverridePopover();
        const preview = getPreviewForStore(storeNumber);
        const rules = (preview?.adjustments || []).slice();
        const rule = { scope: target.scope, mode, value, date: target.date };
        if (target.scope === 'hour') rule.hour = target.hour;
        const existingIdx = rules.findIndex((r) => {
            if (r.scope !== target.scope || r.date !== target.date) return false;
            if (target.scope === 'hour') return r.hour === target.hour;
            return true;
        });
        if (existingIdx >= 0) rules[existingIdx] = rule;
        else rules.push(rule);
        try {
            await savePreviewAdjustments(storeNumber, rules);
            renderPreviewStore(storeNumber);
        } catch (error) {
            const errEl = previewBackdrop?.querySelector('#admin-forecast-preview-error');
            if (errEl) errEl.textContent = error.message;
        }
    }

    function renderAreaTabs(root) {
        const nav = root.querySelector('#admin-forecast-area-tabs');
        if (!nav) return;
        nav.style.setProperty('--scope-cols', String(ADMIN_AREAS.length));
        nav.innerHTML = ADMIN_AREAS.map((name) => {
            const isActive = name === activeArea;
            return `<button type="button" class="admin-accounts-scope-chip${isActive ? ' is-active' : ''}" role="tab" aria-selected="${isActive ? 'true' : 'false'}" data-forecast-area="${escapeHtml(name)}">${escapeHtml(areaLabel(name))}</button>`;
        }).join('');
    }

    function formatAdjustmentRuleLabel(rule, planDays) {
        const modeLabel = rule.mode === 'percent' ? '%' : '$';
        const valueLabel =
            rule.mode === 'percent'
                ? `${rule.value >= 0 ? '+' : ''}${rule.value}%`
                : `${rule.value >= 0 ? '+' : ''}${formatMoney(rule.value)}`;
        if (rule.scope === 'week') return `Whole week ${valueLabel}`;
        const day = (planDays || []).find((d) => d.date === rule.date);
        const dayLabel = day?.weekdayLabel || formatShortDate(rule.date);
        if (rule.scope === 'hour') {
            return `${dayLabel} ${rule.hour != null ? `hr ${rule.hour}` : ''} ${valueLabel}`;
        }
        if (rule.scope === 'daypart') {
            const part = LIFELENZ_DAY_PARTS.find((p) => p.key === rule.dayPartKey);
            return `${dayLabel} ${part?.label || rule.dayPartKey} ${valueLabel}`;
        }
        return `${dayLabel} ${valueLabel}`;
    }

    function getPreviewForStore(storeNumber) {
        return (previewData?.previews || []).find((row) => String(row.storeNumber) === String(storeNumber));
    }

    function updatePreviewStoreFromPayload(storeNumber, payload) {
        if (!previewData?.previews) return;
        const idx = previewData.previews.findIndex((row) => String(row.storeNumber) === String(storeNumber));
        if (idx < 0) return;
        const existing = previewData.previews[idx];
        previewData.previews[idx] = {
            ...existing,
            grid: payload.grid || existing.grid,
            baseGrid: payload.baseGrid || existing.baseGrid,
            baseWeekTotal: payload.baseWeekTotal ?? existing.baseWeekTotal,
            adjustedWeekTotal: payload.adjustedWeekTotal ?? existing.adjustedWeekTotal,
            adjustmentDelta: payload.adjustmentDelta ?? existing.adjustmentDelta,
            adjustments: payload.adjustments?.rules ?? payload.rules ?? existing.adjustments,
        };
    }

    async function savePreviewAdjustments(storeNumber, rules) {
        const preview = getPreviewForStore(storeNumber);
        const weekStart = preview?.targetWeeks?.[0] || previewData?.targetWeeks?.[0] || '';
        if (!weekStart) return;
        const res = await fetch('/api/admin/forecast/adjustments', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ store: storeNumber, weekStart, rules }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not save adjustments.');
        updatePreviewStoreFromPayload(storeNumber, {
            ...data.preview,
            adjustments: data.adjustments?.rules || rules,
        });
        return data;
    }

    async function clearPreviewAdjustments() {
        const storeNumber = previewActiveStore;
        if (!storeNumber) return;
        const preview = getPreviewForStore(storeNumber);
        const weekStart = preview?.targetWeeks?.[0] || previewData?.targetWeeks?.[0] || '';
        const root = ensurePreviewBackdrop();
        root.querySelector('#admin-forecast-preview-error').textContent = '';
        try {
            const params = new URLSearchParams({ store: storeNumber, weekStart });
            const res = await fetch(`/api/admin/forecast/adjustments?${params}`, {
                method: 'DELETE',
                credentials: 'same-origin',
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) throw new Error(data.error || 'Could not clear adjustments.');
            updatePreviewStoreFromPayload(storeNumber, {
                ...data.preview,
                adjustments: [],
            });
            renderPreviewStore(storeNumber);
        } catch (error) {
            root.querySelector('#admin-forecast-preview-error').textContent = error.message;
        }
    }

    async function removePreviewAdjustment(index) {
        const storeNumber = previewActiveStore;
        const preview = getPreviewForStore(storeNumber);
        if (!preview) return;
        const rules = (preview.adjustments || []).slice();
        rules.splice(index, 1);
        const root = ensurePreviewBackdrop();
        root.querySelector('#admin-forecast-preview-error').textContent = '';
        try {
            await savePreviewAdjustments(storeNumber, rules);
            renderPreviewStore(storeNumber);
        } catch (error) {
            root.querySelector('#admin-forecast-preview-error').textContent = error.message;
        }
    }

    async function addPreviewAdjustment() {
        const storeNumber = previewActiveStore;
        const root = ensurePreviewBackdrop();
        const panel = root.querySelector('#admin-forecast-preview-adjustments');
        if (!storeNumber || !panel) return;
        root.querySelector('#admin-forecast-preview-error').textContent = '';

        const scope = panel.querySelector('[name="adjustScope"]:checked')?.value || 'week';
        const mode = panel.querySelector('[name="adjustMode"]:checked')?.value || 'percent';
        const value = Number(panel.querySelector('[name="adjustValue"]')?.value);
        if (!Number.isFinite(value)) {
            root.querySelector('#admin-forecast-preview-error').textContent = 'Enter a valid adjustment value.';
            return;
        }

        const preview = getPreviewForStore(storeNumber);
        const rules = (preview?.adjustments || []).slice();
        const rule = { scope, mode, value };
        if (scope === 'day') {
            const date = panel.querySelector('[name="adjustDate"]')?.value;
            if (!date) {
                root.querySelector('#admin-forecast-preview-error').textContent = 'Select a day for the adjustment.';
                return;
            }
            rule.date = date;
        }
        rules.push(rule);

        try {
            await savePreviewAdjustments(storeNumber, rules);
            panel.querySelector('[name="adjustValue"]').value = '';
            renderPreviewStore(storeNumber);
        } catch (error) {
            root.querySelector('#admin-forecast-preview-error').textContent = error.message;
        }
    }

    function renderPreviewAdjustmentsPanel(root, preview) {
        const panel = root.querySelector('#admin-forecast-preview-adjustments');
        if (!panel) return;
        panel.hidden = false;

        const weekStart = preview.targetWeeks?.[0] || '';
        const planDays = preview.grid?.columns || preview.plan || [];

        const rules = preview.adjustments || [];
        const rulesList = rules.length
            ? `<ul class="admin-forecast-adjustments-list">${rules
                  .map((rule, idx) => {
                      return `<li><span>${escapeHtml(formatAdjustmentRuleLabel(rule, planDays))}</span><button type="button" class="admin-forecast-adjust-remove" data-adjust-action="remove" data-adjust-index="${idx}">Remove</button></li>`;
                  })
                  .join('')}</ul>`
            : '<p class="admin-accounts-meta">No adjustments applied. Saved adjustments also apply to scheduled auto-submit.</p>';

        panel.innerHTML = `
            <h3 class="admin-forecast-history-heading">Overrides</h3>
            <p class="admin-accounts-meta">Use Override on a day or hour in the grid below. Day changes keep hourly spread unless an hour is overridden.</p>
            <div class="admin-forecast-adjustments-actions">
                <button type="button" class="mic-settings-btn" data-adjust-action="clear">Clear all overrides</button>
            </div>
            ${rulesList}
            <p class="admin-accounts-meta">Target week starting ${escapeHtml(formatShortDate(weekStart))}. Overrides persist until cleared.</p>`;
    }

    function renderPreviewStore(storeNumber) {
        const root = ensurePreviewBackdrop();
        const body = root.querySelector('#admin-forecast-preview-body');
        const tabs = root.querySelector('#admin-forecast-preview-stores');
        const meta = root.querySelector('#admin-forecast-preview-meta');
        const okPreviews = (previewData?.previews || []).filter((row) => row.ok);
        const preview = okPreviews.find((row) => String(row.storeNumber) === String(storeNumber));
        previewActiveStore = storeNumber;
        if (!preview) {
            body.innerHTML = '<p>Preview not available for this store.</p>';
            return;
        }
        root.querySelector('#admin-forecast-preview-title').textContent =
            `Forecast preview - ${preview.storeNumber}${preview.storeName ? ' ' + preview.storeName : ''}`;
        const targetDesc = describeForecastTarget({
            targetScope: preview.targetScope || previewData?.targetScope,
            weekStart: preview.weekStart,
            date: preview.targetDates?.length === 1 ? preview.targetDates[0] : undefined,
        });
        const dayCount = preview.forecastDays || preview.plan?.length || preview.targetDates?.length || 0;
        meta.textContent = `${targetDesc} (${dayCount} day${dayCount === 1 ? '' : 's'}). Trimmed weekday averages + hourly shape. Review before submitting to Macromatix${hasLifeLenzForSubmit() ? ' and LifeLenz' : ''}.`;
        const noteEl = root.querySelector('#admin-forecast-preview-lifelenz-note');
        if (noteEl) {
            noteEl.hidden = false;
            noteEl.textContent = hasLifeLenzForSubmit()
                ? 'Submit forecast writes to Macromatix first, then LifeLenz using your connected login.'
                : 'LifeLenz is not configured - submit will update Macromatix only. Use Setup LifeLenz to connect.';
        }
        if (okPreviews.length > 1) {
            tabs.hidden = false;
            tabs.innerHTML = `
                <div class="admin-settings-segmented-tabs admin-accounts-org-nav">
                    <div class="admin-accounts-scope-row-wrap">
                        <span class="admin-accounts-scope-row-label">Store</span>
                        <div class="admin-accounts-scope-row admin-accounts-scope-row--equal" role="tablist" aria-label="Select store" style="--scope-cols: ${okPreviews.length}">
                        ${okPreviews
                            .map((row) => {
                                const active = String(row.storeNumber) === String(storeNumber);
                                return `<button type="button" class="admin-accounts-scope-chip${active ? ' is-active' : ''}" data-preview-store="${escapeHtml(row.storeNumber)}" role="tab" aria-selected="${active ? 'true' : 'false'}">${escapeHtml(row.storeNumber)}</button>`;
                            })
                            .join('')}
                        </div>
                    </div>
                </div>`;
        } else {
            tabs.hidden = true;
            tabs.innerHTML = '';
        }
        renderPreviewAdjustmentsPanel(root, preview);
        const weekStart = preview.weekStart || preview.targetWeeks?.[0] || '';
        const forecastDayUpdates =
            statusPayload?.forecastUpdatesByWeek?.[weekStart]?.[storeNumber]?.days ||
            statusPayload?.forecastUpdates?.[storeNumber]?.days ||
            {};
        renderPreviewWeekGrid(body, preview.grid, {
            baseWeekTotal: preview.baseWeekTotal,
            adjustmentDelta: preview.adjustmentDelta,
            forecastDayUpdates,
            adjustments: preview.adjustments || [],
            onOverride: (target) => openOverridePopover(target, storeNumber),
        });
    }

    function focusPreviewSubmit() {
        const btn = previewBackdrop?.querySelector('#admin-forecast-preview-submit');
        btn?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        btn?.focus();
    }

    async function reloadPreviewForTarget() {
        const root = ensurePreviewBackdrop();
        const stores = pendingSubmitStores.slice();
        if (!stores.length) return;
        const targetErr = validatePreviewTarget();
        if (targetErr) {
            root.querySelector('#admin-forecast-preview-error').textContent = targetErr;
            root.querySelector('#admin-forecast-preview-body').innerHTML = '';
            return;
        }
        root.querySelector('#admin-forecast-preview-adjustments').hidden = true;
        root.querySelector('#admin-forecast-preview-error').textContent = '';
        root.querySelector('#admin-forecast-preview-body').innerHTML = '<p>Loading preview…</p>';
        const submitBtn = root.querySelector('#admin-forecast-preview-submit');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Submit forecast';
        }
        try {
            previewData = await fetchPreview(stores);
            const first = previewData.previews?.find((row) => row.ok);
            if (!first) throw new Error('No preview available.');
            if (submitBtn) submitBtn.disabled = false;
            renderPreviewStore(previewActiveStore || first.storeNumber);
        } catch (error) {
            root.querySelector('#admin-forecast-preview-error').textContent = error.message;
            root.querySelector('#admin-forecast-preview-body').innerHTML = '';
        }
    }

    async function openPreview(storeNumbers, { focusSubmit = false } = {}) {
        pendingSubmitStores = storeNumbers.slice();
        const root = ensurePreviewBackdrop();
        const mainRoot = getRoot();
        if (mainRoot) mainRoot.querySelector('#admin-forecast-error').textContent = '';
        renderPreviewTargetControls(root, statusPayload);
        root.hidden = false;
        previewData = null;
        previewActiveStore = null;
        root.querySelector('#admin-forecast-preview-error').textContent = '';
        root.querySelector('#admin-forecast-preview-body').innerHTML = '<p>Loading preview…</p>';
        root.querySelector('#admin-forecast-preview-stores').innerHTML = '';
        root.querySelector('#admin-forecast-preview-stores').hidden = true;
        root.querySelector('#admin-forecast-preview-adjustments').hidden = true;
        const submitBtn = root.querySelector('#admin-forecast-preview-submit');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submit forecast';
        const targetErr = validatePreviewTarget();
        if (targetErr) {
            root.querySelector('#admin-forecast-preview-error').textContent = targetErr;
            root.querySelector('#admin-forecast-preview-body').innerHTML = '';
            return;
        }
        try {
            await refreshLifeLenzStatus();
        } catch (error) {
            root.querySelector('#admin-forecast-preview-error').textContent = error.message;
        }
        void reloadPreviewForTarget();
        if (focusSubmit) {
            root.querySelector('#admin-forecast-preview-target-scope')?.focus();
        }
    }

    async function confirmSubmit() {
        const previewRoot = ensurePreviewBackdrop();
        const stores = pendingSubmitStores.slice();
        if (!stores.length) return;

        if (!previewData?.previews?.some((row) => row.ok)) {
            previewRoot.querySelector('#admin-forecast-preview-error').textContent =
                'Wait for the preview to finish loading before submitting.';
            return;
        }

        const targetErr = validatePreviewTarget();
        if (targetErr) {
            previewRoot.querySelector('#admin-forecast-preview-error').textContent = targetErr;
            return;
        }

        const previewSnapshot = previewData;
        const submitTarget = getPreviewTargetPayload();

        previewRoot.querySelector('#admin-forecast-preview-error').textContent = '';
        previewRoot.querySelector('#admin-forecast-preview-submit').disabled = true;
        previewRoot.querySelector('#admin-forecast-preview-cancel').disabled = true;

        closePreview();
        pendingSubmitTarget = submitTarget;
        openProgress(stores, previewSnapshot);

        try {
            const payload = await runStoresWithProgress(stores, (eventName, data) => {
                if (eventName === 'progress') handleProgressPayload(data);
                else if (eventName === 'platform-started') handlePlatformStarted(data);
                else if (eventName === 'lifelenz-started') handleLifeLenzStarted(data);
            });
            renderProgressComplete(payload);
            if (!payload?.success) {
                const root = ensureProgressBackdrop();
                root.querySelector('#admin-forecast-progress-error').textContent =
                    payload?.error || 'Forecast run failed.';
            }
        } catch (error) {
            const root = ensureProgressBackdrop();
            root.querySelector('#admin-forecast-progress-error').textContent = error.message;
            setProgressCloseEnabled(root, true, { label: 'Done' });
            if (progressState) progressState.error = error.message;
        } finally {
            previewRoot.querySelector('#admin-forecast-preview-submit').disabled = false;
            previewRoot.querySelector('#admin-forecast-preview-cancel').disabled = false;
            previewRoot.querySelector('#admin-forecast-preview-submit').textContent = 'Submit forecast';
        }
    }

    function renderHistoryGrid(root, grid) {
        const body = root.querySelector('#admin-forecast-history-body');
        const meta = root.querySelector('#admin-forecast-history-meta');
        const weekPicker = root.querySelector('#admin-forecast-history-week-start');

        root.querySelector('#admin-forecast-history-title').textContent =
            `Sales history - ${grid.storeNumber}${grid.storeName ? ' ' + grid.storeName : ''}`;

        historyWeekStart = grid.weekStart || historyWeekStart;
        if (weekPicker && historyWeekStart) {
            weekPicker.min = historyDateBounds?.oldest || '';
            weekPicker.max = historyDateBounds?.newest || '';
            weekPicker.value = historyWeekStart;
        }

        meta.textContent = `Actual sales ${formatShortDate(grid.weekStart)} – ${formatShortDate(grid.weekEnd)}.`;

        body.innerHTML =
            '<section class="admin-forecast-history-section" id="admin-forecast-history-actual" aria-label="Historical actual sales"></section>';

        const actualSection = body.querySelector('#admin-forecast-history-actual');
        actualSection.innerHTML = '<h3 class="admin-forecast-history-heading">Actual sales</h3>';
        const actualGrid = document.createElement('div');
        actualSection.appendChild(actualGrid);
        renderHistoryWeekGrid(actualGrid, grid);
    }

    async function loadHistoryGrid(storeNumber, weekStart) {
        const root = ensureHistoryBackdrop();
        const isWeekSwitch = historyStoreNumber === storeNumber && historyGridData != null;
        root.querySelector('#admin-forecast-history-error').textContent = '';
        if (!isWeekSwitch) {
            root.querySelector('#admin-forecast-history-body').innerHTML = '<p>Loading…</p>';
            closeHistoryEditForm();
        }
        try {
            const data = await fetchHistoryGrid(storeNumber, weekStart);
            historyGridData = data.grid;
            if (data.dateBounds) historyDateBounds = data.dateBounds;
            historyWeekStart = data.grid?.weekStart || weekStart || historyWeekStart;
            renderHistoryGrid(root, data.grid);
        } catch (error) {
            root.querySelector('#admin-forecast-history-error').textContent = error.message;
            root.querySelector('#admin-forecast-history-body').innerHTML = '';
        }
    }

    async function openHistory(storeNumber, { weekStart } = {}) {
        historyStoreNumber = storeNumber;
        historyWeekStart = weekStart || null;
        const root = ensureHistoryBackdrop();
        root.hidden = false;
        syncBackfillButtons();
        root.querySelector('#admin-forecast-history-error').textContent = '';
        await loadHistoryGrid(storeNumber, historyWeekStart);
    }

    let overrideForecastBackdrop = null;
    let overrideState = null;

    function round2(value) {
        return Math.round((Number(value) || 0) * 100) / 100;
    }

    function overrideActiveHours(day) {
        return [...day.baseHourly.entries()].filter(([, value]) => value != null);
    }

    // Base (unadjusted) dollar total for a day part, summed from base hourly values.
    function dayPartBaseTotal(day, partKey) {
        const hours = DAY_PART_HOURS.get(partKey) || [];
        let total = 0;
        for (const hour of hours) {
            const baseVal = day.baseHourly.get(hour);
            if (baseVal != null) total += Number(baseVal) || 0;
        }
        return round2(total);
    }

    // Copy of the hour locks, extended with day-part rules resolved to per-hour values.
    // Mirrors foldDayPartRulesIntoLocked() on the server: each ruled bucket spreads its
    // target total across its unlocked hours proportionally to base shape.
    function effectiveLockedForDay(day) {
        const locked = new Map(day.locked);
        if (!day.dayPartRules?.size) return locked;
        for (const [partKey, rule] of day.dayPartRules) {
            if (!rule?.hasRule) continue;
            const hours = DAY_PART_HOURS.get(partKey) || [];
            const inPart = hours
                .map((hour) => [hour, day.baseHourly.get(hour)])
                .filter(([, baseVal]) => baseVal != null);
            if (!inPart.length) continue;
            const unlockedInPart = inPart.filter(([hour]) => !day.locked.has(hour));
            const lockedSum = inPart.reduce(
                (sum, [hour]) => (day.locked.has(hour) ? sum + (Number(day.locked.get(hour)) || 0) : sum),
                0
            );
            const remainder = round2(rule.total - lockedSum);
            const baseUnlockedTotal = unlockedInPart.reduce((sum, [, baseVal]) => sum + (Number(baseVal) || 0), 0);
            unlockedInPart.forEach(([hour, baseVal]) => {
                let value;
                if (baseUnlockedTotal <= 0) value = remainder / unlockedInPart.length;
                else value = remainder * ((Number(baseVal) || 0) / baseUnlockedTotal);
                locked.set(hour, round2(value));
            });
            if (unlockedInPart.length) {
                const shaped = round2(unlockedInPart.reduce((sum, [hour]) => sum + (locked.get(hour) || 0), 0));
                const fix = round2(remainder - shaped);
                if (Math.abs(fix) >= 0.01) {
                    const lastHour = unlockedInPart[unlockedInPart.length - 1][0];
                    locked.set(lastHour, round2((locked.get(lastHour) || 0) + fix));
                }
            }
        }
        return locked;
    }

    // Day total when no explicit day override: base total shifted by locked hour and day-part edits.
    function overrideNaturalTotal(day) {
        const active = overrideActiveHours(day);
        const locked = effectiveLockedForDay(day);
        let total = 0;
        for (const [hour, baseVal] of active) {
            total += locked.has(hour) ? Number(locked.get(hour)) || 0 : Number(baseVal) || 0;
        }
        return round2(total);
    }

    function currentOverrideDayTotal(day) {
        return day.hasDayRule ? round2(day.total) : overrideNaturalTotal(day);
    }

    function dayHasDayPartRules(day) {
        for (const rule of day.dayPartRules?.values() || []) {
            if (rule?.hasRule) return true;
        }
        return false;
    }

    function overrideDayChanged(day) {
        return day.locked.size > 0 || day.hasDayRule || dayHasDayPartRules(day);
    }

    // Mirrors the server's reshape logic: locked hours (including day-part targets) keep
    // their value, the rest of the day total is spread across the remaining unlocked hours
    // proportionally to base shape.
    function computeOverrideDayValues(day) {
        const active = overrideActiveHours(day);
        const locked = effectiveLockedForDay(day);
        const values = new Map();
        if (!day.hasDayRule) {
            for (const [hour, baseVal] of active) {
                values.set(hour, locked.has(hour) ? round2(locked.get(hour)) : round2(baseVal));
            }
            return values;
        }
        const unlocked = active.filter(([hour]) => !locked.has(hour));
        const lockedSum = active.reduce(
            (sum, [hour]) => sum + (locked.has(hour) ? Number(locked.get(hour)) || 0 : 0),
            0
        );
        const remainder = round2(day.total - lockedSum);
        const baseUnlockedTotal = unlocked.reduce((sum, [, baseVal]) => sum + (Number(baseVal) || 0), 0);
        for (const [hour, baseVal] of active) {
            if (locked.has(hour)) {
                values.set(hour, round2(locked.get(hour)));
            } else if (baseUnlockedTotal <= 0) {
                values.set(hour, round2(remainder / unlocked.length));
            } else {
                values.set(hour, round2(remainder * ((Number(baseVal) || 0) / baseUnlockedTotal)));
            }
        }
        if (unlocked.length) {
            const shaped = round2([...values.values()].reduce((sum, v) => sum + v, 0));
            const fix = round2(day.total - shaped);
            if (Math.abs(fix) >= 0.01) {
                const lastHour = unlocked[unlocked.length - 1][0];
                values.set(lastHour, round2(values.get(lastHour) + fix));
            }
        }
        return values;
    }

    // Current resolved dollar total for a day part, summed from the computed hourly values.
    function currentDayPartTotal(day, partKey, dayValues) {
        const values = dayValues || computeOverrideDayValues(day);
        const hours = DAY_PART_HOURS.get(partKey) || [];
        let total = 0;
        for (const hour of hours) {
            if (values.has(hour)) total += Number(values.get(hour)) || 0;
        }
        return round2(total);
    }

    function buildOverrideState(preview) {
        const baseGrid = preview.baseGrid || preview.grid;
        const grid = preview.grid || baseGrid;
        const rules = preview.adjustments || [];
        const hasWeekRule = rules.some((r) => r.scope === 'week');
        const hours = (baseGrid.rows || []).map((row) => ({ hour: row.hour, label: row.label }));
        const days = (baseGrid.columns || []).map((col, idx) => {
            const baseHourly = new Map();
            for (const row of baseGrid.rows || []) baseHourly.set(row.hour, row.values[idx]);
            const baseTotal = round2(baseGrid.dayTotals?.[idx] ?? 0);
            const locked = new Map();
            for (const rule of rules) {
                if (rule.scope !== 'hour' || rule.date !== col.date) continue;
                const baseVal = Number(baseHourly.get(rule.hour)) || 0;
                locked.set(
                    rule.hour,
                    rule.mode === 'percent'
                        ? round2(baseVal * (1 + Number(rule.value) / 100))
                        : round2(baseVal + Number(rule.value))
                );
            }
            const hasDayRule = hasWeekRule || rules.some((r) => r.scope === 'day' && r.date === col.date);
            const dayPartRules = new Map();
            const day = { date: col.date, weekdayLabel: col.weekdayLabel, baseHourly, baseTotal, locked, dayPartRules, hasDayRule, total: baseTotal };
            for (const rule of rules) {
                if (rule.scope !== 'daypart' || rule.date !== col.date) continue;
                const baseTotalForPart = dayPartBaseTotal(day, rule.dayPartKey);
                const total =
                    rule.mode === 'percent'
                        ? round2(baseTotalForPart * (1 + Number(rule.value) / 100))
                        : round2(baseTotalForPart + Number(rule.value));
                dayPartRules.set(rule.dayPartKey, { hasRule: true, total });
            }
            day.total = hasDayRule ? round2(grid.dayTotals?.[idx] ?? baseTotal) : overrideNaturalTotal(day);
            return day;
        });
        return {
            storeNumber: preview.storeNumber,
            storeName: preview.storeName || '',
            weekStart: preview.weekStart || preview.targetWeeks?.[0] || '',
            hours,
            days,
            displayMode: 'dollar',
            dirty: false,
            previewPayload: null,
        };
    }

    function ensureOverrideForecastBackdrop() {
        if (overrideForecastBackdrop) return overrideForecastBackdrop;
        overrideForecastBackdrop = document.createElement('div');
        overrideForecastBackdrop.className = 'admin-modal-backdrop admin-modal-backdrop--stacked';
        overrideForecastBackdrop.hidden = true;
        overrideForecastBackdrop.innerHTML = `
            <div class="admin-modal admin-modal--wide admin-modal--history" role="dialog" aria-modal="true">
                <h2 id="admin-forecast-override-title">Override Forecast</h2>
                <div class="admin-forecast-override-toolbar">
                    <span class="admin-accounts-meta">Edit as</span>
                    <div class="admin-forecast-mode-toggle" role="group" aria-label="Edit as">
                        <button type="button" class="admin-forecast-mode-toggle-btn is-active" data-override-display-mode="dollar" aria-pressed="true">$</button>
                        <button type="button" class="admin-forecast-mode-toggle-btn" data-override-display-mode="percent" aria-pressed="false">% change</button>
                    </div>
                    <button type="button" class="mic-settings-btn" id="admin-forecast-override-reset">Reset week</button>
                    <span class="admin-forecast-override-week-total" id="admin-forecast-override-week-total"></span>
                </div>
                <div id="admin-forecast-override-body"></div>
                <p class="admin-accounts-meta" id="admin-forecast-override-lifelenz-note" hidden></p>
                <p id="admin-forecast-override-error" class="admin-modal-error" role="alert"></p>
                <div class="admin-modal-actions admin-forecast-override-actions">
                    <button type="button" class="mic-settings-btn" id="admin-forecast-override-cancel">Cancel</button>
                    <button type="button" class="mic-settings-btn" id="admin-forecast-override-save" disabled>Save overrides only</button>
                    <button type="button" class="mic-settings-btn admin-btn-primary" id="admin-forecast-override-submit" disabled>Submit forecast</button>
                </div>
            </div>`;
        document.body.appendChild(overrideForecastBackdrop);
        overrideForecastBackdrop.addEventListener('click', (event) => {
            if (event.target === overrideForecastBackdrop) closeOverrideForecast();
        });
        overrideForecastBackdrop
            .querySelector('#admin-forecast-override-cancel')
            ?.addEventListener('click', closeOverrideForecast);
        overrideForecastBackdrop.querySelector('#admin-forecast-override-save')?.addEventListener('click', () => {
            void saveOverrideForecast();
        });
        overrideForecastBackdrop.querySelector('#admin-forecast-override-submit')?.addEventListener('click', () => {
            void submitOverrideForecast();
        });
        overrideForecastBackdrop
            .querySelector('#admin-forecast-override-reset')
            ?.addEventListener('click', resetAllOverrides);
        overrideForecastBackdrop.querySelectorAll('[data-override-display-mode]').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (!overrideState) return;
                const mode = btn.getAttribute('data-override-display-mode');
                if (!mode || mode === overrideState.displayMode) return;
                overrideState.displayMode = mode;
                syncOverrideDisplayModeToggle(overrideForecastBackdrop);
                renderOverrideForecastGrid();
            });
        });
        return overrideForecastBackdrop;
    }

    function syncOverrideDisplayModeToggle(root) {
        const mode = overrideState?.displayMode || 'dollar';
        root.querySelectorAll('[data-override-display-mode]').forEach((btn) => {
            const active = btn.getAttribute('data-override-display-mode') === mode;
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
    }

    function closeOverrideForecast() {
        if (overrideForecastBackdrop) overrideForecastBackdrop.hidden = true;
        overrideState = null;
    }

    function renderOverrideForecastGrid(focus) {
        const root = ensureOverrideForecastBackdrop();
        const body = root.querySelector('#admin-forecast-override-body');
        const st = overrideState;
        if (!st?.days?.length) {
            body.innerHTML = '<p>No forecast data for this timeframe.</p>';
            return;
        }
        const isPct = st.displayMode === 'percent';
        const perDayValues = st.days.map((day) => computeOverrideDayValues(day));
        const perDayTotals = st.days.map((day) => currentOverrideDayTotal(day));
        const weekTotal = round2(perDayTotals.reduce((sum, v) => sum + v, 0));

        const head = st.days
            .map(
                (day) => `<th><span class="admin-history-col-label">${escapeHtml(day.weekdayLabel || '')}</span><span class="admin-accounts-meta">${escapeHtml(formatShortDate(day.date))}</span></th>`
            )
            .join('');
        const rows = st.hours
            .map((hourCol) => {
                const cells = st.days
                    .map((day, dayIdx) => {
                        const baseVal = day.baseHourly.get(hourCol.hour);
                        if (baseVal == null) return '<td class="admin-history-num">-</td>';
                        const value = perDayValues[dayIdx].get(hourCol.hour) || 0;
                        const base = Number(baseVal) || 0;
                        // % mode shows the change vs the base forecast for that hour.
                        const display = isPct ? (base > 0 ? round2((value / base - 1) * 100) : 0) : round2(value);
                        const changedCls = day.locked.has(hourCol.hour)
                            ? ' admin-forecast-override-input--changed'
                            : '';
                        const hint = isPct
                            ? `<span class="admin-forecast-override-dollar-hint">${formatMoney(value)}</span>`
                            : '';
                        return `<td class="admin-history-num admin-forecast-override-cell">
                            <span class="admin-forecast-override-input-wrap">
                                <input type="number" min="${isPct ? '-100' : '0'}" step="0.01" class="admin-forecast-override-input${changedCls}"
                                    data-ov-day="${dayIdx}" data-ov-hour="${hourCol.hour}" value="${display}"
                                    aria-label="${escapeHtml(`${day.weekdayLabel || day.date} ${hourCol.label}`)}" />
                                <span class="admin-forecast-override-unit">${isPct ? '%' : '$'}</span>
                            </span>${hint}
                        </td>`;
                    })
                    .join('');
                return `<tr><th scope="row" class="admin-history-hour">${escapeHtml(hourCol.label)}</th>${cells}</tr>`;
            })
            .join('');
        const totalCells = st.days
            .map((day, dayIdx) => {
                const changedCls = day.hasDayRule ? ' admin-forecast-override-input--changed' : '';
                const total = perDayTotals[dayIdx];
                const display = isPct
                    ? day.baseTotal > 0
                        ? round2((total / day.baseTotal - 1) * 100)
                        : 0
                    : round2(total);
                const hint = isPct
                    ? `<span class="admin-forecast-override-dollar-hint">${formatMoney(total)}</span>`
                    : '';
                return `<td class="admin-history-num admin-history-total admin-forecast-override-cell">
                    <span class="admin-forecast-override-input-wrap">
                        <input type="number" min="${isPct ? '-100' : '0'}" step="0.01" class="admin-forecast-override-input${changedCls}"
                            data-ov-total="${dayIdx}" value="${display}"
                            aria-label="${escapeHtml(`${day.weekdayLabel || day.date} day total`)}" />
                        <span class="admin-forecast-override-unit">${isPct ? '%' : '$'}</span>
                    </span>${hint}
                </td>`;
            })
            .join('');
        const resetCells = st.days
            .map((day, dayIdx) => {
                const disabled = overrideDayChanged(day) ? '' : ' disabled';
                return `<td class="admin-history-num"><button type="button" class="admin-forecast-history-col-edit admin-forecast-override-reset-day" data-ov-reset-day="${dayIdx}"${disabled}>Reset day</button></td>`;
            })
            .join('');
        const dayPartRows = LIFELENZ_DAY_PARTS
            .map((part) => {
                const cells = st.days
                    .map((day, dayIdx) => {
                        const hasHours = (DAY_PART_HOURS.get(part.key) || []).some(
                            (hour) => day.baseHourly.get(hour) != null
                        );
                        if (!hasHours) return '<td class="admin-history-num">-</td>';
                        const baseTotal = dayPartBaseTotal(day, part.key);
                        const total = currentDayPartTotal(day, part.key, perDayValues[dayIdx]);
                        const changedCls = day.dayPartRules.get(part.key)?.hasRule
                            ? ' admin-forecast-override-input--changed'
                            : '';
                        const display = isPct
                            ? baseTotal > 0
                                ? round2((total / baseTotal - 1) * 100)
                                : 0
                            : Math.round(total);
                        const hint = isPct
                            ? `<span class="admin-forecast-override-dollar-hint">${formatMoney(total)}</span>`
                            : '';
                        return `<td class="admin-history-num admin-forecast-override-cell">
                            <span class="admin-forecast-override-input-wrap">
                                <input type="number" min="${isPct ? '-100' : '0'}" step="${isPct ? '0.01' : '1'}" class="admin-forecast-override-input${changedCls}"
                                    data-ov-daypart="${part.key}" data-ov-day="${dayIdx}" value="${display}"
                                    aria-label="${escapeHtml(`${day.weekdayLabel || day.date} ${part.label}`)}" />
                                <span class="admin-forecast-override-unit">${isPct ? '%' : '$'}</span>
                            </span>${hint}
                        </td>`;
                    })
                    .join('');
                return `<tr><th scope="row" class="admin-history-hour">${escapeHtml(part.label)}</th>${cells}</tr>`;
            })
            .join('');
        body.innerHTML = `
            <div class="admin-history-grid-wrap admin-forecast-preview-grid-wrap">
                <table class="admin-table admin-history-grid admin-forecast-override-grid">
                    <thead><tr><th scope="col">Hour</th>${head}</tr></thead>
                    <tbody>${rows}</tbody>
                    <tfoot>
                        <tr><th scope="row">Day total</th>${totalCells}</tr>
                        <tr><th scope="row">Reset</th>${resetCells}</tr>
                    </tfoot>
                </table>
            </div>
            <div class="admin-forecast-override-dayparts">
                <h3 class="admin-forecast-history-heading">LifeLenz day parts</h3>
                <p class="admin-accounts-meta">Editing a day part reshapes its hours above; these totals are what LifeLenz receives on submit.</p>
                <div class="admin-history-grid-wrap admin-forecast-preview-grid-wrap">
                    <table class="admin-table admin-history-grid admin-forecast-override-grid">
                        <thead><tr><th scope="col">Day part</th>${head}</tr></thead>
                        <tbody>${dayPartRows}</tbody>
                    </table>
                </div>
            </div>`;
        const weekTotalEl = root.querySelector('#admin-forecast-override-week-total');
        if (weekTotalEl) {
            weekTotalEl.innerHTML = `<span class="admin-forecast-week-total-label">Total</span> <span class="admin-forecast-week-total-value">${formatMoney(weekTotal)}</span>`;
        }
        body.querySelectorAll('input[data-ov-hour]').forEach((input) => {
            input.addEventListener('change', () => {
                onOverrideHourChange(
                    Number(input.getAttribute('data-ov-day')),
                    Number(input.getAttribute('data-ov-hour')),
                    input.value
                );
            });
        });
        body.querySelectorAll('input[data-ov-total]').forEach((input) => {
            input.addEventListener('change', () => {
                onOverrideDayTotalChange(Number(input.getAttribute('data-ov-total')), input.value);
            });
        });
        body.querySelectorAll('input[data-ov-daypart]').forEach((input) => {
            input.addEventListener('change', () => {
                onOverrideDayPartChange(
                    Number(input.getAttribute('data-ov-day')),
                    input.getAttribute('data-ov-daypart'),
                    input.value
                );
            });
        });
        body.querySelectorAll('[data-ov-reset-day]').forEach((btn) => {
            btn.addEventListener('click', () => resetOverrideDay(Number(btn.getAttribute('data-ov-reset-day'))));
        });
        if (focus) {
            let selector;
            if (focus.type === 'total') selector = `input[data-ov-total="${focus.dayIdx}"]`;
            else if (focus.type === 'daypart')
                selector = `input[data-ov-daypart="${focus.partKey}"][data-ov-day="${focus.dayIdx}"]`;
            else selector = `input[data-ov-day="${focus.dayIdx}"][data-ov-hour="${focus.hour}"]`;
            body.querySelector(selector)?.focus();
        }
    }

    function onOverrideHourChange(dayIdx, hour, rawValue) {
        const day = overrideState?.days?.[dayIdx];
        if (!day || day.baseHourly.get(hour) == null) return;
        const prevValue = computeOverrideDayValues(day).get(hour) || 0;
        let newValue;
        if (overrideState.displayMode === 'percent') {
            // % scales the hour's base $ value; the day total moves by the same delta.
            const pct = Math.max(-100, Number(rawValue) || 0);
            const base = Number(day.baseHourly.get(hour)) || 0;
            newValue = round2(base * (1 + pct / 100));
        } else {
            newValue = round2(Math.max(0, Number(rawValue) || 0));
        }
        day.locked.set(hour, newValue);
        if (day.hasDayRule) {
            // Bump the day total by the hour's change so other hours stay put.
            day.total = Math.max(0, round2(day.total + newValue - prevValue));
        } else {
            day.total = overrideNaturalTotal(day);
        }
        overrideState.dirty = true;
        renderOverrideForecastGrid({ type: 'hour', dayIdx, hour });
    }

    function onOverrideDayTotalChange(dayIdx, rawValue) {
        const day = overrideState?.days?.[dayIdx];
        if (!day) return;
        if (overrideState.displayMode === 'percent') {
            const pct = Math.max(-100, Number(rawValue) || 0);
            day.total = Math.max(0, round2(day.baseTotal * (1 + pct / 100)));
        } else {
            day.total = Math.max(0, round2(Number(rawValue) || 0));
        }
        day.hasDayRule = true;
        overrideState.dirty = true;
        renderOverrideForecastGrid({ type: 'total', dayIdx });
    }

    function onOverrideDayPartChange(dayIdx, partKey, rawValue) {
        const day = overrideState?.days?.[dayIdx];
        if (!day || !DAY_PART_HOURS.has(partKey)) return;
        const baseTotal = dayPartBaseTotal(day, partKey);
        let total;
        if (overrideState.displayMode === 'percent') {
            const pct = Math.max(-100, Number(rawValue) || 0);
            total = Math.max(0, round2(baseTotal * (1 + pct / 100)));
        } else {
            total = Math.max(0, round2(Number(rawValue) || 0));
        }
        // Treat an edit back to the base bucket total as clearing the day-part rule.
        if (Math.round(total) === Math.round(baseTotal)) {
            day.dayPartRules.delete(partKey);
        } else {
            day.dayPartRules.set(partKey, { hasRule: true, total });
        }
        if (!day.hasDayRule) day.total = overrideNaturalTotal(day);
        overrideState.dirty = true;
        renderOverrideForecastGrid({ type: 'daypart', dayIdx, partKey });
    }

    function resetOverrideDay(dayIdx) {
        const day = overrideState?.days?.[dayIdx];
        if (!day) return;
        day.locked.clear();
        day.dayPartRules.clear();
        day.hasDayRule = false;
        day.total = day.baseTotal;
        overrideState.dirty = true;
        renderOverrideForecastGrid();
    }

    function resetAllOverrides() {
        if (!overrideState) return;
        for (const day of overrideState.days) {
            day.locked.clear();
            day.dayPartRules.clear();
            day.hasDayRule = false;
            day.total = day.baseTotal;
        }
        overrideState.dirty = true;
        renderOverrideForecastGrid();
    }

    // Whether an hour belongs to a day part that currently has an active rule.
    function hourInRuledDayPart(day, hour) {
        for (const [partKey, rule] of day.dayPartRules || []) {
            if (rule?.hasRule && (DAY_PART_HOURS.get(partKey) || []).includes(hour)) return true;
        }
        return false;
    }

    function buildOverrideRules() {
        const rules = [];
        for (const day of overrideState?.days || []) {
            const naturalTotal = overrideNaturalTotal(day);
            const wantsDayRule = day.hasDayRule && Math.abs(day.total - naturalTotal) >= 0.01;
            for (const [hour, value] of day.locked) {
                const base = Number(day.baseHourly.get(hour)) || 0;
                const delta = round2(value - base);
                // Zero-delta locks only matter when a day or day-part rule reshapes around them.
                if (!wantsDayRule && !hourInRuledDayPart(day, hour) && Math.abs(delta) < 0.01) continue;
                rules.push({ scope: 'hour', date: day.date, hour, mode: 'dollar', value: delta });
            }
            for (const [partKey, rule] of day.dayPartRules || []) {
                if (!rule?.hasRule) continue;
                const delta = round2(rule.total - dayPartBaseTotal(day, partKey));
                if (Math.abs(delta) < 0.01) continue;
                rules.push({ scope: 'daypart', date: day.date, dayPartKey: partKey, mode: 'dollar', value: delta });
            }
            if (wantsDayRule) {
                rules.push({ scope: 'day', date: day.date, mode: 'dollar', value: round2(day.total - day.baseTotal) });
            }
        }
        return rules;
    }

    async function putOverrideRules(st) {
        const res = await fetch('/api/admin/forecast/adjustments', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ store: st.storeNumber, weekStart: st.weekStart, rules: buildOverrideRules() }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not save forecast overrides.');
        st.dirty = false;
        return data;
    }

    function setOverrideButtonsBusy(root, busy) {
        ['#admin-forecast-override-save', '#admin-forecast-override-submit', '#admin-forecast-override-cancel', '#admin-forecast-override-reset'].forEach(
            (id) => {
                const btn = root.querySelector(id);
                if (btn) btn.disabled = busy;
            }
        );
    }

    async function saveOverrideForecast() {
        const root = ensureOverrideForecastBackdrop();
        const st = overrideState;
        if (!st) return;
        const errEl = root.querySelector('#admin-forecast-override-error');
        errEl.textContent = '';
        const saveBtn = root.querySelector('#admin-forecast-override-save');
        setOverrideButtonsBusy(root, true);
        saveBtn.textContent = 'Saving…';
        try {
            await putOverrideRules(st);
            closeOverrideForecast();
            if (getRoot()) {
                statusPayload = await fetchStatus();
                renderTable(getRoot(), statusPayload);
            }
        } catch (error) {
            errEl.textContent = error.message;
        } finally {
            setOverrideButtonsBusy(root, false);
            saveBtn.textContent = 'Save overrides only';
        }
    }

    async function submitOverrideForecast() {
        const root = ensureOverrideForecastBackdrop();
        const st = overrideState;
        if (!st) return;
        const errEl = root.querySelector('#admin-forecast-override-error');
        errEl.textContent = '';
        const submitBtn = root.querySelector('#admin-forecast-override-submit');
        setOverrideButtonsBusy(root, true);
        submitBtn.textContent = 'Submitting…';

        const stores = [st.storeNumber];
        let previewSnapshot = st.previewPayload;
        try {
            if (st.dirty) {
                await putOverrideRules(st);
                // Refresh the plan so the progress view reflects the edited numbers.
                previewSnapshot = await fetchPreview(stores);
            }
        } catch (error) {
            errEl.textContent = error.message;
            setOverrideButtonsBusy(root, false);
            submitBtn.textContent = 'Submit forecast';
            return;
        }

        pendingSubmitTarget = getForecastTargetPayload();
        closeOverrideForecast();
        setOverrideButtonsBusy(root, false);
        submitBtn.textContent = 'Submit forecast';
        openProgress(stores, previewSnapshot);

        try {
            const payload = await runStoresWithProgress(stores, (eventName, data) => {
                if (eventName === 'progress') handleProgressPayload(data);
                else if (eventName === 'platform-started') handlePlatformStarted(data);
                else if (eventName === 'lifelenz-started') handleLifeLenzStarted(data);
            });
            renderProgressComplete(payload);
            if (!payload?.success) {
                const progressRoot = ensureProgressBackdrop();
                progressRoot.querySelector('#admin-forecast-progress-error').textContent =
                    payload?.error || 'Forecast run failed.';
            }
        } catch (error) {
            const progressRoot = ensureProgressBackdrop();
            progressRoot.querySelector('#admin-forecast-progress-error').textContent = error.message;
            setProgressCloseEnabled(progressRoot, true, { label: 'Done' });
            if (progressState) progressState.error = error.message;
        }
    }

    async function openOverrideForecast(storeNumber) {
        const root = ensureOverrideForecastBackdrop();
        overrideState = null;
        root.hidden = false;
        root.querySelector('#admin-forecast-override-title').textContent = `Override Forecast - ${storeNumber}`;
        root.querySelector('#admin-forecast-override-error').textContent = '';
        root.querySelector('#admin-forecast-override-body').innerHTML = '<p>Loading forecast…</p>';
        root.querySelector('#admin-forecast-override-week-total').innerHTML = '';
        const saveBtn = root.querySelector('#admin-forecast-override-save');
        const submitBtn = root.querySelector('#admin-forecast-override-submit');
        saveBtn.disabled = true;
        submitBtn.disabled = true;
        syncOverrideDisplayModeToggle(root);
        const noteEl = root.querySelector('#admin-forecast-override-lifelenz-note');
        if (noteEl) noteEl.hidden = true;
        const targetErr = validateForecastTarget();
        if (targetErr) {
            root.querySelector('#admin-forecast-override-error').textContent = targetErr;
            root.querySelector('#admin-forecast-override-body').innerHTML = '';
            return;
        }
        try {
            const data = await fetchPreview([storeNumber]);
            const preview = (data.previews || []).find((row) => String(row.storeNumber) === String(storeNumber));
            if (!preview?.ok) throw new Error(preview?.error || 'Could not load forecast preview.');
            overrideState = buildOverrideState(preview);
            overrideState.previewPayload = data;
            root.querySelector('#admin-forecast-override-title').textContent =
                `Override Forecast - ${preview.storeNumber}${preview.storeName ? ' ' + preview.storeName : ''}`;
            if (noteEl) {
                noteEl.hidden = false;
                noteEl.textContent = hasLifeLenzForSubmit()
                    ? 'Submit forecast writes to Macromatix first, then LifeLenz using your connected login.'
                    : 'LifeLenz is not configured - submit will update Macromatix only. Use Setup LifeLenz to connect.';
            }
            saveBtn.disabled = false;
            submitBtn.disabled = false;
            syncOverrideDisplayModeToggle(root);
            renderOverrideForecastGrid();
        } catch (error) {
            root.querySelector('#admin-forecast-override-error').textContent = error.message;
            root.querySelector('#admin-forecast-override-body').innerHTML = '';
        }
    }

    function syncBackfillButtons() {
        const show = Boolean(canManageBackfill);
        ensureHistoryBackdrop()
            .querySelector('#admin-forecast-history-backfill')
            ?.toggleAttribute('hidden', !show);
    }

    function ensureBackfillProgressModal() {
        if (backfillProgressBackdrop) return backfillProgressBackdrop;
        backfillProgressBackdrop = document.createElement('div');
        backfillProgressBackdrop.className =
            'admin-modal-backdrop admin-modal-backdrop--stacked admin-report-sub-progress-backdrop';
        backfillProgressBackdrop.hidden = true;
        backfillProgressBackdrop.innerHTML = `
            <div class="admin-modal admin-modal--wide admin-report-sub-progress-modal" role="dialog" aria-modal="true" aria-labelledby="admin-forecast-backfill-progress-title">
                <h2 id="admin-forecast-backfill-progress-title">Backfilling forecast history</h2>
                <p class="admin-report-sub-progress-status" id="admin-forecast-backfill-progress-status">Starting…</p>
                <div class="admin-report-sub-progress-log-wrap">
                    <ol class="admin-report-sub-progress-log" id="admin-forecast-backfill-progress-log" role="log" aria-live="polite"></ol>
                </div>
                <div class="admin-report-sub-form-actions">
                    <button type="button" id="admin-forecast-backfill-progress-close" disabled>Close</button>
                </div>
            </div>`;
        document.body.appendChild(backfillProgressBackdrop);
        backfillProgressBackdrop.querySelector('#admin-forecast-backfill-progress-close')?.addEventListener('click', () => {
            if (!backfillProgressRunning) closeBackfillProgressModal();
        });
        backfillProgressBackdrop.addEventListener('click', (event) => {
            if (event.target === backfillProgressBackdrop && !backfillProgressRunning) closeBackfillProgressModal();
        });
        return backfillProgressBackdrop;
    }

    const BACKFILL_PROGRESS_TIME_FORMAT = { hour: 'numeric', minute: '2-digit' };
    const BACKFILL_PROGRESS_LOG_SKIP_TYPES = new Set(['day-saved', 'day-read', 'day-batch-start', 'keepalive']);

    function shouldShowBackfillProgressEvent(event) {
        return !BACKFILL_PROGRESS_LOG_SKIP_TYPES.has(String(event?.type || '').trim());
    }

    function formatBackfillProgressTime(event) {
        const ts = event?.ts ? new Date(event.ts) : new Date();
        return ts.toLocaleTimeString(undefined, BACKFILL_PROGRESS_TIME_FORMAT);
    }

    function backfillProgressLogClass(type, success) {
        const key = String(type || '').trim();
        if (key === 'complete') return success ? 'admin-report-sub-progress-line--ok' : 'admin-report-sub-progress-line--error';
        if (key === 'day-saved' || key === 'store-done' || key === 'scope-done') {
            return 'admin-report-sub-progress-line--ok';
        }
        if (key === 'day-skipped' || key === 'warn') return 'admin-report-sub-progress-line--warn';
        return '';
    }

    function appendBackfillProgressLine(logEl, event) {
        if (!logEl || !event || !shouldShowBackfillProgressEvent(event)) return;
        const li = document.createElement('li');
        const type = String(event.type || 'info');
        const ok = type === 'complete' ? event.success !== false : true;
        li.className = ['admin-report-sub-progress-line', backfillProgressLogClass(type, ok)].filter(Boolean).join(' ');
        const time = formatBackfillProgressTime(event);
        const msg = event.message || event.error || JSON.stringify(event);
        li.textContent = `[${time}] ${msg}`;
        logEl.appendChild(li);
        logEl.parentElement?.scrollTo({ top: logEl.parentElement.scrollHeight, behavior: 'smooth' });
    }

    function openBackfillProgressModal(statusText) {
        const modal = ensureBackfillProgressModal();
        modal.querySelector('#admin-forecast-backfill-progress-status').textContent = statusText || 'Starting…';
        const logEl = modal.querySelector('#admin-forecast-backfill-progress-log');
        if (logEl) logEl.innerHTML = '';
        modal.querySelector('#admin-forecast-backfill-progress-close').disabled = true;
        modal.hidden = false;
        backfillProgressRunning = true;
    }

    function finishBackfillProgressModal(statusText, success) {
        backfillProgressRunning = false;
        const modal = backfillProgressBackdrop;
        if (!modal) return;
        const statusEl = modal.querySelector('#admin-forecast-backfill-progress-status');
        if (statusEl) {
            statusEl.textContent = statusText || (success ? 'Done.' : 'Failed.');
            statusEl.classList.toggle('admin-modal-error', !success);
            statusEl.classList.toggle('admin-report-sub-progress-status--ok', success);
        }
        modal.querySelector('#admin-forecast-backfill-progress-close').disabled = false;
    }

    function closeBackfillProgressModal() {
        if (backfillProgressRunning) return;
        if (backfillProgressBackdrop) {
            backfillProgressBackdrop.hidden = true;
            const statusEl = backfillProgressBackdrop.querySelector('#admin-forecast-backfill-progress-status');
            statusEl?.classList.remove('admin-modal-error', 'admin-report-sub-progress-status--ok');
        }
    }

    async function consumeForecastBackfillStream(response, onEvent) {
        if (!response.body) {
            const data = await response.json().catch(() => ({}));
            if (data.error) throw new Error(data.error);
            return data;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finalResult = null;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                let event;
                try {
                    event = JSON.parse(trimmed);
                } catch {
                    continue;
                }
                onEvent?.(event);
                if (event.type === 'complete') finalResult = event;
            }
        }
        const tail = buffer.trim();
        if (tail) {
            try {
                const event = JSON.parse(tail);
                onEvent?.(event);
                if (event.type === 'complete') finalResult = event;
            } catch {
                /* ignore */
            }
        }
        return finalResult;
    }

    async function runForecastBackfill(storeNumbers, { refreshHistory = false } = {}) {
        const stores = [...new Set((storeNumbers || []).map((s) => String(s || '').trim()).filter(Boolean))];
        if (!stores.length) return;
        const root = getRoot();
        root?.querySelector('#admin-forecast-error')?.replaceChildren();

        const modal = ensureBackfillProgressModal();
        const logEl = modal.querySelector('#admin-forecast-backfill-progress-log');
        openBackfillProgressModal(`Backfilling ${stores.length} store(s) from MMX…`);

        const disableSelectors = ['#admin-forecast-submit-all', '#admin-forecast-history-backfill'];
        for (const sel of disableSelectors) {
            const btn = root?.querySelector(sel) || ensureHistoryBackdrop().querySelector(sel);
            if (btn) btn.disabled = true;
        }

        try {
            const res = await fetch('/api/admin/forecast/backfill-stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ storeNumbers: stores }),
            });
            if (!res.ok && !res.body) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || `Request failed (${res.status}).`);
            }

            const finalEvent = await consumeForecastBackfillStream(res, (event) => {
                if (event.type === 'complete') return;
                appendBackfillProgressLine(logEl, event);
                if (event.message) {
                    modal.querySelector('#admin-forecast-backfill-progress-status').textContent = event.message;
                }
            });

            if (!finalEvent) throw new Error('No response from server.');
            appendBackfillProgressLine(logEl, {
                type: 'complete',
                success: finalEvent.success,
                ts: new Date().toISOString(),
                message: finalEvent.success
                    ? finalEvent.result?.message || 'Backfill complete.'
                    : finalEvent.error || 'Failed.',
            });

            if (!finalEvent.success) throw new Error(finalEvent.error || 'Backfill failed.');

            const result = finalEvent.result || {};
            finishBackfillProgressModal(
                result.forecastReady
                    ? 'Backfill complete. Forecast history ready.'
                    : result.message || 'Backfill finished. See log for details.',
                Boolean(result.forecastReady || result.ready)
            );

            if (root) {
                await refresh(root);
                if (refreshHistory && historyStoreNumber && stores.includes(historyStoreNumber)) {
                    await loadHistoryGrid(historyStoreNumber, historyWeekStart);
                }
            }
        } catch (error) {
            finishBackfillProgressModal(error.message || 'Backfill failed.', false);
            root?.querySelector('#admin-forecast-error') &&
                (root.querySelector('#admin-forecast-error').textContent = error.message || 'Backfill failed.');
        } finally {
            for (const sel of disableSelectors) {
                const btn = root?.querySelector(sel) || ensureHistoryBackdrop().querySelector(sel);
                if (btn) btn.disabled = false;
            }
        }
    }

    function renderTable(root, payload) {
        const body = root.querySelector('#admin-forecast-body');
        const weeks = payload.targetWeeks || [];
        const history = payload.history?.stores || {};
        const stores = storesInActiveArea(
            Object.keys(payload.stores || {}).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        );
        if (!stores.length) {
            body.innerHTML = `<p>No stores in ${escapeHtml(activeArea || 'this area')}.</p>`;
            return;
        }
        const updatesByWeek = payload.updatesSummaryByWeek || {};
        const head = weeks
            .map((w, idx) => {
                const label = FORECAST_WEEK_LABELS[idx] || w;
                return `<th><span class="admin-history-col-label">${escapeHtml(label)}</span><span class="admin-accounts-meta">${escapeHtml(formatShortDate(w))}</span></th>`;
            })
            .join('');
        const rows = stores
            .map((storeNumber) => {
                const hist = history[storeNumber] || {};
                const captureNote = hist.newestFinalizedDate
                    ? ` · last ${formatShortDate(hist.newestFinalizedDate)}`
                    : hist.yesterdayCaptured === false
                      ? ' · yesterday missing'
                      : '';
                const histLabel = hist.ready
                    ? `History ${hist.daysRecorded}/${hist.daysRequired}d${captureNote}`
                    : `History ${hist.daysRecorded}/${hist.daysRequired}d${captureNote} - need ${escapeHtml((hist.weekdayGaps || []).join(', ') || 'more days')}`;
                const runDisabled = hist.ready ? '' : ' disabled title="Open History and use Backfill data"';
                const weekCells = weeks
                    .map((weekStart) => {
                        const row = payload.stores[storeNumber]?.[weekStart] || {};
                        const upd = updatesByWeek[weekStart]?.[storeNumber];
                        const updNote = upd?.lastUpdatedAt
                            ? `<span class="admin-accounts-meta">${upd.daysUpdated || 0}/7 · ${upd.lastSource === 'auto' ? 'Auto' : 'User'} ${escapeHtml(formatShortDateTime(upd.lastUpdatedAt))}</span>`
                            : '';
                        if (row.completed) {
                            return `<td>${dot(true)} Done${updNote}</td>`;
                        }
                        if (row.mmxCompleted && !row.lifelenzCompleted) {
                            return `<td>${dot(false, true)} MMX only</td>`;
                        }
                        if (row.lifelenzCompleted && !row.mmxCompleted) {
                            return `<td>${dot(false, true)} LifeLenz only</td>`;
                        }
                        return `<td>${dot(false)} Pending</td>`;
                    })
                    .join('');
                return `<tr>
                    <td>${escapeHtml(storeNumber)}<span class="admin-accounts-meta">${histLabel}</span></td>
                    <td>${dot(hist.ready, !hist.ready && hist.daysRecorded > 0)} ${hist.ready ? 'Ready' : 'Not ready'}</td>
                    ${weekCells}
                    <td class="admin-forecast-actions">
                        <button type="button" class="mic-settings-btn" data-history-store="${escapeHtml(storeNumber)}">History</button>
                        <button type="button" class="mic-settings-btn admin-btn-primary" data-submit-store="${escapeHtml(storeNumber)}"${runDisabled}>Submit</button>
                    </td>
                </tr>`;
            })
            .join('');
        body.innerHTML = `
            <p class="admin-accounts-meta">Daily forecast auto-submit is configured under Admin → Daily reports.</p>
            <table class="admin-table">
                <thead>
                    <tr><th>Store</th><th>History</th>${head}<th></th></tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>`;
        body.querySelectorAll('[data-submit-store]').forEach((btn) => {
            btn.addEventListener('click', () => {
                void openOverrideForecast(btn.getAttribute('data-submit-store'));
            });
        });
        body.querySelectorAll('[data-history-store]').forEach((btn) => {
            btn.addEventListener('click', () => {
                void openHistory(btn.getAttribute('data-history-store'));
            });
        });
    }

    let manualGuideBackdrop = null;

    function ensureManualGuideBackdrop() {
        if (manualGuideBackdrop) return manualGuideBackdrop;
        manualGuideBackdrop = document.createElement('div');
        manualGuideBackdrop.className = 'admin-modal-backdrop admin-modal-backdrop--stacked';
        manualGuideBackdrop.hidden = true;
        manualGuideBackdrop.innerHTML = `
            <div class="admin-modal admin-modal--wide admin-modal--forecast-manual" role="dialog" aria-modal="true">
                <h2 id="admin-forecast-manual-title">Manual entry guide</h2>
                <p class="admin-accounts-meta" id="admin-forecast-manual-meta"></p>
                <div class="admin-forecast-manual-actions">
                    <button type="button" class="mic-settings-btn" id="admin-forecast-manual-copy">Copy all values</button>
                </div>
                <div id="admin-forecast-manual-body"></div>
                <p id="admin-forecast-manual-error" class="admin-modal-error" role="alert"></p>
                <div class="admin-modal-actions">
                    <button type="button" class="mic-settings-btn admin-btn-primary" id="admin-forecast-manual-close">Close</button>
                </div>
            </div>`;
        document.body.appendChild(manualGuideBackdrop);
        manualGuideBackdrop.addEventListener('click', (event) => {
            if (event.target === manualGuideBackdrop) manualGuideBackdrop.hidden = true;
        });
        manualGuideBackdrop.querySelector('#admin-forecast-manual-close')?.addEventListener('click', () => {
            manualGuideBackdrop.hidden = true;
        });
        return manualGuideBackdrop;
    }

    function renderManualDayPartsTable(days) {
        const partLabels = [
            'OVERNIGHT',
            'BREAKFAST',
            'MORNING',
            'LUNCH',
            'AFTERNOON',
            'DINNER',
            'AFTER DINNER',
            'LATE NIGHT',
            'OVERNIGHT',
        ];
        const header = `<tr><th>Day part</th>${(days || []).map((d) => `<th>${escapeHtml(formatShortDate(d.date))}</th>`).join('')}</tr>`;
        const body = partLabels
            .map((label, idx) => {
                const cells = (days || []).map((day) => {
                    const part = (day.dayParts || [])[idx];
                    return `<td>${part?.adjusted ?? 0}</td>`;
                });
                return `<tr><th>${escapeHtml(label)}</th>${cells.join('')}</tr>`;
            })
            .join('');
        return `<table class="admin-table admin-forecast-manual-dayparts"><thead>${header}</thead><tbody>${body}</tbody></table>`;
    }

    async function openManualEntryGuide(storeNumber, weekStart) {
        const root = ensureManualGuideBackdrop();
        root.hidden = false;
        root.querySelector('#admin-forecast-manual-error').textContent = '';
        root.querySelector('#admin-forecast-manual-body').innerHTML = '<p>Loading…</p>';
        root.querySelector('#admin-forecast-manual-title').textContent = `Manual entry guide - ${storeNumber}`;
        try {
            const qs = weekStart ? `?weekStart=${encodeURIComponent(weekStart)}` : '';
            const res = await fetch(`/api/admin/forecast/manual/${encodeURIComponent(storeNumber)}${qs}`, {
                credentials: 'same-origin',
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                throw new Error(data.error || `Could not load manual pack (${res.status}).`);
            }
            const pack = data.pack;
            root.querySelector('#admin-forecast-manual-meta').textContent =
                `Week total ~$${Math.round(pack.weekTotal || 0)} · generated ${String(pack.generatedAt || '').slice(0, 19).replace('T', ' ')}`;
            const bodyEl = root.querySelector('#admin-forecast-manual-body');
            bodyEl.innerHTML = '';
            const mmxHeading = document.createElement('h3');
            mmxHeading.textContent = 'Macromatix hourly';
            bodyEl.appendChild(mmxHeading);
            const mmxGrid = document.createElement('div');
            bodyEl.appendChild(mmxGrid);
            renderForecastGrid(mmxGrid, buildForecastPreviewGridFromPlan(pack.days), { mode: 'preview' });
            const llHeading = document.createElement('h3');
            llHeading.textContent = 'LifeLenz day parts (adjusted)';
            bodyEl.appendChild(llHeading);
            const llWrap = document.createElement('div');
            llWrap.innerHTML = renderManualDayPartsTable(pack.days);
            bodyEl.appendChild(llWrap);
            const copyBtn = root.querySelector('#admin-forecast-manual-copy');
            copyBtn.onclick = () => {
                void navigator.clipboard.writeText(data.plainText || '').then(() => {
                    copyBtn.textContent = 'Copied!';
                    setTimeout(() => {
                        copyBtn.textContent = 'Copy all values';
                    }, 2000);
                });
            };
        } catch (error) {
            root.querySelector('#admin-forecast-manual-error').textContent = error.message;
            root.querySelector('#admin-forecast-manual-body').innerHTML = '';
        }
    }

    function buildForecastPreviewGridFromPlan(days) {
        const hours = [];
        const hourSeen = new Set();
        for (const day of days || []) {
            for (const slot of day.hourly || []) {
                if (!hourSeen.has(slot.hour)) {
                    hourSeen.add(slot.hour);
                    hours.push(slot.hour);
                }
            }
        }
        hours.sort((a, b) => a - b);
        return {
            columns: (days || []).map((day) => ({
                date: day.date,
                weekday: day.weekday,
                weekdayLabel: weekdayLabel(day.weekday),
                forecastTotal: day.forecastTotal,
            })),
            rows: hours.map((hour) => ({
                hour,
                label: formatHourLabel(hour),
                values: (days || []).map((day) => {
                    const slot = (day.hourly || []).find((h) => h.hour === hour);
                    return slot != null ? slot.forecast : null;
                }),
            })),
            dayTotals: (days || []).map((d) => d.forecastTotal),
            weekTotal: Math.round((days || []).reduce((sum, d) => sum + (Number(d.forecastTotal) || 0), 0) * 100) / 100,
        };
    }

    async function refresh(root) {
        await fetchStores();
        statusPayload = await fetchStatus();
        canManageBackfill = Boolean(statusPayload?.canManageBackfill);
        await refreshLifeLenzStatus(root);
        const allStores = Object.keys(statusPayload.stores || {});
        if (!activeArea || !ADMIN_AREAS.includes(activeArea)) {
            activeArea = pickDefaultArea(allStores);
            sessionStorage.setItem(FORECAST_AREA_STORAGE_KEY, activeArea);
        }
        renderAreaTabs(root);
        renderForecastTargetControls(root, statusPayload);
        syncBackfillButtons();
        renderTable(root, statusPayload);
    }

    async function runAll() {
        const root = ensureBackdrop();
        root.querySelector('#admin-forecast-error').textContent = '';
        const data = statusPayload || (await fetchStatus());
        const storeNumbers = storesInActiveArea(
            Object.entries(data.history?.stores || {})
                .filter(([, row]) => row.ready)
                .map(([storeNumber]) => storeNumber)
        );
        if (!storeNumbers.length) {
            root.querySelector('#admin-forecast-error').textContent =
                `No ready stores in ${activeArea || 'this area'}. Open History and use Backfill data first.`;
            renderTable(root, data);
            return;
        }
        await openPreview(storeNumbers, { focusSubmit: true });
    }

    async function open() {
        const root = ensureBackdrop();
        if (!isInline()) root.hidden = false;
        root.querySelector('#admin-forecast-error').textContent = '';
        root.querySelector('#admin-forecast-body').innerHTML = '<p>Loading…</p>';
        try {
            await refreshLifeLenzStatus(root);
            await refresh(root);
        } catch (error) {
            root.querySelector('#admin-forecast-error').textContent = error.message;
        }
    }

    function mount(host, options = {}) {
        pageHost = host;
        return open(options);
    }

    function setInlineHost(host) {
        pageHost = host || null;
    }

    function unmount() {
        pageHost = null;
    }

    global.AdminForecast = { open, close, mount, unmount, setInlineHost };
})(window);
