const IS_ADMIN_TACAUDIT =
    /^\/tacaudit\/(summary|actions)\/?$/i.test(window.location.pathname) ||
    /^\/Admin\/tacaudit\/?$/i.test(window.location.pathname);
const IS_ADMIN_SUMMARY =
    /^\/tacaudit\/summary\/?$/i.test(window.location.pathname) ||
    /^\/Admin\/tacaudit\/?$/i.test(window.location.pathname);
const IS_ADMIN_ACTIONS = /^\/tacaudit\/actions\/?$/i.test(window.location.pathname);
const pathMatch = window.location.pathname.match(/^\/(teststore|\d{3,6})\/tacaudit(?:\/actions)?\/?$/i);
const IS_STORE_ACTIONS = Boolean(pathMatch && /\/actions\/?$/i.test(window.location.pathname));
const STORE_NUMBER = IS_ADMIN_TACAUDIT ? '' : pathMatch ? pathMatch[1].toLowerCase() : '';

const SPLASH_STATUS_CYCLE = ['blank', 'opened', 'complete'];

document.documentElement.classList.add('dfsc-page');
document.body.classList.add('dfsc-page', 'tacaudit-page');

const app = document.getElementById('app');

const AUDIT_CONFIG = {
    dfsc: {
        label: 'DFSC',
        sessionApi: '/api/dfsc/session',
        deleteApi: '/api/dfsc/session',
        reopenApi: '/api/dfsc/reopen',
        reportApi: '/api/dfsc/report.pdf',
        auditPath: 'dfsc/audit',
        dateParam: 'dateKey',
        rowTitle(row) {
            return `${row.dateKey || '—'} · ${row.shift || '—'} shift`;
        },
    },
    'pest-walk': {
        label: 'Pest Walk',
        sessionApi: '/api/pest-walk/session',
        deleteApi: '/api/pest-walk/session',
        reopenApi: '/api/pest-walk/reopen',
        reportApi: '/api/pest-walk/report.pdf',
        auditPath: 'pest-walk/audit',
        dateParam: 'periodKey',
        rowTitle(row) {
            return row.periodKey || '—';
        },
    },
    'rgm-cleaning': {
        label: 'RGM Cleaning',
        sessionApi: '/api/rgm-cleaning/session',
        deleteApi: '/api/rgm-cleaning/session',
        reopenApi: '/api/rgm-cleaning/reopen',
        reportApi: '/api/rgm-cleaning/report.pdf',
        auditPath: 'rgm-cleaning/audit',
        dateParam: 'periodKey',
        rowTitle(row) {
            return row.periodKey || '—';
        },
    },
    psi: {
        label: 'PSI',
        sessionApi: '/api/psi/session',
        deleteApi: '/api/psi/session',
        reopenApi: '/api/psi/reopen',
        reportApi: '/api/psi/report.pdf',
        auditPath: 'psi/audit',
        dateParam: 'periodKey',
        rowTitle(row) {
            const week = row.psiWeek ? `Week ${row.psiWeek}` : '';
            return [row.periodKey, week].filter(Boolean).join(' · ') || '—';
        },
    },
    'square-one': {
        label: 'Square One',
        sessionApi: '/api/square-one/session',
        deleteApi: '/api/square-one/session',
        reopenApi: '/api/square-one/reopen',
        reportApi: '/api/square-one/report.pdf',
        auditPath: 'square-one/audit',
        dateParam: 'periodKey',
        rowTitle(row) {
            return row.areaTitle || row.dashboardLabel || row.periodKey || '—';
        },
    },
    'core-ops': {
        label: 'CORE Operations',
        sessionApi: '/api/core-ops/session',
        deleteApi: '/api/core-ops/session',
        reopenApi: '/api/core-ops/reopen',
        reportApi: '/api/core-ops/report.pdf',
        auditPath: 'core-ops/audit',
        dateParam: 'periodKey',
        rowTitle(row) {
            return row.periodKey || '—';
        },
    },
    'core-food-safety': {
        label: 'CORE Food Safety',
        sessionApi: '/api/core-food-safety/session',
        deleteApi: '/api/core-food-safety/session',
        reopenApi: '/api/core-food-safety/reopen',
        reportApi: '/api/core-food-safety/report.pdf',
        auditPath: 'core-food-safety/audit',
        dateParam: 'periodKey',
        rowTitle(row) {
            return row.periodKey || '—';
        },
    },
    'visit-coach': {
        label: 'Visiting as a Coach',
        sessionApi: '/api/visit-coach/session',
        deleteApi: '/api/visit-coach/session',
        reopenApi: '/api/visit-coach/reopen',
        reportApi: '/api/visit-coach/report.pdf',
        auditPath: 'visit-coach/audit',
        dateParam: 'periodKey',
        rowTitle(row) {
            return row.periodKey || '—';
        },
    },
    'visit-customer': {
        label: 'Visiting as a Customer',
        sessionApi: '/api/visit-customer/session',
        deleteApi: '/api/visit-customer/session',
        reopenApi: '/api/visit-customer/reopen',
        reportApi: '/api/visit-customer/report.pdf',
        auditPath: 'visit-customer/audit',
        dateParam: 'periodKey',
        rowTitle(row) {
            return row.periodKey || '—';
        },
    },
};

let context = null;
let activeTab = 'dfsc';
let inspectionHistory = [];
let historyDetailRow = null;
let historyDetailSession = null;
let historyDetailCanReopen = false;
let view = 'main';
let statusMessage = '';
let statusKind = '';
let savingSettings = false;
let adminSummary = null;
let summaryLoading = false;
let actionsList = [];
let actionsLoading = false;
let actionsFilterStore = '';
let submittingActionId = '';
let scopeMeta = null;
let complianceWeeks = [];
let complianceMeta = null;
let complianceViewLevel = 'area';

function tacauditPath() {
    return window.AppPaths?.tacaudit?.(STORE_NUMBER) || `/${STORE_NUMBER}/tacaudit`;
}

function currentAreaName() {
    if (IS_ADMIN_TACAUDIT) {
        return (
            new URLSearchParams(window.location.search).get('area') ||
            context?.areaName ||
            adminSummary?.areaName ||
            ''
        );
    }
    return context?.areaName || '';
}

function splashViewUrl() {
    if (window.AppPaths?.tacauditSplash) {
        return window.AppPaths.tacauditSplash({
            area: currentAreaName(),
            store: STORE_NUMBER || undefined,
        });
    }
    const url = new URL(IS_ADMIN_TACAUDIT ? '/tacaudit/summary' : tacauditPath(), window.location.origin);
    url.searchParams.set('view', 'status');
    const area = currentAreaName();
    if (area) url.searchParams.set('area', area);
    return `${url.pathname}${url.search}`;
}

function actionsViewUrl(storeFilter = '') {
    if (window.AppPaths?.tacauditActions) {
        return window.AppPaths.tacauditActions({
            area: currentAreaName(),
            store: storeFilter || STORE_NUMBER || undefined,
        });
    }
    if (IS_ADMIN_TACAUDIT || !STORE_NUMBER) {
        const url = new URL('/tacaudit/actions', window.location.origin);
        const area = currentAreaName();
        if (area) url.searchParams.set('area', area);
        if (storeFilter) url.searchParams.set('store', storeFilter);
        return `${url.pathname}${url.search}`;
    }
    const base = `/${STORE_NUMBER}/tacaudit/actions`;
    return storeFilter ? `${base}?store=${encodeURIComponent(storeFilter)}` : base;
}

function adminHubUrl(area = '') {
    if (window.AppPaths?.tacauditAdminHub) {
        return window.AppPaths.tacauditAdminHub({ area: area || currentAreaName() });
    }
    const url = new URL('/tacaudit/summary', window.location.origin);
    const a = area || currentAreaName();
    if (a) url.searchParams.set('area', a);
    return `${url.pathname}${url.search}`;
}

function normalizeSplashStatus(status) {
    const value = String(status || 'blank').toLowerCase();
    if (value === 'notstarted' || value === 'unavailable' || value === 'count') return 'blank';
    return SPLASH_STATUS_CYCLE.includes(value) ? value : 'blank';
}

function nextSplashStatus(current) {
    const normalized = normalizeSplashStatus(current);
    const idx = SPLASH_STATUS_CYCLE.indexOf(normalized);
    const next = SPLASH_STATUS_CYCLE[(idx + 1) % SPLASH_STATUS_CYCLE.length];
    return next;
}

function setViewInUrl(nextView) {
    const url = new URL(window.location.href);
    if (nextView === 'main') {
        url.searchParams.delete('view');
    } else {
        url.searchParams.set('view', nextView);
    }
    window.history.replaceState({}, '', url);
}

function micPath() {
    return window.AppPaths?.overview?.() || '/overview';
}

function navigateBackToOverview() {
    const dest = micPath();
    if (window.DashboardPageTransition?.navigateBackToStores) {
        window.DashboardPageTransition.navigateBackToStores(dest);
        return;
    }
    window.location.href = dest;
}

function mountBackNav() {
    window.DashboardNavBack?.mountBackButton(document.getElementById('tacaudit-nav-back'), {
        fallback: micPath(),
        alwaysFallback: true,
        fade: IS_ADMIN_TACAUDIT,
    });
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function apiUrl(path, params = {}) {
    const url = new URL(path, window.location.origin);
    for (const [key, value] of Object.entries(params)) {
        if (value != null && value !== '') url.searchParams.set(key, value);
    }
    return url.toString();
}

async function fetchJson(url, options = {}) {
    const res = await fetch(url, { credentials: 'include', ...options });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
        throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
}

function formatAuditTime(iso) {
    if (!iso) return '—';
    const parsed = Date.parse(iso);
    if (!Number.isFinite(parsed)) return iso;
    return new Date(parsed).toLocaleString('en-AU', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    });
}

function formatDuration(minutes) {
    if (minutes == null || !Number.isFinite(Number(minutes))) return '—';
    const m = Number(minutes);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem ? `${h}h ${rem}m` : `${h}h`;
}

function formatDurationTaken(minutes) {
    const formatted = formatDuration(minutes);
    return formatted === '—' ? '' : `Took ${formatted}`;
}

function completedHistoryMeta(row) {
    const parts = [
        row.conductorName || 'Unknown',
        `Completed ${formatAuditTime(row.completedAt)}`,
    ];
    const took = formatDurationTaken(row.durationMinutes);
    if (took) parts.push(took);
    if (row.nonCompliantCount) parts.push(`${row.nonCompliantCount} NC`);
    if (row.score != null) parts.push(`Score ${row.score}`);
    return parts.join(' · ');
}

function renderStatus() {
    if (!statusMessage) return '';
    const cls = statusKind === 'error' ? 'dfsc-status dfsc-status--error' : 'dfsc-status dfsc-status--info';
    return `<div class="${cls}" role="status">${escapeHtml(statusMessage)}</div>`;
}

function renderStatusBar() {
    const bar = document.getElementById('tacaudit-status-bar');
    if (bar) bar.innerHTML = renderStatus();
}

function auditCfg(type = activeTab) {
    return AUDIT_CONFIG[type] || null;
}

function renderTabs() {
    const types = context?.auditTypes || [];
    return `
        <div class="tacaudit-tabs" role="tablist" aria-label="Audit history">
            ${types
                .map(
                    (tab) => `
                <button type="button" class="tacaudit-tab${tab.id === activeTab ? ' is-active' : ''}" data-tab="${escapeHtml(tab.id)}" role="tab" aria-selected="${tab.id === activeTab}">
                    ${escapeHtml(tab.label)}
                </button>`
                )
                .join('')}
        </div>`;
}

function renderHistoryList() {
    const cfg = auditCfg();
    if (!inspectionHistory.length) {
        const days = context?.archiveRetentionDays || 45;
        return `<p class="dfsc-history-empty">No completed ${escapeHtml(cfg?.label || 'audit')} inspections yet. Finished audits are kept for ${days} days.</p>`;
    }
    return `
        <ul class="dfsc-history-list">
            ${inspectionHistory
                .map((row) => {
                    const title = cfg?.rowTitle ? cfg.rowTitle(row) : row.completedAt || '—';
                    const archiveBadge = row.archiveOnly
                        ? '<span class="tacaudit-archive-badge">archive</span>'
                        : '';
                    return `
                <li class="dfsc-history-item">
                    <button type="button" class="dfsc-history-row" data-history-id="${escapeHtml(row.id)}" data-history-date="${escapeHtml(row.dateKey || row.periodKey || '')}">
                        <span class="dfsc-history-row-main">
                            <span class="dfsc-history-row-title">${escapeHtml(title)}${archiveBadge}</span>
                            <span class="dfsc-history-row-sub">${escapeHtml(completedHistoryMeta(row))}</span>
                        </span>
                        <span class="dfsc-history-chevron" aria-hidden="true">›</span>
                    </button>
                </li>`;
                })
                .join('')}
        </ul>`;
}

function renderAdminHistoryList() {
    const cfg = auditCfg();
    if (!inspectionHistory.length) {
        const days = context?.archiveRetentionDays || 45;
        return `<p class="dfsc-history-empty">No completed ${escapeHtml(cfg?.label || 'audit')} inspections across this area yet. Finished audits are kept for ${days} days.</p>`;
    }
    return `
        <ul class="dfsc-history-list">
            ${inspectionHistory
                .map((row) => {
                    const detail = cfg?.rowTitle ? cfg.rowTitle(row) : row.completedAt || '—';
                    const title = `${row.storeName || row.storeNumber} · ${detail}`;
                    const archiveBadge = row.archiveOnly
                        ? '<span class="tacaudit-archive-badge">archive</span>'
                        : '';
                    return `
                <li class="dfsc-history-item">
                    <div class="dfsc-history-row dfsc-history-row--static">
                        <span class="dfsc-history-row-main">
                            <span class="dfsc-history-row-title">${escapeHtml(title)}${archiveBadge}</span>
                            <span class="dfsc-history-row-sub">${escapeHtml(completedHistoryMeta(row))}</span>
                        </span>
                    </div>
                </li>`;
                })
                .join('')}
        </ul>`;
}

function bindLaunchRowDragScroll() {
    const row = document.querySelector('.tacaudit-launch-row');
    if (!row) return;

    let dragging = false;
    let didDrag = false;
    let startX = 0;
    let startScrollLeft = 0;
    let activePointerId = null;

    function endDrag() {
        if (!dragging) return;
        dragging = false;
        row.classList.remove('is-drag-scroll');
        if (activePointerId != null && row.hasPointerCapture(activePointerId)) {
            row.releasePointerCapture(activePointerId);
        }
        activePointerId = null;
    }

    row.addEventListener(
        'click',
        (e) => {
            if (!didDrag) return;
            e.preventDefault();
            e.stopPropagation();
            didDrag = false;
        },
        true
    );

    row.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        dragging = true;
        didDrag = false;
        startX = e.clientX;
        startScrollLeft = row.scrollLeft;
        activePointerId = e.pointerId;
        row.classList.add('is-drag-scroll');
        row.setPointerCapture(e.pointerId);
    });

    row.addEventListener('pointermove', (e) => {
        if (!dragging || e.pointerId !== activePointerId) return;
        const delta = e.clientX - startX;
        if (Math.abs(delta) > 4) didDrag = true;
        if (!didDrag) return;
        e.preventDefault();
        row.scrollLeft = startScrollLeft - delta;
    });

    row.addEventListener('pointerup', endDrag);
    row.addEventListener('pointercancel', endDrag);
    row.addEventListener('lostpointercapture', endDrag);
}

function resumeAuditUrl(audit, storeNumber = STORE_NUMBER) {
    const cfg = AUDIT_CONFIG[audit?.auditType];
    const store = String(storeNumber || audit?.storeNumber || STORE_NUMBER || '').trim();
    if (!cfg?.auditPath || !audit?.id || !store) return '';
    const params = new URLSearchParams({ session: audit.id });
    const dateVal = audit[cfg.dateParam] || audit.dateKey || audit.periodKey;
    if (dateVal && cfg.dateParam) params.set(cfg.dateParam, dateVal);
    return `/${store}/${cfg.auditPath}?${params.toString()}`;
}

function inProgressForTab(tab) {
    return (context?.inProgressAudits || []).filter((audit) => audit.auditType === tab);
}

function inProgressMeta(audit) {
    const parts = [`Started ${formatAuditTime(audit.startedAt)}`];
    if (audit.auditType === 'dfsc') {
        parts.push(`${audit.dateKey || '—'} · ${audit.shift || '—'} shift`);
    } else if (audit.auditType === 'psi' && audit.psiWeek) {
        parts.push(`${audit.periodKey || '—'} · Week ${audit.psiWeek}`);
    } else if (audit.auditType === 'square-one') {
        parts.push(audit.areaTitle || audit.dashboardLabel || audit.periodKey || '—');
    } else {
        parts.push(audit.periodKey || audit.dateKey || '—');
    }
    return parts.join(' · ');
}

function renderStoreInProgressTabBlock(tab) {
    const audits = inProgressForTab(tab);
    if (!audits.length) return '';
    const rows = audits
        .map((audit) => {
            const href = resumeAuditUrl(audit);
            const title = `${audit.auditLabel || 'Audit'} · ${audit.conductorName || 'Unknown'}`;
            const auditKey = encodeURIComponent(
                JSON.stringify({
                    id: audit.id,
                    auditType: audit.auditType,
                    periodKey: audit.periodKey,
                    dateKey: audit.dateKey,
                    conductorName: audit.conductorName,
                    auditLabel: audit.auditLabel,
                })
            );
            return `
        <li class="dfsc-open-item">
            <div class="dfsc-open-main">
                <div class="dfsc-open-title">${escapeHtml(title)}</div>
                <div class="dfsc-open-meta">${escapeHtml(inProgressMeta(audit))}</div>
            </div>
            <div class="dfsc-open-actions">
                <a class="dfsc-btn dfsc-btn-secondary dfsc-btn-sm" href="${escapeHtml(href)}">Resume</a>
                <button type="button" class="dfsc-btn dfsc-btn-danger dfsc-btn-sm" data-delete-in-progress="${auditKey}">Delete</button>
            </div>
        </li>`;
        })
        .join('');
    return `
        <div class="tacaudit-tab-in-progress dfsc-open-section" aria-labelledby="tacaudit-tab-in-progress-heading">
            <div class="dfsc-open-head">
                <h3 id="tacaudit-tab-in-progress-heading" class="tacaudit-tab-in-progress__heading">In progress</h3>
                <span class="dfsc-open-count">${audits.length}</span>
            </div>
            <ul class="dfsc-open-list">${rows}</ul>
        </div>`;
}

function renderAdminInProgressTabBlock(tab) {
    const audits = inProgressForTab(tab);
    if (!audits.length) return '';
    const rows = audits
        .map((audit) => {
            const storeNum = audit.storeNumber || '';
            const title = `${audit.storeName || storeNum} · ${audit.auditLabel || 'Audit'} · ${audit.conductorName || 'Unknown'}`;
            const href = resumeAuditUrl(audit, storeNum);
            return `
        <li class="dfsc-open-item">
            <div class="dfsc-open-main">
                <div class="dfsc-open-title">${escapeHtml(title)}</div>
                <div class="dfsc-open-meta">${escapeHtml(inProgressMeta(audit))}</div>
            </div>
            <div class="dfsc-open-actions">
                ${href ? `<a class="dfsc-btn dfsc-btn-secondary dfsc-btn-sm" href="${escapeHtml(href)}">Resume</a>` : ''}
            </div>
        </li>`;
        })
        .join('');
    return `
        <div class="tacaudit-tab-in-progress dfsc-open-section" aria-labelledby="tacaudit-admin-tab-in-progress-heading">
            <div class="dfsc-open-head">
                <h3 id="tacaudit-admin-tab-in-progress-heading" class="tacaudit-tab-in-progress__heading">In progress across area</h3>
                <span class="dfsc-open-count">${audits.length}</span>
            </div>
            <ul class="dfsc-open-list">${rows}</ul>
        </div>`;
}

function renderTabPanelContent({ admin = false } = {}) {
    const inProgress = admin ? renderAdminInProgressTabBlock(activeTab) : renderStoreInProgressTabBlock(activeTab);
    const completed = admin ? renderAdminHistoryList() : renderHistoryList();
    return `${inProgress}${completed}`;
}

function bindTabButtons() {
    document.querySelectorAll('[data-tab]').forEach((btn) => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
}

function renderLaunchTiles() {
    const tiles = context?.launchTiles || [];
    if (!tiles.length) return '';
    return `
        <section class="tacaudit-launch-section" aria-labelledby="tacaudit-launch-heading">
            <h2 id="tacaudit-launch-heading" class="tacaudit-launch-heading">Start an audit</h2>
            <div class="tacaudit-launch-row" role="list">
                ${tiles
                    .map((tile) => {
                        const stateClass = tile.complete
                            ? ' tacaudit-launch-tile--complete'
                            : tile.placeholder
                              ? ' tacaudit-launch-tile--placeholder'
                              : ' tacaudit-launch-tile--due';
                        const body = `
                            <div class="tacaudit-launch-tile-body">
                                <div class="tacaudit-launch-tile-label">${escapeHtml(tile.label)}</div>
                                <div class="tacaudit-launch-tile-sub">${escapeHtml(tile.sub || '')}</div>
                            </div>`;
                        if (tile.placeholder || !tile.href) {
                            return `<article class="tacaudit-launch-tile${stateClass}" role="listitem" aria-disabled="true">${body}</article>`;
                        }
                        return `<a class="tacaudit-launch-tile tacaudit-launch-tile--link${stateClass}" role="listitem" href="${escapeHtml(tile.href)}" aria-label="${escapeHtml(`${tile.label} — ${tile.sub || 'Start audit'}`)}">${body}</a>`;
                    })
                    .join('')}
            </div>
        </section>`;
}

function hasReportEmail() {
    return Boolean(String(context?.settings?.reportEmail || '').trim());
}

function renderCoreSection() {
    return `
        <article class="tacaudit-core-section">
            <h2>CORE audit report</h2>
            <p>Download the combined CORE audit PDF for this store.</p>
            <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-toolbar" id="tacaudit-core-report-btn">
                CORE audit report
            </button>
        </article>`;
}

function renderEmailSetupCard() {
    if (hasReportEmail()) return '';
    return `
        <article class="tacaudit-settings-card tacaudit-settings-card--setup">
            <h2>Report email</h2>
            <p>Set where completed audit PDFs are emailed (original resolution photos and signatures). You can change this later in Settings.</p>
            <div class="tacaudit-settings-row">
                <input type="email" id="tacaudit-email-input" value="" placeholder="store@example.com" autocomplete="email" />
                <button type="button" class="dfsc-btn dfsc-btn-primary dfsc-btn-toolbar" id="tacaudit-save-email-btn"${savingSettings ? ' disabled' : ''}>
                    ${savingSettings ? 'Saving…' : 'Save'}
                </button>
            </div>
        </article>`;
}

function renderHubActionButtons() {
    const parts = [];
    if (context?.canViewAdminSummary || IS_ADMIN_TACAUDIT) {
        parts.push(`
        <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-sm tacaudit-compliance-btn" id="tacaudit-compliance-btn">
            Audit Compliance
        </button>`);
    }
    const openCount = Math.max(0, Number(context?.openActionsCount) || 0);
    const dueClass = openCount > 0 ? ' tacaudit-actions-btn--due' : '';
    parts.push(`
        <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-sm tacaudit-actions-btn${dueClass}" id="tacaudit-actions-btn">
            Open Actions (${openCount})
        </button>`);
    return parts.join('');
}

function getScopeMeta() {
    return {
        accessibleAreas: scopeMeta?.accessibleAreas || context?.accessibleAreas || [],
        accessibleMarkets: scopeMeta?.accessibleMarkets || context?.accessibleMarkets || [],
        marketAreas: scopeMeta?.marketAreas || context?.marketAreas || {},
    };
}

function applyScopeMeta(data) {
    if (!data || typeof data !== 'object') return;
    if (!Array.isArray(data.accessibleAreas)) return;
    scopeMeta = {
        accessibleAreas: data.accessibleAreas,
        accessibleMarkets: data.accessibleMarkets || [],
        marketAreas: data.marketAreas || {},
    };
}

function currentMarketName() {
    const area = currentAreaName();
    const { accessibleMarkets, marketAreas } = getScopeMeta();
    for (const market of accessibleMarkets) {
        if ((marketAreas[market] || []).includes(area)) return market;
    }
    return accessibleMarkets[0] || '';
}

function areasInCurrentMarket() {
    const { accessibleAreas, accessibleMarkets, marketAreas } = getScopeMeta();
    const market = currentMarketName();
    if (market && Array.isArray(marketAreas[market]) && marketAreas[market].length) {
        return marketAreas[market];
    }
    return accessibleAreas;
}

function canShowScopePicker() {
    if (!(IS_ADMIN_TACAUDIT || context?.canViewAdminSummary)) return false;
    const meta = getScopeMeta();
    return meta.accessibleMarkets.length > 1 || meta.accessibleAreas.length > 1;
}

function canShowComplianceViewToggle() {
    if (!(IS_ADMIN_TACAUDIT || context?.canViewAdminSummary)) return false;
    const scope = scopeMeta?.overviewScope || context?.overviewScope || '';
    return scope === 'market' || scope === 'super';
}

function defaultComplianceViewLevel() {
    return canShowComplianceViewToggle() ? 'market' : 'area';
}

function renderComplianceViewToggle() {
    if (!canShowComplianceViewToggle()) return '';
    return `<div class="tacaudit-view-toggle">
        <span class="tacaudit-scope-picker__label">View</span>
        <button type="button" class="dfsc-btn dfsc-btn-sm${complianceViewLevel === 'area' ? ' dfsc-btn-primary' : ' dfsc-btn-secondary'}" id="tacaudit-view-area-btn">Area</button>
        <button type="button" class="dfsc-btn dfsc-btn-sm${complianceViewLevel === 'market' ? ' dfsc-btn-primary' : ' dfsc-btn-secondary'}" id="tacaudit-view-market-btn">Market</button>
    </div>`;
}

function renderScopePicker() {
    if (!canShowScopePicker()) return '';
    const meta = getScopeMeta();
    const showMarket = meta.accessibleMarkets.length > 1;
    const areas = areasInCurrentMarket();
    const showArea = areas.length > 1;
    if (!showMarket && !showArea) return '';
    const area = currentAreaName();
    const market = currentMarketName();
    const parts = ['<div class="tacaudit-scope-picker">'];
    if (showMarket) {
        parts.push(`
            <label class="tacaudit-scope-picker__field">
                <span class="tacaudit-scope-picker__label">Market</span>
                <select id="tacaudit-market-select" class="dfsc-input tacaudit-scope-picker__select">
                    ${meta.accessibleMarkets
                        .map(
                            (name) =>
                                `<option value="${escapeHtml(name)}"${name === market ? ' selected' : ''}>${escapeHtml(name)}</option>`
                        )
                        .join('')}
                </select>
            </label>`);
    }
    if (showArea) {
        parts.push(`
            <label class="tacaudit-scope-picker__field">
                <span class="tacaudit-scope-picker__label">Area</span>
                <select id="tacaudit-area-select" class="dfsc-input tacaudit-scope-picker__select">
                    ${areas
                        .map(
                            (name) =>
                                `<option value="${escapeHtml(name)}"${name === area ? ' selected' : ''}>${escapeHtml(name)}</option>`
                        )
                        .join('')}
                </select>
            </label>`);
    }
    parts.push('</div>');
    return parts.join('');
}

function renderAreaPicker() {
    if (!IS_ADMIN_TACAUDIT) return '';
    return renderScopePicker();
}

async function switchAdminArea(area) {
    const nextArea = String(area || '').trim();
    if (!nextArea) return;
    const url = new URL(window.location.href);
    url.searchParams.set('area', nextArea);
    if (view === 'status') {
        url.searchParams.set('view', 'status');
        window.history.replaceState({}, '', url);
        await openAdminSummary();
        return;
    }
    if (view === 'actions') {
        url.pathname = '/tacaudit/actions';
        window.location.href = `${url.pathname}${url.search}`;
        return;
    }
    window.location.href = adminHubUrl(nextArea);
}

function bindScopePicker() {
    document.getElementById('tacaudit-market-select')?.addEventListener('change', (e) => {
        const market = e.target.value;
        const areas = getScopeMeta().marketAreas[market] || [];
        const current = currentAreaName();
        const next = areas.includes(current) ? current : areas[0];
        if (next) void switchAdminArea(next);
    });
    document.getElementById('tacaudit-area-select')?.addEventListener('change', (e) => {
        void switchAdminArea(e.target.value);
    });
}

function renderAdminLaunchTiles() {
    const tiles = context?.launchTiles || [];
    if (!tiles.length) return '';
    return `
        <section class="tacaudit-launch-section" aria-labelledby="tacaudit-area-launch-heading">
            <h2 id="tacaudit-area-launch-heading" class="tacaudit-launch-heading">Area audit status</h2>
            <div class="tacaudit-launch-row" role="list">
                ${tiles
                    .map((tile) => {
                        const stateClass = tile.complete
                            ? ' tacaudit-launch-tile--complete'
                            : ' tacaudit-launch-tile--due';
                        return `<article class="tacaudit-launch-tile${stateClass}" role="listitem">
                            <div class="tacaudit-launch-tile-body">
                                <div class="tacaudit-launch-tile-label">${escapeHtml(tile.label)}</div>
                                <div class="tacaudit-launch-tile-sub">${escapeHtml(tile.sub || '')}</div>
                            </div>
                        </article>`;
                    })
                    .join('')}
            </div>
        </section>`;
}

function renderAdminMainView() {
    const areaLine = context?.areaName ? context.areaName : 'Area';
    app.innerHTML = `
        <div class="dfsc-shell tacaudit-shell">
            <header class="tacaudit-page-header">
                <div class="tacaudit-page-header__main">
                    <h1>TacAudit</h1>
                    <p>${escapeHtml(areaLine)} · Area hub</p>
                    ${renderAreaPicker()}
                    <div class="tacaudit-header-actions">${renderHubActionButtons()}</div>
                </div>
            </header>
            <div id="tacaudit-status-bar">${renderStatus()}</div>
            ${renderAdminLaunchTiles()}
            <div class="tacaudit-history-card">
                ${renderTabs()}
                <section class="dfsc-history-section tacaudit-history-section">
                    ${renderTabPanelContent({ admin: true })}
                </section>
            </div>
        </div>`;

    document.getElementById('tacaudit-compliance-btn')?.addEventListener('click', () => {
        void openAdminSummary();
    });
    document.getElementById('tacaudit-actions-btn')?.addEventListener('click', () => {
        void openActionsView();
    });
    bindScopePicker();
    bindTabButtons();
}

function renderMainView() {
    auditCfg();
    app.innerHTML = `
        <div class="dfsc-shell tacaudit-shell">
            <header class="tacaudit-page-header tacaudit-page-header--with-settings">
                <div class="tacaudit-page-header__main">
                    <h1>TacAudit</h1>
                    <p>${escapeHtml(context?.storeName || STORE_NUMBER)} · Audit history &amp; settings</p>
                    <div class="tacaudit-header-actions">${renderHubActionButtons()}</div>
                </div>
            </header>
            <div id="tacaudit-status-bar">${renderStatus()}</div>
            ${renderCoreSection()}
            ${renderEmailSetupCard()}
            ${renderLaunchTiles()}
            <div class="tacaudit-history-card">
                ${renderTabs()}
                <section class="dfsc-history-section tacaudit-history-section">
                    ${renderTabPanelContent()}
                </section>
            </div>
        </div>`;

    document.getElementById('tacaudit-save-email-btn')?.addEventListener('click', saveEmailSettings);
    document.getElementById('tacaudit-core-report-btn')?.addEventListener('click', downloadCoreReport);
    document.getElementById('tacaudit-compliance-btn')?.addEventListener('click', () => {
        void openAdminSummary();
    });
    document.getElementById('tacaudit-actions-btn')?.addEventListener('click', () => {
        void openActionsView();
    });
    bindTabButtons();
    document.querySelectorAll('[data-history-id]').forEach((btn) => {
        btn.addEventListener('click', () => openHistoryDetail(btn.dataset.historyId, btn.dataset.historyDate));
    });
    document.querySelectorAll('[data-delete-in-progress]').forEach((btn) => {
        btn.addEventListener('click', () => {
            try {
                const audit = JSON.parse(decodeURIComponent(btn.dataset.deleteInProgress || ''));
                void deleteInProgressAudit(audit);
            } catch {
                statusMessage = 'Could not delete audit.';
                statusKind = 'error';
                renderStatusBar();
            }
        });
    });
    bindLaunchRowDragScroll();
    window.MicSettings?.setStoreContext?.({
        storeNumber: STORE_NUMBER,
        reportEmail: context?.settings?.reportEmail || '',
    });
}

async function refreshContext() {
    const data = await fetchJson(apiUrl('/api/tacaudit/context', { store: STORE_NUMBER }));
    context = data;
}

async function deleteInProgressAudit(audit) {
    const cfg = AUDIT_CONFIG[audit?.auditType];
    const deleteApi = cfg?.deleteApi;
    if (!deleteApi || !audit?.id) return;

    const title = `${audit.auditLabel || cfg.label || 'Audit'} by ${audit.conductorName || 'Unknown'}`;
    if (!window.confirm(`Delete ${title}? This cannot be undone.`)) return;

    statusMessage = '';
    try {
        const params = { store: STORE_NUMBER, sessionId: audit.id };
        const dateVal = audit[cfg.dateParam] || audit.dateKey || audit.periodKey;
        if (dateVal && cfg.dateParam) params[cfg.dateParam] = dateVal;
        const res = await fetch(apiUrl(deleteApi, params), {
            method: 'DELETE',
            credentials: 'include',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.success === false) {
            throw new Error(data.error || `Delete failed (${res.status})`);
        }
        await refreshContext();
        statusMessage = 'Open audit deleted.';
        statusKind = 'success';
        render();
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
        renderStatusBar();
    }
}

function mountSettingsChrome() {
    if (!window.MicSettings || document.getElementById('mic-settings-btn')) return;
    const host = document.createElement('div');
    host.className = 'tacaudit-settings-host';
    host.innerHTML =
        window.MicSettings.renderCog() +
        window.MicSettings.renderPanel({
            storeNumber: STORE_NUMBER,
            reportEmail: context?.settings?.reportEmail || '',
            darkModeHint: 'Dark background on TacoAudit and audit pages.',
            onReportEmailSaved: (email) => {
                if (context?.settings) context.settings.reportEmail = email;
                else context = { ...context, settings: { reportEmail: email } };
                render();
            },
        });
    document.body.appendChild(host);
    window.MicSettings.bind({
        storeNumber: STORE_NUMBER,
        reportEmail: context?.settings?.reportEmail || '',
        onReportEmailSaved: (email) => {
            if (context?.settings) context.settings.reportEmail = email;
            render();
        },
    });
    void window.MicSettings.initPreferences?.();
}

function renderHistoryDetailNcRows(session) {
    const rows = session?.nonCompliant || historyDetailRow?.nonCompliant || [];
    if (!rows.length) {
        return `<p class="dfsc-field-hint">No non-compliant items recorded.</p>`;
    }
    return `
        <ul class="dfsc-history-nc-list">
            ${rows
                .map(
                    (row) => `
                <li class="dfsc-history-nc-item">
                    <div class="dfsc-history-nc-label">${escapeHtml(row.label)}</div>
                    <div class="dfsc-history-nc-action">${escapeHtml(row.actionText || '—')}</div>
                </li>`
                )
                .join('')}
        </ul>`;
}

function renderHistoryDetailView() {
    const cfg = auditCfg();
    const row = historyDetailRow;
    const session = historyDetailSession;
    const title = cfg?.rowTitle ? cfg.rowTitle(row || session || {}) : 'Inspection';
    const archiveOnly = Boolean(row?.archiveOnly);

    const editBtnHtml =
        !archiveOnly && historyDetailCanReopen
            ? `<button type="button" class="dfsc-btn dfsc-btn-primary dfsc-btn-toolbar" id="tacaudit-history-edit-btn">Edit inspection</button>`
            : '';

    const summaryHtml = archiveOnly
        ? `
            <dl class="dfsc-history-dl">
                <div><dt>Conducted by</dt><dd>${escapeHtml(row?.conductorName || '—')}</dd></div>
                <div><dt>Completed</dt><dd>${escapeHtml(formatAuditTime(row?.completedAt))}</dd></div>
                <div><dt>Duration</dt><dd>${escapeHtml(formatDuration(row?.durationMinutes))}</dd></div>
                ${row?.score != null ? `<div><dt>Score</dt><dd>${escapeHtml(String(row.score))}</dd></div>` : ''}
            </dl>
            <p class="dfsc-field-hint">Session data expired — archived PDF only.</p>`
        : `
            <dl class="dfsc-history-dl">
                <div><dt>Conducted by</dt><dd>${escapeHtml(session?.conductor?.name || '—')}</dd></div>
                <div><dt>Signed off by</dt><dd>${escapeHtml(session?.signOff?.name || '—')}</dd></div>
                <div><dt>Started</dt><dd>${escapeHtml(formatAuditTime(session?.startedAt))}</dd></div>
                <div><dt>Completed</dt><dd>${escapeHtml(formatAuditTime(session?.completedAt))}</dd></div>
            </dl>`;

    app.innerHTML = `
        <div class="dfsc-shell tacaudit-shell">
            <div class="dfsc-landing-head">
                <h1>${escapeHtml(title)}</h1>
                <p>${escapeHtml(cfg?.label || '')} · ${escapeHtml(context?.storeName || STORE_NUMBER)}</p>
            </div>
            <div id="tacaudit-status-bar">${renderStatus()}</div>
            <article class="dfsc-card">
                <h2>Summary</h2>
                ${summaryHtml}
            </article>
            ${
                archiveOnly
                    ? ''
                    : `<article class="dfsc-card">
                <h2>Non-compliant items</h2>
                ${renderHistoryDetailNcRows(session)}
            </article>`
            }
            <div class="dfsc-landing-toolbar dfsc-landing-toolbar--bottom dfsc-landing-toolbar--stack">
                ${editBtnHtml}
                <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-toolbar" id="tacaudit-history-download-pdf">Download PDF</button>
                <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-toolbar" id="tacaudit-history-back-btn">Back to history</button>
            </div>
        </div>`;

    document.getElementById('tacaudit-history-edit-btn')?.addEventListener('click', () => {
        if (session) reopenHistorySession(session);
    });
    document.getElementById('tacaudit-history-download-pdf')?.addEventListener('click', () => {
        downloadHistoryPdf(row || session);
    });
    document.getElementById('tacaudit-history-back-btn')?.addEventListener('click', () => {
        view = 'main';
        historyDetailRow = null;
        historyDetailSession = null;
        renderMainView();
    });
}

async function saveEmailSettings() {
    const input = document.getElementById('tacaudit-email-input');
    const email = String(input?.value || '').trim();
    savingSettings = true;
    statusMessage = '';
    renderMainView();
    try {
        const data = await fetchJson(apiUrl('/api/tacaudit/settings'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ store: STORE_NUMBER, reportEmail: email }),
        });
        context.settings = data.settings;
        window.MicSettings?.setStoreContext?.({
            storeNumber: STORE_NUMBER,
            reportEmail: data.settings?.reportEmail || '',
        });
        statusMessage = 'Email saved.';
        statusKind = 'info';
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
    } finally {
        savingSettings = false;
        renderMainView();
    }
}

async function downloadCoreReport() {
    const btn = document.getElementById('tacaudit-core-report-btn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Generating report…';
    }
    statusMessage = '';
    try {
        const url = apiUrl('/api/tacaudit/core-report.pdf', { store: STORE_NUMBER });
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `Download failed (${res.status})`);
        }
        const blob = await res.blob();
        const disposition = res.headers.get('Content-Disposition') || '';
        const match = disposition.match(/filename="([^"]+)"/i);
        const filename = match ? match[1] : 'CORE-Audit-report.pdf';
        const link = document.createElement('a');
        const objectUrl = URL.createObjectURL(blob);
        link.href = objectUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(objectUrl);
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
        renderStatusBar();
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'CORE audit report';
        }
    }
}

async function loadHistory(tab = activeTab) {
    const data = await fetchJson(apiUrl('/api/tacaudit/history', { store: STORE_NUMBER, type: tab }));
    inspectionHistory = data.history || [];
}

async function loadAdminHistory(tab = activeTab) {
    const data = await fetchJson(
        apiUrl('/api/tacaudit/admin-history', {
            area: context?.areaName || currentAreaName(),
            type: tab,
        })
    );
    inspectionHistory = data.history || [];
}

async function switchTab(tab) {
    if (tab === activeTab && view === 'main') return;
    activeTab = tab;
    statusMessage = '';
    try {
        if (IS_ADMIN_TACAUDIT && context?.isAdminHub) {
            await loadAdminHistory(tab);
            view = 'main';
            renderAdminMainView();
            return;
        }
        await loadHistory(tab);
        view = 'main';
        historyDetailRow = null;
        historyDetailSession = null;
        renderMainView();
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
        if (IS_ADMIN_TACAUDIT && context?.isAdminHub) {
            renderAdminMainView();
        } else {
            renderMainView();
        }
    }
}

async function openHistoryDetail(sessionId, dateKey) {
    const row = inspectionHistory.find((r) => r.id === sessionId);
    if (!row) return;

    statusMessage = '';
    historyDetailRow = row;

    if (row.archiveOnly) {
        historyDetailSession = null;
        historyDetailCanReopen = false;
        view = 'detail';
        renderHistoryDetailView();
        return;
    }

    const cfg = auditCfg();
    if (!cfg?.sessionApi) return;

    try {
        const params = { store: STORE_NUMBER, sessionId };
        if (dateKey) params[cfg.dateParam] = dateKey;
        const data = await fetchJson(apiUrl(cfg.sessionApi, params));
        if (data.session?.status !== 'completed') {
            throw new Error('This inspection is not completed.');
        }
        historyDetailSession = data.session;
        historyDetailCanReopen = Boolean(data.canReopen);
        view = 'detail';
        renderHistoryDetailView();
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
        historyDetailRow = null;
        renderMainView();
    }
}

async function downloadHistoryPdf(target) {
    const btn = document.getElementById('tacaudit-history-download-pdf');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Downloading…';
    }
    statusMessage = '';
    const sessionId = target?.id;
    const cfg = auditCfg();

    async function tryArchive() {
        const url = apiUrl('/api/tacaudit/archive.pdf', {
            store: STORE_NUMBER,
            type: activeTab,
            sessionId,
        });
        const res = await fetch(url, { credentials: 'include' });
        if (res.ok) return res;
        return null;
    }

    async function tryLiveReport() {
        if (!cfg?.reportApi || target?.archiveOnly) return null;
        const params = { store: STORE_NUMBER, sessionId };
        const dateKey = target?.dateKey || target?.periodKey || historyDetailSession?.dateKey || historyDetailSession?.periodKey;
        if (dateKey && cfg.dateParam) params[cfg.dateParam] = dateKey;
        const url = apiUrl(cfg.reportApi, params);
        const res = await fetch(url, { credentials: 'include' });
        if (res.ok) return res;
        return null;
    }

    try {
        let res = await tryArchive();
        if (!res) res = await tryLiveReport();
        if (!res) {
            const data = await fetch(apiUrl('/api/tacaudit/archive.pdf', { store: STORE_NUMBER, type: activeTab, sessionId }), {
                credentials: 'include',
            }).then((r) => r.json().catch(() => ({})));
            throw new Error(data.error || 'PDF not available.');
        }
        const blob = await res.blob();
        const disposition = res.headers.get('Content-Disposition') || '';
        const match = disposition.match(/filename="([^"]+)"/i);
        const filename = match ? match[1] : `${cfg?.label || 'audit'}-report.pdf`;
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(link.href);
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
        renderStatusBar();
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Download PDF';
        }
    }
}

async function reopenHistorySession(session) {
    const cfg = auditCfg();
    if (!cfg?.reopenApi) return;
    const proceed = window.confirm(
        'Reopen this inspection for editing? You can change answers and will need to sign off again when finished.'
    );
    if (!proceed) return;

    const editBtn = document.getElementById('tacaudit-history-edit-btn');
    if (editBtn) {
        editBtn.disabled = true;
        editBtn.textContent = 'Reopening…';
    }

    try {
        const body = { store: STORE_NUMBER, sessionId: session.id };
        if (cfg.dateParam && (session.dateKey || session.periodKey)) {
            body[cfg.dateParam] = session.dateKey || session.periodKey;
        }
        await fetchJson(apiUrl(cfg.reopenApi), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        window.location.href = `/${STORE_NUMBER}/${cfg.auditPath}?session=${encodeURIComponent(session.id)}`;
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
        renderStatusBar();
        if (editBtn) {
            editBtn.disabled = false;
            editBtn.textContent = 'Edit inspection';
        }
    }
}

function formatComplianceWeekRange(weekStartYmd, weekEndYmd) {
    const fmt = (ymd) => {
        const parts = String(ymd || '').split('-').map(Number);
        if (parts.length !== 3) return ymd || '';
        const d = new Date(parts[0], parts[1] - 1, parts[2]);
        return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
    };
    if (!weekStartYmd) return '';
    if (!weekEndYmd || weekEndYmd === weekStartYmd) return fmt(weekStartYmd);
    return `${fmt(weekStartYmd)} – ${fmt(weekEndYmd)}`;
}

function complianceWeekOptionLabel(week) {
    const range = formatComplianceWeekRange(week.weekStartYmd, week.weekEndYmd);
    const base = range ? `${week.label} (${range})` : week.label;
    if (week.isCurrent) return `${base} · current`;
    return base;
}

function selectableComplianceWeeks() {
    return (complianceWeeks || []).filter((week) => week.isCurrent || week.hasSnapshot);
}

function selectedComplianceWeek() {
    const selected = complianceMeta?.selectedWeekStartYmd || '';
    return (
        complianceWeeks.find((week) => week.weekStartYmd === selected) ||
        complianceWeeks.find((week) => week.isCurrent) ||
        null
    );
}

function uniqueCompliancePeriods() {
    return [...new Set(selectableComplianceWeeks().map((week) => week.periodNumber))].sort((a, b) => a - b);
}

function selectableWeeksInPeriod(periodNumber) {
    return selectableComplianceWeeks().filter((week) => week.periodNumber === periodNumber);
}

function navigateToComplianceWeek(weekStartYmd) {
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'status');
    if (weekStartYmd && weekStartYmd !== complianceMeta?.currentWeekStartYmd) {
        url.searchParams.set('week', weekStartYmd);
    } else {
        url.searchParams.delete('week');
    }
    window.history.replaceState({}, '', url);
    closeComplianceBandPicker();
    void openAdminSummary();
}

function navigateToCompliancePeriod(periodNumber) {
    const weeks = selectableWeeksInPeriod(periodNumber);
    if (!weeks.length) return;
    const current = selectedComplianceWeek();
    let target = weeks.find((week) => week.weekInPeriod === current?.weekInPeriod);
    if (!target) target = weeks[weeks.length - 1];
    navigateToComplianceWeek(target.weekStartYmd);
}

let complianceBandPickerKind = '';

function closeComplianceBandPicker() {
    complianceBandPickerKind = '';
    document.getElementById('tacaudit-band-picker')?.remove();
    document.getElementById('tacaudit-period-band-btn')?.setAttribute('aria-expanded', 'false');
    document.getElementById('tacaudit-week-band-btn')?.setAttribute('aria-expanded', 'false');
}

function positionComplianceBandPicker(pop, anchor) {
    const rect = anchor.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.left = `${Math.max(8, rect.left)}px`;
    pop.style.top = `${rect.bottom + 4}px`;
    pop.style.minWidth = `${Math.max(rect.width, 168)}px`;
    pop.style.zIndex = '2500';
}

function renderComplianceBandPickerItems(kind) {
    const selected = selectedComplianceWeek();
    if (kind === 'period') {
        return uniqueCompliancePeriods()
            .map((periodNumber) => {
                const active = selected?.periodNumber === periodNumber;
                return `<button type="button" class="tacaudit-band-picker__item${active ? ' is-active' : ''}" data-period="${periodNumber}" role="option" aria-selected="${active}">Period ${periodNumber}</button>`;
            })
            .join('');
    }
    const periodNumber = selected?.periodNumber;
    return selectableWeeksInPeriod(periodNumber)
        .map((week) => {
            const active = week.weekStartYmd === selected?.weekStartYmd;
            const range = formatComplianceWeekRange(week.weekStartYmd, week.weekEndYmd);
            const suffix = week.isCurrent ? ' · current' : '';
            return `<button type="button" class="tacaudit-band-picker__item${active ? ' is-active' : ''}" data-week="${escapeHtml(week.weekStartYmd)}" role="option" aria-selected="${active}">Week ${week.weekInPeriod}${range ? ` · ${escapeHtml(range)}` : ''}${suffix}</button>`;
        })
        .join('');
}

function openComplianceBandPicker(kind, anchor) {
    if (!anchor) return;
    if (complianceBandPickerKind === kind) {
        closeComplianceBandPicker();
        return;
    }
    closeComplianceBandPicker();
    const items = renderComplianceBandPickerItems(kind);
    if (!items) return;
    complianceBandPickerKind = kind;
    const pop = document.createElement('div');
    pop.id = 'tacaudit-band-picker';
    pop.className = 'tacaudit-band-picker';
    pop.setAttribute('role', 'listbox');
    pop.innerHTML = items;
    document.body.appendChild(pop);
    positionComplianceBandPicker(pop, anchor);
    anchor.setAttribute('aria-expanded', 'true');
    pop.addEventListener('click', (event) => {
        const periodBtn = event.target.closest('[data-period]');
        if (periodBtn) {
            navigateToCompliancePeriod(Number(periodBtn.dataset.period));
            return;
        }
        const weekBtn = event.target.closest('[data-week]');
        if (weekBtn) {
            navigateToComplianceWeek(weekBtn.dataset.week || '');
        }
    });
}

function bindComplianceBandPickers() {
    closeComplianceBandPicker();
    const periodBtn = document.getElementById('tacaudit-period-band-btn');
    const weekBtn = document.getElementById('tacaudit-week-band-btn');
    periodBtn?.addEventListener('click', (event) => {
        event.stopPropagation();
        openComplianceBandPicker('period', periodBtn);
    });
    weekBtn?.addEventListener('click', (event) => {
        event.stopPropagation();
        openComplianceBandPicker('week', weekBtn);
    });
    if (!window.__tacauditBandPickerOutsideBound) {
        window.__tacauditBandPickerOutsideBound = true;
        document.addEventListener('click', (event) => {
            if (!complianceBandPickerKind) return;
            if (event.target.closest('#tacaudit-band-picker')) return;
            if (event.target.closest('#tacaudit-period-band-btn')) return;
            if (event.target.closest('#tacaudit-week-band-btn')) return;
            closeComplianceBandPicker();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') closeComplianceBandPicker();
        });
    }
}

function complianceCaptureTitle() {
    const area = adminSummary?.areaName || currentAreaName() || 'Area';
    const week = selectedComplianceWeek();
    const periodLabel = adminSummary?.periodLabel || (week ? `PERIOD ${week.periodNumber}` : '');
    const weekLabel = adminSummary?.weekLabel || (week ? `WEEK ${week.weekInPeriod}` : '');
    const range = week ? formatComplianceWeekRange(week.weekStartYmd, week.weekEndYmd) : '';
    const parts = [`Audit Compliance · ${area}`, periodLabel, weekLabel];
    if (range) parts.push(range);
    return parts.filter(Boolean).join(' · ');
}

async function rasterizeElementToCanvas(element, { scale } = {}) {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) throw new Error('Nothing to capture.');
    const render = window.html2canvas;
    if (typeof render !== 'function') {
        throw new Error('Image capture is unavailable. Check your network connection and refresh.');
    }
    const captureScale = scale ?? Math.min(3, Math.max(2, window.devicePixelRatio || 2));
    return render(element, {
        scale: captureScale,
        backgroundColor: '#ffffff',
        useCORS: true,
        logging: false,
        scrollX: 0,
        scrollY: -window.scrollY,
        windowWidth: document.documentElement.clientWidth,
        windowHeight: document.documentElement.clientHeight,
    });
}

async function copyComplianceImageToClipboard() {
    const target = document.getElementById('tacaudit-compliance-capture');
    if (!target) return;
    const btn = document.getElementById('tacaudit-copy-image-btn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Copying…';
    }
    statusMessage = '';
    try {
        if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
            throw new Error('Copy to clipboard is not supported in this browser.');
        }
        const canvas = await rasterizeElementToCanvas(target);
        const blob = await new Promise((resolve, reject) => {
            canvas.toBlob((value) => {
                if (!value) reject(new Error('Could not create image.'));
                else resolve(value);
            }, 'image/png');
        });
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        statusMessage = 'Compliance image copied to clipboard.';
        statusKind = 'info';
    } catch (err) {
        statusMessage = err.message || 'Could not copy compliance image.';
        statusKind = 'error';
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Copy image';
        }
        renderStatusBar();
    }
}

function renderComplianceCaptureHeader() {
    return `<div class="tacaudit-capture-header">${escapeHtml(complianceCaptureTitle())}</div>`;
}

function renderSummaryCell(cell, row, storeNumber) {
    const tone = cell?.tone || 'red';
    const display = cell?.display != null ? String(cell.display) : '';
    const status = normalizeSplashStatus(cell?.status);
    const cls = `tacaudit-summary-cell tacaudit-summary-cell--${tone}`;
    const readOnly = Boolean(adminSummary?.readOnly);
    if (row.kind === 'open-actions') {
        if (readOnly) {
            return `<td class="${cls}"><span class="tacaudit-summary-cell-btn tacaudit-summary-cell-btn--static">${escapeHtml(display)}</span></td>`;
        }
        return `<td class="${cls}">
            <button type="button" class="tacaudit-summary-cell-btn" data-open-actions-store="${escapeHtml(storeNumber)}">${escapeHtml(display)}</button>
        </td>`;
    }
    if (row.kind === 'dfsc-count' || cell?.clickable === false) {
        return `<td class="${cls}"><span class="tacaudit-summary-cell-btn tacaudit-summary-cell-btn--static">${escapeHtml(display)}</span></td>`;
    }
    if (readOnly) {
        return `<td class="${cls}"><span class="tacaudit-summary-cell-btn tacaudit-summary-cell-btn--static">${escapeHtml(display)}</span></td>`;
    }
    return `<td class="${cls}">
        <button type="button" class="tacaudit-summary-cell-btn"
            data-splash-row="${escapeHtml(row.id)}"
            data-splash-store="${escapeHtml(storeNumber)}"
            data-splash-status="${escapeHtml(status)}">${escapeHtml(display)}</button>
    </td>`;
}

const COMPLIANCE_ROW_LABELS = {
    'core-ops': 'Operations',
    'core-food-safety': 'Food Safety',
    'visit-coach': 'Coach visit',
    'visit-customer': 'Customer visit',
};

function complianceRowLabel(row) {
    const id = String(row?.id || '').trim();
    if (id && COMPLIANCE_ROW_LABELS[id]) return COMPLIANCE_ROW_LABELS[id];
    const legacy = String(row?.label || '').trim();
    if (/^self\s*core\s*ops$/i.test(legacy)) return COMPLIANCE_ROW_LABELS['core-ops'];
    if (/^self\s*core\s*food\s*safety$/i.test(legacy)) return COMPLIANCE_ROW_LABELS['core-food-safety'];
    return legacy;
}

function renderSummaryRow(row, summary) {
    const stores = (summary.regions || []).flatMap((region) => region.stores || []);
    const cells = stores.map((store) => renderSummaryCell(summary.cells?.[row.id]?.[store.storeNumber], row, store.storeNumber));
    const rowLabel = complianceRowLabel(row);
    const labelCell = `<th class="tacaudit-summary-label tacaudit-summary-label--row" scope="row">${escapeHtml(rowLabel)}</th>`;
    return `<tr class="tacaudit-summary-row">${labelCell}${cells.join('')}</tr>`;
}

function renderSummaryBodyRows(summary) {
    const bodyRows = [];

    for (const row of summary.rows || []) {
        if (row.kind === 'group' && Array.isArray(row.children)) {
            for (const child of row.children) {
                bodyRows.push(renderSummaryRow(child, summary));
            }
            continue;
        }
        bodyRows.push(renderSummaryRow(row, summary));
    }
    return `<tbody>${bodyRows.join('')}</tbody>`;
}

function renderMarketSummaryCell(cell) {
    const tone = cell?.tone || 'red';
    const display = cell?.display != null ? String(cell.display) : '';
    const cls = `tacaudit-summary-cell tacaudit-summary-cell--${tone}`;
    return `<td class="${cls}"><span class="tacaudit-summary-cell-btn tacaudit-summary-cell-btn--static">${escapeHtml(display)}</span></td>`;
}

function renderMarketSummaryRow(row, summary) {
    const columns = summary?.columns || [];
    const cells = columns.map((col) => renderMarketSummaryCell(summary.cells?.[row.id]?.[col.areaName]));
    const rowLabel = complianceRowLabel(row);
    return `<tr class="tacaudit-summary-row"><th class="tacaudit-summary-label tacaudit-summary-label--row" scope="row">${escapeHtml(rowLabel)}</th>${cells.join('')}</tr>`;
}

function renderMarketSummaryBodyRows(summary) {
    const bodyRows = [];
    for (const row of summary.rows || []) {
        if (row.kind === 'group' && Array.isArray(row.children)) {
            for (const child of row.children) bodyRows.push(renderMarketSummaryRow(child, summary));
            continue;
        }
        bodyRows.push(renderMarketSummaryRow(row, summary));
    }
    return `<tbody>${bodyRows.join('')}</tbody>`;
}

function renderMarketSummaryTable(summary) {
    const columns = summary?.columns || [];
    const colCount = Math.max(columns.length, 1);
    const colgroup = `<colgroup><col class="tacaudit-col-label" />${columns.map(() => '<col class="tacaudit-col-data" />').join('')}</colgroup>`;
    const areaHeaders = columns.map((col) => `<th class="tacaudit-summary-store">${escapeHtml(col.areaName)}</th>`).join('');
    return `<div class="tacaudit-summary-scroll">
        <table class="tacaudit-summary-table tacaudit-summary-sheet">
            ${colgroup}
            <thead>
                <tr class="tacaudit-summary-band-row">
                    <th rowspan="2" class="tacaudit-summary-band tacaudit-summary-band--period tacaudit-summary-label-corner" scope="colgroup">${escapeHtml(summary?.periodLabel || 'PERIOD')}</th>
                    <th colspan="${colCount}" class="tacaudit-summary-band tacaudit-summary-band--week" scope="colgroup">${escapeHtml(summary?.weekLabel || 'WEEK')} · ${escapeHtml(summary?.marketName || 'Market')}</th>
                </tr>
                <tr class="tacaudit-summary-store-row">${areaHeaders}</tr>
            </thead>
            ${renderMarketSummaryBodyRows(summary)}
        </table>
    </div>`;
}

function renderSummaryTable(summary) {
    if (summary?.viewLevel === 'market' || complianceViewLevel === 'market') {
        return renderMarketSummaryTable(summary);
    }
    const regions = summary?.regions || [];
    const stores = regions.flatMap((region) => region.stores || []);
    const storeCount = Math.max(stores.length, 1);
    const colgroup = `
        <colgroup>
            <col class="tacaudit-col-label" />
            ${stores.map(() => '<col class="tacaudit-col-data" />').join('')}
        </colgroup>`;
    const regionHeaders = regions
        .map(
            (region) =>
                `<th class="tacaudit-summary-region" colspan="${Math.max(region.stores?.length || 0, 1)}">${escapeHtml(region.label)}</th>`
        )
        .join('');
    const storeHeaders = stores
        .map((store) => `<th class="tacaudit-summary-store">${escapeHtml(store.storeName)}</th>`)
        .join('');

    const bodyRows = renderSummaryBodyRows(summary);

    const periodChoices = uniqueCompliancePeriods();
    const weekChoices = selectableWeeksInPeriod(selectedComplianceWeek()?.periodNumber);
    const periodDisabled = periodChoices.length <= 1;
    const weekDisabled = weekChoices.length <= 1;

    return `
        <div class="tacaudit-summary-scroll">
            <table class="tacaudit-summary-table tacaudit-summary-sheet">
                ${colgroup}
                <thead>
                    <tr class="tacaudit-summary-band-row">
                        <th rowspan="3" class="tacaudit-summary-band tacaudit-summary-band--period tacaudit-summary-label-corner" scope="colgroup">
                            <button type="button" class="tacaudit-summary-band-btn" id="tacaudit-period-band-btn" aria-haspopup="listbox" aria-expanded="false" title="${periodDisabled ? '' : 'Choose period'}"${periodDisabled ? ' disabled' : ''}>${escapeHtml(summary?.periodLabel || 'PERIOD')}</button>
                        </th>
                        <th colspan="${storeCount}" class="tacaudit-summary-band tacaudit-summary-band--week" scope="colgroup">
                            <button type="button" class="tacaudit-summary-band-btn" id="tacaudit-week-band-btn" aria-haspopup="listbox" aria-expanded="false" title="${weekDisabled ? '' : 'Choose week'}"${weekDisabled ? ' disabled' : ''}>${escapeHtml(summary?.weekLabel || 'WEEK')}</button>
                        </th>
                    </tr>
                    <tr class="tacaudit-summary-region-row">
                        ${regionHeaders}
                    </tr>
                    <tr class="tacaudit-summary-store-row">
                        ${storeHeaders}
                    </tr>
                </thead>
                ${bodyRows}
            </table>
        </div>`;
}

function renderSummaryView() {
    const areaLine = adminSummary?.areaName ? ` · ${adminSummary.areaName}` : '';
    const scopePicker = renderScopePicker();
    const historicalNote = adminSummary?.readOnly
        ? '<p class="tacaudit-summary-historical">Viewing a completed week (read-only snapshot).</p>'
        : '';
    const seedNote = adminSummary?.seededFromReference
        ? '<p class="tacaudit-summary-historical">Showing one-off reference data for this week (display only — cells are not linked to live audits).</p>'
        : '';
    const gridMarkup =
        summaryLoading
            ? '<p class="tacaudit-summary-loading">Loading area summary…</p>'
            : adminSummary
              ? `<div id="tacaudit-compliance-capture" class="tacaudit-compliance-capture">${renderComplianceCaptureHeader()}${renderSummaryTable(adminSummary)}</div>`
              : '<p class="tacaudit-summary-loading">No summary data.</p>';
    app.innerHTML = `
        <div class="dfsc-shell tacaudit-shell tacaudit-shell--summary">
            <div class="tacaudit-summary-toolbar tacaudit-summary-toolbar--sheet">
                <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-sm" id="tacaudit-summary-back-btn">Back</button>
                <p class="tacaudit-summary-meta">Audit Compliance${escapeHtml(areaLine)}</p>
                <div class="tacaudit-summary-toolbar__pickers">
                    ${renderComplianceViewToggle()}
                    ${scopePicker}
                    <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-sm" id="tacaudit-copy-image-btn"${adminSummary ? '' : ' disabled'}>Copy image</button>
                </div>
            </div>
            ${historicalNote}
            ${seedNote}
            <div id="tacaudit-status-bar">${renderStatus()}</div>
            ${gridMarkup}
            <p class="tacaudit-summary-footnote">Cells reflect audit status tracked in TacAudit (including Operations and Food Safety when enabled). Completed weeks are saved automatically when the week ends. Refreshing the current week resets any manual grid changes. Open actions are corrective items from in-progress store audits.</p>
        </div>`;

    bindScopePicker();
    bindComplianceBandPickers();
    document.getElementById('tacaudit-view-area-btn')?.addEventListener('click', () => {
        complianceViewLevel = 'area';
        const url = new URL(window.location.href);
        url.searchParams.set('complianceView', 'area');
        window.history.replaceState({}, '', url);
        void openAdminSummary();
    });
    document.getElementById('tacaudit-view-market-btn')?.addEventListener('click', () => {
        complianceViewLevel = 'market';
        const url = new URL(window.location.href);
        url.searchParams.set('complianceView', 'market');
        window.history.replaceState({}, '', url);
        void openAdminSummary();
    });
    document.getElementById('tacaudit-copy-image-btn')?.addEventListener('click', () => {
        void copyComplianceImageToClipboard();
    });

    document.getElementById('tacaudit-summary-back-btn')?.addEventListener('click', () => {
        if (IS_ADMIN_TACAUDIT) {
            view = 'main';
            adminSummary = null;
            setViewInUrl('main');
            void loadAdminHub();
            return;
        }
        view = 'main';
        adminSummary = null;
        const url = new URL(window.location.href);
        url.searchParams.delete('view');
        url.searchParams.delete('row');
        window.history.replaceState({}, '', url);
        renderMainView();
    });

    document.querySelectorAll('[data-splash-row]').forEach((btn) => {
        btn.addEventListener('click', () => {
            void cycleSplashCell(btn);
        });
    });
    document.querySelectorAll('[data-open-actions-store]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const store = btn.dataset.openActionsStore || '';
            void openActionsView(store);
        });
    });

}

async function cycleSplashCell(btn) {
    if (adminSummary?.readOnly) return;
    const rowId = btn.dataset.splashRow || '';
    const storeNumber = btn.dataset.splashStore || '';
    const current = normalizeSplashStatus(btn.dataset.splashStatus);
    const next = nextSplashStatus(current);
    btn.disabled = true;
    try {
        const body = {
            area: currentAreaName(),
            storeNumber,
            rowId,
            status: next,
        };
        const data = await fetchJson(apiUrl('/api/tacaudit/splash-state'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        adminSummary = data.summary || adminSummary;
        renderSummaryView();
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
        renderStatusBar();
    } finally {
        btn.disabled = false;
    }
}

function actionContextLine(action) {
    const parts = [action.auditLabel || action.auditType];
    if (action.dateKey) parts.push(`${action.dateKey}${action.shift ? ` · ${action.shift}` : ''}`);
    else if (action.periodKey) parts.push(action.periodKey);
    if (action.areaTitle) parts.push(action.areaTitle);
    if (action.conductorName) parts.push(`by ${action.conductorName}`);
    return parts.join(' · ');
}

function renderActionsList() {
    let items = actionsList || [];
    if (actionsFilterStore) {
        items = items.filter((a) => String(a.storeNumber) === String(actionsFilterStore));
    }
    if (!items.length) {
        return '<p class="dfsc-history-empty">No open actions.</p>';
    }
    const showStore = IS_ADMIN_TACAUDIT || items.some((a, i, arr) => i > 0 && a.storeNumber !== arr[0].storeNumber);
    return `
        <ul class="tacaudit-actions-list">
            ${items
                .map((action) => {
                    const busy = submittingActionId === action.id;
                    return `
                <li class="tacaudit-action-item" data-action-id="${escapeHtml(action.id)}">
                    ${showStore ? `<div class="tacaudit-action-store">${escapeHtml(action.storeName || action.storeNumber)}</div>` : ''}
                    <div class="tacaudit-action-label">${escapeHtml(action.label)}</div>
                    <div class="tacaudit-action-meta">${escapeHtml(actionContextLine(action))}</div>
                    <div class="tacaudit-action-form">
                        <textarea class="dfsc-input tacaudit-action-text" rows="3" data-action-text="${escapeHtml(action.id)}"
                            placeholder="Describe corrective action taken…">${escapeHtml(action.draftText || '')}</textarea>
                        <button type="button" class="dfsc-btn dfsc-btn-primary dfsc-btn-sm tacaudit-action-submit"
                            data-action-submit="${escapeHtml(action.id)}"${busy ? ' disabled' : ''}>
                            ${busy ? 'Saving…' : 'Mark complete'}
                        </button>
                    </div>
                </li>`;
                })
                .join('')}
        </ul>`;
}

function renderActionsView() {
    const areaLine = currentAreaName() ? ` · ${currentAreaName()}` : '';
    const storeLine = STORE_NUMBER ? ` · ${context?.storeName || STORE_NUMBER}` : '';
    app.innerHTML = `
        <div class="dfsc-shell tacaudit-shell">
            <header class="tacaudit-page-header">
                <div class="tacaudit-page-header__main">
                    <h1>Open actions</h1>
                    <p>Review and complete corrective actions${escapeHtml(areaLine || storeLine)}</p>
                </div>
            </header>
            <div class="tacaudit-summary-toolbar">
                <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-sm" id="tacaudit-actions-back-btn">Back</button>
            </div>
            <div id="tacaudit-status-bar">${renderStatus()}</div>
            ${
                actionsLoading
                    ? '<p class="tacaudit-summary-loading">Loading actions…</p>'
                    : renderActionsList()
            }
        </div>`;

    document.getElementById('tacaudit-actions-back-btn')?.addEventListener('click', () => {
        view = 'main';
        actionsFilterStore = '';
        setViewInUrl('main');
        if (IS_ADMIN_TACAUDIT) {
            void loadAdminHub();
            return;
        }
        renderMainView();
    });

    document.querySelectorAll('[data-action-submit]').forEach((btn) => {
        btn.addEventListener('click', () => {
            void submitActionItem(btn.dataset.actionSubmit);
        });
    });
}

async function submitActionItem(actionId) {
    const action = actionsList.find((a) => a.id === actionId);
    if (!action) return;
    const textarea = document.querySelector(`[data-action-text="${CSS.escape(actionId)}"]`);
    const text = String(textarea?.value || '').trim();
    if (!text) {
        statusMessage = 'Enter corrective action text before marking complete.';
        statusKind = 'error';
        renderStatusBar();
        return;
    }
    submittingActionId = actionId;
    renderActionsView();
    try {
        await fetchJson(apiUrl('/api/tacaudit/actions'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                storeNumber: action.storeNumber,
                auditType: action.auditType,
                sessionId: action.sessionId,
                questionId: action.questionId,
                text,
                dateKey: action.dateKey,
                periodKey: action.periodKey,
            }),
        });
        statusMessage = 'Action marked complete.';
        statusKind = 'success';
        await refreshActionsList();
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
    } finally {
        submittingActionId = '';
        renderActionsView();
    }
}

async function refreshActionsList() {
    const params = {};
    if (STORE_NUMBER) params.store = STORE_NUMBER;
    else if (currentAreaName()) params.area = currentAreaName();
    if (actionsFilterStore) params.store = actionsFilterStore;
    const data = await fetchJson(apiUrl('/api/tacaudit/actions', params));
    actionsList = data.actions || [];
    if (context) context.openActionsCount = actionsList.length;
}

async function openActionsView(storeFilter = '') {
    if (!IS_ADMIN_TACAUDIT && STORE_NUMBER && !IS_STORE_ACTIONS && view === 'main' && !storeFilter) {
        window.location.href = actionsViewUrl();
        return;
    }
    view = 'actions';
    actionsLoading = true;
    actionsFilterStore = storeFilter || '';
    statusMessage = '';
    if (IS_ADMIN_TACAUDIT) {
        setViewInUrl('actions');
    } else if (IS_STORE_ACTIONS) {
        /* URL already correct */
    } else {
        window.history.replaceState({}, '', actionsViewUrl(storeFilter));
    }
    renderActionsView();
    try {
        await refreshActionsList();
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
    } finally {
        actionsLoading = false;
        renderActionsView();
    }
}

async function loadAdminHub() {
    const areaParam = new URLSearchParams(window.location.search).get('area') || '';
    const data = await fetchJson(apiUrl('/api/tacaudit/admin-context', { area: areaParam }));
    context = data;
    applyScopeMeta(data);
    const resolvedArea = String(data.areaName || areaParam || '').trim();
    if (resolvedArea && resolvedArea !== areaParam) {
        const url = new URL(window.location.href);
        url.searchParams.set('area', resolvedArea);
        window.history.replaceState({}, '', url);
    }
    statusMessage = '';
    statusKind = 'info';
    try {
        await loadAdminHistory(activeTab);
    } catch (err) {
        inspectionHistory = [];
        statusMessage = err.message;
        statusKind = 'error';
    }
    renderAdminMainView();
}

async function openAdminSummary() {
    view = 'status';
    summaryLoading = true;
    statusMessage = '';
    adminSummary = null;
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'status');
    url.searchParams.delete('row');
    if (!url.searchParams.get('complianceView')) {
        complianceViewLevel = defaultComplianceViewLevel();
        url.searchParams.set('complianceView', complianceViewLevel);
    } else {
        complianceViewLevel = url.searchParams.get('complianceView') === 'market' ? 'market' : 'area';
    }
    window.history.replaceState({}, '', url);
    renderSummaryView();
    try {
        const params = new URLSearchParams(window.location.search);
        const summaryParams = { area: params.get('area') || context?.areaName || '' };
        const weekParam = params.get('week');
        if (weekParam) summaryParams.week = weekParam;
        if (STORE_NUMBER) summaryParams.store = STORE_NUMBER;
        if (complianceViewLevel === 'market') {
            summaryParams.view = 'market';
            const market = currentMarketName();
            if (market) summaryParams.market = market;
        }
        const data = await fetchJson(apiUrl('/api/tacaudit/admin-summary', summaryParams));
        adminSummary = data.summary;
        if (data.viewLevel) complianceViewLevel = data.viewLevel;
        complianceWeeks = data.complianceWeeks || [];
        complianceMeta = data.complianceMeta || null;
        applyScopeMeta(data);
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
        complianceWeeks = err.complianceWeeks || complianceWeeks;
    } finally {
        summaryLoading = false;
        renderSummaryView();
    }
}

function render() {
    if (view === 'detail') {
        renderHistoryDetailView();
        return;
    }
    if (view === 'status') {
        renderSummaryView();
        return;
    }
    if (view === 'actions') {
        renderActionsView();
        return;
    }
    if (IS_ADMIN_TACAUDIT && context?.isAdminHub) {
        renderAdminMainView();
        return;
    }
    renderMainView();
}

async function init() {
    mountBackNav();

    if (IS_ADMIN_TACAUDIT) {
        try {
            const params = new URLSearchParams(window.location.search);
            const requestedView = params.get('view') || (IS_ADMIN_ACTIONS ? 'actions' : '');
            if (requestedView === 'status' || requestedView === 'summary') {
                await openAdminSummary();
                return;
            }
            if (requestedView === 'actions') {
                await openActionsView(params.get('store') || '');
                return;
            }
            await loadAdminHub();
        } catch (err) {
            app.innerHTML = `<div class="dfsc-shell"><p class="dfsc-status dfsc-status--error">${escapeHtml(err.message)}</p></div>`;
        }
        return;
    }

    if (!STORE_NUMBER) {
        app.textContent = 'Invalid store URL.';
        return;
    }

    try {
        const params = new URLSearchParams(window.location.search);
        if (IS_STORE_ACTIONS) {
            const data = await fetchJson(apiUrl('/api/tacaudit/context', { store: STORE_NUMBER }));
            context = data;
            await openActionsView(params.get('store') || STORE_NUMBER);
            return;
        }
        const data = await fetchJson(apiUrl('/api/tacaudit/context', { store: STORE_NUMBER }));
        context = data;
        if (data.auditTypes?.length) {
            const tabParam = params.get('tab');
            if (tabParam && AUDIT_CONFIG[tabParam]) activeTab = tabParam;
        }
        mountSettingsChrome();
        await loadHistory(activeTab);
        const requestedView = params.get('view') || '';
        if (requestedView === 'actions') {
            await openActionsView(params.get('store') || '');
            return;
        }
        const wantsAdminSummary =
            context.canViewAdminSummary && (requestedView === 'status' || requestedView === 'summary');
        if (wantsAdminSummary) {
            await openAdminSummary();
            return;
        }
        render();
    } catch (err) {
        app.innerHTML = `<div class="dfsc-shell"><p class="dfsc-status dfsc-status--error">${escapeHtml(err.message)}</p></div>`;
    }
}

init();
