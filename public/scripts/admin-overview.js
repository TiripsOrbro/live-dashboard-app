const app = document.getElementById('app');
const REFRESH_MS = 2 * 60 * 1000;
const TIME_ZONE = 'Australia/Melbourne';
const VOC_PLACEHOLDER = { count: 30, osatPercent: 83, accuracyPercent: 90 };
const SMG_REPORTING_URL = 'https://reporting.smg.com/Index.aspx';

const CURRENT_PROMO = {
    label: 'Current Promo',
    name: 'Nacho Cheese Dip Burrito',
    imageUrl: '/images/promos/nacho-cheese-dip-burrito.png',
    pdfUrl: '/documents/promos/let-it-drip-frrop.pdf',
};

let overviewData = null;
let areaIndex = 0;
let rotateTimer = null;

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

function formatAreaSssg(area) {
    const stores = Array.isArray(area?.storeSales) ? area.storeSales : [];
    const values = stores
        .map((s) => s.sssgPercent)
        .filter((v) => v != null && !Number.isNaN(Number(v)))
        .map((v) => Number(v));
    if (!values.length) return null;
    const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
    return Math.round(avg * 10) / 10;
}

function renderShell() {
    document.documentElement.classList.add('admin-overview-page');
    document.body.classList.add('admin-overview-page');
    app.innerHTML = `
        <div class="mic-page">
            <header class="mic-header">
                <div class="nav-back-host" id="admin-overview-back"></div>
                <div>
                    <h1>ADMIN OVERVIEW</h1>
                    <p class="subtitle">Market snapshot</p>
                </div>
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
    `;
    window.DashboardNavBack?.mountBackButton(document.getElementById('admin-overview-back'), {
        fallback: '/admin',
        alwaysFallback: true,
    });
    document.getElementById('admin-view-accounts-btn')?.addEventListener('click', () => {
        window.DashboardAccount?.openViewAccountsModal?.({ isAdmin: true });
    });
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
    const stores = Array.isArray(area?.storeSales) ? area.storeSales : [];
    const rows =
        window.StoreSnapRow?.renderStoreSnapList?.(stores, formatMoney, undefined, {
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
    const sssg = formatAreaSssg(area);
    const valueEl = tile.querySelector('.mic-sssg-value');
    const subEl = tile.querySelector('.mic-tile-sub');
    if (valueEl) valueEl.textContent = sssg == null ? '—' : `${sssg}%`;
    if (subEl) {
        subEl.textContent =
            sssg == null ? 'Pipeline coming soon' : `${area?.name || 'Area'} average`;
    }
    tile.classList.toggle('mic-tile--future', sssg == null);
}

function replaceStockCountTile(stock) {
    const tile = document.querySelector('.mic-tile--pos-stock');
    if (!tile) return;
    tile.outerHTML = renderStockCountTile(stock);
}

function updateAreaTiles(area) {
    if (!document.querySelector('.mic-tile--pos-area-stores')) return false;
    updateAreaStoresTile(area);
    updateVocTile(currentVoc() || {});
    updateSssgTile(area);
    replaceStockCountTile(area?.stockCount);
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
            stopRotation();
        });
    });
}

function renderSssgTile(area) {
    const sssg = formatAreaSssg(area);
    const futureClass = sssg == null ? ' mic-tile--future' : '';
    return `
        <article class="mic-tile mic-tile--sssg${futureClass} mic-tile--pos-sssg">
            <div class="mic-tile-body">
                <div class="mic-tile-label">SSSG %</div>
                <div class="mic-sssg-value">${sssg == null ? '—' : `${sssg}%`}</div>
                <div class="mic-tile-sub">${
                    sssg == null ? 'Pipeline coming soon' : `${area?.name || 'Area'} average`
                }</div>
            </div>
        </article>
    `;
}

function renderPromoTile() {
    return `
        <a
            class="mic-tile mic-tile--link mic-tile--promo mic-tile--pos-promo"
            href="${CURRENT_PROMO.pdfUrl}"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="${CURRENT_PROMO.label}: ${CURRENT_PROMO.name}. Tap to view FRROP."
        >
            <div class="mic-promo-media" aria-hidden="true">
                <img src="${CURRENT_PROMO.imageUrl}" alt="">
                <p class="mic-promo-name">${CURRENT_PROMO.name}</p>
            </div>
            <div class="mic-promo-idle">
                <span class="mic-tile-label">${CURRENT_PROMO.label}</span>
                <span class="mic-tile-foot mic-promo-foot">tap to view FRROP</span>
            </div>
        </a>
    `;
}

function renderAreaStoresTile(area) {
    const sales = area?.salesToday || { actual: 0, forecast: 0 };
    const stores = Array.isArray(area?.storeSales) ? area.storeSales : [];
    const rows =
        window.StoreSnapRow?.renderStoreSnapList?.(stores, formatMoney, undefined, {
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

function renderStockCountTile(stock) {
    const sc = stock || {};
    const active = Boolean(sc.active);
    const clickable = Boolean(sc.clickable && sc.href);
    const tag = clickable ? 'a' : 'article';
    const hrefAttr = clickable ? ` href="${sc.href}"` : '';
    const classes = [
        'mic-tile',
        'mic-tile--stock-count',
        active ? 'mic-tile--stock-active' : 'mic-tile--stock-idle',
        clickable ? 'mic-tile--link' : '',
    ]
        .filter(Boolean)
        .join(' ');
    const foot = clickable
        ? 'Open stock count →'
        : active
          ? 'Stock counts due in area'
          : '';
    return `
        <${tag} class="${classes} mic-tile--pos-stock"${hrefAttr}${clickable ? '' : ' aria-disabled="true"'}>
            <div class="mic-tile-body">
                <div class="mic-tile-label">Stock count</div>
                <div class="mic-tile-main">${active ? 'Orders to place' : 'All clear'}</div>
                <div class="mic-tile-sub">${sc.message || ''}</div>
            </div>
            ${foot ? `<div class="mic-tile-foot">${foot}</div>` : ''}
        </${tag}>
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

        ${renderPromoTile()}

        ${renderStockCountTile(area?.stockCount)}
    `;

    bindAreaTextSelector();
    applyAreaHighlight();
}

function stopRotation() {
    if (rotateTimer) {
        clearInterval(rotateTimer);
        rotateTimer = null;
    }
}

function startRotation() {
    stopRotation();
    const areas = overviewData?.areas || [];
    if (!areas.length) return;
    areaIndex = areaIndex % areas.length;
    const ms = overviewData?.rotateIntervalMs || 8000;
    rotateTimer = window.setInterval(() => {
        const list = overviewData?.areas || [];
        if (!list.length) return;
        areaIndex = (areaIndex + 1) % list.length;
        if (!updateAreaTiles(currentArea())) renderTiles();
        else applyAreaHighlight();
    }, ms);
}

async function loadOverview() {
    const res = await fetch('/api/admin/overview', { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok || !data.success) {
        app.textContent = data.error || 'Could not load admin overview.';
        return;
    }
    overviewData = data;
    const areas = data.areas || [];
    if (areas.length) areaIndex = areaIndex % areas.length;
    if (!document.getElementById('admin-grid')) renderShell();
    renderTiles();
    startRotation();
}

applyDashboardScale();
renderShell();
loadOverview();
window.setInterval(() => {
    const clock = document.getElementById('admin-clock');
    if (clock) clock.textContent = formatTime(new Date());
}, 1000);
window.setInterval(loadOverview, REFRESH_MS);
