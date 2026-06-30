(function (global) {
    const DAILY_REPORT_JOBS = [
        {
            id: 'stock-levels',
            label: 'Stock levels',
            title: 'Run the stock-levels check (on hand, and on hand + on order)',
            dataAttr: 'data-daily-stock-store',
            readEnabled: (store, state) => Boolean(state.stockPayload?.stores?.[store]),
            writeEnabled: async (store, enabled) => {
                const res = await fetch('/api/admin/five-am-reports/stores', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({ store, enabled }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.success) {
                    throw new Error(data.error || 'Could not save stock levels setting.');
                }
                return data;
            },
        },
        {
            id: 'forecast-auto-submit',
            label: 'Forecast',
            title: 'Auto-submit weekly forecasts for this store',
            dataAttr: 'data-daily-forecast-store',
            readEnabled: (store, state) => Boolean(state.forecastPayload?.stores?.[store]),
            writeEnabled: async (store, enabled) => {
                const res = await fetch('/api/admin/forecast/store-auto-submit', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({ store, enabled }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.success) {
                    throw new Error(data.error || 'Could not save forecast setting.');
                }
                return data;
            },
        },
    ];

    let pageHost = null;
    let stockPayload = null;
    let forecastPayload = null;
    let storesPayload = [];
    let canManage = false;
    const pullingStores = new Set();

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function getRoot() {
        return pageHost || null;
    }

    function pageState() {
        return { stockPayload, forecastPayload };
    }

    async function fetchProfile() {
        try {
            const res = await fetch('/api/me', { credentials: 'same-origin' });
            const data = await res.json().catch(() => ({}));
            return res.ok && data.success ? data : {};
        } catch {
            return {};
        }
    }

    async function fetchStores() {
        try {
            const res = await fetch('/api/stores', { credentials: 'same-origin' });
            const data = await res.json().catch(() => ({}));
            return res.ok && data.success && Array.isArray(data.stores) ? data.stores : [];
        } catch {
            return [];
        }
    }

    async function fetchStockStatus() {
        const res = await fetch('/api/admin/five-am-reports/stores', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not load daily reports settings.');
        }
        return data;
    }

    async function fetchForecastStatus() {
        const res = await fetch('/api/admin/forecast/auto-submit', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not load forecast auto-submit settings.');
        }
        return data;
    }

    function formatDay(dateKey) {
        if (!dateKey) return '—';
        return escapeHtml(String(dateKey));
    }

    function renderJobToggle(job, store, enabled) {
        if (!canManage) {
            return `<span class="admin-accounts-meta">${enabled ? 'On' : 'Off'}</span>`;
        }
        return `<label class="mic-toggle-switch" title="${escapeHtml(job.title)}">
            <input type="checkbox" role="switch" aria-label="${escapeHtml(job.label)} for store ${escapeHtml(store)}" ${job.dataAttr}="${escapeHtml(store)}" data-daily-job="${escapeHtml(job.id)}"${enabled ? ' checked' : ''} />
            <span class="mic-toggle-slider" aria-hidden="true"></span>
        </label>`;
    }

    function renderRows() {
        const enabledMap = stockPayload?.stores || {};
        const lastRun = stockPayload?.lastRun || {};
        const forecastMap = forecastPayload?.stores || {};
        const rows = storesPayload
            .filter((s) => Object.prototype.hasOwnProperty.call(enabledMap, String(s.storeNumber)))
            .sort((a, b) => {
                const area = String(a.area || '').localeCompare(String(b.area || ''));
                if (area !== 0) return area;
                return String(a.storeNumber).localeCompare(String(b.storeNumber), undefined, { numeric: true });
            });
        if (!rows.length) {
            return '<p class="admin-accounts-meta">No stores available.</p>';
        }
        const jobHeaders = DAILY_REPORT_JOBS.map((job) => `<th>${escapeHtml(job.label)}</th>`).join('');
        const state = pageState();
        const body = rows
            .map((s) => {
                const store = String(s.storeNumber);
                const jobCells = DAILY_REPORT_JOBS.map((job) => {
                    const enabled = job.readEnabled(store, state);
                    return `<td>${renderJobToggle(job, store, enabled)}</td>`;
                }).join('');
                const lastRunLabel = pullingStores.has(store) ? 'Pulling now…' : formatDay(lastRun[store]);
                return `<tr>
                    <td>${escapeHtml(store)}<span class="admin-accounts-meta">${escapeHtml(s.storeName || '')}</span></td>
                    <td>${escapeHtml(s.area || '')}</td>
                    ${jobCells}
                    <td><span class="admin-accounts-meta">${lastRunLabel}</span></td>
                </tr>`;
            })
            .join('');
        return `
            <table class="admin-table">
                <thead>
                    <tr><th>Store</th><th>Area</th>${jobHeaders}<th>Last stock run</th></tr>
                </thead>
                <tbody>${body}</tbody>
            </table>`;
    }

    function render() {
        const root = getRoot();
        if (!root) return;
        const hour = Number(stockPayload?.scheduleHour ?? forecastPayload?.scheduleHour);
        const hourLabel = Number.isFinite(hour) ? `${hour}:00` : '5:00';
        const forecastLastRun = forecastPayload?.lastScheduledRun
            ? formatDay(forecastPayload.lastScheduledRun)
            : '—';
        root.innerHTML = `
            <div class="admin-modal admin-modal--inline admin-five-am-reports">
                <h2>Daily reports</h2>
                <p class="admin-accounts-meta">
                    Once-per-day automated jobs for enabled stores, typically around ${escapeHtml(hourLabel)} in each store's timezone.
                    Stock results appear on the store's Stock levels tile; forecast auto-submit uses the Forecast tool settings.
                </p>
                <p class="admin-accounts-meta">Forecast scheduler last ran: ${forecastLastRun}</p>
                <p class="admin-modal-error" id="admin-five-am-error" role="alert"></p>
                <div id="admin-five-am-body">${renderRows()}</div>
            </div>`;
        bindRows();
    }

    function bindRows() {
        const root = getRoot();
        if (!root) return;
        root.querySelectorAll('[data-daily-job]').forEach((input) => {
            input.addEventListener('change', (event) => {
                const jobId = event.target.getAttribute('data-daily-job');
                const job = DAILY_REPORT_JOBS.find((row) => row.id === jobId);
                if (!job) return;
                const store = event.target.getAttribute(job.dataAttr) || '';
                if (!store) return;
                void saveJob(store, job, event.target.checked, event.target);
            });
        });
    }

    async function saveJob(storeNumber, job, enabled, inputEl) {
        const root = getRoot();
        const errEl = root?.querySelector('#admin-five-am-error');
        if (errEl) errEl.textContent = '';
        try {
            const data = await job.writeEnabled(storeNumber, enabled);
            if (job.id === 'stock-levels') {
                if (stockPayload?.stores) stockPayload.stores[storeNumber] = Boolean(enabled);
                if (data.pulling) {
                    pullingStores.add(String(storeNumber));
                    render();
                } else if (!enabled) {
                    pullingStores.delete(String(storeNumber));
                }
            } else if (job.id === 'forecast-auto-submit') {
                if (forecastPayload?.stores) forecastPayload.stores[storeNumber] = Boolean(enabled);
            }
        } catch (err) {
            if (inputEl) inputEl.checked = !enabled;
            if (errEl) errEl.textContent = err.message || 'Could not save setting.';
        }
    }

    async function open() {
        const root = getRoot();
        if (root) {
            root.innerHTML = '<p class="admin-accounts-meta">Loading daily reports…</p>';
        }
        try {
            const [profile, stores, stockStatus, forecastStatus] = await Promise.all([
                fetchProfile(),
                fetchStores(),
                fetchStockStatus(),
                fetchForecastStatus(),
            ]);
            canManage = Boolean(profile.canEditGlobalBuildTo);
            storesPayload = stores;
            stockPayload = stockStatus;
            forecastPayload = forecastStatus;
            render();
        } catch (err) {
            if (root) {
                root.innerHTML = `<p class="admin-modal-error" role="alert">${escapeHtml(err.message || 'Could not load daily reports.')}</p>`;
            }
        }
    }

    function mount(host) {
        pageHost = host;
        return open();
    }

    function setInlineHost(host) {
        pageHost = host || null;
    }

    function unmount() {
        pageHost = null;
        stockPayload = null;
        forecastPayload = null;
        storesPayload = [];
    }

    global.AdminFiveAmReports = { mount, setInlineHost, unmount, open };
})(window);
