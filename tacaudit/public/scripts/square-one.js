const pathMatch = window.location.pathname.match(/^\/(teststore|\d{3,6})\/square-one(?:\/audit)?\/?$/i);
const STORE_NUMBER = pathMatch ? pathMatch[1].toLowerCase() : '';
const API_PREFIX = '/api/square-one';
const IS_AUDIT_VIEW = /\/square-one\/audit\/?$/i.test(window.location.pathname);

document.documentElement.classList.add('dfsc-page');
document.body.classList.add('dfsc-page');

const app = document.getElementById('app');
let context = null;
let session = null;
let schema = null;
let currentSectionIndex = 0;
let statusMessage = '';
let statusKind = '';
const autosave = window.AuditSessionSave?.createSaveRunner?.();
let saveTimer = null;
const signaturePads = new Map();
const expandedNotes = new Set();
const expandedActions = new Set();

let selectedAreaId = '';

const SECTION_TAB_LABELS = {
    checklist: 'Checklist',
    signOff: 'Sign off',
};

const IMAGE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5z"/></svg>`;

const SIGNATURE_DRAW_SCALE_MAX = 2;

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

function tacauditPath() {
    return window.AppPaths?.tacaudit?.(STORE_NUMBER) || `/${STORE_NUMBER}/tacaudit`;
}

function mountBackNav() {
    window.DashboardNavBack?.mountBackButton(document.getElementById('sq-nav-back'), {
        fallback: tacauditPath(),
        alwaysFallback: true,
    });
}

function areaTitle(areaId = selectedAreaId || session?.areaId || context?.selectedAreaId) {
    const fromSession = session?.areaTitle;
    if (fromSession) return fromSession;
    const area = (context?.dueAreas || []).find((a) => a.id === areaId);
    return area?.title || area?.dashboardLabel || 'Square One';
}

function visibleQuestions(sectionId) {
    return (schema?.questions || []).filter((q) => q.section === sectionId && q.type !== 'banner');
}

function isSquareStandardType(type) {
    return type === 'square_standard';
}

function isAnswerEmpty(question, value) {
    if (!question) return true;
    if (question.type === 'banner') return false;
    if (isSquareStandardType(question.type)) {
        return value !== 'complete' && value !== 'not_complete' && value !== 'na';
    }
    return value === null || value === undefined || String(value).trim() === '';
}

function photoMissing(question) {
    if (!question?.photoRequired) return false;
    const value = session?.answers?.[question.id];
    if (isAnswerEmpty(question, value)) return false;
    if (String(value).toLowerCase() !== 'complete') return false;
    return !session?.photos?.[question.id];
}

function getActionEntry(questionId) {
    const raw = session.actions?.[questionId];
    if (!raw) return { text: '', submittedAt: null, dueDate: null };
    return {
        text: String(raw.text || ''),
        submittedAt: raw.submittedAt || null,
        dueDate: raw.dueDate || null,
    };
}

function isActionSubmitted(questionId) {
    const entry = getActionEntry(questionId);
    return Boolean(entry.submittedAt && entry.text.trim());
}

const {
    captureScrollAnchor,
    restoreScrollAnchor,
    setPageScrollY: setQuestionAreaScrollY,
} = window.AuditQuestionGroupsUi.createController({ isAnswerEmpty });

function isNcAnswer(question, value) {
    return isSquareStandardType(question.type) && String(value || '').toLowerCase() === 'not_complete';
}

function sectionProgress(sectionId) {
    const questions = visibleQuestions(sectionId).filter((q) => isSquareStandardType(q.type));
    const total = questions.filter((q) => q.required !== false).length;
    const answered = questions.filter((q) => {
        const v = session?.answers?.[q.id];
        return !isAnswerEmpty(q, v);
    }).length;
    const pct = total ? Math.round((answered / total) * 100) : 100;
    return { answered, total, pct };
}

function isSectionComplete(sectionId) {
    if (sectionId === 'signOff') {
        return Boolean(session?.signOff?.name?.trim() && session?.signOff?.signatureDataUrl);
    }
    const questions = visibleQuestions(sectionId);
    for (const question of questions) {
        if (!question.required) continue;
        const value = session?.answers?.[question.id];
        if (isAnswerEmpty(question, value)) return false;
        if (isNcAnswer(question, value) && !isActionSubmitted(question.id)) return false;
        if (photoMissing(question)) return false;
    }
    return true;
}

function renderStatus() {
    if (!statusMessage) return '';
    return `<div class="dfsc-status dfsc-status--${statusKind || 'info'}">${escapeHtml(statusMessage)}</div>`;
}

function scrollSectionToTop() {
    window.scrollTo(0, 0);
}

function scheduleSave() {
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
        saveTimer = null;
        void saveSession();
    }, 400);
}

async function saveSession() {
    if (!autosave) return;
    await autosave.runSave({
        getSession: () => session,
        setSession: (next) => {
            session = next;
        },
        isBlocked: (s) => s.status === 'completed',
        save: (s) =>
            fetchJson(apiUrl(`${API_PREFIX}/session`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    store: STORE_NUMBER,
                    sessionId: s.id,
                    periodKey: s.periodKey,
                    answers: s.answers,
                    actions: s.actions,
                    notes: s.notes,
                    photos: s.photos,
                    signOff: s.signOff,
                }),
            }),
        onError: (err) => {
            statusMessage = err.message;
            statusKind = 'error';
            renderStatusBar();
        },
    });
}

function setAnswer(questionId, value) {
    session.answers = session.answers || {};
    session.answers[questionId] = value;
    const question = (schema?.questions || []).find((q) => q.id === questionId);
    if (question && isNcAnswer(question, value)) expandedActions.add(questionId);
    scheduleSave();
    renderQuestionArea({ scrollAnchorQuestionId: questionId });
}

function setNote(questionId, value) {
    session.notes = session.notes || {};
    session.notes[questionId] = value;
    scheduleSave();
}

function setActionDraft(questionId, value) {
    session.actions = session.actions || {};
    const prev = getActionEntry(questionId);
    const dueDate = window.AuditActionForm?.readDueDateFromDom?.(questionId) || prev.dueDate;
    session.actions[questionId] = { text: value, submittedAt: prev.submittedAt, dueDate };
    scheduleSave();
}

async function submitAction(questionId) {
    const textarea = document.querySelector(`[data-action-qid="${questionId}"]`);
    const text = String(textarea?.value || getActionEntry(questionId).text || '').trim();
    if (!text) {
        statusMessage = 'Enter an action before submitting.';
        statusKind = 'error';
        renderStatusBar();
        return;
    }
    const dueDate =
        window.AuditActionForm?.readDueDateFromDom?.(questionId) ||
        window.AuditActionForm?.defaultDueDate?.(context) ||
        '';
    session.actions = session.actions || {};
    session.actions[questionId] = { text, submittedAt: new Date().toISOString(), dueDate };
    await saveSession();
    expandedActions.delete(questionId);
    renderQuestionArea({ scrollAnchorQuestionId: questionId });
}

function editAction(questionId) {
    expandedActions.add(questionId);
    renderQuestionArea({ scrollAnchorQuestionId: questionId });
}

function initSignaturePad(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    canvas.setAttribute('tabindex', '-1');
    canvas.setAttribute('role', 'img');
    canvas.addEventListener('focus', () => canvas.blur());

    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const cssWidth = Math.max(rect.width, 1);
    const cssHeight = Math.max(rect.height, 1);
    const scale = Math.min(Math.max(window.devicePixelRatio || 1, 1), SIGNATURE_DRAW_SCALE_MAX);

    canvas.width = Math.round(cssWidth * scale);
    canvas.height = Math.round(cssHeight * scale);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(scale, scale);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1f2933';

    let drawing = false;
    let hasStroke = false;

    function pointFromEvent(e) {
        const r = canvas.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        return { x: clientX - r.left, y: clientY - r.top };
    }

    function start(e) {
        e.preventDefault();
        drawing = true;
        const p = pointFromEvent(e);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
    }

    function move(e) {
        if (!drawing) return;
        e.preventDefault();
        const p = pointFromEvent(e);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        hasStroke = true;
    }

    function end(e) {
        if (!drawing) return;
        e.preventDefault();
        drawing = false;
    }

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseup', end);
    canvas.addEventListener('mouseleave', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end, { passive: false });

    return {
        clear() {
            ctx.clearRect(0, 0, cssWidth, cssHeight);
            hasStroke = false;
        },
        restore(dataUrl) {
            if (!dataUrl) return;
            const img = new Image();
            img.onload = () => {
                ctx.drawImage(img, 0, 0, cssWidth, cssHeight);
                hasStroke = true;
            };
            img.src = dataUrl;
        },
        toDataUrl() {
            return hasStroke ? canvas.toDataURL('image/png') : '';
        },
    };
}

function renderChoiceGroup(question) {
    const value = session.answers?.[question.id] || '';
    const options = (question.options || [
        ['complete', 'Completed to Standard'],
        ['not_complete', 'Not Complete'],
    ]).map(([val, label]) => [val, label, val === 'not_complete' ? 'dfsc-choice--yesno' : 'dfsc-choice--yesno']);
    return `
        <div class="dfsc-radio-group" role="radiogroup" aria-label="${escapeHtml(question.label)}">
            ${options
                .map(
                    ([val, label, cls]) => `
                <label class="dfsc-choice ${cls}">
                    <input type="radio" name="${escapeHtml(question.id)}" value="${val}" ${value === val ? 'checked' : ''}
                        data-qid="${escapeHtml(question.id)}" data-qtype="choice" />
                    <span>${escapeHtml(label)}</span>
                </label>`
                )
                .join('')}
        </div>`;
}

function pickPhoto(questionId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            session.photos = session.photos || {};
            session.photos[questionId] = { dataUrl: String(reader.result || ''), addedAt: new Date().toISOString() };
            scheduleSave();
            renderQuestionArea({ scrollAnchorQuestionId: questionId });
        };
        reader.readAsDataURL(file);
    });
    input.click();
}

const NOTE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 3H5a2 2 0 0 0-2 2v14l4-4h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/></svg>`;

function renderContributionStamp(type, id, options = {}) {
    return window.AuditContributionsUi?.renderContributionStamp(session, type, id, options) || '';
}

function renderActionForm(questionId) {
    const entry = getActionEntry(questionId);
    const submitted = isActionSubmitted(questionId);
    const open = expandedActions.has(questionId) || !submitted;
    if (submitted && !open) {
        const dueLine = entry.dueDate ? `<p class="dfsc-action-due-display">Due ${escapeHtml(entry.dueDate)}</p>` : '';
        return `
            <div class="dfsc-inline-action dfsc-inline-action--submitted">
                <div class="dfsc-action-submitted-label">Action submitted</div>
                <p class="dfsc-action-submitted-text">${escapeHtml(entry.text)}</p>
                ${dueLine}
                ${renderContributionStamp('actions', questionId, { prefix: 'Submitted' })}
                <button type="button" class="dfsc-qcard-link" data-edit-action="${escapeHtml(questionId)}">Edit action</button>
            </div>`;
    }
    const dueField = window.AuditActionForm?.renderDueDateField?.(questionId, entry, context) || '';
    return `
        <div class="dfsc-inline-action">
            <textarea class="dfsc-textarea" rows="3" data-action-qid="${escapeHtml(questionId)}"
                placeholder="Describe corrective action taken">${escapeHtml(entry.text)}</textarea>
            ${dueField}
            <button type="button" class="dfsc-btn dfsc-btn-primary dfsc-action-submit" data-submit-action="${escapeHtml(questionId)}">
                Submit action
            </button>
        </div>`;
}

function renderQuestionFooter(question, { inlineButtons = false } = {}) {
    const isNc = isNcAnswer(question, session.answers?.[question.id]);
    const hasNote = Boolean(String(session.notes?.[question.id] || '').trim());
    const noteOpen = expandedNotes.has(question.id) || hasNote;
    const actionSubmitted = isActionSubmitted(question.id);
    return `
        <div class="dfsc-qcard-foot">
            ${
                inlineButtons
                    ? ''
                    : `<div class="dfsc-qcard-footer">
                <button type="button" class="dfsc-qcard-btn dfsc-qcard-btn--note${noteOpen ? ' is-active' : ''}" data-toggle-note="${escapeHtml(question.id)}">
                    ${NOTE_ICON}<span>Add note</span>
                </button>
            </div>`
            }
            ${noteOpen ? `<div class="dfsc-qcard-strip dfsc-qcard-strip--note"><textarea class="dfsc-textarea" rows="2" data-note-qid="${escapeHtml(question.id)}" placeholder="Add a note">${escapeHtml(session.notes?.[question.id] || '')}</textarea>${renderContributionStamp('notes', question.id)}</div>` : ''}
            ${
                isNc
                    ? `<div class="dfsc-qcard-strip${actionSubmitted && !expandedActions.has(question.id) ? ' dfsc-qcard-strip--submitted' : ''}">${renderActionForm(question.id)}</div>`
                    : ''
            }
        </div>`;
}

function renderQuestion(question) {
    if (question.type === 'banner') {
        return `
            <div class="dfsc-group-banner">
                <p class="dfsc-group-banner__title">${escapeHtml(question.bannerTitle || '')}</p>
                ${question.bannerSubtitle ? `<p class="dfsc-group-banner__subtitle">${escapeHtml(question.bannerSubtitle)}</p>` : ''}
            </div>`;
    }

    const value = session.answers?.[question.id] ?? '';
    const isNc = isNcAnswer(question, value);
    const unanswered = question.required && isAnswerEmpty(question, value);
    let control = '';

    if (isSquareStandardType(question.type)) {
        control = `
            <div class="dfsc-qcard-actions">
                ${renderChoiceGroup(question)}
                <div class="dfsc-qcard-footer-btns">
                    <button type="button" class="dfsc-qcard-btn dfsc-qcard-btn--note${expandedNotes.has(question.id) ? ' is-active' : ''}" data-toggle-note="${escapeHtml(question.id)}">
                        ${NOTE_ICON}<span>Add note</span>
                    </button>
                    <button type="button" class="dfsc-qcard-btn dfsc-qcard-btn--media${session.photos?.[question.id] ? ' is-active' : ''}" data-add-photo="${escapeHtml(question.id)}" aria-label="Attach photo">
                        ${IMAGE_ICON}<span>Photo</span>
                    </button>
                </div>
            </div>`;
        if (photoMissing(question)) {
            control += `<p class="dfsc-field-hint">Photo evidence required for completed items.</p>`;
        }
    }

    const actionSubmitted = isActionSubmitted(question.id);
    const ncAlert = !isNc
        ? ''
        : actionSubmitted
          ? `<div class="dfsc-nc-alert dfsc-nc-alert--done">Not complete - action submitted</div>`
          : `<div class="dfsc-nc-alert">SUBMIT A CORRECTIVE ACTION FOR THIS ITEM</div>`;

    const cardClass = [
        'dfsc-qcard',
        isSquareStandardType(question.type) ? 'dfsc-qcard--action-grid' : '',
        isNc ? (actionSubmitted ? 'dfsc-qcard--nc-resolved' : 'dfsc-qcard--nc') : '',
        unanswered && !isNc ? 'dfsc-qcard--pending' : '',
    ]
        .filter(Boolean)
        .join(' ');

    return `
        <article class="${cardClass}" data-question-id="${escapeHtml(question.id)}">
            <div class="dfsc-qcard-content">
                <p class="dfsc-qcard-label">${question.required ? '<span class="dfsc-required">*</span>' : ''}${escapeHtml(question.label)}</p>
                ${control}
                ${renderContributionStamp('answers', question.id, { prefix: 'Answered' })}
                ${session.photos?.[question.id] ? renderContributionStamp('photos', question.id, { prefix: 'Photo added' }) : ''}
                ${ncAlert}
            </div>
            ${renderQuestionFooter(question, { inlineButtons: isSquareStandardType(question.type) })}
        </article>`;
}

function renderQuestionsGrouped(sectionId) {
    const questions = (schema?.questions || []).filter((q) => q.section === sectionId);
    return questions.map((q) => renderQuestion(q)).join('');
}

function renderSignOffSection() {
    return `
        <p class="dfsc-signoff-text">
            Name and signature of Manager completing the inspection.
        </p>
        <div class="dfsc-field">
            <label for="sq-signoff-name">Manager name</label>
            <input class="dfsc-input" id="sq-signoff-name" type="text"
                value="${escapeHtml(session.signOff?.name || session.conductor?.name || context?.conductorFullName || '')}" />
        </div>
        <div class="dfsc-field">
            <span class="dfsc-field-label">Signature</span>
            <div class="dfsc-signature-wrap">
                <canvas id="sq-signoff-signature" class="dfsc-signature-canvas" aria-label="Sign-off signature"></canvas>
                <div class="dfsc-signature-actions">
                    <button type="button" class="dfsc-btn dfsc-btn-ghost" data-clear-signature="sq-signoff-signature">Clear</button>
                </div>
            </div>
        </div>`;
}

function renderAuditHeader() {
    return `
        <header class="dfsc-header">
            <div class="dfsc-tabs-sticky">
                <div class="dfsc-header-top">
                    <div class="dfsc-header-title">
                        <h1 class="dfsc-title">Square One</h1>
                        <div class="dfsc-header-meta">
                            <span>${escapeHtml(areaTitle())}</span>
                        </div>
                    </div>
                </div>
                ${renderStepper()}
            </div>
        </header>`;
}

function renderStepper() {
    const sections = schema?.sections || [];
    return `
        <div class="dfsc-stepper" role="tablist">
            ${sections
                .map((section, index) => {
                    const done = isSectionComplete(section.id);
                    const active = index === currentSectionIndex;
                    const label = SECTION_TAB_LABELS[section.id] || section.label;
                    return `<button type="button" class="dfsc-step ${active ? 'is-active' : ''} ${done ? 'is-done' : ''}"
                        data-section-index="${index}" title="${escapeHtml(section.label)}">${escapeHtml(label)}</button>`;
                })
                .join('')}
        </div>`;
}

function renderQuestionArea({ scrollToTop = false, scrollAnchorQuestionId = null } = {}) {
    const section = schema.sections[currentSectionIndex];
    const scrollAnchor = scrollAnchorQuestionId ? captureScrollAnchor(scrollAnchorQuestionId) : null;
    const progress = sectionProgress(section.id);
    document.getElementById('dfsc-section-title').textContent = section.label.toUpperCase();
    document.getElementById('dfsc-section-progress').textContent = `${progress.answered} / ${progress.total} (${progress.pct}%)`;

    let body = '';
    if (section.id === 'signOff') {
        body = `<div class="dfsc-card">${renderSignOffSection()}</div>`;
    } else {
        body = `<div class="dfsc-questions">${renderQuestionsGrouped(section.id)}</div>`;
    }

    document.getElementById('dfsc-section-body').innerHTML = body;
    if (!scrollToTop && scrollAnchor && Number.isFinite(scrollAnchor.scrollY)) {
        setQuestionAreaScrollY(scrollAnchor.scrollY);
    }

    document.getElementById('dfsc-prev-btn').disabled = currentSectionIndex === 0;
    document.getElementById('dfsc-next-btn').hidden = section.id === 'signOff';
    document.getElementById('dfsc-submit-btn').hidden =
        section.id !== 'signOff' || context?.canCompleteAudits === false;

    bindQuestionEvents();
    bindSignOffSignature();
    updateStepperClasses();
    if (scrollToTop) scrollSectionToTop();
    else if (scrollAnchor) restoreScrollAnchor(scrollAnchor);
}

function updateStepperClasses() {
    document.querySelectorAll('.dfsc-step').forEach((btn, index) => {
        const section = schema.sections[index];
        btn.classList.toggle('is-active', index === currentSectionIndex);
        btn.classList.toggle('is-done', isSectionComplete(section.id));
    });
}

function bindQuestionEvents() {
    document.querySelectorAll('[data-qtype="choice"]').forEach((input) => {
        input.addEventListener('change', () => setAnswer(input.dataset.qid, input.value));
    });
    document.querySelectorAll('[data-note-qid]').forEach((textarea) => {
        textarea.addEventListener('input', () => setNote(textarea.dataset.noteQid, textarea.value));
    });
    document.querySelectorAll('[data-action-qid]').forEach((textarea) => {
        textarea.addEventListener('input', () => setActionDraft(textarea.dataset.actionQid, textarea.value));
    });
    document.querySelectorAll('[data-submit-action]').forEach((btn) => {
        btn.addEventListener('click', () => submitAction(btn.dataset.submitAction));
    });
    document.querySelectorAll('[data-edit-action]').forEach((btn) => {
        btn.addEventListener('click', () => editAction(btn.dataset.editAction));
    });
    document.querySelectorAll('[data-toggle-note]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const qid = btn.dataset.toggleNote;
            if (expandedNotes.has(qid)) expandedNotes.delete(qid);
            else expandedNotes.add(qid);
            renderQuestionArea({ scrollAnchorQuestionId: qid });
        });
    });
    document.querySelectorAll('[data-add-photo]').forEach((btn) => {
        btn.addEventListener('click', () => pickPhoto(btn.dataset.addPhoto));
    });
}

function bindSignOffSignature() {
    const pad = initSignaturePad('sq-signoff-signature');
    if (pad) {
        signaturePads.set('sq-signoff-signature', pad);
        if (session.signOff?.signatureDataUrl) pad.restore(session.signOff.signatureDataUrl);
    }
    document.querySelectorAll('[data-clear-signature]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const padRef = signaturePads.get(btn.dataset.clearSignature);
            padRef?.clear();
            if (btn.dataset.clearSignature.includes('signoff')) {
                session.signOff = session.signOff || {};
                session.signOff.signatureDataUrl = '';
            }
            scheduleSave();
        });
    });
    const nameInput = document.getElementById('sq-signoff-name');
    if (nameInput) {
        nameInput.addEventListener('input', () => {
            session.signOff = session.signOff || {};
            session.signOff.name = nameInput.value;
            scheduleSave();
        });
    }
}

function bindStepperEvents() {
    document.querySelectorAll('[data-section-index]').forEach((btn) => {
        btn.addEventListener('click', () => {
            currentSectionIndex = Number(btn.dataset.sectionIndex);
            renderQuestionArea({ scrollToTop: true });
        });
    });
}

function renderStatusBar() {
    const el = document.getElementById('dfsc-status-bar');
    if (el) el.innerHTML = renderStatus();
}

function renderAuditView() {
    schema = schema || context?.schema;
    app.innerHTML = `
        <div class="dfsc-shell">
            ${renderAuditHeader()}
            <div id="dfsc-status-bar">${renderStatus()}</div>
            <div class="dfsc-section-head">
                <h2 id="dfsc-section-title">INSPECTION</h2>
                <span class="dfsc-section-progress" id="dfsc-section-progress">0 / 0 (0%)</span>
            </div>
            <div id="dfsc-section-body"></div>
            <div class="dfsc-nav-bar">
                <button type="button" class="dfsc-btn dfsc-btn-secondary" id="dfsc-prev-btn">Back</button>
                <button type="button" class="dfsc-btn dfsc-btn-primary" id="dfsc-next-btn">Next</button>
                <button type="button" class="dfsc-btn dfsc-btn-primary" id="dfsc-submit-btn" hidden>Complete Square One</button>
            </div>
        </div>`;

    bindStepperEvents();
    renderQuestionArea({ scrollToTop: true });

    document.getElementById('dfsc-prev-btn').addEventListener('click', () => {
        statusMessage = '';
        if (currentSectionIndex > 0) {
            currentSectionIndex -= 1;
            renderQuestionArea({ scrollToTop: true });
        }
    });

    document.getElementById('dfsc-next-btn').addEventListener('click', async () => {
        statusMessage = '';
        await saveSession();
        if (currentSectionIndex < schema.sections.length - 1) {
            currentSectionIndex += 1;
            renderQuestionArea({ scrollToTop: true });
        }
    });

    document.getElementById('dfsc-submit-btn').addEventListener('click', submitAudit);
}

async function submitAudit() {
    statusMessage = '';
    const signPad = signaturePads.get('sq-signoff-signature');
    const name = document.getElementById('sq-signoff-name')?.value?.trim() || '';
    const signatureDataUrl = signPad?.toDataUrl() || session.signOff?.signatureDataUrl || '';
    if (!name) {
        statusMessage = 'Enter the manager name before completing.';
        statusKind = 'error';
        renderStatusBar();
        return;
    }
    if (!signatureDataUrl) {
        statusMessage = 'Add your signature before completing.';
        statusKind = 'error';
        renderStatusBar();
        return;
    }
    try {
        await saveSession();
        const data = await fetchJson(apiUrl(`${API_PREFIX}/submit`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                store: STORE_NUMBER,
                sessionId: session.id,
                periodKey: session.periodKey,
                signOff: { name, signatureDataUrl },
            }),
        });
        session = data.session;
        renderCompleteView();
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
        renderStatusBar();
    }
}

function renderCompleteView() {
    const score = session.score || {};
    app.innerHTML = `
        <div class="dfsc-shell">
            <article class="dfsc-card">
                <div class="dfsc-complete-icon" aria-hidden="true">✓</div>
                <h2>Square One completed</h2>
                <p class="dfsc-signoff-text">${escapeHtml(session.storeName)} · ${escapeHtml(areaTitle())}</p>
                <p class="dfsc-signoff-text">Score ${typeof score === 'number' ? score : score.percent ?? 0}%</p>
                <p class="dfsc-signoff-text">Completed at ${escapeHtml(new Date(session.completedAt).toLocaleString())}</p>
                <button type="button" class="dfsc-btn dfsc-btn-secondary" id="sq-download-pdf">Download PDF</button>
                <button type="button" class="dfsc-btn dfsc-btn-primary" id="sq-back-tacaudit">Back to TacoAudit</button>
            </article>
        </div>`;
    document.getElementById('sq-back-tacaudit').addEventListener('click', () => {
        window.location.href = tacauditPath();
    });
    document.getElementById('sq-download-pdf').addEventListener('click', () => {
        window.location.href = apiUrl(`${API_PREFIX}/report.pdf`, {
            store: STORE_NUMBER,
            sessionId: session.id,
            periodKey: session.periodKey,
        });
    });
}

function formatAuditTime(iso) {
    if (!iso) return '-';
    try {
        return new Date(iso).toLocaleString(undefined, {
            day: 'numeric',
            month: 'short',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
        });
    } catch {
        return iso;
    }
}

function renderOpenAuditsSection(openAudits = []) {
    if (!openAudits.length) return '';
    const rows = openAudits
        .map(
            (audit) => `
        <li class="dfsc-open-item" data-audit-id="${escapeHtml(audit.id)}">
            <div class="dfsc-open-main">
                <div class="dfsc-open-title">${escapeHtml(audit.conductorName || 'Unknown')}</div>
                <div class="dfsc-open-meta">
                    ${escapeHtml(audit.areaTitle || audit.dashboardLabel || 'Square One')}
                    · Started ${escapeHtml(formatAuditTime(audit.startedAt))}
                </div>
            </div>
            <div class="dfsc-open-actions">
                <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-sm" data-resume-audit="${escapeHtml(audit.id)}" data-audit-period="${escapeHtml(audit.periodKey)}">Resume</button>
                <button type="button" class="dfsc-btn dfsc-btn-danger dfsc-btn-sm" data-delete-audit="${escapeHtml(audit.id)}">Delete</button>
            </div>
        </li>`
        )
        .join('');
    return `
        <section class="dfsc-open-section" aria-labelledby="sq-open-heading">
            <div class="dfsc-open-head">
                <h2 id="sq-open-heading">Your open Square One audits</h2>
                <span class="dfsc-open-count">${openAudits.length}</span>
            </div>
            <ul class="dfsc-open-list">${rows}</ul>
        </section>`;
}

function renderPeriodCompletedSection(rows = []) {
    if (!rows.length) return '';
    const items = rows
        .map(
            (row) => `
        <li class="dfsc-open-item">
            <div class="dfsc-open-main">
                <div class="dfsc-open-title">${escapeHtml(row.conductorName || 'Unknown')}</div>
                <div class="dfsc-open-meta">
                    Completed ${escapeHtml(formatAuditTime(row.completedAt))}
                    · Week ${escapeHtml(row.psiWeek || '?')}
                    · Score ${row.score?.yesCount ?? '-'}/${row.score?.total ?? '-'}
                </div>
            </div>
            <div class="dfsc-open-actions">
                <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-sm" data-pdf-period="${escapeHtml(row.id)}" data-period-key="${escapeHtml(row.periodKey)}">PDF</button>
            </div>
        </li>`
        )
        .join('');
    return `
        <section class="dfsc-open-section dfsc-open-section--completed">
            <div class="dfsc-open-head">
                <h2>Completed this week</h2>
                <span class="dfsc-open-count">${rows.length}</span>
            </div>
            <ul class="dfsc-open-list">${items}</ul>
        </section>`;
}

function renderDueAreaCards() {
    const dueAreas = context?.dueAreas || [];
    return dueAreas
        .map((area) => {
            const complete = area.periodCompleted;
            const inProgress = area.inProgress;
            const stateClass = complete ? ' dfsc-area-card--complete' : inProgress ? ' dfsc-area-card--progress' : '';
            return `
            <button type="button" class="dfsc-area-card${stateClass}" data-pick-area="${escapeHtml(area.id)}" ${complete ? 'disabled' : ''}>
                <div class="dfsc-area-card__title">${escapeHtml(area.title || area.dashboardLabel)}</div>
                <div class="dfsc-area-card__sub">${complete ? 'Complete this week' : inProgress ? 'In progress - resume below' : 'Due this week'}</div>
            </button>`;
        })
        .join('');
}

function renderLandingView() {
    const openAudits = context.openAudits || [];
    const dueAreas = context.dueAreas || [];
    const completedCount = dueAreas.filter((a) => a.periodCompleted).length;

    app.innerHTML = `
        <div class="dfsc-shell">
            <div class="dfsc-landing-head">
                <h1>Square One</h1>
                <p>${completedCount}/${dueAreas.length} complete this week · Period ${escapeHtml(context.periodKey)}</p>
                <p class="dfsc-field-hint">Two deep-clean areas rotate each week. Select an area to begin.</p>
            </div>
            <div class="dfsc-area-grid">${renderDueAreaCards()}</div>
            ${renderOpenAuditsSection(openAudits)}
            <div id="dfsc-status-bar">${renderStatus()}</div>
            <article class="dfsc-card" id="sq-start-card" hidden>
                <h2 id="sq-start-heading">Before you begin</h2>
                <div class="dfsc-field">
                    <label>Restaurant</label>
                    <input class="dfsc-input dfsc-input-readonly" readonly value="${escapeHtml(context.storeName)}" />
                </div>
                <div class="dfsc-field">
                    <label>Area</label>
                    <input class="dfsc-input dfsc-input-readonly" readonly id="sq-area-label" value="" />
                </div>
                <div class="dfsc-field">
                    <label for="sq-name">Conducted by (full name)</label>
                    <input class="dfsc-input" id="sq-name" type="text" autocomplete="name" value="${escapeHtml(context.conductorFullName || '')}" />
                </div>
                <div class="dfsc-field">
                    <span class="dfsc-field-label">Signature</span>
                    <div class="dfsc-signature-wrap">
                        <canvas id="sq-start-signature" class="dfsc-signature-canvas" aria-label="Start signature"></canvas>
                        <div class="dfsc-signature-actions">
                            <button type="button" class="dfsc-btn dfsc-btn-ghost" data-clear-signature="sq-start-signature">Clear</button>
                        </div>
                    </div>
                </div>
                <button type="button" class="dfsc-btn dfsc-btn-primary" id="sq-begin-btn">Begin Square One</button>
            </article>
        </div>`;

    const startPad = initSignaturePad('sq-start-signature');
    signaturePads.set('sq-start-signature', startPad);

    document.querySelectorAll('[data-pick-area]').forEach((btn) => {
        btn.addEventListener('click', () => selectArea(btn.dataset.pickArea));
    });
    document.getElementById('sq-begin-btn').addEventListener('click', () => startSession(false));
    document.querySelectorAll('[data-resume-audit]').forEach((btn) => {
        btn.addEventListener('click', () =>
            resumeSession({ id: btn.dataset.resumeAudit, periodKey: btn.dataset.auditPeriod })
        );
    });
    document.querySelectorAll('[data-delete-audit]').forEach((btn) => {
        btn.addEventListener('click', () => deleteOpenAudit(btn.dataset.deleteAudit));
    });
    document.querySelectorAll('[data-pdf-period]').forEach((btn) => {
        btn.addEventListener('click', () => {
            window.location.href = apiUrl(`${API_PREFIX}/report.pdf`, {
                store: STORE_NUMBER,
                sessionId: btn.dataset.pdfPeriod,
                periodKey: btn.dataset.periodKey,
            });
        });
    });
    document.querySelectorAll('[data-clear-signature="sq-start-signature"]').forEach((btn) => {
        btn.addEventListener('click', () => signaturePads.get('sq-start-signature')?.clear());
    });
}

function selectArea(areaId) {
    selectedAreaId = String(areaId || '').trim();
    const area = (context?.dueAreas || []).find((a) => a.id === selectedAreaId);
    const card = document.getElementById('sq-start-card');
    const label = document.getElementById('sq-area-label');
    const heading = document.getElementById('sq-start-heading');
    if (label) label.value = area?.title || area?.dashboardLabel || selectedAreaId;
    if (heading) heading.textContent = `Before you begin - ${area?.title || area?.dashboardLabel || 'Square One'}`;
    if (card) card.hidden = !selectedAreaId;
    if (area?.inProgress) {
        void resumeSession(area.inProgress);
    }
}

async function loadSchemaForArea(areaId) {
    const data = await fetchJson(apiUrl(`${API_PREFIX}/context`, { store: STORE_NUMBER, areaId }));
    schema = data.schema;
}

async function startSession(forceNew) {
    statusMessage = '';
    const name = document.getElementById('sq-name')?.value?.trim() || '';
    const startPad = signaturePads.get('sq-start-signature');
    const startSignatureDataUrl = startPad?.toDataUrl() || '';
    if (!selectedAreaId) {
        statusMessage = 'Select a Square One area first.';
        statusKind = 'error';
        renderStatusBar();
        return;
    }
    if (!name) {
        statusMessage = 'Enter your full name.';
        statusKind = 'error';
        renderStatusBar();
        return;
    }
    if (!startSignatureDataUrl) {
        statusMessage = 'Add your signature before beginning.';
        statusKind = 'error';
        renderStatusBar();
        return;
    }
    try {
        const data = await fetchJson(apiUrl(`${API_PREFIX}/start`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                store: STORE_NUMBER,
                areaId: selectedAreaId,
                name,
                startSignatureDataUrl,
                forceNew: Boolean(forceNew),
            }),
        });
        session = data.session;
        await loadSchemaForArea(session.areaId);
        window.history.replaceState({}, '', `/${STORE_NUMBER}/square-one/audit?session=${session.id}`);
        renderAuditView();
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
        renderStatusBar();
    }
}

async function resumeSession(inProgress) {
    try {
        const data = await fetchJson(
            apiUrl(`${API_PREFIX}/session`, {
                store: STORE_NUMBER,
                sessionId: inProgress.id,
                periodKey: inProgress.periodKey,
            })
        );
        session = data.session;
        await loadSchemaForArea(session.areaId);
        window.history.replaceState({}, '', `/${STORE_NUMBER}/square-one/audit?session=${session.id}`);
        renderAuditView();
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
        renderLandingView();
    }
}

async function deleteOpenAudit(sessionId) {
    if (!window.confirm('Delete this open Square One audit? This cannot be undone.')) return;
    try {
        await fetch(apiUrl(`${API_PREFIX}/session`, { store: STORE_NUMBER, sessionId }), {
            method: 'DELETE',
            credentials: 'include',
        });
        context = await fetchJson(apiUrl(`${API_PREFIX}/context`, { store: STORE_NUMBER }));
        renderLandingView();
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
        renderStatusBar();
    }
}

async function loadSessionFromQuery() {
    const sessionId = new URLSearchParams(window.location.search).get('session');
    if (!sessionId) return false;
    try {
        const data = await fetchJson(apiUrl(`${API_PREFIX}/session`, { store: STORE_NUMBER, sessionId }));
        session = data.session;
        await loadSchemaForArea(session.areaId);
        if (session.status === 'completed') {
            renderCompleteView();
            return true;
        }
        renderAuditView();
        return true;
    } catch {
        return false;
    }
}

async function init() {
    if (!STORE_NUMBER) {
        app.textContent = 'Invalid store.';
        return;
    }
    mountBackNav();
    try {
        const [, contextData] = await Promise.all([
            window.AuditPreferences?.init?.(),
            fetchJson(apiUrl(`${API_PREFIX}/context`, { store: STORE_NUMBER })),
        ]);
        context = contextData;
        schema = context.schema;
        const areaParam = new URLSearchParams(window.location.search).get('area');
        if (IS_AUDIT_VIEW) {
            if (await loadSessionFromQuery()) return;
            window.location.replace(`/${STORE_NUMBER}/square-one`);
            return;
        }
        if (await loadSessionFromQuery()) return;
        renderLandingView();
        if (areaParam) selectArea(areaParam);
    } catch (err) {
        const denied = /not available|403/i.test(String(err.message || ''));
        app.innerHTML = `<div class="dfsc-shell"><div class="dfsc-status dfsc-status--error">${escapeHtml(
            denied
                ? 'Weekly audits are not available on shared store login accounts. Ask your manager to create a personal crew account for you.'
                : err.message
        )}</div><p style="margin-top:1rem;text-align:center"><a class="dfsc-btn dfsc-btn-secondary" href="${escapeHtml(tacauditPath())}">Back to TacoAudit</a></p></div>`;
    }
}

init();
