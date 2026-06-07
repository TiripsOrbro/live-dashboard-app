const STORE_NUMBER =
    (window.location.pathname.match(/\/(\d{3,6})\/mic\/?$/i) || [])[1] || '';

const app = document.getElementById('app');
const REFRESH_MS = 2 * 60 * 1000;
const TIME_ZONE = 'Australia/Melbourne';
const MULTIPLIER_NOTHING_LABEL = 'Nothing Yet...';

let micData = null;
let pickerOpen = false;
let pickerEscHandler = null;

const VOC_PLACEHOLDER = { count: 30, osatPercent: 83, accuracyPercent: 90 };
const SMG_REPORTING_URL = 'https://reporting.smg.com/Index.aspx';

const CURRENT_PROMO = {
    label: 'Current Promo',
    name: 'Nacho Cheese Dip Burrito',
    imageUrl: '/images/promos/let-it-drip-banner.png',
    pdfUrl: '/documents/promos/let-it-drip-frrop.pdf',
};

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
    const n = Number(value) || 0;
    return `$${n.toLocaleString('en-AU')}`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
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

function formatSssgDisplay(value) {
    if (value == null || Number.isNaN(Number(value))) {
        return { text: '—', toneClass: 'mic-sssg--na' };
    }
    const n = Number(value);
    const sign = n > 0 ? '+' : '';
    const toneClass = n > 0 ? 'mic-sssg--up' : n < 0 ? 'mic-sssg--down' : 'mic-sssg--na';
    return { text: `${sign}${n}%`, toneClass };
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
    document.documentElement.classList.add('mic-overview-page');
    document.body.classList.add('mic-overview-page');
    app.innerHTML = `
        <div class="mic-page mic-page--admin" id="mic-page">
            <header class="mic-header mic-header--admin">
                <div class="mic-header-brand">
                    <div>
                        <h1>MIC OVERVIEW</h1>
                        <p class="subtitle" id="mic-store-label">Store ${STORE_NUMBER}</p>
                    </div>
                </div>
                ${renderPromoBanner()}
                <div class="mic-header-actions">
                    <div class="mic-clock">
                        <span class="mic-clock-label">Current time</span>
                        <span class="mic-clock-value" id="mic-clock">${formatTime(new Date())}</span>
                    </div>
                </div>
            </header>
            <div class="mic-grid mic-grid--admin" id="mic-grid"></div>
        </div>
        ${window.MicSettings?.renderCog?.() || ''}
        <div id="mic-item-picker" class="mic-item-picker" hidden>
            <div class="mic-item-picker-panel">
                <h2>Select item for 3× points today</h2>
                <div class="mic-item-list" id="mic-item-list"></div>
            </div>
        </div>
        ${window.MicSettings?.renderPanel?.({
            darkModeHint: 'Dark background and tiles on this MIC page.',
        }) || ''}
    `;
}

function renderSalesStack(sales) {
    const actual = Number(sales?.actual) || 0;
    const forecast = Number(sales?.forecast) || 0;
    const progress = sales?.progress || {};
    const paceClass = progress.paceClass || 'cell-green';
    const timeFill = window.SalesProgress?.paceFillPercentFromProgress?.(progress) ?? 0;
    const layers = window.SalesProgress?.buildPaceStripHtml?.(timeFill, paceClass) || '';
    const amounts =
        sales?.hours > 0
            ? `${formatMoney(actual)} / ${formatMoney(forecast)}`
            : 'Waiting for sales data';
    return `
        <div class="mic-store-lead-sales-stack">
            <div class="mic-store-lead-total-amount">${amounts}</div>
            <div class="mic-store-lead-pace-band">${layers}</div>
        </div>
    `;
}

function renderMultiplierBlock(data) {
    const rules =
        data?.dailyItemMultipliers || (data?.dailyItemMultiplier ? [data.dailyItemMultiplier] : []);
    const hasRules = rules.length > 0;
    const rule = hasRules ? rules[0] : null;
    const pts = rule
        ? (Number(rule.basePoints) || 0) * (Number(rule.multiplier) || 3)
        : 0;
    const soldCount = rule?.soldCount;
    const soldHtml = hasRules
        ? `<div class="mic-multiplier-pick-sold"><span class="mic-multiplier-pick-sold-num">${soldCount == null ? '—' : soldCount}</span><span class="mic-multiplier-pick-sold-label">sold today</span></div>`
        : '';

    return `
        <button type="button" class="mic-multiplier-pick${hasRules ? ' mic-multiplier-pick--active' : ''}" id="mic-multiplier-tile">
            <span class="mic-multiplier-pick-kicker">Daily item multipliers</span>
            <span class="mic-multiplier-pick-body">
                ${
                    hasRules
                        ? `<span class="mic-multiplier-pick-item">${escapeHtml(rule.itemLabel)}</span>
                           <span class="mic-multiplier-pick-badge">${rule.multiplier}× · ${pts} pts</span>
                           ${soldHtml}`
                        : `<span class="mic-multiplier-pick-idle">${escapeHtml(micData?.multiplierNothingLabel || MULTIPLIER_NOTHING_LABEL)}</span>
                           <span class="mic-multiplier-pick-hint">Tap to choose today's 3× item</span>`
                }
            </span>
            <span class="mic-multiplier-pick-action">${hasRules ? 'Tap to change' : 'Tap to choose'}</span>
        </button>
    `;
}

function isMicMobileView() {
    return window.matchMedia('(max-width: 900px)').matches;
}

let lastMicMobileLayout = null;

function syncMicLayoutMode() {
    const mobile = isMicMobileView();
    document.body.classList.toggle('mic-overview--mobile', mobile);
    if (lastMicMobileLayout !== null && lastMicMobileLayout !== mobile && micData) {
        renderTiles(micData);
    }
    lastMicMobileLayout = mobile;
    return mobile;
}

function renderMiniDashboard(sales) {
    const mobile = isMicMobileView();
    if (mobile) {
        const totalsHtml = window.MicMiniDashboard?.renderMobileMealTotals?.(sales) || '';
        return `
            <div class="mic-mini-dashboard mic-mini-dashboard--mobile">
                ${totalsHtml}
                <a class="mic-store-lead-dashboard-link mic-store-lead-dashboard-link--plain mic-meal-dashboard-link" href="/${escapeHtml(STORE_NUMBER)}">View full dashboard →</a>
            </div>
        `;
    }
    const gridHtml = window.MicMiniDashboard?.renderPortraitGrid?.(sales) || '';
    return `
        <div class="mic-mini-dashboard">
            <div class="dashboard-grid dashboard-grid--portrait" role="region" aria-label="Today's sales by hour">
                ${gridHtml}
            </div>
        </div>
    `;
}

function refreshMiniDashboard() {
    if (!micData?.salesToday) return;
    const host = document.querySelector('.mic-mini-dashboard');
    if (!host) return;
    host.outerHTML = renderMiniDashboard(micData.salesToday);
}

function renderStoreSalesTile(data) {
    const sales = data?.salesToday || { actual: 0, forecast: 0 };
    const storeName = escapeHtml(data?.storeName || STORE_NUMBER);
    const storeLabel = data?.storeName && data.storeName !== STORE_NUMBER
        ? `${storeName} · ${escapeHtml(STORE_NUMBER)}`
        : storeName;
    return `
        <article class="mic-tile mic-tile--store-leaderboard mic-tile--pos-store-sales">
            <div class="mic-store-lead mic-store-lead--purple">
                <div class="mic-store-lead-store-label">${storeLabel}</div>
                <div class="mic-store-lead-sales">${renderSalesStack(sales)}</div>
            </div>
            <div class="mic-store-lead-list mic-store-lead-list--dashboard">
                ${renderMiniDashboard(sales)}
                ${isMicMobileView() ? '' : `<a class="mic-store-lead-dashboard-link mic-store-lead-dashboard-link--plain" href="/${escapeHtml(STORE_NUMBER)}">Open full dashboard →</a>`}
                ${renderMultiplierBlock(data)}
            </div>
        </article>
    `;
}

function renderSssgTile(sales = {}) {
    const today = formatSssgDisplay(sales.sssgPercent);
    const wtd = formatSssgDisplay(sales.sssgWtdPercent);
    const hasData = today.text !== '—' || wtd.text !== '—';
    const futureClass = hasData ? '' : ' mic-tile--future';
    return `
        <article class="mic-tile mic-tile--sssg${futureClass} mic-tile--pos-sssg">
            <div class="mic-tile-body">
                <div class="mic-tile-label">Today SSSG</div>
                <div class="mic-sssg-value ${today.toneClass}">${escapeHtml(today.text)}</div>
                <div class="mic-sssg-wtd ${wtd.toneClass}">WTD ${escapeHtml(wtd.text)}</div>
            </div>
        </article>
    `;
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

function renderDfscTile(data) {
    const dfsc = data?.dfsc;
    if (!dfsc) return '';
    const href = dfsc.href || `/${STORE_NUMBER}/dfsc`;
    const sub = dfsc.subtext || 'AM pending · PM pending';
    const tone = dfsc.inProgress ? 'mic-tile--orders-active' : dfsc.amCompleted && dfsc.pmCompleted ? 'mic-tile--stock-idle' : 'mic-tile--orders-idle';
    return `
        <a
            class="mic-tile mic-tile--link ${tone} mic-tile--pos-dfsc"
            href="${escapeHtml(href)}"
            aria-label="Daily Food Safety Check"
        >
            <div class="mic-tile-body">
                <div class="mic-tile-label">DFSC</div>
                <div class="mic-tile-sub">${escapeHtml(sub)}</div>
            </div>
        </a>
    `;
}

function ordersStoreDetail(entry) {
    const count = Number(entry?.pendingCount) || 0;
    if (count > 0) {
        return `${count} vendor${count === 1 ? '' : 's'} to count`;
    }
    return entry?.message || 'Open stock count';
}

function renderOrdersToPlaceTile(data) {
    const sc = data?.stockCount || {};
    const active = Boolean(sc.active);
    const tone = active ? 'mic-tile--orders-active' : 'mic-tile--orders-idle';
    const rows = active
        ? `
            <li class="mic-orders-store-item" role="listitem">
                <a
                    class="mic-orders-store-link"
                    href="${escapeHtml(sc.href || `/${STORE_NUMBER}`)}"
                    aria-label="${escapeHtml(`${data?.storeName || STORE_NUMBER} — ${ordersStoreDetail(sc)}`)}"
                >
                    <span class="mic-orders-store-title">
                        <span class="mic-orders-store-name">${escapeHtml(data?.storeName || STORE_NUMBER)}</span>
                        <span class="mic-orders-store-num">${escapeHtml(STORE_NUMBER)}</span>
                    </span>
                    <span class="mic-orders-store-detail">${escapeHtml(ordersStoreDetail(sc))}</span>
                </a>
            </li>`
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

function renderTiles(data) {
    const grid = document.getElementById('mic-grid');
    if (!grid) return;
    const sales = data?.salesToday || { actual: 0, forecast: 0 };
    const voc = formatVocDisplay(data?.voc || {});

    grid.innerHTML = `
        ${renderStoreSalesTile(data)}

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

        ${renderSssgTile(sales)}

        ${renderDfscTile(data)}
        ${renderAdminLabelTile({ label: 'Daily count', posClass: 'mic-tile--pos-daily-count' })}
        ${renderAdminLabelTile({ label: 'Square One', posClass: 'mic-tile--pos-square-one' })}
        ${renderOrdersToPlaceTile(data)}
    `;

    const multiplierTile = document.getElementById('mic-multiplier-tile');
    if (multiplierTile) {
        multiplierTile.addEventListener('click', openItemPicker);
    }
}

function pickerItems() {
    return (micData?.items || []).filter((item) => !/\bbox\b/i.test(String(item?.label || '')));
}

function openItemPicker() {
    if (pickerOpen) return;
    pickerOpen = true;
    const picker = document.getElementById('mic-item-picker');
    const list = document.getElementById('mic-item-list');
    if (!picker || !list) return;
    const items = pickerItems();
    const nothingOption = `
        <button type="button" class="mic-item-option mic-item-option--none" data-clear="true">
            Nothing
            <span class="mic-item-option-points">No multiplier today</span>
        </button>
    `;
    list.innerHTML = items.length
        ? `${nothingOption}${items
              .map(
                  (item) => `
            <button type="button" class="mic-item-option" data-item="${encodeURIComponent(item.label)}">
                ${escapeHtml(item.label)}
                <span class="mic-item-option-points">${item.basePoints} pts normally</span>
            </button>
        `
              )
              .join('')}`
        : `${nothingOption}<p class="mic-tile-sub">No upsell items configured in .points yet.</p>`;
    picker.hidden = false;
    list.querySelectorAll('.mic-item-option').forEach((button) => {
        button.addEventListener('click', async () => {
            if (button.dataset.clear === 'true') {
                await clearDailyMultiplier();
            } else {
                const itemLabel = decodeURIComponent(button.dataset.item || '');
                await setDailyMultiplier(itemLabel);
            }
            closeItemPicker();
        });
    });
    pickerEscHandler = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeItemPicker();
        }
    };
    document.addEventListener('keydown', pickerEscHandler);
}

function closeItemPicker() {
    const picker = document.getElementById('mic-item-picker');
    if (!picker) return;
    if (pickerEscHandler) {
        document.removeEventListener('keydown', pickerEscHandler);
        pickerEscHandler = null;
    }
    picker.classList.add('is-closing');
    window.setTimeout(() => {
        picker.hidden = true;
        picker.classList.remove('is-closing');
        pickerOpen = false;
    }, 350);
}

async function setDailyMultiplier(itemLabel) {
    const res = await fetch('/api/mic/daily-item-multiplier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ store: STORE_NUMBER, itemLabel }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not set multiplier.');
    }
    await loadMicData();
}

async function clearDailyMultiplier() {
    const res = await fetch('/api/mic/daily-item-multiplier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ store: STORE_NUMBER, clear: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not clear multiplier.');
    }
    await loadMicData();
}

async function enrichMicSalesHourly(data) {
    const sales = data?.salesToday || {};
    const resolved = window.MicMiniDashboard?.resolveHourly?.(sales);
    if (resolved?.forecasts?.length || resolved?.actuals?.length) {
        if (!sales.actualHourly?.length && !sales.forecastHourly?.length) {
            data.salesToday = {
                ...sales,
                actualHourly: resolved.actuals,
                forecastHourly: resolved.forecasts,
                hours: Math.max(resolved.actuals.length, resolved.forecasts.length) || sales.hours,
            };
        }
        return data;
    }

    try {
        const res = await fetch(`/api/sales?store=${encodeURIComponent(STORE_NUMBER)}`, {
            credentials: 'same-origin',
        });
        const slice = await res.json();
        if (!res.ok || !slice.success) return data;
        const trim = window.MicMiniDashboard?.trimHourlyToTradingWindow;
        const trimmed = trim
            ? trim(slice.actual, slice.forecast, slice.openHour ?? sales.openHour, slice.closeHour ?? sales.closeHour)
            : { actual: [], forecast: [] };
        if (!trimmed.actual.length && !trimmed.forecast.length) return data;
        data.salesToday = {
            ...sales,
            openHour: slice.openHour ?? sales.openHour,
            closeHour: slice.closeHour ?? sales.closeHour,
            timeZone: slice.timeZone ?? sales.timeZone,
            rawActual: slice.actual,
            rawForecast: slice.forecast,
            actualHourly: trimmed.actual,
            forecastHourly: trimmed.forecast,
            hours: Math.max(trimmed.actual.length, trimmed.forecast.length) || sales.hours,
        };
    } catch {
        /* keep totals-only payload */
    }
    return data;
}

async function loadMicData() {
    const res = await fetch(`/api/mic?store=${encodeURIComponent(STORE_NUMBER)}`, {
        credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
        app.textContent = data.error || 'Could not load MIC overview.';
        return;
    }
    micData = await enrichMicSalesHourly(data);
    const label = document.getElementById('mic-store-label');
    if (label) {
        label.textContent = micData.storeName
            ? `${micData.storeName} · ${STORE_NUMBER}`
            : `Store ${STORE_NUMBER}`;
    }
    if (!document.getElementById('mic-grid')) renderShell();
    renderTiles(micData);
}

function init() {
    if (!STORE_NUMBER) {
        app.textContent = 'Invalid store.';
        return;
    }
    applyDashboardScale();
    renderShell();
    syncMicLayoutMode();
    window.MicSettings?.bind?.({
        getViewAccountsOptions: () => ({ storeNumber: STORE_NUMBER }),
    });
    window.MicSettings?.initPreferences?.();
    loadMicData();
    window.setInterval(() => {
        const clock = document.getElementById('mic-clock');
        if (clock) clock.textContent = formatTime(new Date());
    }, 1000);
    window.setInterval(refreshMiniDashboard, 60 * 1000);
    window.setInterval(loadMicData, REFRESH_MS);
    window.addEventListener('resize', () => {
        applyDashboardScale();
        syncMicLayoutMode();
    });
}

init();
