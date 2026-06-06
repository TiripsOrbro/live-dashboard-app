const app = document.getElementById('app');
const REFRESH_MS = 2 * 60 * 1000;
/** Poll for new scrape data between full refreshes (matches background scraper cadence). */
const SCRAPE_POLL_MS = 15 * 1000;
const TIME_ZONE = 'Australia/Melbourne';
const VOC_PLACEHOLDER = { count: 30, osatPercent: 83, accuracyPercent: 90 };
const SMG_REPORTING_URL = 'https://reporting.smg.com/Index.aspx';

const CURRENT_PROMO = {
    label: 'Current Promo',
    name: 'Nacho Cheese Dip Burrito',
    imageUrl: '/images/promos/let-it-drip-banner.png',
    pdfUrl: '/documents/promos/let-it-drip-frrop.pdf',
};

const DEFAULT_AREA = 'Area 22';

let overviewData = null;
let areaIndex = 0;
let lastSalesUpdatedAt = null;
let overviewLoadInFlight = false;

function formatVocDisplay(voc = {}) {
    if (voc.placeholder) {
        return {
            count: voc.count ?? VOC_PLACEHOLDER.count,
            osat: voc.osatPercent ?? VOC_PLACEHOLDER.osatPercent,
            acc: voc.accuracyPercent ?? VOC_PLACEHOLDER.accuracyPercent,
        };
    }
    return {
        count: voc.count == null ? '—' : voc.count,
        osat: voc.osatPercent,
        acc: voc.accuracyPercent,
    };
}

function formatMoney(value) {
    return `$${(Number(value) || 0).toLocaleString('en-AU')}`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Market snapshot always lists stores 3806, 3808, 3811, 3901… regardless of API order. */
function sortStoresByNumber(stores) {
    return [...(stores || [])].sort((a, b) =>
        String(a.storeNumber).localeCompare(String(b.storeNumber), undefined, { numeric: true })
    );
}

function formatTime(date) {
    return date.toLocaleTimeString('en-AU', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: TIME_ZONE,
    });
}

function applyDashboardScale() {
    const scale = Math.min(1.15, Math.max(0.72, window.innerWidth / 1280));
    document.documentElement.style.setProperty('--dashboard-scale', String(scale));
}

function defaultAreaIndex(areas) {
    const list = areas || [];
    if (!list.length) return 0;
    const idx = list.findIndex((a) => String(a?.name || '').trim() === DEFAULT_AREA);
    return idx >= 0 ? idx : 0;
}

function currentArea() {
    const areas = overviewData?.areas || [];
    if (!areas.length) return null;
    return areas[areaIndex % areas.length];
}

function currentVoc() {
    const list = overviewData?.vocByArea || [];
    if (!list.length) return null;
    return list[areaIndex % list.length];
}

function areaSssgToday(area) {
    const v = area?.sssgTodayPercent;
    if (v == null || Number.isNaN(Number(v))) {
        return formatAreaSssgFromStores(area);
    }
    return Number(v);
}

function areaSssgWtd(area) {
    const v = area?.sssgWtdPercent;
    return v == null || Number.isNaN(Number(v)) ? null : Number(v);
}

function formatAreaSssgFromStores(area) {
    const stores = Array.isArray(area?.storeSales) ? area.storeSales : [];
    const values = stores
        .map((s) => s.sssgPercent)
        .filter((v) => v != null && !Number.isNaN(Number(v)))
        .map((v) => Number(v));
    if (!values.length) return null;
    const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
    return Math.round(avg * 10) / 10;
}

function formatSssgDisplay(value) {
    if (value == null || Number.isNaN(Number(value))) {
        return { text: '—', toneClass: 'mic-sssg--na' };
    }
    const n = Number(value);
    const sign = n > 0 ? '+' : '';
    const toneClass = n > 0 ? 'mic-sssg--up' : n < 0 ? 'mic-sssg--down' : 'mic-sssg--na';
    return { text: `${sign}${n}%`, toneClass };
}

function renderSssgTileBody(area) {
    const today = formatSssgDisplay(areaSssgToday(area));
    const wtd = formatSssgDisplay(areaSssgWtd(area));
    const hasData = today.text !== '—' || wtd.text !== '—';
    const futureClass = hasData ? '' : ' mic-tile--future';
    return {
        html: `
        <article class="mic-tile mic-tile--sssg${futureClass} mic-tile--pos-sssg">
            <div class="mic-tile-body">
                <div class="mic-tile-label">Today SSSG</div>
                <div class="mic-sssg-value ${today.toneClass}">${escapeHtml(today.text)}</div>
                <div class="mic-sssg-wtd ${wtd.toneClass}">WTD ${escapeHtml(wtd.text)}</div>
            </div>
        </article>`,
        hasData,
    };
}

function renderPromoBanner() {
    return `
        <a
            class="admin-promo-banner"
            href="${CURRENT_PROMO.pdfUrl}"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="${CURRENT_PROMO.label}: ${CURRENT_PROMO.name}. Tap to view FRROP."
        >
            <span class="admin-promo-banner-bg" aria-hidden="true">
                <img src="${CURRENT_PROMO.imageUrl}" alt="">
            </span>
            <span class="admin-promo-banner-content">
                <span class="admin-promo-banner-text">
                    <span class="admin-promo-banner-label">${CURRENT_PROMO.label}</span>
                    <span class="admin-promo-banner-name">${CURRENT_PROMO.name}</span>
                </span>
                <span class="admin-promo-banner-cta">View FRROP</span>
            </span>
        </a>
    `;
}

function renderShell() {
    document.documentElement.classList.add('admin-overview-page');
    document.body.classList.add('admin-overview-page');
    app.innerHTML = `
        <div class="mic-page mic-page--admin">
            <header class="mic-header mic-header--admin">
                <div class="mic-header-brand">
                    <div class="nav-back-host" id="admin-overview-back"></div>
                    <div>
                        <h1>ADMIN OVERVIEW</h1>
                        <p class="subtitle">Market snapshot</p>
                    </div>
                </div>
                ${renderPromoBanner()}
                <div class="mic-header-actions">
                    <button type="button" class="mic-account-btn" id="admin-view-accounts-btn">View accounts</button>
                    <div class="mic-clock">
                        <span class="mic-clock-label">Current time</span>
                        <span class="mic-clock-value" id="admin-clock">${formatTime(new Date())}</span>
                    </div>
                </div>
            </header>
            <div class="mic-grid mic-grid--admin" id="admin-grid"></div>
        </div>
        ${window.MicSettings?.renderCog?.() || ''}
        ${window.MicSettings?.renderPanel?.({
            viewAccountsHidden: false,
            darkModeHint: 'Dark background and tiles on this overview.',
        }) || ''}
    `;
    window.DashboardNavBack?.mountBackButton(document.getElementById('admin-overview-back'), {
        fallback: '/admin',
        alwaysFallback: true,
    });
    document.getElementById('admin-view-accounts-btn')?.addEventListener('click', () => {
        window.DashboardAccount?.openViewAccountsModal?.({ isAdmin: true });
    });
    window.MicSettings?.bind?.({
        getViewAccountsOptions: () => ({ isAdmin: true }),
        resolveViewAccountsVisibility: false,
    });
    window.MicSettings?.initPreferences?.();
}

function areaRowCells(areas) {
    const last = areas.length - 1;
    const parts = [];
    areas.forEach((a, idx) => {
        const active = idx === areaIndex % areas.length;
        parts.push(
            `<button type="button" class="admin-area-text-tab${active ? ' is-active' : ''}" role="tab" aria-selected="${active}" data-area-index="${idx}">${a.name}</button>`
        );
        if (idx < last) {
            parts.push('<span class="admin-area-text-pipe" aria-hidden="true"> |</span>');
        }
    });
    return parts.join('');
}

function renderAreaSalesTotal(sales) {
    const actual = Number(sales?.actual) || 0;
    const forecast = Number(sales?.forecast) || 0;
    const progress = sales?.progress || {};
    const paceClass = progress.paceClass || 'cell-green';
    const timeFill = window.SalesProgress?.paceFillPercentFromProgress?.(progress) ?? 0;
    const layers = window.SalesProgress?.buildPaceStripHtml?.(timeFill, paceClass) || '';
    return `
        <div class="mic-store-lead-sales-stack">
            <div class="mic-store-lead-total-amount">${formatMoney(actual)} / ${formatMoney(forecast)}</div>
            <div class="mic-store-lead-pace-band">${layers}</div>
        </div>
    `;
}

function renderAreaTextSelector({ live = false } = {}) {
    const areas = overviewData?.areas || [];
    if (!areas.length) return '';
    const liveAttr = live ? ' aria-live="polite"' : '';
    return `
        <div class="admin-area-text-track" role="tablist"${liveAttr} data-area-count="${areas.length}">
            <div class="admin-area-text-row">${areaRowCells(areas)}</div>
        </div>`;
}

function setActiveAreaTab(track, index) {
    track.querySelectorAll('.admin-area-text-tab').forEach((tab, idx) => {
        const active = idx === index;
        tab.classList.toggle('is-active', active);
        tab.setAttribute('aria-selected', String(active));
    });
}

function applyAreaHighlight() {
    const track = document.querySelector('.admin-area-text-track');
    const areas = overviewData?.areas || [];
    if (!track || !areas.length) return;
    setActiveAreaTab(track, areaIndex % areas.length);
}

function updateAreaStoresTile(area) {
    const tile = document.querySelector('.mic-tile--pos-area-stores');
    if (!tile) return false;

    const sales = area?.salesToday || { actual: 0, forecast: 0 };
    const salesEl = tile.querySelector('.mic-store-lead-sales');
    if (salesEl) salesEl.innerHTML = renderAreaSalesTotal(sales);

    const listEl = tile.querySelector('.mic-store-lead-list');
    const rows =
        window.StoreSnapRow?.renderStoreSnapList?.(sortStoresByNumber(area?.storeSales), formatMoney, undefined, {
            storeBasePath: '/admin',
        }) || '<p class="mic-store-lead-empty">No stores in this area yet.</p>';
    if (listEl) listEl.innerHTML = rows;

    const track = tile.querySelector('.admin-area-text-track');
    if (track) setActiveAreaTab(track, areaIndex % Math.max(overviewData?.areas?.length || 1, 1));
    return true;
}

function updateVocTile(vocRaw = {}) {
    const tile = document.querySelector('.mic-tile--pos-voc');
    if (!tile) return;
    const voc = formatVocDisplay(vocRaw);
    const countEl = tile.querySelector('.mic-voc-count');
    if (countEl) countEl.textContent = voc.count;
    const metrics = tile.querySelectorAll('.mic-voc-metric');
    if (metrics[0]) metrics[0].textContent = `OSAT ${voc.osat == null ? '—' : `${voc.osat}%`}`;
    if (metrics[1]) metrics[1].textContent = `Acc ${voc.acc == null ? '—' : `${voc.acc}%`}`;
}

function updateSssgTile(area) {
    const tile = document.querySelector('.mic-tile--pos-sssg');
    if (!tile) return;
    const today = formatSssgDisplay(areaSssgToday(area));
    const wtd = formatSssgDisplay(areaSssgWtd(area));
    const valueEl = tile.querySelector('.mic-sssg-value');
    const wtdEl = tile.querySelector('.mic-sssg-wtd');
    if (valueEl) {
        valueEl.textContent = today.text;
        valueEl.className = `mic-sssg-value ${today.toneClass}`;
    }
    if (wtdEl) {
        wtdEl.textContent = `WTD ${wtd.text}`;
        wtdEl.className = `mic-sssg-wtd ${wtd.toneClass}`;
    }
    tile.classList.toggle('mic-tile--future', today.text === '—' && wtd.text === '—');
}

function replaceOrdersToPlaceTile(stores) {
    const tile = document.querySelector('.mic-tile--pos-orders');
    if (!tile) return;
    tile.outerHTML = renderOrdersToPlaceTile(stores);
}

function updateAreaTiles(area) {
    if (!document.querySelector('.mic-tile--pos-area-stores')) return false;
    updateAreaStoresTile(area);
    updateVocTile(currentVoc() || {});
    updateSssgTile(area);
    replaceOrdersToPlaceTile(overviewData?.storesNeedingOrders || []);
    return true;
}

function bindAreaTextSelector() {
    const grid = document.getElementById('admin-grid');
    if (!grid) return;
    grid.querySelectorAll('.admin-area-text-tab').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const idx = Number(btn.dataset.areaIndex);
            if (!Number.isFinite(idx)) return;
            areaIndex = idx;
            updateAreaTiles(currentArea());
            applyAreaHighlight();
        });
    });
}

function renderSssgTile(area) {
    return renderSssgTileBody(area).html;
}

function renderAdminLabelTile({ label, posClass, sub = 'Coming soon' }) {
    return `
        <article class="mic-tile ${posClass}">
            <div class="mic-tile-body">
                <div class="mic-tile-label">${escapeHtml(label)}</div>
                <div class="mic-tile-sub">${escapeHtml(sub)}</div>
            </div>
        </article>
    `;
}

function renderAreaStoresTile(area) {
    const sales = area?.salesToday || { actual: 0, forecast: 0 };
    const rows =
        window.StoreSnapRow?.renderStoreSnapList?.(sortStoresByNumber(area?.storeSales), formatMoney, undefined, {
            storeBasePath: '/admin',
        }) || '<p class="mic-store-lead-empty">No stores in this area yet.</p>';

    return `
        <article class="mic-tile mic-tile--store-leaderboard mic-tile--pos-area-stores">
            <div class="mic-store-lead mic-store-lead--purple">
                ${renderAreaTextSelector({ live: true })}
                <div class="mic-store-lead-sales">${renderAreaSalesTotal(sales)}</div>
            </div>
            <div class="mic-store-lead-list" role="list">${rows}</div>
        </article>
    `;
}

function ordersStoreDetail(entry) {
    const count = Number(entry?.pendingCount) || 0;
    if (count > 0) {
        return `${count} vendor${count === 1 ? '' : 's'} to count`;
    }
    return entry?.message || 'Open stock count';
}

function renderOrdersToPlaceTile(stores) {
    const list = Array.isArray(stores) ? stores : [];
    const hasStores = list.length > 0;
    const tone = hasStores ? 'mic-tile--orders-active' : 'mic-tile--orders-idle';
    const rows = hasStores
        ? list
              .map(
                  (store) => `
            <li class="mic-orders-store-item" role="listitem">
                <a
                    class="mic-orders-store-link"
                    href="${escapeHtml(store.href)}"
                    aria-label="${escapeHtml(`${store.storeName || store.storeNumber} — ${ordersStoreDetail(store)}`)}"
                >
                    <span class="mic-orders-store-title">
                        <span class="mic-orders-store-name">${escapeHtml(store.storeName || store.storeNumber)}</span>
                        <span class="mic-orders-store-num">${escapeHtml(store.storeNumber)}</span>
                    </span>
                    <span class="mic-orders-store-detail">${escapeHtml(ordersStoreDetail(store))}</span>
                </a>
            </li>`
              )
              .join('')
        : '<li class="mic-orders-store-empty">All orders are placed for today</li>';

    return `
        <article class="mic-tile mic-tile--orders-to-place ${tone} mic-tile--pos-orders">
            <div class="mic-tile-body mic-tile-body--orders">
                <div class="mic-tile-label">Orders to place</div>
                <ul class="mic-orders-store-list" role="list">${rows}</ul>
            </div>
        </article>
    `;
}

function renderTiles() {
    const grid = document.getElementById('admin-grid');
    if (!grid || !overviewData) return;
    const area = currentArea();
    const vocRaw = currentVoc() || {};
    const voc = formatVocDisplay(vocRaw);

    grid.innerHTML = `
        ${renderAreaStoresTile(area)}

        <a
            class="mic-tile mic-tile--link mic-tile--voc mic-tile--pos-voc"
            href="${SMG_REPORTING_URL}"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="VOC — open SMG reporting"
        >
            <div class="mic-tile-body">
                <div class="mic-tile-label">VOC</div>
                <div class="mic-voc-grid">
                    <div class="mic-voc-count">${voc.count}</div>
                    <div class="mic-voc-metrics">
                        <div class="mic-voc-metric">OSAT ${voc.osat == null ? '—' : `${voc.osat}%`}</div>
                        <div class="mic-voc-metric">Acc ${voc.acc == null ? '—' : `${voc.acc}%`}</div>
                    </div>
                </div>
                <div class="mic-tile-sub">Pipeline coming soon</div>
            </div>
        </a>

        ${renderSssgTile(area)}

        ${renderAdminLabelTile({ label: 'DFSC', posClass: 'mic-tile--pos-dfsc' })}
        ${renderAdminLabelTile({ label: 'Daily count', posClass: 'mic-tile--pos-daily-count' })}
        ${renderAdminLabelTile({ label: 'Square One', posClass: 'mic-tile--pos-square-one' })}
        ${renderOrdersToPlaceTile(overviewData?.storesNeedingOrders || [])}
    `;

    bindAreaTextSelector();
    applyAreaHighlight();
}

async function loadOverview() {
    if (overviewLoadInFlight) return;
    overviewLoadInFlight = true;
    try {
        const res = await fetch('/api/admin/overview', { credentials: 'same-origin' });
        const data = await res.json();
        if (!res.ok || !data.success) {
            app.textContent = data.error || 'Could not load admin overview.';
            return;
        }
        if (data.salesUpdatedAt) lastSalesUpdatedAt = data.salesUpdatedAt;
        overviewData = data;
        const areas = data.areas || [];
        if (areas.length) areaIndex = defaultAreaIndex(areas);
        if (!document.getElementById('admin-grid')) renderShell();
        renderTiles();
    } finally {
        overviewLoadInFlight = false;
    }
}

async function checkForScrapeUpdate() {
    if (overviewLoadInFlight) return;
    try {
        const res = await fetch('/api/admin/overview/status', { credentials: 'same-origin' });
        const data = await res.json();
        if (!res.ok || !data.success) return;
        const updatedAt = data.salesUpdatedAt || null;
        if (!updatedAt) return;
        if (!lastSalesUpdatedAt) {
            lastSalesUpdatedAt = updatedAt;
            return;
        }
        if (updatedAt !== lastSalesUpdatedAt) {
            await loadOverview();
        }
    } catch {
        /* ignore transient poll errors */
    }
}

applyDashboardScale();
renderShell();
loadOverview();
window.setInterval(() => {
    const clock = document.getElementById('admin-clock');
    if (clock) clock.textContent = formatTime(new Date());
}, 1000);
window.setInterval(loadOverview, REFRESH_MS);
window.setInterval(checkForScrapeUpdate, SCRAPE_POLL_MS);
