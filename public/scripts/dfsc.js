const pathMatch = window.location.pathname.match(/^\/(teststore|\d{3,6})\/dfsc(?:\/audit)?\/?$/i);
const STORE_NUMBER = pathMatch ? pathMatch[1].toLowerCase() : '';
const IS_AUDIT_VIEW = /\/dfsc\/audit\/?$/i.test(window.location.pathname);

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
let timerInterval = null;
let signaturePads = new Map();
let expandedNotes = new Set();
let expandedActions = new Set();
const collapsedQuestionGroups = new Set();
let landingView = 'start';
let inspectionHistory = [];
let historyDetailSession = null;
let historyDetailReturnTo = 'history';
let blue2Unsubscribe = null;
let completionGuideActive = false;
const dfscReminderTimeouts = new Map();
let completionGuideQuestionId = null;
const editingTempQuestions = new Set();

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
    return window.AppPaths?.micOverview?.() || '/MIC/Overview';
}

function mountBackNav() {
    window.DashboardNavBack?.mountBackButton(document.getElementById('dfsc-nav-back'), {
        fallback: micPath(),
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

function isTimeGateOpen(question) {
    if (!question.unlockAfterMinutes) return true;
    const started = startedAtMs();
    if (!Number.isFinite(started)) return false;
    return Date.now() >= started + question.unlockAfterMinutes * 60 * 1000;
}

function timeGateRemainingMs(question) {
    const started = startedAtMs();
    if (!Number.isFinite(started)) return question.unlockAfterMinutes * 60 * 1000;
    return Math.max(0, started + question.unlockAfterMinutes * 60 * 1000 - Date.now());
}

function showWhenAnswerMatches(actual, expected) {
    const options = Array.isArray(expected) ? expected : [expected];
    return options.some((e) => String(actual ?? '').toLowerCase() === String(e).toLowerCase());
}

function isQuestionVisible(question) {
    if (question.amOnly && session.shift !== 'AM') return false;
    if (question.skipGroup && (session.sectionSkips || []).includes(question.skipGroup)) return false;
    if (question.showWhenAnswer) {
        for (const [qId, expected] of Object.entries(question.showWhenAnswer)) {
            if (!showWhenAnswerMatches(session.answers?.[qId], expected)) return false;
        }
    }
    if (question.hideWhenAnswer) {
        for (const [qId, expected] of Object.entries(question.hideWhenAnswer)) {
            if (showWhenAnswerMatches(session.answers?.[qId], expected)) return false;
        }
    }
    return true;
}

function visibleQuestions(sectionId) {
    return (schema?.questions || []).filter((q) => q.section === sectionId && isQuestionVisible(q));
}

function isCompliantType(type) {
    return type === 'compliant' || type === 'compliant_na';
}

function parseTempAnswer(value) {
    const raw = String(value ?? '').trim();
    if (!raw || raw.toLowerCase() === 'na') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

function isTempRangeNonCompliant(question, value) {
    if (!question) return false;
    if (question.type === 'carryover_temp') {
        if (String(value).toLowerCase() === 'no') return false;
        const temp = parseTempAnswer(value);
        if (temp === null) return false;
        const max = question.tempMax ?? 5;
        if (temp > max) return true;
        if (question.tempMin != null && temp < question.tempMin) return true;
        return false;
    }
    if (question.type !== 'temperature' && question.type !== 'temperature_na') return false;
    if (question.tempMin == null && question.tempMax == null) return false;
    const temp = parseTempAnswer(value);
    if (temp === null) return false;
    if (question.tempMin != null && temp < question.tempMin) return true;
    if (question.tempMax != null && temp > question.tempMax) return true;
    return false;
}

function isNcAnswer(question, value) {
    if (isCompliantType(question.type)) return String(value || '').toLowerCase() === 'not_compliant';
    if (question.type === 'ppm_band') {
        const choice = (question.choices || []).find((c) => c.value === String(value));
        return Boolean(choice?.nc);
    }
    if (isTempRangeNonCompliant(question, value)) return true;
    return false;
}

function effectiveChoiceValue(question, value) {
    let effective = String(value ?? '').trim();
    if (effective === '' && (question.type === 'select' || question.type === 'segmented')) {
        effective = String(question.defaultValue ?? '').trim();
    }
    return effective;
}

function isAnswerEmpty(question, value) {
    if (question.type === 'banner') return false;
    if (value === null || value === undefined) return true;
    if (question.type === 'yes_no') {
        if (question.choices?.length) {
            return !(question.choices || []).some((c) => c.value === String(value));
        }
        return value !== 'yes' && value !== 'no';
    }
    if (question.type === 'received') return value !== 'received' && value !== 'not_received';
    if (question.type === 'carryover_temp') {
        if (String(value).toLowerCase() === 'no') return false;
        return String(value).trim() === '';
    }
    if (question.type === 'ppm_band') {
        return !(question.choices || []).some((c) => c.value === String(value));
    }
    if (isCompliantType(question.type)) {
        const v = String(value).toLowerCase();
        return v !== 'compliant' && v !== 'not_compliant' && v !== 'na';
    }
    if (question.type === 'temperature_na' || question.type === 'text_na') {
        if (String(value).toLowerCase() === 'na') return false;
    }
    if (question.type === 'select' || question.type === 'segmented') {
        const effective = effectiveChoiceValue(question, value);
        if (effective === '') return true;
        return !(question.choices || []).some((c) => c.value === effective);
    }
    if (typeof value === 'string') return value.trim() === '';
    return false;
}

function collectNonCompliant() {
    const out = [];
    for (const question of schema?.questions || []) {
        if (!isQuestionVisible(question)) continue;
        const value = session.answers?.[question.id];
        if (isNcAnswer(question, value)) {
            const action = getActionEntry(question.id);
            out.push({
                questionId: question.id,
                label: question.label,
                actionText: action.text,
                actionSubmitted: Boolean(action.submittedAt && action.text),
            });
        }
    }
    return out;
}

function getActionEntry(questionId) {
    const raw = session.actions?.[questionId];
    if (!raw) return { text: '', submittedAt: null };
    if (typeof raw === 'string') return { text: raw.trim(), submittedAt: null };
    return {
        text: String(raw.text || '').trim(),
        submittedAt: raw.submittedAt || null,
    };
}

function isActionSubmitted(questionId) {
    const entry = getActionEntry(questionId);
    return Boolean(entry.submittedAt && entry.text);
}

function applySelectDefaults() {
    if (!session || !schema?.questions) return false;
    session.answers = session.answers || {};
    let changed = false;
    for (const question of schema.questions) {
        if ((question.type !== 'select' && question.type !== 'segmented') || !question.defaultValue) continue;
        if (!isQuestionVisible(question)) continue;
        const stored = String(session.answers[question.id] ?? '').trim();
        if (stored === '') {
            session.answers[question.id] = question.defaultValue;
            changed = true;
        }
    }
    return changed;
}

function getQuestionItemsInOrder() {
    const items = [];
    for (let i = 0; i < (schema?.sections || []).length; i++) {
        const section = schema.sections[i];
        if (section.id === 'actions' || section.id === 'signOff') continue;
        for (const question of visibleQuestions(section.id)) {
            if (question.type === 'banner') continue;
            items.push({
                sectionIndex: i,
                sectionId: section.id,
                question,
                questionId: question.id,
                label: question.label,
            });
        }
    }
    return items;
}

function findFirstUnansweredItem() {
    for (const item of getQuestionItemsInOrder()) {
        if (!item.question.required) continue;
        if (!isTimeGateOpen(item.question)) continue;
        if (isAnswerEmpty(item.question, session.answers?.[item.question.id])) {
            return item;
        }
    }
    return null;
}

function findFirstIncompleteItem() {
    const unanswered = findFirstUnansweredItem();
    if (unanswered) return { type: 'question', ...unanswered };
    const nc = collectNonCompliant().find((row) => !row.actionSubmitted);
    if (nc) return { type: 'nc', questionId: nc.questionId, label: nc.label };
    return null;
}

function navigateToQuestionItem(item) {
    document.querySelectorAll('.dfsc-qcard--guide-focus').forEach((el) => {
        el.classList.remove('dfsc-qcard--guide-focus');
    });
    if (item.sectionIndex != null && item.sectionIndex >= 0) {
        currentSectionIndex = item.sectionIndex;
    }
    renderQuestionArea();
    window.requestAnimationFrame(() => {
        const el = document.querySelector(`[data-question-id="${item.questionId}"]`);
        if (el) {
            el.classList.add('dfsc-qcard--guide-focus');
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    });
}

function navigateToNcItem(row) {
    const question = (schema?.questions || []).find((q) => q.id === row.questionId);
    if (!question) return;
    const sectionIndex = (schema?.sections || []).findIndex((s) => s.id === question.section);
    expandedActions.add(row.questionId);
    navigateToQuestionItem({
        sectionIndex,
        sectionId: question.section,
        questionId: row.questionId,
        label: row.label,
    });
}

function goToNextIncompleteOrFinish() {
    const item = findFirstIncompleteItem();
    if (item?.type === 'question') {
        completionGuideActive = true;
        completionGuideQuestionId = item.questionId;
        navigateToQuestionItem(item);
        statusMessage = 'Please complete remaining questions.';
        statusKind = 'info';
    } else if (item?.type === 'nc') {
        completionGuideActive = true;
        completionGuideQuestionId = item.questionId;
        navigateToNcItem(item);
        statusMessage = 'Submit an action for this non-compliant item.';
        statusKind = 'info';
    } else {
        completionGuideActive = false;
        completionGuideQuestionId = null;
        const signOffIndex = (schema?.sections || []).findIndex((s) => s.id === 'signOff');
        if (signOffIndex >= 0) currentSectionIndex = signOffIndex;
        renderQuestionArea();
        statusMessage = 'All questions complete. Sign off to finish.';
        statusKind = 'success';
    }
    renderStatusBar();
}

function maybeAdvanceCompletionGuide(questionId) {
    if (!completionGuideActive || questionId !== completionGuideQuestionId) return;
    const question = (schema?.questions || []).find((q) => q.id === questionId);
    if (!question) return;
    if (isAnswerEmpty(question, session.answers?.[questionId])) return;
    goToNextIncompleteOrFinish();
}

function tryGuideFromValidationError(message) {
    const answerMatch = String(message || '').match(/^Answer required: (.+)$/);
    if (answerMatch) {
        const question = (schema?.questions || []).find((q) => q.label === answerMatch[1]);
        if (question) {
            completionGuideActive = true;
            completionGuideQuestionId = question.id;
            const sectionIndex = (schema?.sections || []).findIndex((s) => s.id === question.section);
            navigateToQuestionItem({ sectionIndex, questionId: question.id, label: question.label });
            statusMessage = message;
            statusKind = 'error';
            renderStatusBar();
            return true;
        }
    }
    const actionMatch = String(message || '').match(/^Submit an action for: (.+)$/);
    if (actionMatch) {
        const row = collectNonCompliant().find((r) => r.label === actionMatch[1]);
        if (row) {
            completionGuideActive = true;
            completionGuideQuestionId = row.questionId;
            navigateToNcItem(row);
            statusMessage = message;
            statusKind = 'error';
            renderStatusBar();
            return true;
        }
    }
    return false;
}

function sectionSkipGroupsForSection(sectionId) {
    return (schema?.sectionSkipGroups || []).filter((g) => g.section === sectionId);
}

function isSectionComplete(sectionId) {
    if (sectionId === 'actions') {
        return collectNonCompliant().every((row) => row.actionSubmitted);
    }
    if (sectionId === 'signOff') {
        return Boolean(String(session.signOff?.name || '').trim() && String(session.signOff?.signatureDataUrl || '').trim());
    }
    const questions = visibleQuestions(sectionId);
    return questions.every((q) => !q.required || !isAnswerEmpty(q, session.answers?.[q.id]));
}

function scheduleSave() {
    if (!session?.id) return;
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveSession, 400);
}

async function saveSession() {
    if (!session?.id || session.status === 'completed') return;
    saving = true;
    try {
        const data = await fetchJson(apiUrl('/api/dfsc/session'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                store: STORE_NUMBER,
                sessionId: session.id,
                dateKey: session.dateKey,
                answers: session.answers,
                sectionSkips: session.sectionSkips,
                actions: session.actions,
                notes: session.notes,
                signOff: session.signOff,
            }),
        });
        session = data.session;
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
        render();
    } finally {
        saving = false;
    }
}

function dfscReminderStorageKey(sessionId, questionId) {
    return `dfscReminder:${sessionId}:${questionId}`;
}

function clearDfscReminder(questionId) {
    const timeoutId = dfscReminderTimeouts.get(questionId);
    if (timeoutId) window.clearTimeout(timeoutId);
    dfscReminderTimeouts.delete(questionId);
    if (session?.id) {
        try {
            localStorage.removeItem(dfscReminderStorageKey(session.id, questionId));
        } catch {
            /* ignore */
        }
    }
}

function clearAllDfscReminders() {
    for (const questionId of [...dfscReminderTimeouts.keys()]) {
        clearDfscReminder(questionId);
    }
}

async function requestDfscNotificationPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    try {
        return (await Notification.requestPermission()) === 'granted';
    } catch {
        return false;
    }
}

function showDfscReminderNotification(question) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const title = question.remindTitle || 'DFSC reminder';
    const body = question.remindBody || question.label;
    try {
        const n = new Notification(title, {
            body,
            tag: `dfsc-${session?.id}-${question.id}`,
            icon: '/icon.svg',
        });
        n.onclick = () => {
            try {
                window.focus();
            } catch {
                /* ignore */
            }
            n.close();
        };
        new Audio('/assets/sounds/notification.mp3').play().catch(() => {});
    } catch {
        /* ignore */
    }
}

function scheduleDfscReminder(question) {
    clearDfscReminder(question.id);
    if (!question.remindWhenAnswer || !question.remindAfterMinutes) return;
    const answer = session?.answers?.[question.id];
    if (String(answer).toLowerCase() !== String(question.remindWhenAnswer).toLowerCase()) return;

    const ms = question.remindAfterMinutes * 60 * 1000;
    const fireAt = Date.now() + ms;
    if (session?.id) {
        try {
            localStorage.setItem(
                dfscReminderStorageKey(session.id, question.id),
                JSON.stringify({ fireAt, questionId: question.id })
            );
        } catch {
            /* ignore */
        }
    }

    requestDfscNotificationPermission();
    const timeoutId = window.setTimeout(() => {
        showDfscReminderNotification(question);
        clearDfscReminder(question.id);
    }, ms);
    dfscReminderTimeouts.set(question.id, timeoutId);
}

function restoreDfscReminders() {
    if (!session?.id || !schema?.questions) return;
    for (const question of schema.questions) {
        if (!question.remindWhenAnswer || !question.remindAfterMinutes) continue;
        const answer = session.answers?.[question.id];
        if (String(answer).toLowerCase() !== String(question.remindWhenAnswer).toLowerCase()) {
            clearDfscReminder(question.id);
            continue;
        }

        let fireAt = Date.now() + question.remindAfterMinutes * 60 * 1000;
        try {
            const raw = localStorage.getItem(dfscReminderStorageKey(session.id, question.id));
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed?.fireAt) fireAt = parsed.fireAt;
            }
        } catch {
            /* ignore */
        }

        const remaining = fireAt - Date.now();
        if (remaining <= 0) {
            showDfscReminderNotification(question);
            clearDfscReminder(question.id);
            continue;
        }

        try {
            localStorage.setItem(
                dfscReminderStorageKey(session.id, question.id),
                JSON.stringify({ fireAt, questionId: question.id })
            );
        } catch {
            /* ignore */
        }

        const timeoutId = window.setTimeout(() => {
            showDfscReminderNotification(question);
            clearDfscReminder(question.id);
        }, remaining);
        dfscReminderTimeouts.set(question.id, timeoutId);
    }
}

function setAnswerDraft(questionId, value) {
    session.answers = session.answers || {};
    session.answers[questionId] = value;
    scheduleSave();
}

function setAnswer(questionId, value) {
    session.answers = session.answers || {};
    session.answers[questionId] = value;
    const question = (schema?.questions || []).find((q) => q.id === questionId);
    if (question && isNcAnswer(question, value)) {
        expandedActions.add(questionId);
    }
    if (question?.remindWhenAnswer) {
        scheduleDfscReminder(question);
    }
    scheduleSave();
    renderQuestionArea();
    maybeAdvanceCompletionGuide(questionId);
}

function setActionDraft(questionId, value) {
    session.actions = session.actions || {};
    const prev = getActionEntry(questionId);
    session.actions[questionId] = { text: value, submittedAt: prev.submittedAt };
    scheduleSave();
}

async function submitAction(questionId) {
    const textarea = document.querySelector(`[data-action-qid="${questionId}"]`);
    const text = String(textarea?.value || '').trim();
    if (!text) {
        statusMessage = 'Describe the corrective action before submitting.';
        statusKind = 'error';
        renderStatusBar();
        return;
    }
    session.actions = session.actions || {};
    session.actions[questionId] = { text, submittedAt: new Date().toISOString() };
    statusMessage = '';
    await saveSession();
    expandedActions.delete(questionId);
    renderQuestionArea();
    if (completionGuideActive && questionId === completionGuideQuestionId) {
        goToNextIncompleteOrFinish();
    }
}

function editAction(questionId) {
    expandedActions.add(questionId);
    const entry = getActionEntry(questionId);
    session.actions = session.actions || {};
    session.actions[questionId] = { text: entry.text, submittedAt: null };
    renderQuestionArea();
}

function setNote(questionId, value) {
    session.notes = session.notes || {};
    session.notes[questionId] = value;
    scheduleSave();
}

function sectionProgress(sectionId) {
    const questions = visibleQuestions(sectionId).filter((q) => q.type !== 'banner');
    const required = questions.filter((q) => q.required);
    const answered = required.filter((q) => !isAnswerEmpty(q, session.answers?.[q.id])).length;
    const total = required.length;
    const pct = total ? Math.round((answered / total) * 100) : 100;
    return { answered, total, pct };
}

function questionGroupKey(sectionId, groupName) {
    return `${sectionId}::${groupName}`;
}

function questionGroupDomId(groupKey) {
    return `dfsc-grp-${groupKey.replace(/[^a-zA-Z0-9]+/g, '-')}`;
}

function groupProgress(questions) {
    const items = questions.filter((q) => q.type !== 'banner');
    const required = items.filter((q) => q.required);
    const answered = required.filter((q) => !isAnswerEmpty(q, session.answers?.[q.id])).length;
    return { answered, total: required.length };
}

function renderQuestionGroupBlock(sectionId, groupName, groupQuestions) {
    const key = questionGroupKey(sectionId, groupName);
    const domId = questionGroupDomId(key);
    const collapsed = collapsedQuestionGroups.has(key);
    const progress = groupProgress(groupQuestions);
    const complete = progress.total > 0 && progress.answered === progress.total;
    return `
        <div class="dfsc-group${collapsed ? ' is-collapsed' : ''}" data-group-key="${escapeHtml(key)}">
            <button type="button" class="dfsc-subsection dfsc-subsection-toggle"
                data-toggle-group="${escapeHtml(key)}"
                aria-expanded="${collapsed ? 'false' : 'true'}"
                aria-controls="${escapeHtml(domId)}">
                <span class="dfsc-subsection-progress${complete ? ' is-complete' : ''}">${progress.answered}/${progress.total}</span>
                <span class="dfsc-subsection-title">${escapeHtml(groupName)}</span>
                <span class="dfsc-subsection-chevron" aria-hidden="true"></span>
            </button>
            <div class="dfsc-group-body" id="${escapeHtml(domId)}"${collapsed ? ' hidden' : ''}>
                ${groupQuestions.map((question) => renderQuestion(question)).join('')}
            </div>
        </div>`;
}

function toggleQuestionGroup(groupKey) {
    if (collapsedQuestionGroups.has(groupKey)) {
        collapsedQuestionGroups.delete(groupKey);
    } else {
        collapsedQuestionGroups.add(groupKey);
    }
    const wrap = document.querySelector(`.dfsc-group[data-group-key="${CSS.escape(groupKey)}"]`);
    const btn = wrap?.querySelector('[data-toggle-group]');
    const body = wrap?.querySelector('.dfsc-group-body');
    const collapsed = collapsedQuestionGroups.has(groupKey);
    wrap?.classList.toggle('is-collapsed', collapsed);
    btn?.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    body?.toggleAttribute('hidden', collapsed);
}

function toggleSectionSkip(groupId, checked) {
    session.sectionSkips = session.sectionSkips || [];
    if (checked) {
        if (!session.sectionSkips.includes(groupId)) session.sectionSkips.push(groupId);
    } else {
        session.sectionSkips = session.sectionSkips.filter((id) => id !== groupId);
    }
    scheduleSave();
    render();
}

function blurActiveTextInput() {
    const ae = document.activeElement;
    if (!ae || ae === document.body) return;
    if (ae.matches('input:not([readonly]), textarea, select, [contenteditable="true"]')) {
        ae.blur();
    }
}

const SIGNATURE_MIN_SCALE = 4;
const SIGNATURE_EXPORT_MIN_WIDTH = 1600;

function initSignaturePad(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    canvas.setAttribute('tabindex', '-1');
    canvas.setAttribute('role', 'img');
    canvas.addEventListener('focus', () => canvas.blur());

    const wrap = canvas.closest('.dfsc-signature-wrap');
    if (wrap) {
        wrap.addEventListener(
            'touchstart',
            (e) => {
                if (e.target === canvas) blurActiveTextInput();
            },
            { passive: true }
        );
        wrap.addEventListener('pointerdown', (e) => {
            if (e.target === canvas) blurActiveTextInput();
        });
    }

    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const cssWidth = Math.max(rect.width, 1);
    const cssHeight = Math.max(rect.height, 1);
    const scale = Math.max(window.devicePixelRatio || 1, SIGNATURE_MIN_SCALE);

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

    function logicalSize() {
        return { width: cssWidth, height: cssHeight };
    }

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
    }

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseup', end);
    canvas.addEventListener('mouseleave', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);

    return {
        clear() {
            const { width, height } = logicalSize();
            ctx.clearRect(0, 0, width, height);
            hasStroke = false;
        },
        isEmpty() {
            return !hasStroke;
        },
        toDataUrl() {
            if (!hasStroke) return '';
            if (canvas.width >= SIGNATURE_EXPORT_MIN_WIDTH) {
                return canvas.toDataURL('image/png');
            }
            const exportScale = SIGNATURE_EXPORT_MIN_WIDTH / canvas.width;
            const exportCanvas = document.createElement('canvas');
            exportCanvas.width = SIGNATURE_EXPORT_MIN_WIDTH;
            exportCanvas.height = Math.round(canvas.height * exportScale);
            const exportCtx = exportCanvas.getContext('2d');
            exportCtx.fillStyle = '#fff';
            exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
            exportCtx.drawImage(canvas, 0, 0, exportCanvas.width, exportCanvas.height);
            return exportCanvas.toDataURL('image/png');
        },
        restore(dataUrl) {
            if (!dataUrl) return;
            const img = new Image();
            img.onload = () => {
                const { width, height } = logicalSize();
                ctx.clearRect(0, 0, width, height);
                ctx.drawImage(img, 0, 0, width, height);
                hasStroke = true;
            };
            img.src = dataUrl;
        },
    };
}

function renderStatus() {
    if (!statusMessage) return '';
    return `<div class="dfsc-status dfsc-status--${escapeHtml(statusKind || 'info')}">${escapeHtml(statusMessage)}</div>`;
}

function isTemperatureQuestion(question) {
    return question.type === 'temperature' || question.type === 'temperature_na' || question.type === 'carryover_temp';
}

function blue2Supported() {
    return Boolean(window.DfscBlue2?.isSupported?.());
}

function blue2Connected() {
    return Boolean(blue2Supported() && window.DfscBlue2.getState().connected);
}

function blue2Connecting() {
    return Boolean(blue2Supported() && window.DfscBlue2.getState().connecting);
}

function showCaptureTempButton(question) {
    if (!blue2Supported()) return false;
    if (question?.id === 'init_prepThermoTemp') return false;
    return isTemperatureQuestion(question);
}

function renderCaptureTempButton(questionId, { locked = false, disabled = false } = {}) {
    if (locked || !blue2Supported()) return '';
    const fieldDisabled = disabled;
    const title = fieldDisabled
        ? ''
        : blue2Connected()
          ? 'Capture when the reading stabilizes'
          : 'Connects to the Bluetooth thermometer, then captures when stable';
    return `<button type="button" class="dfsc-capture-temp" data-blue2-qid="${escapeHtml(questionId)}"${
        fieldDisabled ? ' data-blue2-field-disabled="true"' : ''
    }${fieldDisabled ? ' disabled' : ''}${title ? ` title="${escapeHtml(title)}"` : ''}>Capture temperature</button>`;
}

function tempInputHtml(questionId, { value = '', disabled = false, qtype = 'temp', placeholder = '' } = {}) {
    return `<input class="dfsc-input dfsc-temp-input" type="text" inputmode="text" autocomplete="off"
        data-qid="${escapeHtml(questionId)}" data-qtype="${escapeHtml(qtype)}"
        value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" ${disabled ? 'disabled' : ''} />`;
}

function scrollDfscSectionToTop() {
    const target = document.querySelector('.dfsc-section-head') || document.getElementById('dfsc-section-body');
    if (target) {
        target.scrollIntoView({ block: 'start', behavior: 'instant' });
        return;
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
}

function renderBlue2Bar() {
    if (!blue2Supported()) {
        const reason =
            window.DfscBlue2?.getSupportBlockReason?.() ||
            'Bluetooth Thermometer auto-read works in Chrome or Edge on a Bluetooth-capable tablet or PC.';
        return `<div class="dfsc-blue2-bar dfsc-blue2-bar--unsupported">${escapeHtml(reason)}</div>`;
    }
    const state = window.DfscBlue2.getState();
    const reading =
        state.connected && state.lastReading?.celsius != null ? `${state.lastReading.celsius}°C` : '';
    const dotClass = state.connected ? 'is-connected' : state.connecting ? 'is-connecting' : '';
    const statusLabel = state.connected
        ? state.deviceName || 'Bluetooth thermometer connected'
        : state.connecting
          ? 'Connecting…'
          : 'Bluetooth thermometer not connected';
    return `
        <div class="dfsc-blue2-bar" id="dfsc-blue2-bar">
            <div class="dfsc-blue2-status">
                <span class="dfsc-blue2-dot ${dotClass}" aria-hidden="true"></span>
                <span id="dfsc-blue2-label">${escapeHtml(statusLabel)}</span>
                <span class="dfsc-blue2-reading" id="dfsc-blue2-reading">${escapeHtml(reading)}</span>
            </div>
            <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-sm" id="dfsc-blue2-connect-btn" ${state.connecting ? 'disabled' : ''}>${state.connected ? 'Disconnect' : 'Connect'}</button>
        </div>`;
}

function updateBlue2Bar() {
    const label = document.getElementById('dfsc-blue2-label');
    if (!label) return;
    const state = window.DfscBlue2.getState();
    label.textContent = state.connected
        ? state.deviceName || 'Bluetooth thermometer connected'
        : state.connecting
          ? 'Connecting…'
          : 'Bluetooth thermometer not connected';
    const readingEl = document.getElementById('dfsc-blue2-reading');
    if (readingEl) {
        readingEl.textContent =
            state.connected && state.lastReading?.celsius != null ? `${state.lastReading.celsius}°C` : '';
    }
    const btn = document.getElementById('dfsc-blue2-connect-btn');
    if (btn) {
        btn.textContent = state.connected ? 'Disconnect' : 'Connect';
        btn.disabled = Boolean(state.connecting);
    }
    const dot = document.querySelector('.dfsc-blue2-dot');
    if (dot) {
        dot.classList.toggle('is-connected', state.connected);
        dot.classList.toggle('is-connecting', Boolean(state.connecting && !state.connected));
    }
    updateCaptureTempButtons();
}

function updateCaptureTempButtons() {
    if (!blue2Supported()) return;
    const connected = blue2Connected();
    const connecting = blue2Connecting();
    document.querySelectorAll('[data-blue2-qid]').forEach((btn) => {
        if (btn.dataset.blue2FieldDisabled === 'true') return;
        btn.disabled = connecting;
        btn.title = connected
            ? 'Capture when the reading stabilizes'
            : 'Connects to the Bluetooth thermometer, then captures when stable';
    });
}

async function toggleBlue2Connection() {
    if (!blue2Supported() || blue2Connecting()) return;
    statusMessage = '';
    try {
        const state = window.DfscBlue2.getState();
        if (state.connected) {
            await window.DfscBlue2.disconnect();
        } else {
            await window.DfscBlue2.connect();
        }
        updateBlue2Bar();
    } catch (err) {
        const msg = String(err?.message || err || 'Could not connect.');
        if (/not found|no compatible/i.test(msg) || err?.name === 'NotFoundError') {
            statusMessage =
                'No Bluetooth device found — put Blue2 in pairing mode, enable Chrome “Nearby devices”, and try again.';
        } else {
            statusMessage = msg;
        }
        statusKind = 'error';
        renderStatusBar();
        updateBlue2Bar();
    }
}

async function captureBlue2ForQuestion(questionId) {
    if (!blue2Supported()) return;
    statusMessage = '';
    const btn = document.querySelector(`[data-blue2-qid="${questionId}"]`);
    const input = document.querySelector(`input[data-qid="${questionId}"]`);
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Connecting…';
    }
    try {
        if (!blue2Connected()) {
            if (btn) btn.textContent = 'Connecting…';
            await window.DfscBlue2.connect();
            updateBlue2Bar();
        }
        if (btn) btn.textContent = 'Reading…';
        statusMessage = 'Hold the probe steady until the reading stabilizes…';
        statusKind = 'info';
        renderStatusBar();

        const celsius = await window.DfscBlue2.captureStableCelsius((live) => {
            if (input) input.value = String(live);
        });

        setAnswer(questionId, String(celsius));
        statusMessage = `Temperature captured: ${celsius}°C`;
        statusKind = 'success';
        renderStatusBar();
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
        renderStatusBar();
        updateBlue2Bar();
    } finally {
        if (btn) {
            btn.textContent = 'Capture temperature';
            if (btn.dataset.blue2FieldDisabled === 'true') {
                btn.disabled = true;
            } else {
                btn.disabled = blue2Connecting();
            }
        }
    }
}

function bindBlue2ConnectButton() {
    document.getElementById('dfsc-blue2-connect-btn')?.addEventListener('click', toggleBlue2Connection);
}

function bindBlue2CaptureButtons() {
    document.querySelectorAll('[data-blue2-qid]').forEach((btn) => {
        btn.addEventListener('click', () => captureBlue2ForQuestion(btn.dataset.blue2Qid));
    });
}

function setupBlue2() {
    if (blue2Unsubscribe) blue2Unsubscribe();
    if (!blue2Supported()) return;
    blue2Unsubscribe = window.DfscBlue2.onStateChange(() => {
        updateBlue2Bar();
        updateCaptureTempButtons();
    });
    updateBlue2Bar();
}

function teardownBlue2() {
    if (blue2Unsubscribe) {
        blue2Unsubscribe();
        blue2Unsubscribe = null;
    }
}

function renderPpmBandGroup(question) {
    const value = session.answers?.[question.id] || '';
    const choices = question.choices || [];
    return `
        <div class="dfsc-radio-group dfsc-radio-group--ppm" role="radiogroup" aria-label="${escapeHtml(question.label)}">
            ${choices
                .map((choice) => {
                    const toneClass =
                        choice.tone === 'green'
                            ? 'dfsc-choice--ppm-green'
                            : choice.tone === 'yellow'
                              ? 'dfsc-choice--ppm-yellow'
                              : 'dfsc-choice--ppm-red';
                    return `
                <label class="dfsc-choice ${toneClass}">
                    <input type="radio" name="${escapeHtml(question.id)}" value="${escapeHtml(choice.value)}" ${value === choice.value ? 'checked' : ''}
                        data-qid="${escapeHtml(question.id)}" data-qtype="choice" />
                    <span>${escapeHtml(choice.label)}</span>
                </label>`;
                })
                .join('')}
        </div>`;
}

function updateTimeGateCountdowns() {
    let needsUnlockRender = false;
    document.querySelectorAll('[data-time-gate-qid]').forEach((el) => {
        const qid = el.dataset.timeGateQid;
        const question = (schema?.questions || []).find((q) => q.id === qid);
        if (!question?.unlockAfterMinutes) return;
        const remaining = timeGateRemainingMs(question);
        if (remaining <= 0) {
            needsUnlockRender = true;
            return;
        }
        el.textContent = formatElapsed(remaining);
    });
    if (needsUnlockRender) renderQuestionArea();
}

function renderTimeGateBanner(question) {
    if (isTimeGateOpen(question) || !question.unlockAfterMinutes) return '';
    return `
        <div class="dfsc-time-gate" role="status" aria-live="polite">
            <span class="dfsc-time-gate-label">Available in</span>
            <span class="dfsc-time-gate-countdown" data-time-gate-qid="${escapeHtml(question.id)}">${formatElapsed(timeGateRemainingMs(question))}</span>
        </div>`;
}

function renderCarryoverControl(question) {
    const raw = session.answers?.[question.id] ?? '';
    const isNo = String(raw).toLowerCase() === 'no';
    const tempValue = isNo ? '' : raw;
    const locked = !isTimeGateOpen(question);
    const tempNc = !isNo && !editingTempQuestions.has(question.id) && isTempRangeNonCompliant(question, raw);
    const captureBtn = showCaptureTempButton(question)
        ? renderCaptureTempButton(question.id, { locked, disabled: isNo })
        : '';
    return `
        <div class="dfsc-carryover-row">
            <div class="dfsc-input-wrap${tempNc ? ' dfsc-input-wrap--nc' : ''}">
                ${tempInputHtml(question.id, {
                    value: tempValue,
                    disabled: locked || isNo,
                    qtype: 'carryover-temp',
                    placeholder: 'Record temp',
                })}
                <span class="dfsc-input-unit">°C</span>
            </div>
            ${captureBtn}
            <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-carryover-no ${isNo ? 'is-selected' : ''}"
                data-carryover-no="${escapeHtml(question.id)}" ${locked ? 'disabled' : ''}
                ${isNo ? 'title="Tap again to undo"' : ''}
                aria-pressed="${isNo ? 'true' : 'false'}">No carryover</button>
        </div>`;
}

function renderChoiceGroup(question) {
    const value = session.answers?.[question.id] || '';
    const options =
        question.type === 'compliant_na'
            ? [
                  ['compliant', 'Compliant', ''],
                  ['not_compliant', 'Not Compliant', 'dfsc-choice--nc'],
                  ['na', 'N/A', 'dfsc-choice--na'],
              ]
            : question.type === 'yes_no'
              ? (question.choices?.length
                    ? question.choices.map((c) => [c.value, c.label, 'dfsc-choice--yesno'])
                    : [
                          ['yes', 'Yes', 'dfsc-choice--yesno'],
                          ['no', 'No', 'dfsc-choice--yesno'],
                      ])
              : question.type === 'received'
                ? [
                      ['received', 'Received', 'dfsc-choice--yesno'],
                      ['not_received', 'Not Received', 'dfsc-choice--yesno'],
                  ]
                : [
                    ['compliant', 'Compliant', ''],
                    ['not_compliant', 'Not Compliant', 'dfsc-choice--nc'],
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

const LINK_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42 9.3-9.29H14V3zM5 5h7v2H7v10h10v-5h2v7H5V5z"/></svg>`;
const NOTE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 3H5a2 2 0 0 0-2 2v14l4-4h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/></svg>`;
const ACTION_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 3H5c-1.1 0-2 .9-2 2v14l4-4h12c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 9h-2V9h2v3zm0-4h-2V5h2v3z"/></svg>`;

function renderActionForm(questionId, { compact = false } = {}) {
    const entry = getActionEntry(questionId);
    const submitted = isActionSubmitted(questionId);
    const open = expandedActions.has(questionId) || !submitted;

    if (submitted && !open) {
        return `
            <div class="dfsc-inline-action dfsc-inline-action--submitted">
                <div class="dfsc-action-submitted-label">Action submitted</div>
                <p class="dfsc-action-submitted-text">${escapeHtml(entry.text)}</p>
                <button type="button" class="dfsc-qcard-link" data-edit-action="${escapeHtml(questionId)}">Edit action</button>
            </div>`;
    }

    return `
        <div class="dfsc-inline-action">
            <textarea class="dfsc-textarea" rows="${compact ? 3 : 3}" data-action-qid="${escapeHtml(questionId)}"
                placeholder="Describe corrective action taken">${escapeHtml(entry.text)}</textarea>
            <button type="button" class="dfsc-btn dfsc-btn-primary dfsc-action-submit" data-submit-action="${escapeHtml(questionId)}">
                Submit action
            </button>
        </div>`;
}

function renderQuestionFooter(question) {
    const isNc = isNcAnswer(question, session.answers?.[question.id]);
    const hasNote = Boolean(String(session.notes?.[question.id] || '').trim());
    const noteOpen = expandedNotes.has(question.id) || hasNote;
    const actionSubmitted = isActionSubmitted(question.id);
    return `
        <div class="dfsc-qcard-foot">
            <div class="dfsc-qcard-footer">
                <button type="button" class="dfsc-qcard-link" data-toggle-note="${escapeHtml(question.id)}">
                    ${NOTE_ICON} Add note
                </button>
                <button type="button" class="dfsc-qcard-link" disabled title="Coming soon">
                    ${LINK_ICON} Attach media
                </button>
                ${
                    isNc
                        ? actionSubmitted
                            ? `<span class="dfsc-qcard-link dfsc-qcard-link--done">${ACTION_ICON} Action submitted</span>`
                            : `<button type="button" class="dfsc-qcard-link" data-toggle-action="${escapeHtml(question.id)}">
                                ${ACTION_ICON} Create action
                               </button>`
                        : ''
                }
            </div>
            ${noteOpen ? `<div class="dfsc-qcard-strip dfsc-qcard-strip--note"><textarea class="dfsc-textarea" rows="2" data-note-qid="${escapeHtml(question.id)}" placeholder="Add a note">${escapeHtml(session.notes?.[question.id] || '')}</textarea></div>` : ''}
            ${
                isNc
                    ? `<div class="dfsc-qcard-strip${actionSubmitted && !expandedActions.has(question.id) ? ' dfsc-qcard-strip--submitted' : ''}">${renderActionForm(question.id)}</div>`
                    : ''
            }
        </div>`;
}

function selectEffectiveValue(question) {
    return effectiveChoiceValue(question, session.answers?.[question.id]);
}

function renderSegmentedControl(question, locked) {
    const value = session.answers?.[question.id] ?? '';
    const choices = question.choices || [];
    return `
        <div class="dfsc-segmented" role="radiogroup" aria-label="${escapeHtml(question.label)}">
            ${choices
                .map((choice) => {
                    const selected = value === choice.value;
                    return `
                <label class="dfsc-segmented__option${selected ? ' is-selected' : ''}">
                    <input type="radio" name="${escapeHtml(question.id)}" value="${escapeHtml(choice.value)}"
                        ${selected ? 'checked' : ''}
                        data-qid="${escapeHtml(question.id)}" data-qtype="choice" ${locked ? 'disabled' : ''} />
                    <span>${escapeHtml(choice.label)}</span>
                </label>`;
                })
                .join('')}
        </div>`;
}

function renderSelectControl(question, locked) {
    const effective = selectEffectiveValue(question);
    const choices = question.choices || [];
    const placeholderOption = question.selectPlaceholder
        ? `<option value="" disabled${effective === '' ? ' selected' : ''}>${escapeHtml(question.selectPlaceholder)}</option>`
        : '';
    const options = choices
        .map(
            (c) =>
                `<option value="${escapeHtml(c.value)}"${effective === c.value ? ' selected' : ''}>${escapeHtml(c.label)}</option>`
        )
        .join('');
    return `<select class="dfsc-select" data-qid="${escapeHtml(question.id)}" data-qtype="select" ${locked ? 'disabled' : ''}>${placeholderOption}${options}</select>`;
}

function renderQuestion(question) {
    if (question.type === 'banner') {
        const title = question.bannerTitle || question.label || '';
        const subtitle = question.bannerSubtitle || '';
        return `
            <div class="dfsc-group-banner">
                <p class="dfsc-group-banner__title">${escapeHtml(title)}</p>
                ${subtitle ? `<p class="dfsc-group-banner__subtitle">${escapeHtml(subtitle)}</p>` : ''}
            </div>`;
    }

    const locked = !isTimeGateOpen(question);
    const value = session.answers?.[question.id] ?? '';
    const isEditingTemp = editingTempQuestions.has(question.id);
    const isNc = !isEditingTemp && isNcAnswer(question, value);
    const unanswered = question.required && isAnswerEmpty(question, value);
    const timeGateBanner = renderTimeGateBanner(question);
    const lockBadge =
        locked && !question.unlockAfterMinutes
            ? `<span class="dfsc-lock-badge">Locked</span>`
            : '';

    let control = '';
    if (isCompliantType(question.type) || question.type === 'yes_no' || question.type === 'received') {
        control = renderChoiceGroup(question);
    } else if (question.type === 'carryover_temp') {
        control = renderCarryoverControl(question);
    } else if (question.type === 'ppm_band') {
        control = renderPpmBandGroup(question);
    } else if (question.type === 'temperature' || question.type === 'temperature_na') {
        const isNa = String(value).toLowerCase() === 'na';
        const tempNc = !isEditingTemp && !isNa && isTempRangeNonCompliant(question, value);
        const captureBtn = showCaptureTempButton(question)
            ? renderCaptureTempButton(question.id, { locked, disabled: isNa })
            : '';
        control = `
            <div class="dfsc-temp-row">
                <div class="dfsc-input-wrap${tempNc ? ' dfsc-input-wrap--nc' : ''}">
                    ${tempInputHtml(question.id, {
                        value: isNa ? '' : value,
                        disabled: locked || isNa,
                    })}
                    <span class="dfsc-input-unit">°C</span>
                </div>
                ${captureBtn}
            </div>
            ${
                question.type === 'temperature_na'
                    ? `<div class="dfsc-na-toggle">
                        <label class="dfsc-choice dfsc-choice--na">
                            <input type="checkbox" data-qid="${escapeHtml(question.id)}" data-qtype="na-temp" ${isNa ? 'checked' : ''} />
                            <span>N/A</span>
                        </label>
                       </div>`
                    : ''
            }`;
    } else if (question.type === 'ppm' || question.type === 'percent') {
        const unit = question.type === 'percent' ? '%' : 'ppm';
        control = `
            <div class="dfsc-input-wrap">
                <input class="dfsc-input" type="number" step="0.1" inputmode="decimal"
                    data-qid="${escapeHtml(question.id)}" data-qtype="text"
                    value="${escapeHtml(value)}" ${locked ? 'disabled' : ''} />
                <span class="dfsc-input-unit">${unit}</span>
            </div>`;
    } else if (question.type === 'segmented') {
        control = renderSegmentedControl(question, locked);
    } else if (question.type === 'select') {
        control = renderSelectControl(question, locked);
    } else if (question.type === 'datetime' || question.type === 'date') {
        control = `<input class="dfsc-input dfsc-input--datetime" type="datetime-local"
            data-qid="${escapeHtml(question.id)}" data-qtype="text"
            value="${escapeHtml(value)}" ${locked ? 'disabled' : ''} />`;
    } else if (question.type === 'text' || question.type === 'text_na') {
        control = `<input class="dfsc-input" type="text"
            data-qid="${escapeHtml(question.id)}" data-qtype="text"
            value="${String(value).toLowerCase() === 'na' ? '' : escapeHtml(value)}"
            placeholder="${question.type === 'text_na' ? 'N/A if not in use' : ''}" ${locked ? 'disabled' : ''} />`;
    }

    const actionSubmitted = isNc && isActionSubmitted(question.id);
    const ncAlert =
        isNc && !actionSubmitted
            ? `<div class="dfsc-nc-alert">YOU'RE REQUIRED TO CREATE AN ACTION</div>`
            : '';
    const ncResolvedBadge = actionSubmitted
        ? `<div class="dfsc-nc-badge">Non-Compliant: action created</div>`
        : '';

    const cardClass = [
        'dfsc-qcard',
        isNc && !actionSubmitted ? 'dfsc-qcard--nc' : '',
        unanswered && !isNc ? 'dfsc-qcard--pending' : '',
        locked ? 'is-locked' : '',
    ]
        .filter(Boolean)
        .join(' ');

    const remindHint =
        question.remindWhenAnswer &&
        String(value).toLowerCase() === String(question.remindWhenAnswer).toLowerCase() &&
        question.remindAfterMinutes
            ? `<p class="dfsc-qcard-hint dfsc-remind-hint">We'll remind you in ${question.remindAfterMinutes} minutes.</p>`
            : '';

    return `
        <article class="${cardClass}" data-question-id="${escapeHtml(question.id)}">
            ${ncResolvedBadge}
            <div class="dfsc-qcard-content">
                <p class="dfsc-qcard-label">${question.required ? '<span class="dfsc-required">*</span>' : ''}${escapeHtml(question.label)}${lockBadge}</p>
                ${question.hint ? `<p class="dfsc-qcard-hint">${escapeHtml(question.hint)}</p>` : ''}
                ${timeGateBanner}
                ${control}
                ${remindHint}
                ${ncAlert}
            </div>
            ${renderQuestionFooter(question)}
        </article>`;
}

function renderQuestionsGrouped(sectionId) {
    const questions = visibleQuestions(sectionId);
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

function renderSectionSkips(sectionId) {
    const groups = sectionSkipGroupsForSection(sectionId);
    if (!groups.length) return '';
    return groups
        .map(
            (group) => `
        <label class="dfsc-skip-toggle">
            <input type="checkbox" data-skip-group="${escapeHtml(group.id)}"
                ${(session.sectionSkips || []).includes(group.id) ? 'checked' : ''} />
            <span>${escapeHtml(group.label)}</span>
        </label>`
        )
        .join('');
}

function renderActionsSection() {
    const rows = collectNonCompliant();
    if (!rows.length) {
        return `<p class="dfsc-field-hint">No non-compliant items — nothing to record.</p>`;
    }
    return rows
        .map(
            (row) => `
        <div class="dfsc-action-item">
            <div class="dfsc-action-label">${escapeHtml(row.label)}</div>
            ${renderActionForm(row.questionId, { compact: true })}
        </div>`
        )
        .join('');
}

function renderSignOffSection() {
    return `
        <p class="dfsc-signoff-text">
            By signing this, you are acknowledging that you have thoroughly completed all sections of the food safety checklist with integrity, confirm that zero food safety breaches are present, and understand that you will be held accountable for any food safety breaches that arise.
        </p>
        <div class="dfsc-field">
            <label for="dfsc-signoff-name">Full name of the manager who completed this checklist</label>
            <input class="dfsc-input" id="dfsc-signoff-name" type="text"
                value="${escapeHtml(session.signOff?.name || session.conductor?.name || context?.conductorFullName || '')}" />
        </div>
        <div class="dfsc-field">
            <span class="dfsc-field-label">Signature</span>
            <div class="dfsc-signature-wrap">
                <canvas id="dfsc-signoff-signature" class="dfsc-signature-canvas" aria-label="Sign-off signature"></canvas>
                <div class="dfsc-signature-actions">
                    <button type="button" class="dfsc-btn dfsc-btn-ghost" data-clear-signature="dfsc-signoff-signature">Clear</button>
                </div>
            </div>
        </div>`;
}

const SECTION_TAB_LABELS = {
    initialChecks: 'Initial',
    freezerColdrooms: 'Fridge',
    prepFry: 'Cook',
    productionLines: 'Lines',
    other: 'Other',
    deliveriesTransfers: 'Deliv.',
    actions: 'Actions',
    signOff: 'Sign off',
};

const SECTION_INTROS = {};

function renderSectionIntro(sectionId) {
    const text = SECTION_INTROS[sectionId];
    if (!text) return '';
    return `<p class="dfsc-section-intro">${escapeHtml(text)}</p>`;
}

function sectionTabLabel(section) {
    return SECTION_TAB_LABELS[section.id] || section.label;
}

function renderStepper() {
    const sections = schema?.sections || [];
    return `
        <div class="dfsc-stepper" role="tablist">
            ${sections
                .map((section, index) => {
                    const done = isSectionComplete(section.id);
                    const active = index === currentSectionIndex;
                    const label = sectionTabLabel(section);
                    return `<button type="button" class="dfsc-step ${active ? 'is-active' : ''} ${done ? 'is-done' : ''}"
                        data-section-index="${index}" title="${escapeHtml(section.label)}">${escapeHtml(label)}</button>`;
                })
                .join('')}
        </div>`;
}

function renderAuditHeader() {
    const elapsed = formatElapsed(Date.now() - startedAtMs());
    const pageTitle = `${session.storeName || STORE_NUMBER} Daily Food Safety Check`;
    return `
        <header class="dfsc-header">
            <div class="dfsc-header-top">
                <div class="dfsc-header-title">
                    <h1 class="dfsc-title">${escapeHtml(pageTitle)}</h1>
                    <div class="dfsc-header-meta">
                        <span class="dfsc-shift-badge">${escapeHtml(session.shift)}</span>
                        <span class="dfsc-subtitle">${escapeHtml(session.dateKey)}</span>
                    </div>
                </div>
                <div class="dfsc-timer" id="dfsc-elapsed" aria-live="polite">${escapeHtml(elapsed)}</div>
            </div>
            ${renderBlue2Bar()}
            ${renderStepper()}
        </header>`;
}

function renderQuestionArea({ scrollToTop = false } = {}) {
    const sections = schema?.sections || [];
    const section = sections[currentSectionIndex];
    if (!section) return;

    const progress = sectionProgress(section.id);
    const progressEl = document.getElementById('dfsc-section-progress');
    const titleEl = document.getElementById('dfsc-section-title');
    if (progressEl) {
        progressEl.textContent = `${progress.answered} / ${progress.total} (${progress.pct}%)`;
    }
    if (titleEl) {
        titleEl.textContent = section.label.toUpperCase();
    }

    let body = renderSectionSkips(section.id);
    body += renderSectionIntro(section.id);
    if (section.id === 'actions') {
        body += `<div class="dfsc-questions">${renderActionsSection()}</div>`;
    } else if (section.id === 'signOff') {
        body += `<div class="dfsc-card">${renderSignOffSection()}</div>`;
    } else {
        body += `<div class="dfsc-questions">${renderQuestionsGrouped(section.id)}</div>`;
    }

    const isSignOff = section.id === 'signOff';

    document.getElementById('dfsc-section-body').innerHTML = body;
    document.getElementById('dfsc-prev-btn').disabled = currentSectionIndex === 0;
    document.getElementById('dfsc-next-btn').hidden = isSignOff;
    document.getElementById('dfsc-submit-btn').hidden = !isSignOff;

    bindQuestionEvents();
    bindBlue2CaptureButtons();
    updateCaptureTempButtons();
    bindSignOffSignature();
    updateStepperClasses();
    if (scrollToTop) scrollDfscSectionToTop();
    if (isSignOff) {
        requestAnimationFrame(() => blurActiveTextInput());
    }
}

function updateStepperClasses() {
    document.querySelectorAll('.dfsc-step').forEach((btn, index) => {
        const section = schema.sections[index];
        btn.classList.toggle('is-active', index === currentSectionIndex);
        btn.classList.toggle('is-done', isSectionComplete(section.id));
    });
}

function bindTempInputEvents(input) {
    const qid = input.dataset.qid;
    input.addEventListener('focus', () => {
        editingTempQuestions.add(qid);
    });
    input.addEventListener('input', () => {
        setAnswerDraft(qid, input.value);
    });
    input.addEventListener('blur', () => {
        editingTempQuestions.delete(qid);
        setAnswer(qid, input.value);
    });
}

function bindQuestionEvents() {
    document.querySelectorAll('[data-qtype="choice"]').forEach((input) => {
        input.addEventListener('change', () => setAnswer(input.dataset.qid, input.value));
    });
    document.querySelectorAll('[data-qtype="temp"], [data-qtype="carryover-temp"]').forEach(bindTempInputEvents);
    document.querySelectorAll('[data-qtype="text"]').forEach((input) => {
        input.addEventListener('input', () => setAnswer(input.dataset.qid, input.value));
    });
    document.querySelectorAll('[data-qtype="select"]').forEach((input) => {
        input.addEventListener('change', () => setAnswer(input.dataset.qid, input.value));
    });
    document.querySelectorAll('[data-qtype="na-temp"]').forEach((input) => {
        input.addEventListener('change', () => {
            setAnswer(input.dataset.qid, input.checked ? 'na' : '');
        });
    });
    document.querySelectorAll('[data-carryover-no]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const qid = btn.dataset.carryoverNo;
            const current = session.answers?.[qid] ?? '';
            setAnswer(qid, String(current).toLowerCase() === 'no' ? '' : 'no');
        });
    });
    document.querySelectorAll('[data-skip-group]').forEach((input) => {
        input.addEventListener('change', () => toggleSectionSkip(input.dataset.skipGroup, input.checked));
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
            renderQuestionArea();
        });
    });
    document.querySelectorAll('[data-toggle-action]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const qid = btn.dataset.toggleAction;
            if (expandedActions.has(qid)) expandedActions.delete(qid);
            else expandedActions.add(qid);
            renderQuestionArea();
        });
    });
}

function bindSignOffSignature() {
    const pad = initSignaturePad('dfsc-signoff-signature');
    if (pad) {
        signaturePads.set('dfsc-signoff-signature', pad);
        if (session.signOff?.signatureDataUrl) pad.restore(session.signOff.signatureDataUrl);
    }
    document.querySelectorAll('[data-clear-signature]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const padRef = signaturePads.get(btn.dataset.clearSignature);
            padRef?.clear();
            session.signOff = session.signOff || {};
            session.signOff.signatureDataUrl = '';
            scheduleSave();
        });
    });
    const nameInput = document.getElementById('dfsc-signoff-name');
    if (nameInput) {
        nameInput.readOnly = true;
        nameInput.addEventListener('click', () => {
            if (nameInput.readOnly) {
                nameInput.readOnly = false;
                nameInput.focus();
            }
        });
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
    applySelectDefaults();
    app.innerHTML = `
        <div class="dfsc-shell">
            ${renderAuditHeader()}
            <div id="dfsc-status-bar">${renderStatus()}</div>
            <div class="dfsc-section-head">
                <h2 id="dfsc-section-title">INITIAL CHECKS</h2>
                <span class="dfsc-section-progress" id="dfsc-section-progress">0 / 0 (0%)</span>
            </div>
            <div id="dfsc-section-body"></div>
            <div class="dfsc-nav-bar">
                <button type="button" class="dfsc-btn dfsc-btn-secondary" id="dfsc-prev-btn">Back</button>
                <button type="button" class="dfsc-btn dfsc-btn-primary" id="dfsc-next-btn">Next</button>
                <button type="button" class="dfsc-btn dfsc-btn-primary" id="dfsc-submit-btn" hidden>Complete DFSC</button>
            </div>
        </div>`;

    bindStepperEvents();
    bindBlue2ConnectButton();
    setupBlue2();
    restoreDfscReminders();
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
        const elapsedEl = document.getElementById('dfsc-elapsed');
        if (elapsedEl) elapsedEl.textContent = formatElapsed(Date.now() - startedAtMs());
        updateTimeGateCountdowns();
    }, 1000);
}

async function submitAudit() {
    statusMessage = '';
    const signPad = signaturePads.get('dfsc-signoff-signature');
    const signOff = {
        name: document.getElementById('dfsc-signoff-name')?.value || session.signOff?.name || '',
        signatureDataUrl: signPad?.toDataUrl() || session.signOff?.signatureDataUrl || '',
    };
    session.signOff = { ...session.signOff, ...signOff };

    try {
        applySelectDefaults();
        await saveSession();

        const incomplete = findFirstIncompleteItem();
        if (incomplete) {
            completionGuideActive = true;
            completionGuideQuestionId = incomplete.questionId;
            if (incomplete.type === 'question') {
                navigateToQuestionItem(incomplete);
                statusMessage = 'Please answer remaining questions before completing.';
            } else {
                navigateToNcItem(incomplete);
                statusMessage = 'Submit actions for non-compliant items before completing.';
            }
            statusKind = 'error';
            renderStatusBar();
            return;
        }

        if (!String(signOff.name).trim() || !String(signOff.signatureDataUrl).trim()) {
            statusMessage = 'Name and signature are required to complete the DFSC.';
            statusKind = 'error';
            renderStatusBar();
            return;
        }

        const data = await fetchJson(apiUrl('/api/dfsc/submit'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                store: STORE_NUMBER,
                sessionId: session.id,
                signOff,
            }),
        });
        session = data.session;
        completionGuideActive = false;
        completionGuideQuestionId = null;
        renderCompleteView();
    } catch (err) {
        if (tryGuideFromValidationError(err.message)) return;
        statusMessage = err.message;
        statusKind = 'error';
        renderStatusBar();
    }
}

function renderCompleteView() {
    if (timerInterval) window.clearInterval(timerInterval);
    clearAllDfscReminders();
    teardownBlue2();
    window.DfscBlue2?.disconnect?.().catch(() => {});
    app.innerHTML = `
        <div class="dfsc-shell">
            <article class="dfsc-card">
                <div class="dfsc-complete-icon" aria-hidden="true">✓</div>
                <h2>DFSC completed</h2>
                <p class="dfsc-signoff-text">
                    ${escapeHtml(session.storeName)} · ${escapeHtml(session.shift)} shift · ${escapeHtml(session.dateKey)}
                </p>
                <p class="dfsc-signoff-text">Completed at ${escapeHtml(new Date(session.completedAt).toLocaleString())}</p>
                <p class="dfsc-signoff-text dfsc-field-hint">Report and actions have been queued for email delivery.</p>
                <button type="button" class="dfsc-btn dfsc-btn-primary" id="dfsc-back-mic">Back to MIC</button>
            </article>
        </div>`;
    document.getElementById('dfsc-back-mic').addEventListener('click', () => {
        window.location.href = micPath();
    });
}

function formatAuditTime(iso) {
    if (!iso) return '—';
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

function formatDuration(minutes) {
    if (minutes == null || !Number.isFinite(minutes)) return '—';
    if (minutes < 60) return `${minutes} min`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
}

function renderLandingToolbar() {
    return `
        <div class="dfsc-landing-toolbar dfsc-landing-toolbar--actions">
            <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-toolbar" id="dfsc-core-report-btn">
                Report for CORE
            </button>
            <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-toolbar" id="dfsc-history-btn">
                Inspection history
            </button>
        </div>`;
}

async function downloadCoreReport() {
    const btn = document.getElementById('dfsc-core-report-btn');
    const defaultLabel = 'Report for CORE';
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Generating report…';
    }
    statusMessage = '';
    try {
        const url = apiUrl('/api/dfsc/core-report.pdf', { store: STORE_NUMBER });
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `Download failed (${res.status})`);
        }
        const blob = await res.blob();
        const disposition = res.headers.get('Content-Disposition') || '';
        const match = disposition.match(/filename="([^"]+)"/i);
        const filename = match ? match[1] : 'CORE-DFSC-report.pdf';
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
            btn.textContent = defaultLabel;
        }
    }
}

function renderHistoryList() {
    if (!inspectionHistory.length) {
        return `<p class="dfsc-history-empty">No completed inspections yet. Finished audits are kept for 30 days.</p>`;
    }
    return `
        <ul class="dfsc-history-list">
            ${inspectionHistory
                .map(
                    (row) => `
                <li class="dfsc-history-item">
                    <button type="button" class="dfsc-history-row" data-history-id="${escapeHtml(row.id)}" data-history-date="${escapeHtml(row.dateKey)}">
                        <span class="dfsc-history-row-main">
                            <span class="dfsc-history-row-title">${escapeHtml(row.dateKey)} · ${escapeHtml(row.shift)} shift</span>
                            <span class="dfsc-history-row-sub">
                                ${escapeHtml(row.conductorName || 'Unknown')}
                                · Completed ${escapeHtml(formatAuditTime(row.completedAt))}
                                · ${formatDuration(row.durationMinutes)}
                                ${row.nonCompliantCount ? ` · ${row.nonCompliantCount} NC` : ''}
                            </span>
                        </span>
                        <span class="dfsc-history-chevron" aria-hidden="true">›</span>
                    </button>
                </li>`
                )
                .join('')}
        </ul>`;
}

function renderHistoryDetailNcRows(session) {
    const rows = session.nonCompliant || [];
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

function renderHistoryView() {
    app.innerHTML = `
        <div class="dfsc-shell">
            <div class="dfsc-landing-head">
                <h1>Inspection history</h1>
                <p>${escapeHtml(context.storeName)} · Last 30 days</p>
            </div>
            <div id="dfsc-status-bar">${renderStatus()}</div>
            <section class="dfsc-history-section">
                ${renderHistoryList()}
            </section>
            <div class="dfsc-landing-toolbar dfsc-landing-toolbar--bottom">
                <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-toolbar" id="dfsc-history-back-btn">Back to DFSC</button>
            </div>
        </div>`;

    document.getElementById('dfsc-history-back-btn').addEventListener('click', () => {
        landingView = 'start';
        renderLandingView();
    });
    document.querySelectorAll('[data-history-id]').forEach((btn) => {
        btn.addEventListener('click', () => openHistoryDetail(btn.dataset.historyId, btn.dataset.historyDate));
    });
}

function renderHistoryDetailView() {
    const session = historyDetailSession;
    if (!session) {
        landingView = 'history';
        renderHistoryView();
        return;
    }
    const summary = {
        shift: session.shift,
        conductorName: session.conductor?.name || '',
        signOffName: session.signOff?.name || '',
        startedAt: session.startedAt,
        completedAt: session.completedAt,
    };
    const started = Date.parse(summary.startedAt || '');
    const completed = Date.parse(summary.completedAt || '');
    const durationMinutes =
        Number.isFinite(started) && Number.isFinite(completed) && completed >= started
            ? Math.round((completed - started) / 60000)
            : null;

    app.innerHTML = `
        <div class="dfsc-shell">
            <div class="dfsc-landing-head">
                <h1>${escapeHtml(session.dateKey)} · ${escapeHtml(summary.shift)}</h1>
                <p>Completed ${escapeHtml(formatAuditTime(summary.completedAt))}</p>
            </div>
            <div id="dfsc-status-bar">${renderStatus()}</div>
            <article class="dfsc-card">
                <h2>Summary</h2>
                <dl class="dfsc-history-dl">
                    <div><dt>Conducted by</dt><dd>${escapeHtml(summary.conductorName || '—')}</dd></div>
                    <div><dt>Signed off by</dt><dd>${escapeHtml(summary.signOffName || '—')}</dd></div>
                    <div><dt>Started</dt><dd>${escapeHtml(formatAuditTime(summary.startedAt))}</dd></div>
                    <div><dt>Duration</dt><dd>${escapeHtml(formatDuration(durationMinutes))}</dd></div>
                </dl>
            </article>
            <article class="dfsc-card">
                <h2>Non-compliant items</h2>
                ${renderHistoryDetailNcRows(session)}
            </article>
            <div class="dfsc-landing-toolbar dfsc-landing-toolbar--bottom dfsc-landing-toolbar--stack">
                <button type="button" class="dfsc-btn dfsc-btn-primary dfsc-btn-toolbar" id="dfsc-history-edit-btn">Edit inspection</button>
                <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-toolbar" id="dfsc-history-download-pdf">Download PDF</button>
                <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-toolbar" id="dfsc-history-detail-back-btn">${historyDetailReturnTo === 'start' ? 'Back to DFSC' : 'Back to history'}</button>
            </div>
        </div>`;

    document.getElementById('dfsc-history-edit-btn')?.addEventListener('click', () => {
        editHistorySession(session);
    });
    document.getElementById('dfsc-history-download-pdf')?.addEventListener('click', () => {
        downloadHistoryPdf(session);
    });
    document.getElementById('dfsc-history-detail-back-btn').addEventListener('click', () => {
        if (historyDetailReturnTo === 'start') {
            landingView = 'start';
            historyDetailSession = null;
            renderLandingView();
            return;
        }
        landingView = 'history';
        historyDetailSession = null;
        renderHistoryView();
    });
}

async function openInspectionHistory() {
    statusMessage = '';
    try {
        const data = await fetchJson(apiUrl('/api/dfsc/history', { store: STORE_NUMBER }));
        inspectionHistory = data.history || [];
        landingView = 'history';
        historyDetailSession = null;
        renderHistoryView();
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
        renderStatusBar();
    }
}

async function openHistoryDetail(sessionId, dateKey, { returnTo = 'history' } = {}) {
    statusMessage = '';
    try {
        const data = await fetchJson(
            apiUrl('/api/dfsc/session', { store: STORE_NUMBER, sessionId, dateKey })
        );
        if (data.session?.status !== 'completed') {
            throw new Error('This inspection is not completed.');
        }
        historyDetailReturnTo = returnTo;
        historyDetailSession = data.session;
        landingView = 'historyDetail';
        renderHistoryDetailView();
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
        renderStatusBar();
    }
}

async function editHistorySession(historySession) {
    const openCount = (context?.openAudits || []).filter((a) => a.id !== historySession.id).length;
    let proceed = true;
    if (openCount > 0) {
        proceed = window.confirm(
            'Another DFSC is already in progress. Reopen this completed inspection for editing anyway?'
        );
    } else {
        proceed = window.confirm(
            'Reopen this inspection for editing? You can change answers and will need to sign off again when finished.'
        );
    }
    if (!proceed) return;

    statusMessage = '';
    const editBtn = document.getElementById('dfsc-history-edit-btn');
    if (editBtn) {
        editBtn.disabled = true;
        editBtn.textContent = 'Reopening…';
    }
    try {
        const data = await fetchJson(apiUrl('/api/dfsc/reopen'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                store: STORE_NUMBER,
                sessionId: historySession.id,
                dateKey: historySession.dateKey,
            }),
        });
        session = data.session;
        schema = context.schema;
        historyDetailSession = null;
        landingView = 'start';
        currentSectionIndex = 0;
        expandedNotes.clear();
        expandedActions.clear();
        collapsedQuestionGroups.clear();
        completionGuideActive = false;
        completionGuideQuestionId = null;
        applySelectDefaults();
        window.history.replaceState({}, '', `/${STORE_NUMBER}/dfsc/audit?session=${session.id}`);
        renderAuditView();
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

async function downloadHistoryPdf(session) {
    const btn = document.getElementById('dfsc-history-download-pdf');
    const defaultLabel = 'Download PDF';
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Generating PDF…';
    }
    statusMessage = '';
    try {
        const url = apiUrl('/api/dfsc/report.pdf', {
            store: STORE_NUMBER,
            sessionId: session.id,
            dateKey: session.dateKey,
        });
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `Download failed (${res.status})`);
        }
        const blob = await res.blob();
        const disposition = res.headers.get('Content-Disposition') || '';
        const match = disposition.match(/filename="([^"]+)"/i);
        const filename = match ? match[1] : 'DFSC-report.pdf';
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
            btn.textContent = defaultLabel;
        }
    }
}

function renderTodayCompletedSection(rows = []) {
    if (!rows.length) return '';
    const items = rows
        .map(
            (row) => `
        <li class="dfsc-open-item">
            <div class="dfsc-open-main">
                <div class="dfsc-open-title">${escapeHtml(row.shift)} shift · ${escapeHtml(row.conductorName || 'Unknown')}</div>
                <div class="dfsc-open-meta">
                    Completed ${escapeHtml(formatAuditTime(row.completedAt))}
                    · ${escapeHtml(formatDuration(row.durationMinutes))}
                    ${row.nonCompliantCount ? ` · ${row.nonCompliantCount} NC` : ''}
                </div>
            </div>
            <div class="dfsc-open-actions">
                <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-sm" data-view-today="${escapeHtml(row.id)}" data-today-date="${escapeHtml(row.dateKey)}">View</button>
                <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-sm" data-pdf-today="${escapeHtml(row.id)}" data-today-date="${escapeHtml(row.dateKey)}">PDF</button>
            </div>
        </li>`
        )
        .join('');
    return `
        <section class="dfsc-open-section dfsc-open-section--completed" aria-labelledby="dfsc-today-heading">
            <div class="dfsc-open-head">
                <h2 id="dfsc-today-heading">Completed today</h2>
                <span class="dfsc-open-count">${rows.length}</span>
            </div>
            <p class="dfsc-open-hint">Shared for everyone with access to store ${escapeHtml(STORE_NUMBER)}.</p>
            <ul class="dfsc-open-list">${items}</ul>
        </section>`;
}

function bindTodayCompletedEvents() {
    document.querySelectorAll('[data-view-today]').forEach((btn) => {
        btn.addEventListener('click', () =>
            openHistoryDetail(btn.dataset.viewToday, btn.dataset.todayDate, { returnTo: 'start' })
        );
    });
    document.querySelectorAll('[data-pdf-today]').forEach((btn) => {
        btn.addEventListener('click', () =>
            downloadHistoryPdf({ id: btn.dataset.pdfToday, dateKey: btn.dataset.todayDate })
        );
    });
}

function renderOpenAuditsSection(openAudits = []) {
    if (!openAudits.length) return '';
    const rows = openAudits
        .map(
            (audit) => `
        <li class="dfsc-open-item" data-audit-id="${escapeHtml(audit.id)}">
            <div class="dfsc-open-main">
                <div class="dfsc-open-title">${escapeHtml(audit.shift)} shift · ${escapeHtml(audit.conductorName || 'Unknown')}</div>
                <div class="dfsc-open-meta">
                    Started ${escapeHtml(formatAuditTime(audit.startedAt))}
                    · ${escapeHtml(audit.dateKey)}
                    · ${Number(audit.answerCount) || 0} answer${Number(audit.answerCount) === 1 ? '' : 's'}
                </div>
            </div>
            <div class="dfsc-open-actions">
                <button type="button" class="dfsc-btn dfsc-btn-secondary dfsc-btn-sm" data-resume-audit="${escapeHtml(audit.id)}" data-audit-date="${escapeHtml(audit.dateKey)}">Resume</button>
                <button type="button" class="dfsc-btn dfsc-btn-danger dfsc-btn-sm" data-delete-audit="${escapeHtml(audit.id)}">Delete</button>
            </div>
        </li>`
        )
        .join('');
    return `
        <section class="dfsc-open-section" aria-labelledby="dfsc-open-heading">
            <div class="dfsc-open-head">
                <h2 id="dfsc-open-heading">Open audits</h2>
                <span class="dfsc-open-count">${openAudits.length}</span>
            </div>
            <p class="dfsc-open-hint">In-progress audits for this restaurant — any ${escapeHtml(context.storeName || 'store')} login can resume or delete.</p>
            <ul class="dfsc-open-list">${rows}</ul>
        </section>`;
}

function bindOpenAuditEvents() {
    document.querySelectorAll('[data-resume-audit]').forEach((btn) => {
        btn.addEventListener('click', () =>
            resumeSession({ id: btn.dataset.resumeAudit, dateKey: btn.dataset.auditDate })
        );
    });
    document.querySelectorAll('[data-delete-audit]').forEach((btn) => {
        btn.addEventListener('click', () => deleteOpenAudit(btn.dataset.deleteAudit));
    });
}

async function deleteOpenAudit(sessionId) {
    const audit = (context.openAudits || []).find((a) => a.id === sessionId);
    const label = audit
        ? `${audit.shift} audit by ${audit.conductorName || 'Unknown'}`
        : 'this open audit';
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;

    statusMessage = '';
    try {
        const res = await fetch(apiUrl('/api/dfsc/session', { store: STORE_NUMBER, sessionId }), {
            method: 'DELETE',
            credentials: 'include',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not delete audit.');
        }
        context = await fetchJson(apiUrl('/api/dfsc/context', { store: STORE_NUMBER }));
        statusMessage = 'Open audit deleted.';
        statusKind = 'success';
        renderLandingView();
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
        renderStatusBar();
    }
}

function renderLandingView() {
    if (landingView === 'history') {
        renderHistoryView();
        return;
    }
    if (landingView === 'historyDetail') {
        renderHistoryDetailView();
        return;
    }

    const openAudits = context.openAudits || [];
    const todayCompletedHtml = renderTodayCompletedSection(context.todayCompleted || []);
    const openAuditsHtml = renderOpenAuditsSection(openAudits);

    const dayStatus = context.daySummary;
    const statusLine = `Today: ${dayStatus.amCompleted ? 'AM done' : 'AM pending'} · ${dayStatus.pmCompleted ? 'PM done' : 'PM pending'}`;

    app.innerHTML = `
        <div class="dfsc-shell">
            <div class="dfsc-landing-head">
                <h1>Daily Food Safety Check</h1>
                <p>${escapeHtml(statusLine)}</p>
            </div>
            ${renderLandingToolbar()}
            ${todayCompletedHtml}
            ${openAuditsHtml}
            <div id="dfsc-status-bar">${renderStatus()}</div>
            <article class="dfsc-card">
                <h2>Before you begin</h2>
                <div class="dfsc-field">
                    <label>Restaurant</label>
                    <input class="dfsc-input dfsc-input-readonly" readonly value="${escapeHtml(context.storeName)}" />
                </div>
                <div class="dfsc-field">
                    <label>Date</label>
                    <input class="dfsc-input dfsc-input-readonly" readonly value="${escapeHtml(context.dateKey)}" />
                </div>
                <div class="dfsc-field">
                    <label>Time</label>
                    <input class="dfsc-input dfsc-input-readonly" readonly id="dfsc-clock" value="${escapeHtml(context.timeLabel)}" />
                </div>
                <div class="dfsc-field">
                    <label for="dfsc-name">Conducted by (full name)</label>
                    <input class="dfsc-input" id="dfsc-name" type="text" autocomplete="name" />
                </div>
                <div class="dfsc-field">
                    <span class="dfsc-field-label">Shift</span>
                    <div class="dfsc-radio-group">
                        <label class="dfsc-choice"><input type="radio" name="dfsc-shift" value="AM" checked /><span>AM</span></label>
                        <label class="dfsc-choice"><input type="radio" name="dfsc-shift" value="PM" /><span>PM</span></label>
                    </div>
                </div>
                <div class="dfsc-field">
                    <span class="dfsc-field-label">Signature</span>
                    <div class="dfsc-signature-wrap">
                        <canvas id="dfsc-start-signature" class="dfsc-signature-canvas" aria-label="Start signature"></canvas>
                        <div class="dfsc-signature-actions">
                            <button type="button" class="dfsc-btn dfsc-btn-ghost" data-clear-signature="dfsc-start-signature">Clear</button>
                        </div>
                    </div>
                </div>
                <button type="button" class="dfsc-btn dfsc-btn-primary" id="dfsc-begin-btn">Begin Food Safety</button>
            </article>
        </div>`;

    const startPad = initSignaturePad('dfsc-start-signature');
    signaturePads.set('dfsc-start-signature', startPad);
    document.querySelector('[data-clear-signature="dfsc-start-signature"]')?.addEventListener('click', () => startPad?.clear());

    window.setInterval(async () => {
        try {
            const data = await fetchJson(apiUrl('/api/dfsc/context', { store: STORE_NUMBER }));
            const clock = document.getElementById('dfsc-clock');
            if (clock) clock.value = data.timeLabel;
        } catch {
            /* ignore clock refresh errors */
        }
    }, 30000);

    document.getElementById('dfsc-begin-btn').addEventListener('click', () => startSession(false));
    document.getElementById('dfsc-core-report-btn')?.addEventListener('click', downloadCoreReport);
    document.getElementById('dfsc-history-btn')?.addEventListener('click', openInspectionHistory);
    bindOpenAuditEvents();
    bindTodayCompletedEvents();

    const nameInput = document.getElementById('dfsc-name');
    if (nameInput && context.conductorFullName) {
        nameInput.value = context.conductorFullName;
    }

    requestAnimationFrame(() => blurActiveTextInput());
}

async function startSession(forceNew) {
    statusMessage = '';
    const name = document.getElementById('dfsc-name')?.value?.trim() || '';
    const shift = document.querySelector('input[name="dfsc-shift"]:checked')?.value || 'AM';
    const startPad = signaturePads.get('dfsc-start-signature');
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

    const shiftAlreadyDone =
        (shift === 'AM' && context.daySummary.amCompleted) || (shift === 'PM' && context.daySummary.pmCompleted);
    if (shiftAlreadyDone && !forceNew) {
        const proceed = window.confirm(
            `An ${shift} DFSC is already completed today. Start another ${shift} audit anyway?`
        );
        if (!proceed) return;
    }

    try {
        const data = await fetchJson(apiUrl('/api/dfsc/start'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                store: STORE_NUMBER,
                name,
                shift,
                startSignatureDataUrl,
                forceNew: true,
            }),
        });
        session = data.session;
        schema = context.schema;
        window.history.replaceState({}, '', `/${STORE_NUMBER}/dfsc/audit?session=${session.id}`);
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
            apiUrl('/api/dfsc/session', { store: STORE_NUMBER, sessionId: inProgress.id, dateKey: inProgress.dateKey })
        );
        session = data.session;
        schema = context.schema;
        window.history.replaceState({}, '', `/${STORE_NUMBER}/dfsc/audit?session=${session.id}`);
        renderAuditView();
    } catch (err) {
        statusMessage = err.message;
        statusKind = 'error';
        render();
    }
}

async function loadSessionFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session');
    if (!sessionId) return false;
    try {
        const data = await fetchJson(apiUrl('/api/dfsc/session', { store: STORE_NUMBER, sessionId }));
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
        context = await fetchJson(apiUrl('/api/dfsc/context', { store: STORE_NUMBER }));
        schema = context.schema;

        if (IS_AUDIT_VIEW || (await loadSessionFromQuery())) return;

        renderLandingView();
    } catch (err) {
        const denied = /not available|403/i.test(String(err.message || ''));
        app.innerHTML = `<div class="dfsc-shell"><div class="dfsc-status dfsc-status--error">${escapeHtml(
            denied
                ? 'DFSC is not available on shared store login accounts. Ask your manager to create a personal crew account for you.'
                : err.message
        )}</div><p style="margin-top:1rem;text-align:center"><a class="dfsc-btn dfsc-btn-secondary" href="${escapeHtml(window.AppPaths?.micOverview?.() || '/MIC/Overview')}">Back to MIC</a></p></div>`;
    }
}

function render() {
    if (session?.status === 'completed') {
        renderCompleteView();
        return;
    }
    if (session && schema) {
        renderAuditView();
        return;
    }
    renderLandingView();
}

init();
