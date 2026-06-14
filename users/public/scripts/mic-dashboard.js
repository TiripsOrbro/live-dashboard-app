const IS_MIC_OVERVIEW = /^\/overview\/?$/i.test(window.location.pathname);
let STORE_NUMBER =
    (window.location.pathname.match(/^\/MIC\/(teststore|\d{3,6})\/?$/i) || [])[1] || '';

const app = document.getElementById('app');
const REFRESH_MS = 2 * 60 * 1000;
const TIME_ZONE = 'Australia/Melbourne';
const MULTIPLIER_NOTHING_LABEL = 'Nothing Yet...';

let micData = null;
let pickerOpen = false;
let pickerEscHandler = null;
let micCanViewAdminAuditSummary = false;

const VOC_PLACEHOLDER = { count: 30, osatPercent: 83, accuracyPercent: 90 };
const SMG_REPORTING_URL = 'https://reporting.smg.com/Index.aspx';

const CURRENT_PROMO = {
    label: 'Current Promo',
    name: 'Nacho Cheese Dip Burrito',
    imageUrl: '/images/promos/let-it-drip-banner.png',
    pdfUrl: '/documents/promos/let-it-drip-frrop.pdf',
};

const MIC_OVERVIEW_TABS = [
    { id: 'sales', label: 'Sales' },
    { id: 'results', label: 'Results' },
    { id: 'orders', label: 'Orders' },
    { id: 'audits', label: 'Audits' },
];
const MIC_TAB_STORAGE_KEY = 'mic-overview-active-tab';

let activeMicTab = sessionStorage.getItem(MIC_TAB_STORAGE_KEY) || 'sales';
let micOverviewTabsBound = false;

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
    window.MicOverviewScale?.apply?.();
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
            <nav
                class="mic-overview-tabs"
                id="mic-overview-tabs"
                role="tablist"
                aria-label="MIC overview sections"
                hidden
            ></nav>
            <div class="mic-grid mic-grid--admin" id="mic-grid"></div>
        </div>
        ${window.MicSettings?.renderCog?.() || ''}
        <!-- Daily item multiplier picker — disabled for now
        <div id="mic-item-picker" class="mic-item-picker" hidden>
            <div class="mic-item-picker-panel">
                <h2>Select item for 3× points today</h2>
                <div class="mic-item-list" id="mic-item-list"></div>
            </div>
        </div>
        -->
        ${window.MicSettings?.renderPanel?.({
            darkModeHint: 'Dark background and tiles on this MIC page.',
            storeNumber: STORE_NUMBER || '',
            reportEmail: micData?.reportEmail || '',
        }) || ''}
    `;
}

function renderSalesStack(sales) {
    const actual = Number(sales?.actual) || 0;
    const forecast = Number(sales?.forecast) || 0;
    const progress = sales?.progress || {};
    const paceClass = progress.paceClass || 'cell-green';
    const outcomeClass = progress.outcomeClass || paceClass;
    const timeFill = window.SalesProgress?.paceFillPercentFromProgress?.(progress) ?? 0;
    const layers =
        window.SalesProgress?.buildLiveProgressLayersHtml?.(timeFill, outcomeClass, paceClass) ||
        window.SalesProgress?.buildPaceStripHtml?.(timeFill, paceClass) ||
        '';
    const amounts =
        sales?.hours > 0
            ? `${formatMoney(actual)} / ${formatMoney(forecast)}`
            : 'Waiting for sales data';
    return `
        <div class="mic-store-lead-sales-stack">
            <div class="mic-store-lead-pace-band mic-store-lead-pace-band--with-amounts">
                ${layers}
                <span class="mic-store-lead-pace-amounts">${escapeHtml(amounts)}</span>
            </div>
        </div>
    `;
}

function renderSssgInlineBlock(sales = {}) {
    const today = formatSssgDisplay(sales.sssgPercent);
    const wtd = formatSssgDisplay(sales.sssgWtdPercent);
    const hasData = today.text !== '—' || wtd.text !== '—';
    return `
        <div class="mic-sssg-inline${hasData ? '' : ' mic-sssg-inline--future'}" aria-label="Same store sales growth">
            <div class="mic-sssg-inline-label">Today SSSG</div>
            <div class="mic-sssg-value ${today.toneClass}">${escapeHtml(today.text)}</div>
            <div class="mic-sssg-wtd ${wtd.toneClass}">WTD ${escapeHtml(wtd.text)}</div>
        </div>
    `;
}

/*
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
*/

function isMicMobileView() {
    return window.matchMedia('(max-width: 900px)').matches;
}

let lastMicMobileLayout = null;

function syncMicLayoutMode() {
    const mobile = isMicMobileView();
    document.body.classList.toggle('mic-overview--mobile', mobile);
    document.documentElement.classList.toggle('mic-overview--mobile', mobile);
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
        const hourlyHtml = window.MicMiniDashboard?.renderMobileHourlyWindow?.(sales, { allHours: true }) || '';
        return `
            <div class="mic-mini-dashboard mic-mini-dashboard--mobile">
                ${totalsHtml}
                ${hourlyHtml}
                <a class="mic-store-lead-dashboard-link mic-store-lead-dashboard-link--plain mic-meal-dashboard-link" href="${escapeHtml(window.AppPaths?.micStore?.(STORE_NUMBER) || `/MIC/${STORE_NUMBER}`)}">View full dashboard →</a>
            </div>
        `;
    }
    const gridHtml = window.MicMiniDashboard?.renderPortraitGrid?.(sales) || '';
    const hourCount = window.MicMiniDashboard?.getTradingHourCount?.(sales) ?? 12;
    return `
        <div class="mic-mini-dashboard">
            <div
                class="dashboard-grid dashboard-grid--portrait dashboard-grid--mic-fill"
                style="--mic-hour-count: ${hourCount}"
                role="region"
                aria-label="Today's sales by hour"
            >
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
    requestAnimationFrame(syncSalesHourlyScroll);
}

function renderMobileStoreLeadHeader(_sales, storeLabelHtml) {
    return `<div class="mic-store-lead-store-label mic-store-lead-store-label--mobile">${storeLabelHtml}</div>`;
}

function renderStoreSalesTile(data, { tabbed = false } = {}) {
    const sales = data?.salesToday || { actual: 0, forecast: 0 };
    const storeName = escapeHtml(data?.storeName || STORE_NUMBER);
    const storeLabel = data?.storeName && data.storeName !== STORE_NUMBER
        ? `${storeName} · ${escapeHtml(STORE_NUMBER)}`
        : storeName;
    const mobile = tabbed || isMicMobileView();
    const leadHeader = mobile
        ? renderMobileStoreLeadHeader(sales, storeLabel)
        : `<div class="mic-store-lead-store-label">${storeLabel}</div>`;
    const posClass = tabbed ? '' : ' mic-tile--pos-store-sales';
    return `
        <article class="mic-tile mic-tile--store-leaderboard${posClass}">
            <div class="mic-store-lead mic-store-lead--purple${mobile ? ' mic-store-lead--mobile' : ''}">
                ${leadHeader}
                <div class="mic-store-lead-sales">${renderSalesStack(sales)}</div>
            </div>
            <div class="mic-store-lead-list mic-store-lead-list--dashboard">
                ${renderMiniDashboard(sales)}
                ${mobile ? '' : `<a class="mic-store-lead-dashboard-link mic-store-lead-dashboard-link--plain" href="${escapeHtml(window.AppPaths?.micStore?.(STORE_NUMBER) || `/MIC/${STORE_NUMBER}`)}">Open full dashboard →</a>`}
                ${mobile ? '' : renderSssgInlineBlock(sales)}
            </div>
        </article>
    `;
}

function renderMicTabPanel(tabId, content) {
    return `
        <section
            class="mic-tab-panel mic-tab-panel--${tabId}"
            data-mic-tab-panel="${tabId}"
            id="mic-tabpanel-${tabId}"
            role="tabpanel"
            aria-labelledby="mic-tab-${tabId}"
        >
            ${content}
        </section>
    `;
}

function renderSssgTile(sales = {}, { tabbed = false } = {}) {
    const today = formatSssgDisplay(sales.sssgPercent);
    const wtd = formatSssgDisplay(sales.sssgWtdPercent);
    const hasData = today.text !== '—' || wtd.text !== '—';
    const futureClass = hasData ? '' : ' mic-tile--future';
    const posClass = tabbed ? '' : ' mic-tile--pos-sssg';
    return `
        <article class="mic-tile mic-tile--sssg${futureClass}${posClass}">
            <div class="mic-tile-body">
                <div class="mic-tile-label">Today SSSG</div>
                <div class="mic-sssg-value ${today.toneClass}">${escapeHtml(today.text)}</div>
                <div class="mic-sssg-wtd ${wtd.toneClass}">WTD ${escapeHtml(wtd.text)}</div>
            </div>
        </article>
    `;
}

function renderVocTile(voc, { tabbed = false, wide = false, inRow = false } = {}) {
    const posClass =
        tabbed || inRow ? '' : ` mic-tile--pos-voc${wide ? ' mic-tile--pos-voc-wide' : ''}`;
    return `
        <a
            class="mic-tile mic-tile--link mic-tile--voc${posClass}"
            href="${SMG_REPORTING_URL}"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="VOC — open SMG reporting"
        >
            <div class="mic-tile-body">
                <div class="mic-tile-label">VOC</div>
                <div class="mic-tile-main">${voc.count}</div>
                <div class="mic-tile-sub">OSAT ${voc.osat == null ? '—' : `${voc.osat}%`} · Acc ${voc.acc == null ? '—' : `${voc.acc}%`}</div>
                <div class="mic-tile-sub mic-tile-sub--footnote">Pipeline coming soon</div>
            </div>
        </a>
    `;
}

function renderMicOverviewTabsHtml() {
    return MIC_OVERVIEW_TABS.map(({ id, label }) => {
        const isActive = activeMicTab === id;
        return `
            <button
                type="button"
                class="mic-overview-tab${isActive ? ' is-active' : ''}"
                role="tab"
                id="mic-tab-${id}"
                aria-selected="${isActive ? 'true' : 'false'}"
                aria-controls="mic-tabpanel-${id}"
                data-mic-overview-tab="${id}"
            >${escapeHtml(label)}</button>
        `;
    }).join('');
}

function applyMicOverviewTab(tabId) {
    if (!MIC_OVERVIEW_TABS.some((tab) => tab.id === tabId)) {
        tabId = 'sales';
    }
    activeMicTab = tabId;
    sessionStorage.setItem(MIC_TAB_STORAGE_KEY, tabId);

    document.querySelectorAll('[data-mic-overview-tab]').forEach((button) => {
        const isActive = button.dataset.micOverviewTab === tabId;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    const tabClasses = [
        'mic-overview-tab--sales',
        'mic-overview-tab--results',
        'mic-overview-tab--orders',
        'mic-overview-tab--audits',
    ];
    document.body.classList.remove(...tabClasses);
    document.documentElement.classList.remove(...tabClasses);
    document.body.classList.add(`mic-overview-tab--${tabId}`);
    document.documentElement.classList.add(`mic-overview-tab--${tabId}`);

    const grid = document.getElementById('mic-grid');
    if (!grid) return;
    grid.querySelectorAll('[data-mic-tab-panel]').forEach((panel) => {
        const isActive = panel.dataset.micTabPanel === tabId;
        panel.hidden = !isActive;
        panel.classList.toggle('is-tab-active', isActive);
    });

    if (tabId === 'sales') {
        requestAnimationFrame(syncSalesHourlyScroll);
    }
}

function syncSalesHourlyScroll() {
    if (!isMicMobileView() || activeMicTab !== 'sales') return;

    const panel = document.querySelector('.mic-tab-panel--sales:not([hidden])');
    const hourly = panel?.querySelector('.mic-mobile-hourly--scroll');
    const body = hourly?.querySelector('.mic-mobile-hourly-body');
    const head = hourly?.querySelector('.mic-mobile-hourly-head');
    if (!panel || !hourly || !body) return;

    const hourlyRect = hourly.getBoundingClientRect();
    const headHeight = head?.offsetHeight || 0;
    const link = panel.querySelector('.mic-meal-dashboard-link');
    const bottomLimit = link
        ? link.getBoundingClientRect().top
        : panel.getBoundingClientRect().bottom;
    const available = bottomLimit - hourlyRect.top - headHeight - 4;
    const maxHeight = Math.max(120, Math.floor(available));

    body.style.maxHeight = `${maxHeight}px`;
    body.style.overflowY = 'auto';
    body.style.webkitOverflowScrolling = 'touch';
}

function bindMicOverviewTabs() {
    const nav = document.getElementById('mic-overview-tabs');
    if (!nav || micOverviewTabsBound) return;
    nav.addEventListener('click', (event) => {
        const button = event.target.closest('[data-mic-overview-tab]');
        if (!button) return;
        applyMicOverviewTab(button.dataset.micOverviewTab);
    });
    micOverviewTabsBound = true;
}

function syncMicOverviewTabs(mobile) {
    const nav = document.getElementById('mic-overview-tabs');
    const tabClasses = [
        'mic-overview-tab--sales',
        'mic-overview-tab--results',
        'mic-overview-tab--orders',
        'mic-overview-tab--audits',
    ];
    if (!mobile) {
        if (nav) nav.hidden = true;
        document.body.classList.remove(...tabClasses);
        document.documentElement.classList.remove(...tabClasses);
        return;
    }
    if (!nav) return;
    nav.hidden = false;
    nav.innerHTML = renderMicOverviewTabsHtml();
    bindMicOverviewTabs();
}

function renderBlankTile({ posClass = 'mic-tile--pos-blank' } = {}) {
    return `<article class="mic-tile mic-tile--blank ${posClass}" aria-hidden="true"></article>`;
}

function renderAdminLabelTile({ label, posClass, sub = 'Coming soon', tabbed = false, inRow = false, href = '' }) {
    const subHtml = sub
        ? `<div class="mic-tile-sub">${escapeHtml(sub)}</div>`
        : '';
    const gridPosClass = tabbed || inRow ? '' : ` ${posClass}`;
    const body = `
            <div class="mic-tile-body">
                <div class="mic-tile-label">${escapeHtml(label)}</div>
                ${subHtml}
            </div>`;
    if (href) {
        return `
        <a class="mic-tile mic-tile--link${gridPosClass}" href="${escapeHtml(href)}" aria-label="${escapeHtml(`${label} — ${sub}`)}">${body}</a>`;
    }
    return `<article class="mic-tile${gridPosClass}">${body}</article>`;
}

function shouldShowDfscTile(data) {
    const dfsc = data?.dfsc;
    if (!dfsc) return false;
    return !(dfsc.amCompleted && dfsc.pmCompleted);
}

function shouldShowOrdersTile(data) {
    const sc = data?.stockCount || {};
    return Number(sc.pendingCount) > 0;
}

const PSI_AUDIT_LABEL = 'Period Safety Inspection';

function storeWeeklyAuditsForTiles(data) {
    const tiles = data?.weeklyAudits?.auditTiles;
    const list = Array.isArray(tiles) && tiles.length ? tiles : weeklyAuditFallbackTiles();
    const due = list.filter((audit) => !audit.done);
    const psi = list.find((audit) => audit.label === PSI_AUDIT_LABEL);
    if (psi && !due.some((audit) => audit.label === PSI_AUDIT_LABEL)) {
        return [...due, psi];
    }
    return due;
}

function dueSquareOneTiles(data) {
    const tiles = data?.squareOneTiles;
    if (!Array.isArray(tiles)) return [];
    return tiles.filter((tile) => !tile.done);
}

function renderSquareOneTile(tile, { tabbed = false } = {}) {
    const label = escapeHtml(tile?.tileLabel || tile?.label || 'Square One');
    const sub = escapeHtml(tile?.sub || (tile?.done ? 'Complete' : 'Due this week'));
    const adminHref = tacauditAdminHrefForAudit(tile?.label, tile?.areaId);
    const href =
        adminHref ||
        tile?.href ||
        (tile?.areaId && STORE_NUMBER ? `/${STORE_NUMBER}/square-one?area=${encodeURIComponent(tile.areaId)}` : '');
    const doneClass = tile?.done ? ' mic-tile--audit-complete' : ' mic-tile--audit-due';
    const body = `
            <div class="mic-tile-body">
                <div class="mic-tile-label">${label}</div>
                <div class="mic-tile-sub">${sub}</div>
            </div>`;
    if (href) {
        return `
        <a
            class="mic-tile mic-tile--link mic-tile--weekly-audit mic-tile--square-one${doneClass}"
            href="${escapeHtml(href)}"
            aria-label="${escapeHtml(`${tile?.label || label} — ${sub}`)}"
        >${body}
        </a>`;
    }
    return `<article class="mic-tile mic-tile--weekly-audit mic-tile--square-one${doneClass}">${body}</article>`;
}

function countMicContentRows(data) {
    let rows = 2;
    if (storeWeeklyAuditsForTiles(data).length > 0 || dueSquareOneTiles(data).length > 0) rows += 1;
    return rows;
}

function renderEqualWidthRow(tileHtmlList, { rowNum, tabbed = false, extraClass = '' } = {}) {
    const tiles = tileHtmlList.filter(Boolean);
    if (!tiles.length) return '';
    const colCount = tiles.length;
    if (tabbed) {
        return `<div class="mic-tab-tile-row mic-tab-tile-row--cols-${colCount}">${tiles.join('')}</div>`;
    }
    const rowClass = rowNum ? ` mic-grid-equal-row--row-${rowNum}` : '';
    return `<div class="mic-grid-equal-row mic-grid-equal-row--cols-${colCount}${rowClass}${extraClass ? ` ${extraClass}` : ''}">${tiles.join('')}</div>`;
}

function renderDfscTile(data, { tabbed = false, inRow = false } = {}) {
    const dfsc = data?.dfsc;
    if (!dfsc || !shouldShowDfscTile(data)) return '';
    const adminHref =
        micCanViewAdminAuditSummary &&
        window.AppPaths?.tacauditAdminHub?.({ area: tacauditAdminAreaQuery() });
    const href = adminHref || dfsc.href || `/${STORE_NUMBER}/dfsc`;
    const sub = dfsc.subtext || 'AM pending · PM pending';
    const posClass = tabbed || inRow ? '' : ' mic-tile--pos-dfsc';
    return `
        <a
            class="mic-tile mic-tile--link${posClass}"
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

const WEEKLY_AUDIT_FORM_ROUTES = {
    'Pest Walk': (store) => `/${store}/pest-walk`,
    'RGM Cleaning Checklist': (store) => `/${store}/rgm-cleaning`,
    'RGM cleaning': (store) => `/${store}/rgm-cleaning`,
    'Period Safety Inspection': (store) => `/${store}/psi`,
    PSI: (store) => `/${store}/psi`,
};

function tacauditAdminAreaQuery() {
    const fromPayload = String(micData?.areaName || '').trim();
    if (fromPayload) return fromPayload;
    const areas = micData?.accessibleAreas;
    if (Array.isArray(areas) && areas.length === 1) return String(areas[0]).trim();
    return '';
}

function tacauditAdminHrefForAudit() {
    if (!micCanViewAdminAuditSummary) return '';
    return window.AppPaths?.tacauditAdminHub?.({ area: tacauditAdminAreaQuery() }) || '';
}

function weeklyAuditHref(audit) {
    const label = String(audit?.label || audit?.tileLabel || '').trim();
    const adminHref = tacauditAdminHrefForAudit(label);
    if (adminHref) return adminHref;
    if (audit?.href) return String(audit.href);
    const route = WEEKLY_AUDIT_FORM_ROUTES[label];
    return route && STORE_NUMBER ? route(STORE_NUMBER) : '';
}

function weeklyAuditFallbackTiles() {
    return [
        { label: 'Pest Walk', tileLabel: 'Pest Walk', sub: 'Due this week', done: false },
        { label: 'RGM Cleaning Checklist', tileLabel: 'RGM cleaning', sub: 'Due this week', done: false },
        { label: 'Period Safety Inspection', tileLabel: 'PSI', sub: 'Due this week', done: false },
    ];
}

function renderWeeklyAuditTile(audit, index, { tabbed = false } = {}) {
    const label = escapeHtml(audit?.tileLabel || audit?.label || 'Audit');
    const sub = escapeHtml(audit?.sub || (audit?.done ? 'Complete' : 'Due this week'));
    const href = weeklyAuditHref(audit);
    const doneClass = audit?.done ? ' mic-tile--audit-complete' : ' mic-tile--audit-due';
    const body = `
            <div class="mic-tile-body">
                <div class="mic-tile-label">${label}</div>
                <div class="mic-tile-sub">${sub}</div>
            </div>`;
    if (href) {
        return `
        <a
            class="mic-tile mic-tile--link mic-tile--weekly-audit${doneClass}"
            href="${escapeHtml(href)}"
            aria-label="${escapeHtml(`${audit?.label || label} — ${sub}`)}"
        >${body}
        </a>`;
    }
    return `<article class="mic-tile mic-tile--weekly-audit${doneClass}">${body}</article>`;
}

function renderWeeklyAuditTiles(data, { tabbed = false, rowNum = 2 } = {}) {
    const squareDue = dueSquareOneTiles(data);
    const weekly = storeWeeklyAuditsForTiles(data);
    const tiles = [
        ...squareDue.slice(0, 2).map((tile) => renderSquareOneTile(tile, { tabbed })),
        ...weekly.map((audit, index) => renderWeeklyAuditTile(audit, index, { tabbed })),
    ];
    if (!tiles.length) return '';
    if (tabbed) return renderEqualWidthRow(tiles, { tabbed: true });
    return renderEqualWidthRow(tiles, {
        rowNum,
        extraClass: 'mic-tile--pos-weekly-audit-row',
    });
}

function renderOrdersToPlaceTile(data, { tabbed = false, inRow = false } = {}) {
    const sc = data?.stockCount || {};
    const active = Boolean(sc.active);
    const sub = active ? ordersStoreDetail(sc) : 'All orders are placed for today';
    const href = active ? sc.href || window.AppPaths?.micStore?.(STORE_NUMBER) || `/MIC/${STORE_NUMBER}` : '';
    const posClass = tabbed || inRow ? '' : ' mic-tile--pos-orders';
    const body = `
            <div class="mic-tile-body">
                <div class="mic-tile-label">Orders to place</div>
                <div class="mic-tile-sub">${escapeHtml(sub)}</div>
            </div>`;
    if (href) {
        return `
        <a
            class="mic-tile mic-tile--link mic-tile--orders-to-place${posClass}"
            href="${escapeHtml(href)}"
            aria-label="${escapeHtml(`Orders to place — ${sub}`)}"
        >${body}
        </a>`;
    }
    return `<article class="mic-tile mic-tile--orders-to-place${posClass}">${body}</article>`;
}

function renderDailyCountTile(data, { tabbed = false, inRow = false } = {}) {
    const dc = data?.dailyStockCount || {};
    if (!dc.configured) return '';
    const sub = dc.sub || dc.message || 'Open daily count';
    const href = dc.href || `/${STORE_NUMBER}/daily-stock-count`;
    const posClass = tabbed || inRow ? '' : ' mic-tile--pos-daily-count';
    const body = `
            <div class="mic-tile-body">
                <div class="mic-tile-label">Daily count</div>
                <div class="mic-tile-sub">${escapeHtml(sub)}</div>
            </div>`;
    if (dc.clickable && href) {
        return `
        <a
            class="mic-tile mic-tile--link mic-tile--daily-count${posClass}"
            href="${escapeHtml(href)}"
            aria-label="${escapeHtml(`Daily count — ${sub}`)}"
        >${body}
        </a>`;
    }
    return `<article class="mic-tile mic-tile--daily-count${posClass}">${body}</article>`;
}

function renderSquareOneMiddleTile(data, { inRow = false } = {}) {
    const due = dueSquareOneTiles(data);
    if (due.length >= 2) return '';
    if (due.length === 1) return renderSquareOneTile(due[0], { tabbed: false });
    const all = data?.squareOneTiles || [];
    if (all.length && all.every((t) => t.done)) {
        return renderAdminLabelTile({
            label: 'Square One',
            sub: 'Complete this week',
            posClass: 'mic-tile--pos-square-one',
            inRow,
        });
    }
    const squareHref =
        tacauditAdminHrefForAudit('Square One') || (STORE_NUMBER ? `/${STORE_NUMBER}/square-one` : '');
    return renderAdminLabelTile({
        label: 'Square One',
        sub: 'Due this week',
        posClass: 'mic-tile--pos-square-one',
        inRow,
        href: squareHref,
    });
}

function renderStoreTopRow(data) {
    const voc = formatVocDisplay(data?.voc || {});
    const tiles = [renderVocTile(voc, { inRow: true })];
    if (shouldShowDfscTile(data)) {
        tiles.push(renderDfscTile(data, { inRow: true }));
    }
    if (!tiles.length) return '';
    return renderEqualWidthRow(tiles, { rowNum: 'top' });
}

function renderDesktopMiddleRow(data) {
    const tiles = [
        renderSquareOneMiddleTile(data, { inRow: true }),
        renderDailyCountTile(data, { inRow: true }),
    ].filter(Boolean);
    if (shouldShowOrdersTile(data)) {
        tiles.push(renderOrdersToPlaceTile(data, { inRow: true }));
    }
    return renderEqualWidthRow(tiles, { rowNum: 1, extraClass: 'mic-tile--pos-middle-row' });
}

function renderMobileOrdersTab(data) {
    const tiles = [];
    if (shouldShowOrdersTile(data)) {
        tiles.push(renderOrdersToPlaceTile(data, { tabbed: true }));
    }
    tiles.push(renderDailyCountTile(data, { tabbed: true }));
    return renderEqualWidthRow(tiles, { tabbed: true });
}

function renderMobileAuditsTab(data) {
    const parts = [];
    const dfscHtml = renderDfscTile(data, { tabbed: true });
    if (dfscHtml) parts.push(dfscHtml);
    const auditRow = renderWeeklyAuditTiles(data, { tabbed: true });
    if (auditRow) parts.push(auditRow);
    if (!parts.length) {
        return '<p class="mic-tile-empty mic-tile-empty--audits">All audits complete for this week</p>';
    }
    return parts.join('');
}

function renderDesktopTiles(data) {
    return `
        ${renderStoreSalesTile(data)}
        ${renderStoreTopRow(data)}
        ${renderDesktopMiddleRow(data)}
        ${renderWeeklyAuditTiles(data)}
    `;
}

function renderMobileTabbedTiles(data) {
    const voc = formatVocDisplay(data?.voc || {});
    const tabbed = true;
    return `
        ${renderMicTabPanel('sales', renderStoreSalesTile(data, { tabbed }))}
        ${renderMicTabPanel(
            'results',
            `
            ${renderVocTile(voc, { tabbed })}
            ${renderSssgTile(data?.salesToday || {}, { tabbed })}
        `
        )}
        ${renderMicTabPanel('orders', renderMobileOrdersTab(data))}
        ${renderMicTabPanel('audits', renderMobileAuditsTab(data))}
    `;
}

function renderTiles(data) {
    const grid = document.getElementById('mic-grid');
    if (!grid) return;
    const mobile = isMicMobileView();

    syncMicOverviewTabs(mobile);
    grid.classList.toggle('mic-grid--tabbed', mobile);
    if (!mobile) {
        grid.style.setProperty('--mic-content-rows', String(countMicContentRows(data)));
    } else {
        grid.style.removeProperty('--mic-content-rows');
    }
    grid.innerHTML = mobile ? renderMobileTabbedTiles(data) : renderDesktopTiles(data);

    if (mobile) {
        applyMicOverviewTab(activeMicTab);
        requestAnimationFrame(syncSalesHourlyScroll);
    }

    /*
    const multiplierTile = document.getElementById('mic-multiplier-tile');
    if (multiplierTile) {
        multiplierTile.addEventListener('click', openItemPicker);
    }
    */
}

/*
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
*/

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
    const storeParam = STORE_NUMBER ? `?store=${encodeURIComponent(STORE_NUMBER)}` : '';
    const res = await fetch(`/api/overview${storeParam}`, {
        credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
        app.textContent = data.error || 'Could not load MIC overview.';
        return;
    }
    micData = await enrichMicSalesHourly(data);
    window.MicSettings?.setStoreContext?.({
        storeNumber: STORE_NUMBER || '',
        reportEmail: micData.reportEmail || '',
    });
    const label = document.getElementById('mic-store-label');
    if (label) {
        label.textContent = micData.storeName
            ? `${micData.storeName} · ${STORE_NUMBER}`
            : `Store ${STORE_NUMBER}`;
    }
    if (!document.getElementById('mic-grid')) renderShell();
    renderTiles(micData);
}

async function resolveMicStoreNumber() {
    if (STORE_NUMBER) return STORE_NUMBER;
    if (!IS_MIC_OVERVIEW) return '';
    try {
        const res = await fetch('/api/me', { credentials: 'same-origin' });
        if (!res.ok) return '';
        const me = await res.json();
        const stores = me.stores === '*' ? [] : Array.isArray(me.stores) ? me.stores.map(String) : [];
        if (stores.length === 1) return stores[0].toLowerCase();
        const fromUser = String(me.username || '').match(/(\d{3,6})/);
        if (fromUser) return fromUser[1].toLowerCase();
    } catch {
        /* ignore */
    }
    return '';
}

async function fetchMeProfile() {
    try {
        const res = await fetch('/api/me', { credentials: 'same-origin' });
        if (!res.ok) return null;
        const data = await res.json();
        return data.success !== false ? data : null;
    } catch {
        return null;
    }
}

async function initStoreOverview() {
    if (!STORE_NUMBER && IS_MIC_OVERVIEW) {
        STORE_NUMBER = await resolveMicStoreNumber();
    }
    if (!STORE_NUMBER) {
        app.textContent = 'Invalid store.';
        return;
    }
    if (!micCanViewAdminAuditSummary) {
        const me = await fetchMeProfile();
        micCanViewAdminAuditSummary = Boolean(me?.canViewCrossStoreAccounts);
    }
    window.MicOverviewScale?.bind?.();
    renderShell();
    syncMicLayoutMode();
    window.MicSettings?.bind?.({
        getViewAccountsOptions: () => ({ storeNumber: STORE_NUMBER }),
        storeNumber: STORE_NUMBER || '',
        onReportEmailSaved: (email) => {
            if (micData) micData.reportEmail = email;
        },
    });
    window.AdminMenu?.bind?.({
        getViewAccountsOptions: () => ({ storeNumber: STORE_NUMBER }),
    });
    window.AdminAccounts?.maybeOpenFromQuery?.();
    window.MicSettings?.initPreferences?.();
    loadMicData();
    window.setInterval(() => {
        const clock = document.getElementById('mic-clock');
        if (clock) clock.textContent = formatTime(new Date());
    }, 1000);
    window.setInterval(refreshMiniDashboard, 60 * 1000);
    window.setInterval(loadMicData, REFRESH_MS);
    window.addEventListener('resize', () => {
        syncMicLayoutMode();
        requestAnimationFrame(syncSalesHourlyScroll);
    });
}

async function init() {
    if (!IS_MIC_OVERVIEW) {
        await initStoreOverview();
        return;
    }
    const me = await fetchMeProfile();
    const scope = me?.overviewScope || 'store';
    if (scope !== 'store') {
        window.MicOverviewMulti?.start(me, app, renderPromoBanner());
        return;
    }
    await initStoreOverview();
}

init();
