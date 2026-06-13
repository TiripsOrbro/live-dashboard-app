(function (global) {
    let backdrop = null;
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
        if (value == null || !Number.isFinite(Number(value))) return '—';
        return '$' + Number(value).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }

    function ensureBackdrop() {
        if (backdrop) return backdrop;
        backdrop = document.createElement('div');
        backdrop.className = 'admin-modal-backdrop';
        backdrop.hidden = true;
        backdrop.innerHTML = `
            <div class="admin-modal admin-modal--wide" role="dialog" aria-modal="true">
                <h2>Forecast tool</h2>
                <p class="admin-accounts-meta">Uses 5 weeks of stored hourly sales (trimmed weekday averages + hourly shape), then writes one target week (Monday start, 2 weeks out) to Macromatix. History builds automatically after each trading day; import backfill for gaps.</p>
                <nav class="admin-area-tabs admin-forecast-area-tabs" id="admin-forecast-area-tabs" role="tablist" aria-label="Select area"></nav>
                <div class="admin-modal-toolbar">
                    <button type="button" class="mic-settings-btn admin-btn-primary" id="admin-forecast-submit-all">Submit all in scope</button>
                    <span id="admin-forecast-busy" hidden>MMX busy…</span>
                </div>
                <div id="admin-forecast-body"></div>
                <p id="admin-forecast-error" class="admin-modal-error" role="alert"></p>
                <div class="admin-modal-actions">
                    <button type="button" id="admin-forecast-close">Close</button>
                </div>
            </div>`;
        document.body.appendChild(backdrop);
        backdrop.addEventListener('click', (event) => {
            if (event.target === backdrop) close();
        });
        backdrop.querySelector('#admin-forecast-close')?.addEventListener('click', close);
        backdrop.querySelector('#admin-forecast-submit-all')?.addEventListener('click', () => {
            void runAll();
        });
        backdrop.querySelector('#admin-forecast-area-tabs')?.addEventListener('click', (event) => {
            const tab = event.target.closest('[data-forecast-area]');
            if (!tab) return;
            activeArea = tab.getAttribute('data-forecast-area') || '';
            sessionStorage.setItem(FORECAST_AREA_STORAGE_KEY, activeArea);
            if (statusPayload) {
                renderAreaTabs(backdrop);
                renderTable(backdrop, statusPayload);
            }
        });
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
                <div class="admin-tabs" id="admin-forecast-history-weekdays"></div>
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
        if (backdrop) backdrop.hidden = true;
        closeHistory();
        closePreview();
        closeProgress(false);
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
                <div class="admin-modal-actions admin-modal-actions--split">
                    <button type="button" class="mic-settings-btn" id="admin-forecast-preview-cancel">Cancel</button>
                    <button type="button" class="mic-settings-btn admin-btn-primary" id="admin-forecast-preview-submit">Submit to Macromatix</button>
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
        if (!iso) return '—';
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
        const res = await fetch('/api/admin/forecast/run', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'text/event-stream',
            },
            credentials: 'same-origin',
            body: JSON.stringify({ storeNumbers, streamProgress: true }),
        });
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('text/event-stream') && res.body) {
            let finalPayload = null;
            await consumeSseStream(res, (eventName, data) => {
                if (eventName === 'progress') onEvent?.('progress', data);
                else if (eventName === 'complete' || eventName === 'error') finalPayload = data;
                else if (eventName === 'started') onEvent?.('started', data);
            });
            if (finalPayload && !finalPayload.success) {
                throw new Error(finalPayload.error || 'Forecast run failed.');
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
                return {
                    storeNumber: String(storeNumber),
                    storeName: preview?.storeName || String(storeNumber),
                    status: 'pending',
                    error: null,
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
                };
            }),
            activeStore: storeNumbers[0] ? String(storeNumbers[0]) : null,
            activeDate: null,
            complete: false,
            results: null,
            error: null,
        };
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
        const store = findProgressStore(state, payload.storeNumber);
        if (!store && !/^store-(complete|error|start)$/.test(payload.type)) return;

        if (payload.type === 'store-start') {
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
            store.status = 'done';
        } else if (payload.type === 'store-complete') {
            store.status = payload.ok === false ? 'error' : 'done';
            if (payload.error) store.error = payload.error;
        } else if (payload.type === 'store-error') {
            store.status = 'error';
            store.error = payload.error || 'Submit failed';
            const activeDay = findProgressDay(store, state.activeDate);
            if (activeDay && activeDay.status !== 'done') {
                activeDay.status = 'error';
                activeDay.error = store.error;
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
                    <div class="admin-forecast-progress-layout">
                        <ol class="admin-forecast-progress-days" id="admin-forecast-progress-days"></ol>
                        <div class="admin-forecast-progress-detail" id="admin-forecast-progress-detail"></div>
                    </div>
                </div>
                <div id="admin-forecast-progress-done" class="admin-forecast-progress-done" hidden>
                    <div class="admin-forecast-progress-done-icon" aria-hidden="true">✓</div>
                    <h2>Forecast submitted</h2>
                    <p class="admin-accounts-meta" id="admin-forecast-progress-done-meta"></p>
                    <ul class="admin-forecast-progress-summary" id="admin-forecast-progress-summary"></ul>
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

    function patchProgressDaysList(daysEl, days) {
        days.forEach((day, index) => {
            const status = day.status || 'pending';
            const cls = `admin-forecast-progress-day admin-forecast-progress-day--${status}`;
            let item = daysEl.children[index];
            if (!item || item.dataset.date !== day.date) {
                item = document.createElement('li');
                item.dataset.date = day.date;
                item.innerHTML =
                    '<span class="admin-forecast-progress-day-label"></span>' +
                    '<span class="admin-forecast-progress-day-total"></span>' +
                    '<span class="admin-forecast-progress-day-state"></span>';
                if (daysEl.children[index]) daysEl.replaceChild(item, daysEl.children[index]);
                else daysEl.appendChild(item);
            }
            item.className = cls;
            item.querySelector('.admin-forecast-progress-day-label').textContent =
                weekdayLabel(day.weekday) || formatShortDate(day.date);
            item.querySelector('.admin-forecast-progress-day-total').textContent = formatMoney(day.forecastTotal);
            item.querySelector('.admin-forecast-progress-day-state').textContent = progressDayStatusLabel(day.status);
        });
        while (daysEl.children.length > days.length) {
            daysEl.removeChild(daysEl.lastChild);
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
        const doneStores = state.stores.filter((s) => s.status === 'done').length;
        const storePos = Math.max(1, state.stores.findIndex((s) => s === activeStore) + 1);
        const activeDay =
            findProgressDay(activeStore, state.activeDate) ||
            activeStore?.days.find((d) => d.status === 'filling' || d.status === 'verifying' || d.status === 'saving') ||
            activeStore?.days.find((d) => d.status === 'pending');

        root.querySelector('#admin-forecast-progress-title').textContent = 'Submitting forecast';
        root.querySelector('#admin-forecast-progress-meta').textContent = activeStore
            ? `Store ${activeStore.storeNumber}${activeStore.storeName !== activeStore.storeNumber ? ' · ' + activeStore.storeName : ''} · ${storePos} of ${state.stores.length}${doneStores ? ` · ${doneStores} complete` : ''}`
            : 'Starting…';

        patchProgressDaysList(root.querySelector('#admin-forecast-progress-days'), activeStore?.days || []);
        patchProgressDayDetail(root.querySelector('#admin-forecast-progress-detail'), activeDay);
    }

    function renderProgressComplete(payload) {
        const root = ensureProgressBackdrop();
        const state = progressState;
        root.querySelector('#admin-forecast-progress-working').hidden = true;
        root.querySelector('#admin-forecast-progress-done').hidden = false;
        setProgressCloseEnabled(root, true, { label: 'Done' });

        const results = payload?.results || [];
        const ok = results.filter((row) => row.ok);
        const failed = results.filter((row) => !row.ok);
        const weekStart = (payload?.targetWeeks || previewData?.targetWeeks || [])[0];

        root.querySelector('#admin-forecast-progress-done-meta').textContent = failed.length
            ? `${ok.length} store(s) submitted${weekStart ? ` for week starting ${weekStart}` : ''}. ${failed.length} failed.`
            : `All ${ok.length} store(s) submitted${weekStart ? ` for week starting ${weekStart}` : ''}.`;

        root.querySelector('#admin-forecast-progress-summary').innerHTML = results
            .map((row) => {
                const cls = row.ok ? 'admin-forecast-progress-summary-ok' : 'admin-forecast-progress-summary-bad';
                const detail = row.ok
                    ? `${row.forecastDays || row.mmx?.dayTouched || 0} days · ${row.mmx?.hourVerified ?? row.mmx?.hourTouched ?? '—'} of ${row.mmx?.slotCount ?? '—'} hours confirmed`
                    : escapeHtml(row.error || 'Failed');
                return `<li class="${cls}"><strong>${escapeHtml(row.storeNumber)}</strong> ${detail}</li>`;
            })
            .join('');

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
                    `<th><span class="admin-history-col-label">${escapeHtml(col.weekdayLabel || col.label || '')}</span><span class="admin-accounts-meta">${escapeHtml(col.date || '—')}</span></th>`
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
            `Forecast preview — ${preview.storeNumber}${preview.storeName ? ' ' + preview.storeName : ''}`;
        const weeks = (preview.targetWeeks || previewData?.targetWeeks || []).join(', ');
        meta.textContent = weeks
            ? `Week starting ${weeks} (Monday, 2 weeks out). Trimmed weekday averages + hourly shape. Review before submitting to Macromatix.`
            : 'Trimmed weekday averages + hourly shape. Review before submitting to Macromatix.';
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
        submitBtn.textContent = 'Submit to Macromatix';
        try {
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
            });
            renderProgressComplete(payload);
        } catch (error) {
            const root = ensureProgressBackdrop();
            root.querySelector('#admin-forecast-progress-error').textContent = error.message;
            setProgressCloseEnabled(root, true, { label: 'Done' });
            if (progressState) progressState.error = error.message;
        } finally {
            previewRoot.querySelector('#admin-forecast-preview-submit').disabled = false;
            previewRoot.querySelector('#admin-forecast-preview-cancel').disabled = false;
            previewRoot.querySelector('#admin-forecast-preview-submit').textContent = 'Submit to Macromatix';
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
            `Sales history & forecast — ${grid.storeNumber}${grid.storeName ? ' ' + grid.storeName : ''}`;

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
        actualSection.innerHTML = '<h3 class="admin-forecast-history-heading">Actual sales — selected weekday</h3>';
        const actualGrid = document.createElement('div');
        actualSection.appendChild(actualGrid);
        renderForecastGrid(actualGrid, {
            columns: grid.columns.map((col) => ({ weekdayLabel: col.label, date: col.date })),
            rows: grid.rows,
            dayTotals: grid.dayTotals,
        });

        const forecastSection = body.querySelector('#admin-forecast-history-forecast');
        if (forecastWeek?.grid) {
            forecastSection.innerHTML = `<h3 class="admin-forecast-history-heading">Forecast week${weekLabel ? ` — starting ${escapeHtml(weekLabel)}` : ''}</h3>`;
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
                    : `History ${hist.daysRecorded}/${hist.daysRequired}d — need ${escapeHtml((hist.weekdayGaps || []).join(', ') || 'more days')}`;
                const weekCells = weeks
                    .map((weekStart) => {
                        const row = payload.stores[storeNumber]?.[weekStart] || {};
                        return `<td>${dot(row.completed)} ${row.completed ? 'Done' : 'Pending'}</td>`;
                    })
                    .join('');
                const runDisabled = hist.ready ? '' : ' disabled title="Import or wait for 5 weeks of hourly history"';
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
    }

    async function refresh(root) {
        await fetchStores();
        statusPayload = await fetchStatus();
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
        root.hidden = false;
        root.querySelector('#admin-forecast-error').textContent = '';
        root.querySelector('#admin-forecast-body').innerHTML = '<p>Loading…</p>';
        try {
            await refresh(root);
        } catch (error) {
            root.querySelector('#admin-forecast-error').textContent = error.message;
        }
    }

    global.AdminForecast = { open, close };
})(window);
