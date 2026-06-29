const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getStoreConfig } = require('../../../stores/src/storeList');
const { normalizeStoreKey } = require('../../../stores/src/testStore');
const { getAuditTypeConfig } = require('./auditRegistry');
const { getCurrentOperationalWeek } = require('../auditRecurrence');

const paths = require('../../../src/paths');
const STORE_ACTIONS_DIR = path.join(paths.tacaudit.data, 'store-actions');

const DEFAULT_SOON_DAYS = 2;

function actionsFilePath(storeNumber) {
    return path.join(STORE_ACTIONS_DIR, normalizeStoreKey(storeNumber), 'actions.json');
}

function readJson(filePath, fallback = null) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function storeTimeZone(storeNumber) {
    const cfg = getStoreConfig(normalizeStoreKey(storeNumber)) || {};
    return String(cfg.timeZone || 'Australia/Melbourne').trim();
}

function ymdInTimeZone(now, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(now instanceof Date ? now : new Date(now));
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const d = parts.find((p) => p.type === 'day')?.value;
    return `${y}-${m}-${d}`;
}

function getDefaultActionDueDate(storeNumber, now = new Date()) {
    const week = getCurrentOperationalWeek(now);
    if (week?.weekEndYmd) return week.weekEndYmd;
    return ymdInTimeZone(now, storeTimeZone(storeNumber));
}

function actionRegistryId(auditType, sessionId, questionId) {
    return `${auditType}:${sessionId}:${questionId}`;
}

function contributorFromAccess(access = {}) {
    const name = String(access.conductorFullName || '').trim();
    const username = String(access.username || '').trim();
    return name || username || 'Unknown';
}

function loadStoreIndex(storeNumber) {
    const store = normalizeStoreKey(storeNumber);
    const raw = readJson(actionsFilePath(store), { actions: [] });
    const actions = Array.isArray(raw.actions) ? raw.actions : [];
    return { storeNumber: store, actions };
}

function saveStoreIndex(storeNumber, actions) {
    const store = normalizeStoreKey(storeNumber);
    writeJson(actionsFilePath(store), {
        storeNumber: store,
        updatedAt: new Date().toISOString(),
        actions,
    });
}

function getAuditLabel(auditType) {
    return getAuditTypeConfig(auditType)?.label || auditType;
}

function normalizeDueDate(value, storeNumber) {
    const raw = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    return getDefaultActionDueDate(storeNumber);
}

function buildActionRecord({
    storeNumber,
    auditType,
    session,
    questionId,
    label,
    entry,
    access,
    status = 'open',
}) {
    const store = normalizeStoreKey(storeNumber);
    const cfg = getStoreConfig(store) || {};
    const text = String(entry?.text || '').trim();
    const now = new Date().toISOString();
    const id = actionRegistryId(auditType, session.id, questionId);
    return {
        id,
        storeNumber: store,
        storeName: String(session.storeName || cfg.storeName || store).trim(),
        auditType,
        auditLabel: getAuditLabel(auditType),
        sessionId: session.id,
        questionId,
        label: String(label || questionId).trim(),
        text,
        dueDate: normalizeDueDate(entry?.dueDate, store),
        status,
        createdAt: entry?.submittedAt || now,
        createdBy: contributorFromAccess(access),
        completedAt: status === 'complete' ? now : null,
        completedBy: status === 'complete' ? contributorFromAccess(access) : null,
        conductorName: String(session.conductor?.name || '').trim(),
        shift: session.shift || null,
        periodKey: session.periodKey || null,
        dateKey: session.dateKey || null,
        areaTitle: session.areaTitle || session.dashboardLabel || null,
        startedAt: session.startedAt || null,
    };
}

function enrichActionForApi(action, storeNumber) {
    const tz = storeTimeZone(storeNumber || action.storeNumber);
    const today = ymdInTimeZone(new Date(), tz);
    const dueDate = String(action.dueDate || '').trim();
    let dueStatus = 'open';
    if (action.status === 'complete') {
        dueStatus = 'complete';
    } else if (dueDate && dueDate < today) {
        dueStatus = 'overdue';
    } else if (dueDate) {
        const soonEnd = new Date(`${today}T12:00:00`);
        soonEnd.setDate(soonEnd.getDate() + DEFAULT_SOON_DAYS);
        const soonYmd = soonEnd.toISOString().slice(0, 10);
        if (dueDate <= soonYmd) dueStatus = 'due_soon';
    }
    return {
        ...action,
        draftText: action.text,
        dueStatus,
        isOverdue: dueStatus === 'overdue',
        isDueSoon: dueStatus === 'due_soon',
    };
}

function upsertAction(storeNumber, record) {
    const index = loadStoreIndex(storeNumber);
    const existingIdx = index.actions.findIndex((a) => a.id === record.id);
    if (existingIdx >= 0) {
        const prev = index.actions[existingIdx];
        index.actions[existingIdx] = {
            ...prev,
            ...record,
            createdAt: prev.createdAt || record.createdAt,
            createdBy: prev.createdBy || record.createdBy,
        };
    } else {
        index.actions.push(record);
    }
    saveStoreIndex(storeNumber, index.actions);
    return index.actions.find((a) => a.id === record.id);
}

function createOrUpdateFromAuditAction(storeNumber, auditType, session, questionId, entry, access = {}, label = '') {
    if (!session?.id || !questionId) return null;
    const text = String(entry?.text || '').trim();
    if (!text || !entry?.submittedAt) return null;
    const record = buildActionRecord({
        storeNumber,
        auditType,
        session,
        questionId,
        label,
        entry,
        access,
        status: 'open',
    });
    return upsertAction(storeNumber, record);
}

function promoteSessionActionsOnSubmit(storeNumber, auditType, session, collectNonCompliant, access = {}) {
    if (!session?.id || typeof collectNonCompliant !== 'function') return [];
    const rows = collectNonCompliant(session) || [];
    const promoted = [];
    for (const row of rows) {
        const entry = session.actions?.[row.questionId];
        const text = String(entry?.text || row.actionText || '').trim();
        if (!text) continue;
        const submittedAt = entry?.submittedAt || row.actionSubmittedAt || new Date().toISOString();
        const record = createOrUpdateFromAuditAction(
            storeNumber,
            auditType,
            session,
            row.questionId,
            { text, submittedAt, dueDate: entry?.dueDate },
            access,
            row.label
        );
        if (record) promoted.push(record);
    }
    return promoted;
}

function listStoreActions(storeNumber, { status = 'open' } = {}) {
    const index = loadStoreIndex(storeNumber);
    let actions = index.actions;
    if (status) {
        actions = actions.filter((a) => a.status === status);
    }
    return actions
        .map((a) => enrichActionForApi(a, storeNumber))
        .sort((a, b) => {
            const dueCmp = String(a.dueDate || '').localeCompare(String(b.dueDate || ''));
            if (dueCmp !== 0) return dueCmp;
            return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
        });
}

function summarizeStoreActions(storeNumber, { soonDays = DEFAULT_SOON_DAYS } = {}) {
    const open = listStoreActions(storeNumber, { status: 'open' });
    return {
        open: open.length,
        overdue: open.filter((a) => a.isOverdue).length,
        dueSoon: open.filter((a) => a.isDueSoon).length,
        soonDays,
    };
}

function listActionsForDigest(storeNumber, { soonDays = DEFAULT_SOON_DAYS } = {}) {
    const open = listStoreActions(storeNumber, { status: 'open' });
    const overdue = open.filter((a) => a.isOverdue);
    const dueSoon = open.filter((a) => a.isDueSoon && !a.isOverdue);
    return { overdue, dueSoon, soonDays };
}

function completeAction(storeNumber, actionId, access = {}) {
    const id = String(actionId || '').trim();
    if (!id) return { ok: false, error: 'actionId is required.' };
    const index = loadStoreIndex(storeNumber);
    const action = index.actions.find((a) => a.id === id);
    if (!action) return { ok: false, error: 'Action not found.' };
    if (action.status === 'complete') return { ok: true, action: enrichActionForApi(action, storeNumber) };
    const now = new Date().toISOString();
    action.status = 'complete';
    action.completedAt = now;
    action.completedBy = contributorFromAccess(access);
    saveStoreIndex(storeNumber, index.actions);
    return { ok: true, action: enrichActionForApi(action, storeNumber) };
}

function syncRegistryFromSessionAction(storeNumber, auditType, session, questionId, entry, access, label) {
    return createOrUpdateFromAuditAction(storeNumber, auditType, session, questionId, entry, access, label);
}

function syncUpdatedActionsToRegistry(storeNumber, auditType, session, updates, access, getQuestionById) {
    if (!updates?.actions || typeof updates.actions !== 'object') return;
    for (const questionId of Object.keys(updates.actions)) {
        const entry = session?.actions?.[questionId];
        if (!entry?.submittedAt || !String(entry.text || '').trim()) continue;
        const question =
            typeof getQuestionById === 'function' ? getQuestionById(questionId, session?.areaId) : null;
        syncRegistryFromSessionAction(
            storeNumber,
            auditType,
            session,
            questionId,
            entry,
            access,
            question?.label || questionId
        );
    }
}

module.exports = {
    DEFAULT_SOON_DAYS,
    getDefaultActionDueDate,
    ymdInTimeZone,
    actionRegistryId,
    createOrUpdateFromAuditAction,
    promoteSessionActionsOnSubmit,
    listStoreActions,
    summarizeStoreActions,
    listActionsForDigest,
    completeAction,
    syncRegistryFromSessionAction,
    syncUpdatedActionsToRegistry,
    enrichActionForApi,
};
