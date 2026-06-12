const AUDIT_TYPE =
    document.body.dataset.auditType ||
    (window.location.pathname.match(/\/(core-ops|core-food-safety|visit-coach|visit-customer)(?:\/|$)/i) || [])[1] ||
    '';
const pathMatch = window.location.pathname.match(/^\/(teststore|\d{3,6})\//i);
const STORE_NUMBER = pathMatch ? pathMatch[1].toLowerCase() : '';
const IS_AUDIT_VIEW = /\/audit\/?$/i.test(window.location.pathname) || Boolean(sessionStorage.getItem(`pa-audit-${AUDIT_TYPE}-${STORE_NUMBER}`));

document.documentElement.classList.add('dfsc-page');
document.body.classList.add('dfsc-page');

const app = document.getElementById('app');
let context = null;
let session = null;
let schema = null;
let currentSectionIndex = 0;
let statusMessage = '';
let statusKind = '';
let saving = false;
let saveTimer = null;
const signaturePads = new Map();

function apiBase() {
    return `/api/${AUDIT_TYPE}`;
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
    if (!res.ok || data.success === false) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
}

function tacauditPath() {
    return window.AppPaths?.tacaudit?.(STORE_NUMBER) || `/${STORE_NUMBER}/tacaudit`;
}

function mountBackNav() {
    window.DashboardNavBack?.mountBackButton(document.getElementById('pa-nav-back'), {
        fallback: tacauditPath(),
        alwaysFallback: true,
    });
}

function showWhenMatches(actual, expected) {
    const options = Array.isArray(expected) ? expected : [expected];
    const norm = String(actual ?? '').toLowerCase();
    return options.some((e) => norm === String(e).toLowerCase() || norm.includes(String(e).toLowerCase()));
}

function isQuestionVisible(question) {
    if (!question?.showWhenAnswer) return true;
    for (const [qId, expected] of Object.entries(question.showWhenAnswer)) {
        if (!showWhenMatches(session?.answers?.[qId], expected)) return false;
    }
    return true;
}

function visibleQuestions(sectionId) {
    return (schema?.questions || []).filter((q) => q.section === sectionId && isQuestionVisible(q));
}

function isAnswerEmpty(question, value) {
    if (!question) return true;
    if (question.type === 'checkbox') return value !== true && value !== 'true' && value !== '1';
    if (question.type === 'textarea' && !question.required) return false;
    return value === null || value === undefined || String(value).trim() === '';
}

function optionButtons(question) {
    const options = question.options || [];
    if (question.type === 'yes_no_points' || question.type === 'yes_no_na') {
        return ['Yes', 'No', 'N/A'].map((opt) => {
            const val = opt.toLowerCase() === 'n/a' ? 'n/a' : opt.toLowerCase();
            const active = String(session?.answers?.[question.id] || '').toLowerCase() === val;
            return `<button type="button" class="dfsc-choice${active ? ' is-active' : ''}" data-answer="${escapeHtml(question.id)}" data-value="${escapeHtml(val)}">${opt}</button>`;
        });
    }
    if (question.type === 'standard_rating') {
        return ['At Standard', 'Secondary', 'Significant'].map((opt) => {
            const val = opt.toLowerCase();
            const active = String(session?.answers?.[question.id] || '').toLowerCase() === val;
            return `<button type="button" class="dfsc-choice${active ? ' is-active' : ''}" data-answer="${escapeHtml(question.id)}" data-value="${escapeHtml(val)}">${opt}</button>`;
        });
    }
    if (question.type === 'compliant_nc') {
        return ['Compliant', 'Non-Compliant', 'N/A'].map((opt) => {
            const val = opt.toLowerCase().replace(/\s+/g, '-');
            const active = String(session?.answers?.[question.id] || '').toLowerCase().replace(/\s+/g, '-') === val;
            return `<button type="button" class="dfsc-choice${active ? ' is-active' : ''}" data-answer="${escapeHtml(question.id)}" data-value="${escapeHtml(val)}">${opt}</button>`;
        });
    }
    return options.map((opt) => {
        const val = String(opt).toLowerCase();
        const active = String(session?.answers?.[question.id] || '').toLowerCase() === val;
        return `<button type="button" class="dfsc-choice${active ? ' is-active' : ''}" data-answer="${escapeHtml(question.id)}" data-value="${escapeHtml(val)}">${escapeHtml(opt)}</button>`;
    });
}

function renderQuestion(question) {
    const value = session?.answers?.[question.id] ?? '';
    if (question.type === 'text' || question.type === 'datetime' || question.type === 'number') {
        return `<label class="dfsc-field"><span class="dfsc-field__label">${escapeHtml(question.label)}</span>
            <input class="dfsc-input" type="${question.type === 'number' ? 'number' : 'text'}" data-text-answer="${escapeHtml(question.id)}" value="${escapeHtml(value)}" /></label>`;
    }
    if (question.type === 'textarea') {
        return `<label class="dfsc-field"><span class="dfsc-field__label">${escapeHtml(question.label)}</span>
            <textarea class="dfsc-input" rows="3" data-text-answer="${escapeHtml(question.id)}">${escapeHtml(value)}</textarea></label>`;
    }
    if (question.type === 'checkbox') {
        const checked = value === true || value === 'true' || value === '1';
        return `<label class="dfsc-check"><input type="checkbox" data-check-answer="${escapeHtml(question.id)}"${checked ? ' checked' : ''} />
            <span>${escapeHtml(question.label)}</span></label>`;
    }
    if (question.type === 'signature') {
        return `<div class="dfsc-field"><span class="dfsc-field__label">${escapeHtml(question.label)}</span>
            <canvas class="dfsc-signature" data-signature="${escapeHtml(question.id)}" width="320" height="120"></canvas>
            <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-sm" data-clear-sig="${escapeHtml(question.id)}">Clear</button></div>`;
    }
    return `<div class="dfsc-question"><p class="dfsc-question__label">${escapeHtml(question.label)}</p>
        <div class="dfsc-choice-row">${optionButtons(question).join('')}</div></div>`;
}

function renderSignOffSection() {
    return `<div class="dfsc-field">
        <label class="dfsc-field"><span class="dfsc-field__label">Sign-off name</span>
            <input class="dfsc-input" id="pa-signoff-name" value="${escapeHtml(session?.signOff?.name || '')}" /></label>
        <canvas class="dfsc-signature" id="pa-signoff-sig" width="320" height="120"></canvas>
        <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-sm" id="pa-clear-signoff">Clear signature</button>
    </div>`;
}

function renderSection() {
    const sections = (schema?.sections || []).filter((s) => s.id !== 'sign_off');
    const section = sections[currentSectionIndex];
    if (!section) return renderSignOffSection();
    const questions = visibleQuestions(section.id);
    return `<h2 class="dfsc-section-title">${escapeHtml(section.label)}</h2>
        ${questions.map((q) => renderQuestion(q)).join('')}`;
}

function renderAuditView() {
    const sections = (schema?.sections || []).filter((s) => s.id !== 'sign_off');
    const onSignOff = currentSectionIndex >= sections.length;
    const score = session?.score;
    app.innerHTML = `<div class="dfsc-shell">
        <header class="dfsc-header"><h1>${escapeHtml(schema?.auditLabel || 'Audit')}</h1>
            <p class="dfsc-meta">${escapeHtml(context?.storeName || STORE_NUMBER)} · ${escapeHtml(session?.periodKey || '')}</p>
            ${score?.rating ? `<p class="dfsc-meta">Score: ${escapeHtml(score.rating)} (${score.deviationTotal ?? 0} pts)</p>` : ''}
        </header>
        <div id="pa-status"></div>
        <div class="dfsc-section-tabs">${sections
            .map(
                (s, i) =>
                    `<button type="button" class="dfsc-section-tab${i === currentSectionIndex ? ' is-active' : ''}" data-section-idx="${i}">${escapeHtml(s.label).slice(0, 24)}</button>`
            )
            .join('')}<button type="button" class="dfsc-section-tab${onSignOff ? ' is-active' : ''}" data-section-idx="${sections.length}">Sign off</button></div>
        <div class="dfsc-card">${onSignOff ? renderSignOffSection() : renderSection()}</div>
        <div class="dfsc-actions">
            ${currentSectionIndex > 0 ? '<button type="button" class="dfsc-btn dfsc-btn-secondary" id="pa-prev">Back</button>' : ''}
            ${!onSignOff ? '<button type="button" class="dfsc-btn dfsc-btn-primary" id="pa-next">Next</button>' : '<button type="button" class="dfsc-btn dfsc-btn-primary" id="pa-submit">Submit audit</button>'}
        </div>
    </div>`;
    bindAuditEvents();
}

function renderStartView() {
    const name = context?.conductorFullName || '';
    app.innerHTML = `<div class="dfsc-shell">
        <header class="dfsc-header"><h1>${escapeHtml(schema?.auditLabel || context?.auditLabel || 'Audit')}</h1>
            <p class="dfsc-meta">${escapeHtml(context?.storeName || STORE_NUMBER)}</p></header>
        <div id="pa-status"></div>
        <div class="dfsc-card">
            <label class="dfsc-field"><span class="dfsc-field__label">Your name</span>
                <input class="dfsc-input" id="pa-start-name" value="${escapeHtml(name)}" /></label>
            <p class="dfsc-field__label">Start signature</p>
            <canvas class="dfsc-signature" id="pa-start-sig" width="320" height="120"></canvas>
            <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-sm" id="pa-clear-start">Clear</button>
        </div>
        <button type="button" class="dfsc-btn dfsc-btn-primary dfsc-btn-block" id="pa-start-btn">Start audit</button>
        ${context?.inProgress ? `<button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-block" id="pa-resume-btn">Resume in progress</button>` : ''}
    </div>`;
    initSignaturePad('pa-start-sig');
    document.getElementById('pa-clear-start')?.addEventListener('click', () => signaturePads.get('pa-start-sig')?.clear());
    document.getElementById('pa-start-btn')?.addEventListener('click', () => void startAudit(false));
    document.getElementById('pa-resume-btn')?.addEventListener('click', () => void resumeAudit());
    renderStatusBar();
}

function renderStatusBar() {
    const el = document.getElementById('pa-status');
    if (!el) return;
    el.innerHTML = statusMessage ? `<div class="dfsc-status dfsc-status--${statusKind || 'info'}">${escapeHtml(statusMessage)}</div>` : '';
}

function initSignaturePad(id) {
    const canvas = document.getElementById(id);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let drawing = false;
    const stroke = () => {
        ctx.strokeStyle = '#231e1f';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
    };
    const pos = (e) => {
        const rect = canvas.getBoundingClientRect();
        const t = e.touches?.[0] || e;
        return { x: t.clientX - rect.left, y: t.clientY - rect.top };
    };
    const pad = {
        clear: () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        },
        dataUrl: () => canvas.toDataURL('image/png'),
    };
    canvas.addEventListener('pointerdown', (e) => {
        drawing = true;
        const p = pos(e);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
    });
    canvas.addEventListener('pointermove', (e) => {
        if (!drawing) return;
        const p = pos(e);
        stroke();
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
    });
    const end = () => {
        drawing = false;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointerleave', end);
    signaturePads.set(id, pad);
}

function scheduleSave() {
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
        saveTimer = null;
        void saveSession();
    }, 400);
}

async function saveSession() {
    if (!session || session.status === 'completed' || saving) return;
    saving = true;
    try {
        const data = await fetchJson(apiUrl(`${apiBase()}/session`), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                store: STORE_NUMBER,
                sessionId: session.id,
                periodKey: session.periodKey,
                answers: session.answers,
                actions: session.actions,
                notes: session.notes,
                signOff: session.signOff,
            }),
        });
        session = data.session;
        if (data.score) session.score = data.score;
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
        renderStatusBar();
    } finally {
        saving = false;
    }
}

function bindAuditEvents() {
    app.querySelectorAll('[data-answer]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.answer;
            const value = btn.dataset.value;
            session.answers = session.answers || {};
            session.answers[id] = value;
            scheduleSave();
            renderAuditView();
        });
    });
    app.querySelectorAll('[data-text-answer]').forEach((input) => {
        input.addEventListener('input', () => {
            session.answers = session.answers || {};
            session.answers[input.dataset.textAnswer] = input.value;
            scheduleSave();
        });
    });
    app.querySelectorAll('[data-check-answer]').forEach((input) => {
        input.addEventListener('change', () => {
            session.answers = session.answers || {};
            session.answers[input.dataset.checkAnswer] = input.checked;
            scheduleSave();
        });
    });
    app.querySelectorAll('[data-section-idx]').forEach((btn) => {
        btn.addEventListener('click', () => {
            currentSectionIndex = Number(btn.dataset.sectionIdx) || 0;
            renderAuditView();
        });
    });
    document.getElementById('pa-prev')?.addEventListener('click', () => {
        currentSectionIndex = Math.max(0, currentSectionIndex - 1);
        renderAuditView();
    });
    document.getElementById('pa-next')?.addEventListener('click', () => {
        currentSectionIndex += 1;
        renderAuditView();
    });
    document.getElementById('pa-signoff-name')?.addEventListener('input', (e) => {
        session.signOff = session.signOff || {};
        session.signOff.name = e.target.value;
        scheduleSave();
    });
    initSignaturePad('pa-signoff-sig');
    document.getElementById('pa-clear-signoff')?.addEventListener('click', () => signaturePads.get('pa-signoff-sig')?.clear());
    document.getElementById('pa-submit')?.addEventListener('click', () => void submitAudit());
    renderStatusBar();
}

async function startAudit(forceNew) {
    statusMessage = '';
    const name = document.getElementById('pa-start-name')?.value?.trim();
    const sig = signaturePads.get('pa-start-sig')?.dataUrl?.() || '';
    if (!name || !sig || sig.length < 50) {
        statusMessage = 'Name and start signature are required.';
        statusKind = 'error';
        renderStatusBar();
        return;
    }
    try {
        const data = await fetchJson(apiUrl(`${apiBase()}/start`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ store: STORE_NUMBER, name, startSignatureDataUrl: sig, forceNew }),
        });
        session = data.session;
        schema = context.schema;
        currentSectionIndex = 0;
        sessionStorage.setItem(`pa-audit-${AUDIT_TYPE}-${STORE_NUMBER}`, '1');
        renderAuditView();
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
        renderStatusBar();
    }
}

async function resumeAudit() {
    if (!context?.inProgress?.id) return;
    try {
        const data = await fetchJson(
            apiUrl(`${apiBase()}/session`, {
                store: STORE_NUMBER,
                sessionId: context.inProgress.id,
                periodKey: context.inProgress.periodKey,
            })
        );
        session = data.session;
        schema = context.schema;
        sessionStorage.setItem(`pa-audit-${AUDIT_TYPE}-${STORE_NUMBER}`, '1');
        renderAuditView();
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
        renderStatusBar();
    }
}

async function submitAudit() {
    const sig = signaturePads.get('pa-signoff-sig')?.dataUrl?.() || session?.signOff?.signatureDataUrl || '';
    const name = document.getElementById('pa-signoff-name')?.value?.trim() || session?.signOff?.name || '';
    try {
        const data = await fetchJson(apiUrl(`${apiBase()}/submit`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                store: STORE_NUMBER,
                sessionId: session.id,
                signOff: { name, signatureDataUrl: sig },
            }),
        });
        session = data.session;
        statusMessage = 'Audit submitted successfully.';
        statusKind = 'info';
        window.location.href = tacauditPath();
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
        renderStatusBar();
    }
}

async function init() {
    if (!AUDIT_TYPE || !STORE_NUMBER) {
        app.textContent = 'Invalid audit page.';
        return;
    }
    mountBackNav();
    try {
        const data = await fetchJson(apiUrl(`${apiBase()}/context`, { store: STORE_NUMBER }));
        context = data;
        schema = data.schema;
        if (data.inProgress && IS_AUDIT_VIEW) {
            await resumeAudit();
            return;
        }
        renderStartView();
    } catch (err) {
        app.innerHTML = `<p class="dfsc-status dfsc-status--error">${escapeHtml(err.message)}</p>`;
    }
}

void init();
