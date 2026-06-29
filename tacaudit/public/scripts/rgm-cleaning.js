const pathMatch = window.location.pathname.match(/^\/(teststore|\d{3,6})\/rgm-cleaning(?:\/audit)?\/?$/i);
const STORE_NUMBER = pathMatch ? pathMatch[1].toLowerCase() : '';
const IS_AUDIT_VIEW = /\/rgm-cleaning\/audit\/?$/i.test(window.location.pathname);
const API_PREFIX = '/api/rgm-cleaning';

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
let timerInterval = null;
const signaturePads = new Map();
const expandedNotes = new Set();
const expandedActions = new Set();
let landingView = 'start';
let inspectionHistory = [];

const SECTION_TAB_LABELS = {
    cleaningAssessment: 'Assessment',
    squareOneReview: 'Sq. One',
    actionPlan: 'Actions',
    signOff: 'Sign off',
};

const SIGNATURE_DRAW_SCALE_MAX = 2;
const IMAGE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 10.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 19l-5.5-7-4 5-2.5-3L5 19h16z"/></svg>`;

function sessionElapsedMs() {
    const started = startedAtMs();
    if (!Number.isFinite(started)) return 0;
    return Math.max(0, Date.now() - started);
}

function squareOnePhotoCandidates() {
    return Array.isArray(session?.squareOnePhotoCandidates)
        ? session.squareOnePhotoCandidates
        : Array.isArray(context?.squareOnePhotoCandidates)
          ? context.squareOnePhotoCandidates
          : [];
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

function micPath() {
    return window.AppPaths?.overview?.() || '/overview';
}

function tacauditPath() {
    return window.AppPaths?.tacaudit?.(STORE_NUMBER) || `/${STORE_NUMBER}/tacaudit`;
}

function mountBackNav() {
    window.DashboardNavBack?.mountBackButton(document.getElementById('rgm-nav-back'), {
        fallback: tacauditPath(),
        alwaysFallback: true,
    });
}

function formatElapsed(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function startedAtMs() {
    return Date.parse(session?.startedAt || '');
}

function visibleQuestions(sectionId) {
    return (schema?.questions || []).filter((q) => q.section === sectionId && q.type !== 'banner');
}

function isCleaningRatingType(type) {
    return type === 'cleaning_rating';
}

function isAnswerEmpty(question, value) {
    if (!question) return true;
    if (question.type === 'banner') return false;
    if (question.type === 'textarea') {
        if (!question.required) return false;
        return !String(value ?? '').trim();
    }
    if (isCleaningRatingType(question.type)) {
        if (!question.required && (value === '' || value == null)) return false;
        return value !== 'satisfactory' && value !== 'not_satisfactory';
    }
    return value === null || value === undefined || String(value).trim() === '';
}

const questionGroups = window.AuditQuestionGroupsUi.createController({ isAnswerEmpty });
const {
    collapsedGroups: collapsedQuestionGroups,
    expandQuestionGroup,
    autoCollapseCompletedGroups,
    toggleQuestionGroup,
    captureScrollAnchor,
    restoreScrollAnchor,
    renderGroupShell,
    setPageScrollY: setQuestionAreaScrollY,
} = questionGroups;

const AUTO_COLLAPSE_SKIP_SECTIONS = new Set(['squareOneReview', 'actionPlan', 'signOff']);

function isNcAnswer(question, value) {
    return isCleaningRatingType(question.type) && String(value || '').toLowerCase() === 'not_satisfactory';
}

function getActionEntry(questionId) {
    const raw = session.actions?.[questionId];
    if (!raw) return { text: '', submittedAt: null };
    return { text: String(raw.text || ''), submittedAt: raw.submittedAt || null };
}

function isActionSubmitted(questionId) {
    const entry = getActionEntry(questionId);
    return Boolean(entry.submittedAt && entry.text.trim());
}

function collectNonCompliant() {
    const out = [];
    for (const question of schema?.questions || []) {
        if (!isCleaningRatingType(question.type)) continue;
        const value = session.answers?.[question.id];
        if (!isNcAnswer(question, value)) continue;
        const action = getActionEntry(question.id);
        out.push({
            questionId: question.id,
            label: question.label,
            group: question.group,
            actionText: action.text,
            actionSubmitted: isActionSubmitted(question.id),
        });
    }
    return out;
}

function sectionProgress(sectionId) {
    const questions = visibleQuestions(sectionId).filter((q) => q.type !== 'textarea');
    const total = questions.filter((q) => q.required !== false).length;
    const answered = questions.filter((q) => {
        const v = session?.answers?.[q.id];
        return !isAnswerEmpty(q, v);
    }).length;
    const pct = total ? Math.round((answered / total) * 100) : 100;
    return { answered, total, pct };
}

function isSectionComplete(sectionId) {
    if (sectionId === 'squareOneReview') {
        const candidates = squareOnePhotoCandidates();
        if (!candidates.length) return true;
        const reviews = session?.squareOnePhotoReviews || {};
        return candidates.every((photo) => {
            const r = String(reviews[photo.id]?.rating || '').toLowerCase();
            return r === 'satisfactory' || r === 'not_satisfactory';
        });
    }
    if (sectionId === 'actionPlan') {
        const ncGroups = new Set(collectNonCompliant().map((r) => r.group));
        if (ncGroups.has('Bin Room') || ncGroups.has('BOH/FOH Bins')) ncGroups.add('Dumpster & Bins');
        const fields = {
            'Drink Machines': 'action_drinkMachines',
            Drains: 'action_drains',
            Floors: 'action_floors',
            Restrooms: 'action_restrooms',
            'Dumpster & Bins': 'action_dumpsterBins',
        };
        for (const group of ncGroups) {
            const key = group === 'Bin Room' || group === 'BOH/FOH Bins' ? 'Dumpster & Bins' : group;
            const fieldId = fields[key];
            if (fieldId && !String(session?.answers?.[fieldId] || '').trim()) return false;
        }
        return true;
    }
    if (sectionId === 'signOff') {
        return Boolean(session?.signOff?.name?.trim() && session?.signOff?.signatureDataUrl);
    }
    const questions = visibleQuestions(sectionId);
    for (const question of questions) {
        if (!question.required) continue;
        if (isAnswerEmpty(question, session?.answers?.[question.id])) return false;
        if (isNcAnswer(question, session?.answers?.[question.id])) {
            if (!String(session?.notes?.[question.id] || '').trim()) return false;
        }
    }
    return true;
}

function renderStatus() {
    if (!statusMessage) return '';
    return `<div class="dfsc-status dfsc-status--${statusKind || 'info'}">${escapeHtml(statusMessage)}</div>`;
}

function setPageScrollY(y) {
    window.scrollTo(0, y);
}

function scrollSectionToTop() {
    setPageScrollY(0);
}

function blurActiveTextInput() {
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.blur();
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
                    squareOnePhotoReviews: s.squareOnePhotoReviews,
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
    if (question && isNcAnswer(question, value)) expandedNotes.add(questionId);
    expandQuestionGroup(schema, questionId);
    scheduleSave();
    renderQuestionArea({ scrollAnchorQuestionId: questionId });
}

function setNote(questionId, value) {
    session.notes = session.notes || {};
    session.notes[questionId] = value;
    scheduleSave();
    renderQuestionArea({ scrollAnchorQuestionId: questionId });
}

function setActionDraft(questionId, value) {
    session.actions = session.actions || {};
    const prev = getActionEntry(questionId);
    session.actions[questionId] = { text: value, submittedAt: prev.submittedAt };
    scheduleSave();
}

async function submitAction(questionId) {
    const entry = getActionEntry(questionId);
    if (!entry.text.trim()) {
        statusMessage = 'Enter an action before submitting.';
        statusKind = 'error';
        renderStatusBar();
        return;
    }
    session.actions[questionId] = { text: entry.text.trim(), submittedAt: new Date().toISOString(), submit: true };
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

    function pos(e) {
        const r = canvas.getBoundingClientRect();
        const touch = e.touches?.[0];
        const clientX = touch ? touch.clientX : e.clientX;
        const clientY = touch ? touch.clientY : e.clientY;
        return { x: clientX - r.left, y: clientY - r.top };
    }

    function start(e) {
        blurActiveTextInput();
        e.preventDefault();
        drawing = true;
        const p = pos(e);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
    }

    function move(e) {
        if (!drawing) return;
        e.preventDefault();
        hasStroke = true;
        const p = pos(e);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
    }

    function end(e) {
        if (!drawing) return;
        e.preventDefault();
        drawing = false;
        if (hasStroke) {
            const dataUrl = canvas.toDataURL('image/png');
            if (canvasId.includes('signoff')) {
                session.signOff = session.signOff || {};
                session.signOff.signatureDataUrl = dataUrl;
            } else {
                session.conductor = session.conductor || {};
                session.conductor.startSignatureDataUrl = dataUrl;
            }
            scheduleSave();
        }
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
    const options = [
        ['satisfactory', 'Satisfactory', 'dfsc-choice--yesno'],
        ['not_satisfactory', 'Not Satisfactory', 'dfsc-choice--nc'],
    ];
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

const NOTE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 3H5a2 2 0 0 0-2 2v14l4-4h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/></svg>`;

function renderContributionStamp(type, id, options = {}) {
    return window.AuditContributionsUi?.renderContributionStamp(session, type, id, options) || '';
}

function renderActionForm(questionId) {
    const entry = getActionEntry(questionId);
    const submitted = isActionSubmitted(questionId);
    const open = expandedActions.has(questionId) || !submitted;
    if (submitted && !open) {
        return `
            <div class="dfsc-inline-action dfsc-inline-action--submitted">
                <div class="dfsc-action-submitted-label">Action submitted</div>
                <p class="dfsc-action-submitted-text">${escapeHtml(entry.text)}</p>
                ${renderContributionStamp('actions', questionId, { prefix: 'Submitted' })}
                <button type="button" class="dfsc-qcard-link" data-edit-action="${escapeHtml(questionId)}">Edit action</button>
            </div>`;
    }
    return `
        <div class="dfsc-inline-action">
            <textarea class="dfsc-textarea" rows="3" data-action-qid="${escapeHtml(questionId)}"
                placeholder="Describe corrective action taken">${escapeHtml(entry.text)}</textarea>
            <button type="button" class="dfsc-btn dfsc-btn-primary dfsc-action-submit" data-submit-action="${escapeHtml(questionId)}">
                Submit action
            </button>
        </div>`;
}

function renderQuestionFooter(question, { inlineButtons = false } = {}) {
    const isNc = isNcAnswer(question, session.answers?.[question.id]);
    const hasNote = Boolean(String(session.notes?.[question.id] || '').trim());
    const noteOpen = expandedNotes.has(question.id) || hasNote || isNc;
    const noteRequired = isNc && !hasNote;
    return `
        <div class="dfsc-qcard-foot">
            ${
                inlineButtons
                    ? ''
                    : `<div class="dfsc-qcard-footer">
                <button type="button" class="dfsc-qcard-btn dfsc-qcard-btn--note${noteOpen ? ' is-active' : ''}" data-toggle-note="${escapeHtml(question.id)}">
                    ${NOTE_ICON}<span>${isNc ? 'Describe issue' : 'Add note'}</span>
                </button>
                <button type="button" class="dfsc-qcard-btn dfsc-qcard-btn--media" data-add-photo="${escapeHtml(question.id)}" aria-label="Attach photo">
                    ${IMAGE_ICON}<span>Photo</span>
                </button>
            </div>`
            }
            ${noteOpen ? `<div class="dfsc-qcard-strip dfsc-qcard-strip--note"><textarea class="dfsc-textarea" rows="2" data-note-qid="${escapeHtml(question.id)}" placeholder="${isNc ? 'Describe what needs to be improved (required)' : 'Add a note'}">${escapeHtml(session.notes?.[question.id] || '')}</textarea>${noteRequired ? '<p class="dfsc-field-hint">A note is required for not satisfactory items.</p>' : ''}${renderContributionStamp('notes', question.id)}</div>` : ''}
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

    if (isCleaningRatingType(question.type)) {
        control = `
            <div class="dfsc-qcard-actions">
                ${renderChoiceGroup(question)}
                <div class="dfsc-qcard-footer-btns">
                    <button type="button" class="dfsc-qcard-btn dfsc-qcard-btn--note${expandedNotes.has(question.id) ? ' is-active' : ''}" data-toggle-note="${escapeHtml(question.id)}">
                        ${NOTE_ICON}<span>Add note</span>
                    </button>
                </div>
            </div>`;
    } else if (question.type === 'textarea') {
        control = `<textarea class="dfsc-textarea" rows="4" data-qid="${escapeHtml(question.id)}" data-qtype="textarea"
            placeholder="${escapeHtml(question.placeholder || '')}">${escapeHtml(value)}</textarea>`;
    }

    const hasNote = Boolean(String(session.notes?.[question.id] || '').trim());
    const ncAlert = !isNc
        ? ''
        : hasNote
          ? `<div class="dfsc-nc-alert dfsc-nc-alert--done">Not satisfactory - note recorded</div>`
          : `<div class="dfsc-nc-alert">ADD A NOTE AND PHOTO FOR THIS ITEM</div>`;

    const cardClass = [
        'dfsc-qcard',
        isCleaningRatingType(question.type) ? 'dfsc-qcard--action-grid' : '',
        isNc ? (hasNote ? 'dfsc-qcard--nc-resolved' : 'dfsc-qcard--nc') : '',
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
            ${renderQuestionFooter(question, { inlineButtons: isCleaningRatingType(question.type) })}
        </article>`;
}

function renderQuestionGroupBlock(sectionId, groupName, groupQuestions) {
    return renderGroupShell({
        sectionId,
        groupName,
        groupQuestions,
        session,
        renderQuestion,
    });
}

function renderQuestionsGrouped(sectionId) {
    const questions = (schema?.questions || []).filter((q) => q.section === sectionId);
    let html = '';
    let index = 0;
    while (index < questions.length) {
        const question = questions[index];
        if (!question.group) {
            html += renderQuestion(question);
            index += 1;
            continue;
        }
        const groupName = question.group;
        const groupQuestions = [];
        while (index < questions.length && questions[index].group === groupName) {
            groupQuestions.push(questions[index]);
            index += 1;
        }
        html += renderQuestionGroupBlock(sectionId, groupName, groupQuestions);
    }
    return html;
}

function renderSquareOneReviewSection() {
    const intro = (schema?.questions || []).find((q) => q.type === 'square_one_photos');
    const candidates = squareOnePhotoCandidates();
    const reviews = session.squareOnePhotoReviews || {};

    if (!candidates.length) {
        return `
            ${intro ? renderQuestion(intro) : ''}
            <p class="dfsc-field-hint">No Square One photos for this week yet. When Square One audits are completed, their photos will appear here for satisfactory / not satisfactory review.</p>`;
    }

    const cards = candidates
        .map((photo) => {
            const id = escapeHtml(photo.id);
            const rating = String(reviews[photo.id]?.rating || '');
            const src = photo.dataUrl || photo.url || '';
            return `
            <article class="dfsc-qcard dfsc-qcard--action-grid" data-square-photo="${id}">
                <div class="dfsc-qcard-content">
                    <p class="dfsc-qcard-label">${escapeHtml(photo.area || photo.label || 'Square One')} · ${escapeHtml(photo.caption || 'Photo')}</p>
                    ${src ? `<img class="dfsc-square-photo" src="${escapeHtml(src)}" alt="" style="max-width:100%;border-radius:6px;margin:0.5rem 0" />` : ''}
                    <div class="dfsc-qcard-actions">
                        <div class="dfsc-radio-group" role="radiogroup">
                            <label class="dfsc-choice dfsc-choice--yesno">
                                <input type="radio" name="sq-${id}" value="satisfactory" ${rating === 'satisfactory' ? 'checked' : ''} data-square-photo-id="${id}" />
                                <span>Satisfactory</span>
                            </label>
                            <label class="dfsc-choice dfsc-choice--nc">
                                <input type="radio" name="sq-${id}" value="not_satisfactory" ${rating === 'not_satisfactory' ? 'checked' : ''} data-square-photo-id="${id}" />
                                <span>Not Satisfactory</span>
                            </label>
                        </div>
                    </div>
                </div>
            </article>`;
        })
        .join('');

    return `${intro ? renderQuestion(intro) : ''}<div class="dfsc-questions">${cards}</div>`;
}

function setSquareOnePhotoRating(photoId, rating) {
    session.squareOnePhotoReviews = session.squareOnePhotoReviews || {};
    session.squareOnePhotoReviews[photoId] = {
        ...(session.squareOnePhotoReviews[photoId] || {}),
        rating,
        reviewedAt: new Date().toISOString(),
    };
    scheduleSave();
    renderQuestionArea();
}

function renderActionPlanSection() {
    const intro = (schema?.questions || []).find((q) => q.id === 'action_plan_intro');
    const fields = (schema?.questions || []).filter((q) => q.section === 'actionPlan' && q.type === 'textarea');
    const ncGroups = new Set(collectNonCompliant().map((r) => r.group));
    if (ncGroups.has('Bin Room') || ncGroups.has('BOH/FOH Bins')) ncGroups.add('Dumpster & Bins');

    return `
        ${intro ? renderQuestion(intro) : ''}
        ${fields
            .map((q) => {
                const area = q.actionPlanArea || q.label;
                const needsPlan = [...ncGroups].some((g) => {
                    if (area === 'Dumpster & Bins') return g === 'Bin Room' || g === 'BOH/FOH Bins' || g === 'Dumpster & Bins';
                    return g === area;
                });
                const value = session.answers?.[q.id] ?? '';
                return `
            <div class="dfsc-field">
                <label for="field-${escapeHtml(q.id)}">${escapeHtml(q.label)}${needsPlan ? ' <span class="dfsc-required">*</span>' : ''}</label>
                <textarea class="dfsc-textarea" id="field-${escapeHtml(q.id)}" rows="3" data-qid="${escapeHtml(q.id)}" data-qtype="textarea"
                    placeholder="${escapeHtml(q.placeholder || '')}">${escapeHtml(value)}</textarea>
            </div>`;
            })
            .join('')}`;
}

function renderSignOffSection() {
    return `
        <p class="dfsc-signoff-text">Action Plan Completed By:</p>
        <div class="dfsc-field">
            <label for="rgm-signoff-name">Manager name</label>
            <input class="dfsc-input" id="rgm-signoff-name" type="text"
                value="${escapeHtml(session.signOff?.name || session.conductor?.name || context?.conductorFullName || '')}" />
        </div>
        <div class="dfsc-field">
            <span class="dfsc-field-label">Signature</span>
            <div class="dfsc-signature-wrap">
                <canvas id="rgm-signoff-signature" class="dfsc-signature-canvas" aria-label="Sign-off signature"></canvas>
                <div class="dfsc-signature-actions">
                    <button type="button" class="dfsc-btn dfsc-btn-ghost" data-clear-signature="rgm-signoff-signature">Clear</button>
                </div>
            </div>
        </div>`;
}

function renderAuditHeader() {
    const elapsed = formatElapsed(Date.now() - startedAtMs());
    return `
        <header class="dfsc-header">
            <div class="dfsc-tabs-sticky">
                <div class="dfsc-header-top">
                    <div class="dfsc-header-title">
                        <h1 class="dfsc-title">RGM Cleaning Checklist</h1>
                        <div class="dfsc-header-meta">
                            <span id="rgm-timer">${escapeHtml(elapsed)}</span>
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
    if (!AUTO_COLLAPSE_SKIP_SECTIONS.has(section.id)) {
        autoCollapseCompletedGroups({
            sectionId: section.id,
            activeQuestionId: scrollAnchorQuestionId || null,
            schema,
            session,
            visibleQuestions,
        });
    }

    const progress = sectionProgress(section.id);
    document.getElementById('dfsc-section-title').textContent = section.label.toUpperCase();
    document.getElementById('dfsc-section-progress').textContent = `${progress.answered} / ${progress.total} (${progress.pct}%)`;

    let body = '';
    if (section.id === 'squareOneReview') {
        body = renderSquareOneReviewSection();
    } else if (section.id === 'actionPlan') {
        body = `<div class="dfsc-questions">${renderActionPlanSection()}</div>`;
    } else if (section.id === 'signOff') {
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
    document.querySelectorAll('[data-qtype="textarea"]').forEach((textarea) => {
        textarea.addEventListener('input', () => setAnswer(textarea.dataset.qid, textarea.value));
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
    document.querySelectorAll('[data-note-qid]').forEach((textarea) => {
        textarea.addEventListener('input', () => setNote(textarea.dataset.noteQid, textarea.value));
    });
    document.querySelectorAll('[data-toggle-group]').forEach((btn) => {
        btn.addEventListener('click', () => toggleQuestionGroup(btn.dataset.toggleGroup));
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
        btn.addEventListener('click', () => {
            statusMessage = 'Photo attachments will link to device camera soon.';
            statusKind = 'info';
            renderStatusBar();
        });
    });
    document.querySelectorAll('[data-square-photo-id]').forEach((input) => {
        input.addEventListener('change', () => {
            setSquareOnePhotoRating(input.dataset.squarePhotoId, input.value);
        });
    });
}

function bindSignOffSignature() {
    const pad = initSignaturePad('rgm-signoff-signature');
    if (pad) {
        signaturePads.set('rgm-signoff-signature', pad);
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
    const nameInput = document.getElementById('rgm-signoff-name');
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
    app.innerHTML = `
        <div class="dfsc-shell">
            ${renderAuditHeader()}
            <div id="dfsc-status-bar">${renderStatus()}</div>
            <div class="dfsc-section-head">
                <h2 id="dfsc-section-title">WALKING INSIDE</h2>
                <span class="dfsc-section-progress" id="dfsc-section-progress">0 / 0 (0%)</span>
            </div>
            <div id="dfsc-section-body"></div>
            <div class="dfsc-nav-bar">
                <button type="button" class="dfsc-btn dfsc-btn-secondary" id="dfsc-prev-btn">Back</button>
                <button type="button" class="dfsc-btn dfsc-btn-primary" id="dfsc-next-btn">Next</button>
                <button type="button" class="dfsc-btn dfsc-btn-primary" id="dfsc-submit-btn" hidden>Complete RGM Cleaning</button>
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
    startTimer();
}

function startTimer() {
    if (timerInterval) window.clearInterval(timerInterval);
    timerInterval = window.setInterval(() => {
        const el = document.getElementById('rgm-timer');
        if (el) el.textContent = formatElapsed(sessionElapsedMs());
    }, 1000);
}

async function submitAudit() {
    statusMessage = '';
    const signPad = signaturePads.get('rgm-signoff-signature');
    const name = document.getElementById('rgm-signoff-name')?.value?.trim() || '';
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
    if (timerInterval) window.clearInterval(timerInterval);
    const score = session.score || {};
    app.innerHTML = `
        <div class="dfsc-shell">
            <article class="dfsc-card">
                <div class="dfsc-complete-icon" aria-hidden="true">✓</div>
                <h2>RGM Cleaning completed</h2>
                <p class="dfsc-signoff-text">
                    ${escapeHtml(session.storeName)} · Week ${escapeHtml(session.periodKey)}
                </p>
                <p class="dfsc-signoff-text">
                    Score ${score.satisfactoryCount ?? '-'} / ${score.total ?? '-'} (${score.percent ?? 0}%)
                    · ${score.flaggedCount ?? 0} flagged
                </p>
                <p class="dfsc-signoff-text">Completed at ${escapeHtml(new Date(session.completedAt).toLocaleString())}</p>
                <button type="button" class="dfsc-btn dfsc-btn-secondary" id="rgm-download-pdf">Download PDF</button>
                <button type="button" class="dfsc-btn dfsc-btn-primary" id="rgm-back-dashboard">Back to TacoAudit</button>
            </article>
        </div>`;
    document.getElementById('rgm-back-dashboard').addEventListener('click', () => {
        window.location.href = tacauditPath();
    });
    document.getElementById('rgm-download-pdf').addEventListener('click', () => {
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
                    Started ${escapeHtml(formatAuditTime(audit.startedAt))}
                    · ${escapeHtml(audit.periodKey)}
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
        <section class="dfsc-open-section" aria-labelledby="rgm-open-heading">
            <div class="dfsc-open-head">
                <h2 id="rgm-open-heading">Your open audits</h2>
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
                    · Score ${row.score?.satisfactoryCount ?? '-'}/${row.score?.total ?? '-'}
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

function renderLandingView() {
    const openAudits = context.openAudits || [];
    const periodCompleted = context.periodCompleted || [];
    const periodStatus = context.periodSummary?.periodCompleted ? 'Complete for this week' : 'Due this week';

    app.innerHTML = `
        <div class="dfsc-shell">
            <div class="dfsc-landing-head">
                <h1>RGM Cleaning Checklist</h1>
                <p>${escapeHtml(periodStatus)} · Period ${escapeHtml(context.periodKey)}</p>
            </div>
            ${renderPeriodCompletedSection(periodCompleted)}
            ${renderOpenAuditsSection(openAudits)}
            <div id="dfsc-status-bar">${renderStatus()}</div>
            <article class="dfsc-card">
                <h2>Before you begin</h2>
                <div class="dfsc-field">
                    <label>Restaurant</label>
                    <input class="dfsc-input dfsc-input-readonly" readonly value="${escapeHtml(context.storeName)}" />
                </div>
                <div class="dfsc-field">
                    <label>Audit period</label>
                    <input class="dfsc-input dfsc-input-readonly" readonly value="${escapeHtml(context.periodKey)}" />
                </div>
                <div class="dfsc-field">
                    <label>Time</label>
                    <input class="dfsc-input dfsc-input-readonly" readonly id="rgm-clock" value="${escapeHtml(context.timeLabel)}" />
                </div>
                <div class="dfsc-field">
                    <label for="rgm-name">Prepared by (full name)</label>
                    <input class="dfsc-input" id="rgm-name" type="text" autocomplete="name" value="${escapeHtml(context.conductorFullName || '')}" />
                </div>
                <div class="dfsc-field">
                    <span class="dfsc-field-label">Signature</span>
                    <div class="dfsc-signature-wrap">
                        <canvas id="rgm-start-signature" class="dfsc-signature-canvas" aria-label="Start signature"></canvas>
                        <div class="dfsc-signature-actions">
                            <button type="button" class="dfsc-btn dfsc-btn-ghost" data-clear-signature="rgm-start-signature">Clear</button>
                        </div>
                    </div>
                </div>
                <button type="button" class="dfsc-btn dfsc-btn-primary" id="rgm-begin-btn">Begin RGM Cleaning</button>
            </article>
        </div>`;

    const startPad = initSignaturePad('rgm-start-signature');
    signaturePads.set('rgm-start-signature', startPad);

    document.getElementById('rgm-begin-btn').addEventListener('click', () => startSession(false));
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
}

async function startSession(forceNew) {
    statusMessage = '';
    const name = document.getElementById('rgm-name')?.value?.trim() || '';
    const startPad = signaturePads.get('rgm-start-signature');
    const startSignatureDataUrl = startPad?.toDataUrl() || '';
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
                name,
                startSignatureDataUrl,
                forceNew: Boolean(forceNew),
            }),
        });
        session = data.session;
        session.squareOnePhotoCandidates =
            session.squareOnePhotoCandidates || context.squareOnePhotoCandidates || [];
        schema = context.schema;
        window.history.replaceState({}, '', `/${STORE_NUMBER}/rgm-cleaning/audit?session=${session.id}`);
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
        session.squareOnePhotoCandidates =
            session.squareOnePhotoCandidates || context.squareOnePhotoCandidates || [];
        schema = context.schema;
        window.history.replaceState({}, '', `/${STORE_NUMBER}/rgm-cleaning/audit?session=${session.id}`);
        renderAuditView();
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
        renderLandingView();
    }
}

async function deleteOpenAudit(sessionId) {
    if (!window.confirm('Delete this open audit? This cannot be undone.')) return;
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
        const data = await fetchJson(
            apiUrl(`${API_PREFIX}/session`, { store: STORE_NUMBER, sessionId })
        );
        session = data.session;
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
        if (IS_AUDIT_VIEW) {
            if (await loadSessionFromQuery()) return;
            window.location.replace(`/${STORE_NUMBER}/rgm-cleaning`);
            return;
        }
        if (await loadSessionFromQuery()) return;
        renderLandingView();
    } catch (err) {
        const denied = /not available|403/i.test(String(err.message || ''));
        app.innerHTML = `<div class="dfsc-shell"><div class="dfsc-status dfsc-status--error">${escapeHtml(
            denied
                ? 'RGM Cleaning is not available on shared store login accounts. Ask your manager to create a personal crew account for you.'
                : err.message
        )}</div><p style="margin-top:1rem;text-align:center"><a class="dfsc-btn dfsc-btn-secondary" href="${escapeHtml(tacauditPath())}">Back to TacoAudit</a></p></div>`;
    }
}

init();
