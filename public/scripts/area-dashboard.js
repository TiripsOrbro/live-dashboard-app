const areaPathMatch = window.location.pathname.match(/\/area\/([a-z0-9-]+)\/?$/i);
const areaCodeMatch = window.location.pathname.match(/\/(a\d+)\/?$/i);
const areaKey = (areaPathMatch ? areaPathMatch[1] : areaCodeMatch ? areaCodeMatch[1].toUpperCase() : '') || '';
const titleEl = document.getElementById('title');
const areaLabelEl = document.getElementById('area-label');
const metaEl = document.getElementById('meta');
const areaGrids = document.getElementById('area-grids');
const ordersList = document.getElementById('orders-list');
const auditsList = document.getElementById('audits-list');
const timeEl = document.getElementById('time-display');
const updatedEl = document.getElementById('last-updated');
const statusBanner = document.getElementById('status-banner');
let latestDashboards = [];

function fmtHour(hour) {
    const h = (((Math.trunc(hour) % 24) + 24) % 24);
    const period = h < 12 ? 'AM' : 'PM';
    const display = h % 12 === 0 ? 12 : h % 12;
    return `${display}${period}`;
}

function fmtCurrency(value) {
    const n = Number(value || 0);
    return `$${Math.round(n).toLocaleString()}`;
}

function li(text) {
    const el = document.createElement('div');
    el.className = 'area-chip';
    el.textContent = text;
    return el;
}

function sum(rows, key) {
    return (rows || []).reduce((acc, row) => acc + (Number(row[key]) || 0), 0);
}

function zoneHourMinuteSecond(timeZone) {
    const parts = new Intl.DateTimeFormat('en-AU', {
        timeZone: String(timeZone || 'Australia/Melbourne'),
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).formatToParts(new Date());
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    return { hour: get('hour'), minute: get('minute'), second: get('second') };
}

function liveHourState(hours, timeZone) {
    if (!Array.isArray(hours) || !hours.length) return { index: -1, progressPct: 0 };
    const { hour, minute, second } = zoneHourMinuteSecond(timeZone);
    const index = hours.findIndex((r) => Math.trunc(r.localHour) === hour);
    if (index < 0) return { index: -1, progressPct: 0 };
    const progressPct = Math.max(0, Math.min(100, ((minute * 60 + second) / 3600) * 100));
    return { index, progressPct };
}

function getPaceClass(actual, forecast, elapsedProgress) {
    const f = Number(forecast) || 0;
    const a = Number(actual) || 0;
    const p = Number(elapsedProgress) || 0;
    if (f <= 0 || p <= 0) return 'cell-green';

    const expected = f * p;
    if (a >= expected) return 'cell-green';

    const shortfall = (expected - a) / expected;
    if (shortfall <= 0.1) return 'cell-orange';
    return 'cell-red';
}

function getActualCellClass(actual, forecast) {
    const f = Number(forecast) || 0;
    const a = Number(actual) || 0;
    if (f <= 0) return '';
    const ratio = (a - f) / f;
    if (ratio >= 0) return 'cell-green';
    if (ratio >= -0.1) return 'cell-orange';
    return 'cell-red';
}

const paceFillMap = {
    'cell-green': 'var(--good)',
    'cell-orange': 'var(--near)',
    'cell-red': 'var(--bad)',
};

const paceBorderMap = {
    'cell-green': 'var(--good-border)',
    'cell-orange': 'var(--near-border)',
    'cell-red': 'var(--bad-border)',
};

function buildLiveProgressLayersHtml(timeFillPercent, outcomeClass, paceClass) {
    const p = Math.max(0, Math.min(100, timeFillPercent));
    const mainBg = paceFillMap[outcomeClass] || 'var(--blank)';
    const paceBg = paceFillMap[paceClass] || 'var(--bad)';
    return `<div class="grid-cell-live-layers" aria-hidden="true">
        <div class="grid-cell-live-main-frame">
            <div class="grid-cell-live-main-fill" style="width: ${p}%; background-color: ${mainBg};"></div>
        </div>
        <div class="grid-cell-live-pace-row">
            <div class="grid-cell-live-pace-grow" style="width: ${p}%;">
                <div class="grid-cell-live-pace-bar" style="border-top: var(--cell-border) ${paceBg}; background-color: ${paceBg};"></div>
            </div>
        </div>
    </div>`;
}

function buildHourCellHtml(row, idx, live, displayValue) {
    const isFuture = live.index >= 0 && idx > live.index;
    if (isFuture) {
        return `<div class="grid-cell">${fmtCurrency(displayValue)}</div>`;
    }

    const forecast = Number(row.forecast) || 0;
    const actual = Number(row.actual) || 0;
    const isCurrentHour = live.index >= 0 && idx === live.index;

    if (!isCurrentHour) {
        const cellClass = getActualCellClass(actual, forecast);
        return `<div class="grid-cell${cellClass ? ` ${cellClass}` : ''}">${fmtCurrency(displayValue)}</div>`;
    }

    const progress = live.progressPct / 100;
    const paceClass = getPaceClass(actual, forecast, progress);
    const outcomeClass = getActualCellClass(actual, forecast);
    const progressPct = Math.round(progress * 1000) / 10;
    const layers = buildLiveProgressLayersHtml(progressPct, outcomeClass, paceClass);
    const outcomeBorder = paceBorderMap[outcomeClass] || 'var(--blank-border)';
    return `<div class="grid-cell grid-cell--live-hour" style="border: var(--cell-border) ${outcomeBorder};">${layers}<span class="grid-cell-live-value">${fmtCurrency(displayValue)}</span></div>`;
}

function buildGrid(rows, titleText = '', dash = {}) {
    if (!areaGrids) return;
    const hours = rows || [];
    const live = liveHourState(hours, dash?.timeZone);
    const section = document.createElement('section');
    section.className = 'area-grid-section';
    const heading = document.createElement('h3');
    heading.className = 'area-grid-heading';
    heading.textContent = titleText || 'Sales Dashboard';
    section.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'dashboard-grid';
    grid.style.setProperty('--grid-hours', String(Math.max(hours.length, 1)));
    section.appendChild(grid);

    if (!hours.length) {
        grid.innerHTML = '<div class="grid-error">No combined hourly sales loaded yet.</div>';
        areaGrids.appendChild(section);
        return;
    }

    const headerCells = hours
        .map((r, idx) => {
            const isLive = idx === live.index;
            return `<div class="grid-cell header-cell${isLive ? ' area-live-header' : ''}">${fmtHour(r.localHour)}</div>`;
        })
        .join('');
    const forecastCells = hours
        .map((r, idx) => buildHourCellHtml(r, idx, live, r.forecast))
        .join('');
    const actualCells = hours
        .map((r, idx) => buildHourCellHtml(r, idx, live, r.actual))
        .join('');
    const forecastTotal = sum(hours, 'forecast');
    const actualTotal = sum(hours, 'actual');
    grid.innerHTML = `
        <div class="grid-label header-label">Time</div>
        ${headerCells}
        <div class="grid-label">Forecast Sales</div>
        ${forecastCells}
        <div class="grid-label">Actual Sales</div>
        ${actualCells}
        <div class="grid-label meal-period-label meal-period-day-sales-total">
            <div class="meal-period-day-sales-stack">
                <div class="meal-period-day-sales-figures">
                    <div class="meal-period-day-sales-line">A${fmtCurrency(actualTotal)}</div>
                    <div class="meal-period-day-sales-line">F${fmtCurrency(forecastTotal)}</div>
                </div>
            </div>
        </div>
        <div class="grid-cell meal-period-cell" style="grid-column: span ${hours.length};">
            <div class="meal-period-body">
                <div class="meal-period-stats">
                    <span class="meal-period-line"><span class="meal-period-k">Actual:</span> <span class="meal-period-value">${fmtCurrency(actualTotal)}</span></span>
                    <span class="meal-period-line"><span class="meal-period-k">Forecast:</span> <span class="meal-period-value">${fmtCurrency(forecastTotal)}</span></span>
                </div>
            </div>
        </div>
    `;
    areaGrids.appendChild(section);
}

function renderDashboards(dashboards) {
    if (areaGrids) areaGrids.innerHTML = '';
    if (!dashboards.length) {
        buildGrid([], 'Sales Dashboard');
        return;
    }
    for (const dash of dashboards) {
        const label = dash?.state ? `${dash.state} Sales Dashboard` : 'Sales Dashboard';
        buildGrid(Array.isArray(dash?.combinedHourly) ? dash.combinedHourly : [], label, dash);
    }
}

function updateClock() {
    if (!timeEl) return;
    timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function setStatus(message) {
    if (!statusBanner) return;
    if (!message) {
        statusBanner.hidden = true;
        statusBanner.textContent = '';
        return;
    }
    statusBanner.hidden = false;
    statusBanner.textContent = message;
}

async function loadArea() {
    if (!areaKey) return;
    const res = await fetch(`/api/area-dashboard?area=${encodeURIComponent(areaKey)}`, { credentials: 'include' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed to load area dashboard');

    titleEl.textContent = 'SALES DASHBOARD';
    if (areaLabelEl) areaLabelEl.textContent = `${data.area} Area`;
    metaEl.textContent = `Updated ${new Date(data.timestamp).toLocaleString()} · ${data.stores.length} stores`;
    if (updatedEl) {
        updatedEl.textContent = new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    const dashboards = Array.isArray(data.dashboards) ? data.dashboards : [];
    latestDashboards = dashboards;
    const hasAnyRows = dashboards.some((d) => Array.isArray(d.combinedHourly) && d.combinedHourly.length);
    if (!hasAnyRows) {
        setStatus('No combined hourly sales loaded yet. Data appears after a successful sales scrape.');
    } else {
        setStatus('');
    }
    renderDashboards(dashboards);

    ordersList.innerHTML = '';
    const orders = data.storesWithOrdersOutstanding || [];
    if (!orders.length) ordersList.appendChild(li('No stores with orders outstanding.'));
    for (const s of orders) {
        ordersList.appendChild(li(`${s.storeNumber} ${s.storeName} (${s.pendingCount})`));
    }

    auditsList.innerHTML = '';
    const audits = data.storesWithAuditsOutstanding || [];
    if (!audits.length) auditsList.appendChild(li('No stores with audits outstanding.'));
    for (const s of audits) {
        auditsList.appendChild(li(`${s.storeNumber} ${s.storeName} (${s.outstandingCount})`));
    }
}

loadArea().catch((err) => {
    setStatus('Unable to refresh area data. If issue persists, contact Ash.');
    metaEl.textContent = err.message || 'Failed to load area dashboard.';
});

updateClock();
setInterval(updateClock, 1000);
const GRID_PROGRESS_REFRESH_MS = 10000;
setInterval(() => {
    if (latestDashboards.length) renderDashboards(latestDashboards);
}, GRID_PROGRESS_REFRESH_MS);
