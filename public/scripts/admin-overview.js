const app = document.getElementById('app');
const REFRESH_MS = 2 * 60 * 1000;
const TIME_ZONE = 'Australia/Melbourne';
const MULTIPLIER_NOTHING_LABEL = 'Nothing Yet...';

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
let pickerOpen = false;

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

function renderShell() {
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
            <div class="mic-grid" id="admin-grid"></div>
        </div>
        <div id="admin-item-picker" class="mic-item-picker" hidden>
            <div class="mic-item-picker-panel admin-picker-panel">
                <h2>Add item multiplier (3× today)</h2>
                <div class="admin-picker-scope">
                    <label><input type="radio" name="scope" value="all" checked> All stores</label>
                    <label><input type="radio" name="scope" value="pick"> Selected stores</label>
                </div>
                <div id="admin-store-checkboxes" class="admin-store-checkboxes" hidden></div>
                <div class="mic-item-list" id="admin-item-list"></div>
            </div>
        </div>
    `;
    window.DashboardNavBack?.mountBackButton(document.getElementById('admin-overview-back'), {
        fallback: '/admin',
    });
    document.getElementById('admin-view-accounts-btn')?.addEventListener('click', () => {
        window.DashboardAccount?.openViewAccountsModal?.({ isAdmin: true });
    });
}

function renderAreaHeading(areaName, { live = false } = {}) {
    const text = areaName || 'Area';
    const liveAttr = live ? ' aria-live="polite"' : '';
    return `<div class="admin-tile-area"${liveAttr}>${text}</div>`;
}

function renderMultiplierBody(rules) {
    if (!rules?.length) {
        const label = overviewData?.multiplierNothingLabel || MULTIPLIER_NOTHING_LABEL;
        return `<div class="mic-tile-main">${label}</div>
                <div class="mic-tile-sub">No multipliers set for today</div>`;
    }
    return rules
        .map((rule) => {
            const stores =
                rule.stores?.includes('*') || rule.stores?.[0] === '*'
                    ? 'All stores'
                    : (rule.stores || []).join(', ');
            const pts = (Number(rule.basePoints) || 0) * (Number(rule.multiplier) || 3);
            return `<div class="mic-tile-sub"><strong>${rule.itemLabel}</strong> — ${rule.multiplier}× (${pts} pts) · ${stores}</div>`;
        })
        .join('');
}

function renderSalesTile(area, areaName) {
    const sales = area?.salesToday || { actual: 0, forecast: 0, hours: 0 };
    const prog = sales.progress || {
        phase: 'empty',
        timeFillPercent: 0,
        outcomeClass: 'cell-green',
        paceClass: 'cell-green',
    };
    const sp = window.SalesProgress;
    const borderColor = sp?.paceBorderMap?.[prog.outcomeClass] || 'var(--blank-border)';
    const showLive = prog.phase === 'during' || prog.phase === 'after';
    const fillPct = prog.phase === 'after' ? 100 : Number(prog.timeFillPercent) || 0;
    const layers =
        showLive && sp?.buildLiveProgressLayersHtml
            ? sp.buildLiveProgressLayersHtml(fillPct, prog.outcomeClass, prog.paceClass)
            : '';
    const liveClass = showLive ? ' mic-tile--sales-live' : '';
    const amounts = `${formatMoney(sales.actual)} / ${formatMoney(sales.forecast)}`;

    return `
        <a class="mic-tile mic-tile--link mic-tile--area-header${liveClass}" href="/stores" style="border: var(--cell-border) ${borderColor};">
            ${layers}
            ${renderAreaHeading(areaName, { live: true })}
            <div class="mic-tile-sales-content">
                <div class="mic-tile-body">
                    <div class="mic-tile-label">Actual vs Forecast</div>
                    <div class="mic-tile-main mic-tile-main--sales">${amounts}</div>
                    <div class="mic-tile-sub">Today so far</div>
                </div>
                <div class="mic-tile-foot">Go to store select →</div>
            </div>
        </a>
    `;
}

function renderSssgTile(areaName) {
    return `
        <article class="mic-tile mic-tile--sssg mic-tile--future mic-tile--area-header">
            ${renderAreaHeading(areaName)}
            <div class="mic-tile-body">
                <div class="mic-tile-label">SSSG %</div>
                <div class="mic-tile-sub">Pipeline coming soon</div>
            </div>
        </article>
    `;
}

function renderPromoTile() {
    return `
        <a
            class="mic-tile mic-tile--link mic-tile--promo"
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
        <${tag} class="${classes}"${hrefAttr}${clickable ? '' : ' aria-disabled="true"'}>
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
    const rules = overviewData.activeMultipliers || [];

    const areaName = area?.name;

    grid.innerHTML = `
        ${renderSalesTile(area, areaName)}

        <a
            class="mic-tile mic-tile--link mic-tile--voc mic-tile--area-header"
            href="${SMG_REPORTING_URL}"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="VOC — open SMG reporting"
        >
            ${renderAreaHeading(areaName)}
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

        ${renderSssgTile(areaName)}

        <article class="mic-tile mic-tile--multiplier" id="admin-multiplier-tile">
            <div class="mic-tile-body">
                <div class="mic-tile-label">Daily item multipliers</div>
                ${renderMultiplierBody(rules)}
            </div>
            <div class="mic-tile-foot">${rules.length ? 'Tap to add another' : 'Tap to add'}</div>
        </article>

        ${renderPromoTile()}

        ${renderStockCountTile(area?.stockCount)}
    `;

    const multiplierTile = document.getElementById('admin-multiplier-tile');
    if (multiplierTile) {
        multiplierTile.style.cursor = 'pointer';
        multiplierTile.addEventListener('click', openAdminPicker);
    }
}

function startRotation() {
    if (rotateTimer) clearInterval(rotateTimer);
    const areas = overviewData?.areas || [];
    if (!areas.length) return;
    areaIndex = areaIndex % areas.length;
    const ms = overviewData?.rotateIntervalMs || 8000;
    rotateTimer = window.setInterval(() => {
        const list = overviewData?.areas || [];
        if (!list.length) return;
        areaIndex = (areaIndex + 1) % list.length;
        renderTiles();
    }, ms);
}

async function loadStoresForPicker() {
    const res = await fetch('/api/stores', { credentials: 'same-origin' });
    const data = await res.json();
    return data.stores || [];
}

function openAdminPicker() {
    if (pickerOpen) return;
    pickerOpen = true;
    const picker = document.getElementById('admin-item-picker');
    const list = document.getElementById('admin-item-list');
    picker.hidden = false;

    list.innerHTML = (overviewData?.items || [])
        .map(
            (item) => `
        <button type="button" class="mic-item-option" data-item="${encodeURIComponent(item.label)}">
            ${item.label}
            <span class="mic-item-option-points">${item.basePoints} pts normally</span>
        </button>`
        )
        .join('');

    loadStoresForPicker().then((stores) => {
        const box = document.getElementById('admin-store-checkboxes');
        box.innerHTML = stores
            .map(
                (s) =>
                    `<label><input type="checkbox" value="${s.storeNumber}"> ${s.storeNumber} ${s.storeName || ''}</label>`
            )
            .join('');
    });

    document.querySelectorAll('input[name="scope"]').forEach((radio) => {
        radio.addEventListener('change', () => {
            const pick = document.querySelector('input[name="scope"]:checked')?.value === 'pick';
            document.getElementById('admin-store-checkboxes').hidden = !pick;
        });
    });

    list.querySelectorAll('.mic-item-option').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const itemLabel = decodeURIComponent(btn.dataset.item || '');
            const scopeAll = document.querySelector('input[name="scope"]:checked')?.value === 'all';
            let body = { itemLabel, allStores: scopeAll };
            if (!scopeAll) {
                const stores = [...document.querySelectorAll('#admin-store-checkboxes input:checked')].map(
                    (el) => el.value
                );
                if (!stores.length) {
                    alert('Select at least one store.');
                    return;
                }
                body.stores = stores;
            }
            const res = await fetch('/api/mic/daily-item-multiplier', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify(body),
            });
            const data = await res.json();
            if (!data.success) {
                alert(data.error || 'Failed to add multiplier');
                return;
            }
            picker.hidden = true;
            pickerOpen = false;
            await loadOverview();
        });
    });
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
