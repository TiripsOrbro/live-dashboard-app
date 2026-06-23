(function (global) {
    let backdrop = null;
    let pageHost = null;
    let historyBackdrop = null;
    let previewBackdrop = null;
    let progressBackdrop = null;
    let progressState = null;
    let historyStoreNumber = null;
    let historyForecastWeek = null;
    let pendingSubmitStores = [];
    let previewData = null;
    let previewActiveStore = null;
    let statusPayload = null;
    let storeAreaByNumber = {};
    let activeArea = '';
    let lifelenzBackdrop = null;
    let lifelenzStatus = { configured: false, updatedAt: null };
    let sessionLifeLenzCredentials = null;

    const ADMIN_AREAS = ['Area 1', 'Area 2', 'Area 21', 'Area 22'];
    const FORECAST_AREA_STORAGE_KEY = 'admin-forecast-area';

    const WEEKDAYS = [
        { value: 1, label: 'Mon' },
        { value: 2, label: 'Tue' },
        { value: 3, label: 'Wed' },
        { value: 4, label: 'Thu' },
        { value: 5, label: 'Fri' },
        { value: 6, label: 'Sat' },
        { value: 0, label: 'Sun' },
    ];

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
                <p class="admin-accounts-meta">Uses 5 weeks of stored hourly sales (trimmed weekday averages + hourly shape), then writes one target week (Monday start, 2 weeks out) to Macromatix and LifeLenz when configured. History builds automatically after each trading day; import backfill for gaps.</p>
                <nav class="admin-area-tabs admin-forecast-area-tabs" id="admin-forecast-area-tabs" role="tablist" aria-label="Select area"></nav>
                <div class="admin-modal-toolbar admin-forecast-toolbar">
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
                <div class="admin-tabs admin-tabs--full" id="admin-forecast-history-weekdays"></div>
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
        historyBackdrop.querySelector('#admin-forecast-history-weekdays')?.addEventListener('click', (event) => {
            const tab = event.target.closest('[data-weekday]');
            if (!tab || !historyStoreNumber) return;
            void loadHistoryGrid(historyStoreNumber, Number(tab.getAttribute('data-weekday')));
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
                <div class="admin-forecast-store-tabs" id="admin-forecast-preview-stores" hidden></div>
                <div class="admin-forecast-preview-body-wrap">
                    <div id="admin-forecast-preview-body"></div>
                </div>
                <p id="admin-forecast-preview-error" class="admin-modal-error" role="alert"></p>
                <p id="admin-forecast-preview-lifelenz-note" class="admin-accounts-meta admin-forecast-preview-lifelenz-note" hidden></p>
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
        previewBackdrop.querySelector('#admin-forecast-preview-stores')?.addEventListener('click', (event) => {
            const tab = event.target.closest('[data-preview-store]');
            if (!tab || !previewData) return;
            renderPreviewStore(tab.getAttribute('data-preview-store'));
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
        const body = { storeNumbers, streamProgress: true };
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
        if (progressBackdrop) return progressBackdrop;
        progressBackdrop = document.createElement('div');
        progressBackdrop.className = 'admin-modal-backdrop admin-modal-backdrop--stacked admin-modal-backdrop--progress';
        progressBackdrop.hidden = true;
        progressBackdrop.innerHTML = `
            <div class="admin-modal admin-modal--wide admin-modal--forecast-progress" role="dialog" aria-modal="true">
                <div id="admin-forecast-progress-working">
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
                <div id="admin-forecast-progress-done" class="admin-forecast-progress-done" hidden>
                    <h2>Forecast entered</h2>
                    <p class="admin-accounts-meta" id="admin-forecast-progress-done-meta"></p>
                    <div id="admin-forecast-progress-done-results" class="admin-forecast-progress-done-results"></div>
                    <div id="admin-forecast-progress-manual-actions" class="admin-forecast-progress-manual-actions" hidden></div>
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
        if (!state) return;

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
            state.complete = true;
            state.results = payload;
        }
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
        previewData = null;
        previewActiveStore = null;
    }

    function closeHistory() {
        if (historyBackdrop) historyBackdrop.hidden = true;
        historyStoreNumber = null;
        historyForecastWeek = null;
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

    async function fetchHistoryGrid(storeNumber, weekday, { includeForecast = true } = {}) {
        const params = new URLSearchParams({ store: storeNumber, weeks: '5' });
        if (Number.isFinite(weekday)) params.set('weekday', String(weekday));
        if (!includeForecast) params.set('includeForecast', '0');
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
            body: JSON.stringify({ storeNumbers }),
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

    function renderForecastGrid(container, grid, { emptyMessage, mode = 'history' } = {}) {
        if (!grid?.columns?.length) {
            container.innerHTML = `<p>${escapeHtml(emptyMessage || 'No forecast data.')}</p>`;
            return;
        }
        const head = grid.columns
            .map(
                (col) =>
                    `<th><span class="admin-history-col-label">${escapeHtml(col.weekdayLabel || col.label || '')}</span><span class="admin-accounts-meta">${escapeHtml(col.date || '-')}</span></th>`
            )
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
        const wrapClass =
            mode === 'preview'
                ? 'admin-history-grid-wrap admin-forecast-preview-grid-wrap'
                : 'admin-history-grid-wrap';
        container.innerHTML = `
            ${previewSummary}
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

    function renderAreaTabs(root) {
        const nav = root.querySelector('#admin-forecast-area-tabs');
        if (!nav) return;
        nav.innerHTML = ADMIN_AREAS.map((name, idx) => {
            const isActive = name === activeArea;
            const tab = `<button type="button" class="admin-area-tab${isActive ? ' is-active' : ''}" role="tab" aria-selected="${isActive}" data-forecast-area="${escapeHtml(name)}">${escapeHtml(name)}</button>`;
            const pipe =
                idx < ADMIN_AREAS.length - 1
                    ? '<span class="admin-area-tab-pipe" aria-hidden="true">|</span>'
                    : '';
            return tab + pipe;
        }).join('');
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
        const weeks = (preview.targetWeeks || previewData?.targetWeeks || []).join(', ');
        meta.textContent = weeks
            ? `Week starting ${weeks} (Monday, 2 weeks out). Trimmed weekday averages + hourly shape. Review before submitting to Macromatix${hasLifeLenzForSubmit() ? ' and LifeLenz' : ''}.`
            : `Trimmed weekday averages + hourly shape. Review before submitting to Macromatix${hasLifeLenzForSubmit() ? ' and LifeLenz' : ''}.`;
        const noteEl = root.querySelector('#admin-forecast-preview-lifelenz-note');
        if (noteEl) {
            noteEl.hidden = false;
            noteEl.textContent = hasLifeLenzForSubmit()
                ? 'Submit forecast writes to Macromatix first, then LifeLenz using your connected login.'
                : 'LifeLenz is not configured - submit will update Macromatix only. Use Setup LifeLenz to connect.';
        }
        if (okPreviews.length > 1) {
            tabs.hidden = false;
            tabs.innerHTML = `<nav class="admin-store-tabs" aria-label="Select store"><div class="admin-store-tabs__scroll" role="tablist">${okPreviews
                .map((row) => {
                    const active = String(row.storeNumber) === String(storeNumber) ? ' is-active' : '';
                    return `<button type="button" class="admin-store-tabs__tab${active}" data-preview-store="${escapeHtml(row.storeNumber)}" role="tab" aria-selected="${String(row.storeNumber) === String(storeNumber)}"><span class="admin-store-tabs__num">${escapeHtml(row.storeNumber)}</span></button>`;
                })
                .join('')}</div></nav>`;
        } else {
            tabs.hidden = true;
            tabs.innerHTML = '';
        }
        renderForecastGrid(body, preview.grid, { mode: 'preview' });
    }

    function focusPreviewSubmit() {
        const btn = previewBackdrop?.querySelector('#admin-forecast-preview-submit');
        btn?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        btn?.focus();
    }

    async function openPreview(storeNumbers, { focusSubmit = false } = {}) {
        pendingSubmitStores = storeNumbers.slice();
        const root = ensurePreviewBackdrop();
        root.hidden = false;
        root.querySelector('#admin-forecast-preview-error').textContent = '';
        root.querySelector('#admin-forecast-preview-body').innerHTML = '<p>Loading preview…</p>';
        root.querySelector('#admin-forecast-preview-stores').innerHTML = '';
        const submitBtn = root.querySelector('#admin-forecast-preview-submit');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submit forecast';
        try {
            await refreshLifeLenzStatus();
            previewData = await fetchPreview(storeNumbers);
            const first = previewData.previews?.find((row) => row.ok);
            if (!first) throw new Error('No preview available.');
            submitBtn.disabled = false;
            renderPreviewStore(first.storeNumber);
            if (focusSubmit) focusPreviewSubmit();
        } catch (error) {
            root.querySelector('#admin-forecast-preview-error').textContent = error.message;
            root.querySelector('#admin-forecast-preview-body').innerHTML = '';
        }
    }

    async function confirmSubmit() {
        const previewRoot = ensurePreviewBackdrop();
        const stores = pendingSubmitStores.slice();
        if (!stores.length) return;

        const previewSnapshot = previewData;

        previewRoot.querySelector('#admin-forecast-preview-error').textContent = '';
        previewRoot.querySelector('#admin-forecast-preview-submit').disabled = true;
        previewRoot.querySelector('#admin-forecast-preview-cancel').disabled = true;

        closePreview();
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

    function renderHistoryGrid(root, grid, forecastWeek) {
        const body = root.querySelector('#admin-forecast-history-body');
        const meta = root.querySelector('#admin-forecast-history-meta');
        const tabs = root.querySelector('#admin-forecast-history-weekdays');
        const weekLabel = forecastWeek?.targetWeeks?.length
            ? forecastWeek.targetWeeks.map((w) => formatShortDate(w)).join(', ')
            : '';

        root.querySelector('#admin-forecast-history-title').textContent =
            `Sales history & forecast - ${grid.storeNumber}${grid.storeName ? ' ' + grid.storeName : ''}`;

        meta.textContent = weekLabel
            ? `${grid.weekdayLabel} actual sales (5 weeks, oldest → newest). Target forecast week starting ${weekLabel}.`
            : `${grid.weekdayLabel} hourly actual sales. Week starting Monday; columns oldest → newest.`;

        tabs.innerHTML = WEEKDAYS.map((wd) => {
            const active = wd.value === grid.weekday ? ' is-active' : '';
            return `<button type="button" class="admin-tab${active}" data-weekday="${wd.value}">${wd.label}</button>`;
        }).join('');

        body.innerHTML =
            '<section class="admin-forecast-history-section" id="admin-forecast-history-actual" aria-label="Historical actual sales"></section>' +
            '<section class="admin-forecast-history-section" id="admin-forecast-history-forecast" aria-label="Target forecast week"></section>';

        const actualSection = body.querySelector('#admin-forecast-history-actual');
        actualSection.innerHTML = '<h3 class="admin-forecast-history-heading">Actual sales - selected weekday</h3>';
        const actualGrid = document.createElement('div');
        actualSection.appendChild(actualGrid);
        renderForecastGrid(actualGrid, {
            columns: grid.columns.map((col) => ({ weekdayLabel: col.label, date: col.date })),
            rows: grid.rows,
            dayTotals: grid.dayTotals,
        });

        const forecastSection = body.querySelector('#admin-forecast-history-forecast');
        if (forecastWeek?.grid) {
            forecastSection.innerHTML = `<h3 class="admin-forecast-history-heading">Forecast week${weekLabel ? ` - starting ${escapeHtml(weekLabel)}` : ''}</h3>`;
            const forecastGrid = document.createElement('div');
            forecastSection.appendChild(forecastGrid);
            renderForecastGrid(forecastGrid, forecastWeek.grid, { mode: 'preview' });
        } else if (forecastWeek?.error) {
            forecastSection.innerHTML = `<h3 class="admin-forecast-history-heading">Forecast week</h3><p class="admin-accounts-meta">${escapeHtml(forecastWeek.error)}</p>`;
        } else {
            forecastSection.innerHTML = '';
        }
    }

    async function loadHistoryGrid(storeNumber, weekday) {
        const root = ensureHistoryBackdrop();
        const isWeekdaySwitch = historyStoreNumber === storeNumber && historyForecastWeek != null;
        root.querySelector('#admin-forecast-history-error').textContent = '';
        if (!isWeekdaySwitch) {
            root.querySelector('#admin-forecast-history-body').innerHTML = '<p>Loading…</p>';
        }
        try {
            const data = await fetchHistoryGrid(storeNumber, weekday, { includeForecast: !isWeekdaySwitch });
            if (data.forecastWeek) historyForecastWeek = data.forecastWeek;
            renderHistoryGrid(root, data.grid, historyForecastWeek);
        } catch (error) {
            root.querySelector('#admin-forecast-history-error').textContent = error.message;
            root.querySelector('#admin-forecast-history-body').innerHTML = '';
        }
    }

    async function openHistory(storeNumber) {
        historyStoreNumber = storeNumber;
        historyForecastWeek = null;
        const root = ensureHistoryBackdrop();
        root.hidden = false;
        root.querySelector('#admin-forecast-history-error').textContent = '';
        await loadHistoryGrid(storeNumber);
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
        const head = weeks.map((w) => `<th>${escapeHtml(w)}</th>`).join('');
        const rows = stores
            .map((storeNumber) => {
                const hist = history[storeNumber] || {};
                const histLabel = hist.ready
                    ? `History ${hist.daysRecorded}/${hist.daysRequired}d`
                    : `History ${hist.daysRecorded}/${hist.daysRequired}d - need ${escapeHtml((hist.weekdayGaps || []).join(', ') || 'more days')}`;
                const runDisabled = hist.ready ? '' : ' disabled title="Import or wait for 5 weeks of hourly history"';
                const weekCells = weeks
                    .map((weekStart) => {
                        const row = payload.stores[storeNumber]?.[weekStart] || {};
                        if (row.completed) {
                            return `<td>${dot(true)} Done</td>`;
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
                const manualWeek = weeks[0] || '';
                const manualBtn = manualWeek
                    ? `<button type="button" class="mic-settings-btn" data-manual-store="${escapeHtml(storeNumber)}" data-manual-week="${escapeHtml(manualWeek)}">Manual</button>`
                    : '';
                return `<tr>
                    <td>${escapeHtml(storeNumber)}<span class="admin-accounts-meta">${histLabel}</span></td>
                    <td>${dot(hist.ready, !hist.ready && hist.daysRecorded > 0)} ${hist.ready ? 'Ready' : 'Not ready'}</td>
                    ${weekCells}
                    <td class="admin-forecast-actions">
                        <button type="button" class="mic-settings-btn" data-history-store="${escapeHtml(storeNumber)}">History</button>
                        ${manualBtn}
                        <button type="button" class="mic-settings-btn admin-btn-primary" data-submit-store="${escapeHtml(storeNumber)}"${runDisabled}>Submit</button>
                    </td>
                </tr>`;
            })
            .join('');
        body.innerHTML = `
            <table class="admin-table">
                <thead>
                    <tr><th>Store</th><th>History</th>${head}<th></th></tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>`;
        body.querySelectorAll('[data-submit-store]').forEach((btn) => {
            btn.addEventListener('click', () => {
                void submitOne(btn.getAttribute('data-submit-store'));
            });
        });
        body.querySelectorAll('[data-history-store]').forEach((btn) => {
            btn.addEventListener('click', () => {
                void openHistory(btn.getAttribute('data-history-store'));
            });
        });
        body.querySelectorAll('[data-manual-store]').forEach((btn) => {
            btn.addEventListener('click', () => {
                void openManualEntryGuide(btn.getAttribute('data-manual-store'), btn.getAttribute('data-manual-week'));
            });
        });
    }

    let manualBackdrop = null;

    function ensureManualBackdrop() {
        if (manualBackdrop) return manualBackdrop;
        manualBackdrop = document.createElement('div');
        manualBackdrop.className = 'admin-modal-backdrop admin-modal-backdrop--stacked';
        manualBackdrop.hidden = true;
        manualBackdrop.innerHTML = `
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
        document.body.appendChild(manualBackdrop);
        manualBackdrop.addEventListener('click', (event) => {
            if (event.target === manualBackdrop) manualBackdrop.hidden = true;
        });
        manualBackdrop.querySelector('#admin-forecast-manual-close')?.addEventListener('click', () => {
            manualBackdrop.hidden = true;
        });
        return manualBackdrop;
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
        const root = ensureManualBackdrop();
        root.hidden = false;
        root.querySelector('#admin-forecast-manual-error').textContent = '';
        root.querySelector('#admin-forecast-manual-body').innerHTML = '<p>Loading…</p>';
        root.querySelector('#admin-forecast-manual-title').textContent = `Manual entry - ${storeNumber}`;
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
        await refreshLifeLenzStatus(root);
        const allStores = Object.keys(statusPayload.stores || {});
        if (!activeArea || !ADMIN_AREAS.includes(activeArea)) {
            activeArea = pickDefaultArea(allStores);
            sessionStorage.setItem(FORECAST_AREA_STORAGE_KEY, activeArea);
        }
        renderAreaTabs(root);
        renderTable(root, statusPayload);
    }

    async function submitOne(storeNumber) {
        const root = ensureBackdrop();
        root.querySelector('#admin-forecast-error').textContent = '';
        await openPreview([storeNumber], { focusSubmit: true });
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
                `No ready stores in ${activeArea || 'this area'}. Import backfill or wait for live capture.`;
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
