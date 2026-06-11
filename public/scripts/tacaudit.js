const IS_ADMIN_SUMMARY =
    /^\/tacaudit\/summary\/?$/i.test(window.location.pathname) ||
    /^\/Admin\/tacaudit\/?$/i.test(window.location.pathname);
const pathMatch = window.location.pathname.match(/^\/(teststore|\d{3,6})\/tacaudit\/?$/i);
const STORE_NUMBER = IS_ADMIN_SUMMARY ? '' : pathMatch ? pathMatch[1].toLowerCase() : '';

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
let summaryHighlightRow = '';

function tacauditPath() {
    return window.AppPaths?.tacaudit?.(STORE_NUMBER) || `/${STORE_NUMBER}/tacaudit`;
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
        fade: IS_ADMIN_SUMMARY,
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
                    const scoreLine =
                        row.score != null ? ` · Score ${row.score}` : '';
                    return `
                <li class="dfsc-history-item">
                    <button type="button" class="dfsc-history-row" data-history-id="${escapeHtml(row.id)}" data-history-date="${escapeHtml(row.dateKey || row.periodKey || '')}">
                        <span class="dfsc-history-row-main">
                            <span class="dfsc-history-row-title">${escapeHtml(title)}${archiveBadge}</span>
                            <span class="dfsc-history-row-sub">
                                ${escapeHtml(row.conductorName || 'Unknown')}
                                · Completed ${escapeHtml(formatAuditTime(row.completedAt))}
                                · ${formatDuration(row.durationMinutes)}
                                ${row.nonCompliantCount ? ` · ${row.nonCompliantCount} NC` : ''}${scoreLine}
                            </span>
                        </span>
                        <span class="dfsc-history-chevron" aria-hidden="true">›</span>
                    </button>
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

function resumeAuditUrl(audit) {
    const cfg = AUDIT_CONFIG[audit?.auditType];
    if (!cfg?.auditPath || !audit?.id) return '';
    const params = new URLSearchParams({ session: audit.id });
    const dateVal = audit[cfg.dateParam] || audit.dateKey || audit.periodKey;
    if (dateVal && cfg.dateParam) params.set(cfg.dateParam, dateVal);
    return `/${STORE_NUMBER}/${cfg.auditPath}?${params.toString()}`;
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

function renderInProgressSection() {
    const audits = context?.inProgressAudits || [];
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
        <section class="tacaudit-in-progress-section dfsc-open-section" aria-labelledby="tacaudit-in-progress-heading">
            <div class="dfsc-open-head">
                <h2 id="tacaudit-in-progress-heading">In progress</h2>
                <span class="dfsc-open-count">${audits.length}</span>
            </div>
            <p class="dfsc-open-hint">Open audits you can continue across DFSC and TacoAudit checklists.</p>
            <ul class="dfsc-open-list">${rows}</ul>
        </section>`;
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

function renderAdminSummaryButton() {
    if (!context?.canViewAdminSummary) return '';
    return `
        <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-sm tacaudit-summary-btn" id="tacaudit-summary-btn">
            Area summary
        </button>`;
}

function renderMainView() {
    auditCfg();
    app.innerHTML = `
        <div class="dfsc-shell tacaudit-shell">
            <header class="tacaudit-page-header tacaudit-page-header--with-settings">
                <div class="tacaudit-page-header__main">
                    <h1>TacoAudit</h1>
                    <p>${escapeHtml(context?.storeName || STORE_NUMBER)} · Audit history &amp; settings</p>
                    ${context?.canViewAdminSummary ? `<div class="tacaudit-header-actions">${renderAdminSummaryButton()}</div>` : ''}
                </div>
            </header>
            <div id="tacaudit-status-bar">${renderStatus()}</div>
            ${renderCoreSection()}
            ${renderEmailSetupCard()}
            ${renderLaunchTiles()}
            ${renderInProgressSection()}
            <div class="tacaudit-history-card">
                ${renderTabs()}
                <section class="dfsc-history-section tacaudit-history-section">
                    ${renderHistoryList()}
                </section>
            </div>
        </div>`;

    document.getElementById('tacaudit-save-email-btn')?.addEventListener('click', saveEmailSettings);
    document.getElementById('tacaudit-core-report-btn')?.addEventListener('click', downloadCoreReport);
    document.getElementById('tacaudit-summary-btn')?.addEventListener('click', () => {
        void openAdminSummary();
    });
    document.querySelectorAll('[data-tab]').forEach((btn) => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
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

async function switchTab(tab) {
    if (tab === activeTab && view === 'main') return;
    activeTab = tab;
    statusMessage = '';
    try {
        await loadHistory(tab);
        view = 'main';
        historyDetailRow = null;
        historyDetailSession = null;
        renderMainView();
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
        renderMainView();
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

function renderSummaryCell(cell) {
    const tone = cell?.tone || 'red';
    const display = cell?.display != null ? String(cell.display) : '';
    const cls = `tacaudit-summary-cell tacaudit-summary-cell--${tone}`;
    return `<td class="${cls}">${escapeHtml(display)}</td>`;
}

function renderSummaryRow(row, summary, { groupLabel = '', groupRowSpan = 0, isFirstGroupRow = false } = {}) {
    const stores = (summary.regions || []).flatMap((region) => region.stores || []);
    const cells = stores.map((store) => renderSummaryCell(summary.cells?.[row.id]?.[store.storeNumber]));
    let labelCells = '';
    if (groupLabel && isFirstGroupRow) {
        labelCells += `<th class="tacaudit-summary-label tacaudit-summary-label--group" scope="row" rowspan="${groupRowSpan}">${escapeHtml(groupLabel)}</th>`;
    }
    if (groupLabel) {
        labelCells += `<th class="tacaudit-summary-label tacaudit-summary-label--sub" scope="row">${escapeHtml(row.label)}</th>`;
    } else {
        labelCells += `<th class="tacaudit-summary-label" scope="row" colspan="2">${escapeHtml(row.label)}</th>`;
    }
    const highlightClass =
        summaryHighlightRow && summaryHighlightRow === row.id ? ' tacaudit-summary-row--highlight' : '';
    return `<tr class="tacaudit-summary-row${highlightClass}" data-tacaudit-row="${escapeHtml(row.id)}">${labelCells}${cells.join('')}</tr>`;
}

function highlightSummaryRow() {
    if (!summaryHighlightRow) return;
    const row = document.querySelector(`tr[data-tacaudit-row="${CSS.escape(summaryHighlightRow)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function renderSummaryTable(summary) {
    const regions = summary?.regions || [];
    const stores = regions.flatMap((region) => region.stores || []);
    const regionHeaders = regions
        .map(
            (region) =>
                `<th class="tacaudit-summary-region" colspan="${Math.max(region.stores?.length || 0, 1)}">${escapeHtml(region.label)}</th>`
        )
        .join('');
    const storeHeaders = stores
        .map((store) => `<th class="tacaudit-summary-store">${escapeHtml(store.storeName)}</th>`)
        .join('');

    const bodyRows = (summary.rows || [])
        .map((row) => {
            if (row.kind === 'group' && Array.isArray(row.children)) {
                return row.children
                    .map((child, index) =>
                        renderSummaryRow(child, summary, {
                            groupLabel: row.label,
                            groupRowSpan: row.children.length,
                            isFirstGroupRow: index === 0,
                        })
                    )
                    .join('');
            }
            return renderSummaryRow(row, summary);
        })
        .join('');

    return `
        <div class="tacaudit-summary-scroll">
            <table class="tacaudit-summary-table">
                <thead>
                    <tr>
                        <th class="tacaudit-summary-corner" colspan="2"></th>
                        ${regionHeaders}
                    </tr>
                    <tr>
                        <th class="tacaudit-summary-corner" colspan="2"></th>
                        ${storeHeaders}
                    </tr>
                </thead>
                <tbody>${bodyRows}</tbody>
            </table>
        </div>`;
}

function renderSummaryView() {
    const areaLine = adminSummary?.areaName ? ` · ${adminSummary.areaName}` : '';
    app.innerHTML = `
        <div class="dfsc-shell tacaudit-shell tacaudit-shell--summary">
            <header class="tacaudit-summary-header">
                <div class="tacaudit-summary-header__period">${escapeHtml(adminSummary?.periodLabel || 'PERIOD')}</div>
                <div class="tacaudit-summary-header__week">${escapeHtml(adminSummary?.weekLabel || 'WEEK')}</div>
            </header>
            <div class="tacaudit-summary-toolbar">
                <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-sm" id="tacaudit-summary-back-btn">Back</button>
                <p class="tacaudit-summary-meta">Audit status across stores${escapeHtml(areaLine)}</p>
            </div>
            <div id="tacaudit-status-bar">${renderStatus()}</div>
            ${
                summaryLoading
                    ? '<p class="tacaudit-summary-loading">Loading area summary…</p>'
                    : adminSummary
                      ? renderSummaryTable(adminSummary)
                      : '<p class="tacaudit-summary-loading">No summary data.</p>'
            }
            <p class="tacaudit-summary-footnote">Self CORE audits are tracked outside TacoAudit. Open safety culture counts are DFSC corrective actions not yet submitted.</p>
        </div>`;

    document.getElementById('tacaudit-summary-back-btn')?.addEventListener('click', () => {
        if (IS_ADMIN_SUMMARY) {
            navigateBackToOverview();
            return;
        }
        view = 'main';
        adminSummary = null;
        summaryHighlightRow = '';
        const url = new URL(window.location.href);
        url.searchParams.delete('view');
        url.searchParams.delete('row');
        window.history.replaceState({}, '', url);
        renderMainView();
    });

    if (!summaryLoading) {
        requestAnimationFrame(() => highlightSummaryRow());
    }
}

async function openAdminSummary() {
    view = 'summary';
    summaryLoading = true;
    statusMessage = '';
    adminSummary = null;
    const url = new URL(window.location.href);
    if (!IS_ADMIN_SUMMARY) {
        url.searchParams.set('view', 'summary');
    }
    if (summaryHighlightRow) url.searchParams.set('row', summaryHighlightRow);
    else url.searchParams.delete('row');
    window.history.replaceState({}, '', url);
    renderSummaryView();
    try {
        const areaParam = new URLSearchParams(window.location.search).get('area');
        const summaryParams = { area: areaParam || context?.areaName || '' };
        if (STORE_NUMBER) summaryParams.store = STORE_NUMBER;
        const data = await fetchJson(apiUrl('/api/tacaudit/admin-summary', summaryParams));
        adminSummary = data.summary;
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
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
    if (view === 'summary') {
        renderSummaryView();
        return;
    }
    renderMainView();
}

async function init() {
    mountBackNav();

    if (IS_ADMIN_SUMMARY) {
        try {
            const params = new URLSearchParams(window.location.search);
            summaryHighlightRow = params.get('row') || '';
            await openAdminSummary();
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
        summaryHighlightRow = params.get('row') || '';
        const data = await fetchJson(apiUrl('/api/tacaudit/context', { store: STORE_NUMBER }));
        context = data;
        if (data.auditTypes?.length) {
            const tabParam = params.get('tab');
            if (tabParam && AUDIT_CONFIG[tabParam]) activeTab = tabParam;
        }
        mountSettingsChrome();
        await loadHistory(activeTab);
        const wantsAdminSummary =
            context.canViewAdminSummary &&
            (params.get('view') === 'summary' || params.get('row'));
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
