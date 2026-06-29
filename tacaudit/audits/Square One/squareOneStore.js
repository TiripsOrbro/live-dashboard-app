const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getStoreConfig } = require('../../../stores/src/storeList');
const { isTestStore, TEST_STORE_SLUG } = require('../../../stores/src/testStore');
const { getAuditSchedule, getDismissalPeriodKey } = require('../../src/auditRecurrence');
const { afterAuditSubmit } = require('../../src/core/tacauditSubmit');
const {
    userOwnsSession,
    canContributeToCollaborativeInProgress,
    canUserAccessSession: sharedCanUserAccessSession,
    shouldListOpenAudit,
    inProgressAccessError,
    canCompleteAudit,
    inCompleteAccessError,
} = require('../../src/audit/auditSessionAccess');
const { applyCollaborativeUpdates } = require('../../src/audit/auditContributions');
const {
    promoteSessionActionsOnSubmit,
    syncUpdatedActionsToRegistry,
    getDefaultActionDueDate,
} = require('../../src/core/storeActionsStore');
const { safePathSegment } = require('../../src/audit/auditPathSafety');
const { getAreaById, getDueAreasForSlot } = require('./squareOneAreas');
const {
    buildSchemaPayload,
    validateSection,
    validateSessionComplete,
    collectNonCompliant,
    getQuestionById,
    scoreSession,
    normalizeActionUpdate,
    AUDIT_LABEL,
} = require('./squareOneSchema');

const paths = require('../../../src/paths');
const DATA_DIR = path.join(paths.tacaudit.data, 'square-one');
const RETENTION_WEEKS = 26;
const DEFAULT_TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';

function normalizeStoreKey(storeNumber) {
    const raw = String(storeNumber || '').trim();
    if (isTestStore(raw)) return TEST_STORE_SLUG;
    return raw.replace(/[^0-9]/g, '') || raw;
}

function storeDateKey(storeNumber, date = new Date()) {
    const cfg = getStoreConfig(storeNumber) || {};
    const tz = cfg.timeZone || DEFAULT_TIME_ZONE;
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date);
}

function storeTimeLabel(storeNumber, date = new Date()) {
    const cfg = getStoreConfig(storeNumber) || {};
    const tz = cfg.timeZone || DEFAULT_TIME_ZONE;
    return new Intl.DateTimeFormat('en-AU', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
    }).format(date);
}

function sessionDir(storeNumber, periodKey) {
    return path.join(
        DATA_DIR,
        safePathSegment(normalizeStoreKey(storeNumber), 'store number'),
        safePathSegment(periodKey, 'period key')
    );
}

function sessionFilePath(storeNumber, periodKey, sessionId) {
    return path.join(sessionDir(storeNumber, periodKey), `${safePathSegment(sessionId, 'session id')}.json`);
}

function activePointerPath(storeNumber) {
    return path.join(DATA_DIR, normalizeStoreKey(storeNumber), '_active.json');
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

function newSessionId() {
    return crypto.randomBytes(8).toString('hex');
}

function parsePeriodKey(periodKey) {
    const m = String(periodKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return { year: +m[1], month: +m[2], day: +m[3] };
}

function periodKeyWeeksAgo(weeks, fromPeriodKey) {
    const base = parsePeriodKey(fromPeriodKey);
    if (!base) return fromPeriodKey;
    const d = new Date(Date.UTC(base.year, base.month - 1, base.day));
    d.setUTCDate(d.getUTCDate() - weeks * 7);
    return d.toISOString().slice(0, 10);
}

function pruneOldRecords(storeNumber, referencePeriodKey) {
    const store = normalizeStoreKey(storeNumber);
    const storeRoot = path.join(DATA_DIR, store);
    if (!fs.existsSync(storeRoot)) return;
    const cutoff = periodKeyWeeksAgo(RETENTION_WEEKS, referencePeriodKey);
    for (const entry of fs.readdirSync(storeRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('_')) continue;
        if (entry.name < cutoff) {
            fs.rmSync(path.join(storeRoot, entry.name), { recursive: true, force: true });
        }
    }
}

function listSessionFiles(storeNumber, periodKey) {
    const dir = sessionDir(storeNumber, periodKey);
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => path.join(dir, name));
}

function loadSession(storeNumber, periodKey, sessionId) {
    const filePath = sessionFilePath(storeNumber, periodKey, sessionId);
    const data = readJson(filePath, null);
    if (!data || data.id !== sessionId) return null;
    return data;
}

function saveSession(session) {
    const filePath = sessionFilePath(session.storeNumber, session.periodKey, session.id);
    writeJson(filePath, session);
    return session;
}

function getActivePointers(storeNumber) {
    const raw = readJson(activePointerPath(storeNumber), null);
    if (!raw) return {};
    if (raw.byArea && typeof raw.byArea === 'object') return raw.byArea;
    if (raw.sessionId && raw.areaId) {
        return { [raw.areaId]: { sessionId: raw.sessionId, periodKey: raw.periodKey } };
    }
    return {};
}

function setActivePointer(storeNumber, areaId, sessionId, periodKey) {
    const byArea = getActivePointers(storeNumber);
    byArea[String(areaId)] = { sessionId, periodKey, updatedAt: new Date().toISOString() };
    writeJson(activePointerPath(storeNumber), { byArea, updatedAt: new Date().toISOString() });
}

function clearActivePointer(storeNumber, areaId) {
    const byArea = getActivePointers(storeNumber);
    delete byArea[String(areaId)];
    writeJson(activePointerPath(storeNumber), { byArea, updatedAt: new Date().toISOString() });
}

function listSessionsForPeriod(storeNumber, periodKey) {
    return listSessionFiles(storeNumber, periodKey)
        .map((filePath) => readJson(filePath, null))
        .filter(Boolean)
        .sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')));
}

function getCurrentSchedule() {
    return getAuditSchedule();
}

function getDueAreas(now) {
    const schedule = getAuditSchedule(now);
    return getDueAreasForSlot(schedule.squareSlot);
}

function completedSessionForArea(storeNumber, periodKey, areaId) {
    return listSessionsForPeriod(storeNumber, periodKey).find(
        (s) => s.status === 'completed' && s.areaId === areaId
    );
}

function inProgressSessionForArea(storeNumber, periodKey, areaId) {
    const ptr = getActivePointers(storeNumber)[String(areaId)];
    if (!ptr || ptr.periodKey !== periodKey) return null;
    const session = loadSession(storeNumber, ptr.periodKey, ptr.sessionId);
    if (!session || session.status !== 'in_progress' || session.areaId !== areaId) return null;
    return session;
}

function buildAreaSummaries(storeNumber, periodKey, squareSlot) {
    const dueAreas = getDueAreasForSlot(squareSlot);
    return dueAreas.map((area) => {
        const completed = completedSessionForArea(storeNumber, periodKey, area.id);
        const inProgress = inProgressSessionForArea(storeNumber, periodKey, area.id);
        return {
            ...area,
            periodCompleted: Boolean(completed),
            completedAt: completed?.completedAt || null,
            completedSessionId: completed?.id || null,
            inProgress: inProgress
                ? {
                      id: inProgress.id,
                      conductorName: inProgress.conductor?.name || '',
                      startedAt: inProgress.startedAt,
                      periodKey: inProgress.periodKey,
                  }
                : null,
        };
    });
}

function getContext(storeNumber, options = {}) {
    const store = normalizeStoreKey(storeNumber);
    const cfg = getStoreConfig(store) || {};
    const schedule = getCurrentSchedule();
    const periodKey = schedule.periodKey;
    pruneOldRecords(store, periodKey);
    const access = {
        username: options.username || '',
        conductorFullName: options.conductorFullName || '',
        accountLevel: options.accountLevel || '',
        canAccessDfsc: Boolean(options.canAccessDfsc),
        canCompleteAudits: options.canCompleteAudits !== false,
        canStartAudits: options.canStartAudits !== false,
        isAdmin: Boolean(options.isAdmin),
    };
    const dueAreas = buildAreaSummaries(store, periodKey, schedule.squareSlot);
    const requestedAreaId = String(options.areaId || '').trim();
    const selectedArea = requestedAreaId ? getAreaById(requestedAreaId) : null;
    const schemaAreaId = selectedArea?.id || dueAreas.find((a) => !a.periodCompleted)?.id || dueAreas[0]?.id;

    return {
        storeNumber: store,
        storeName: String(cfg.storeName || store).trim(),
        periodKey,
        squareSlot: schedule.squareSlot,
        dateKey: storeDateKey(store),
        timeLabel: storeTimeLabel(store),
        timeZone: cfg.timeZone || DEFAULT_TIME_ZONE,
        auditLabel: AUDIT_LABEL,
        conductorFullName: String(access.conductorFullName || '').trim(),
        dueAreas,
        selectedAreaId: schemaAreaId || null,
        openAudits: listOpenAudits(store, { access }),
        canCompleteAudits: access.canCompleteAudits,
        canStartAudits: access.canStartAudits,
        defaultActionDueDate: getDefaultActionDueDate(store),
        schema: schemaAreaId ? buildSchemaPayload(schemaAreaId) : null,
    };
}

function createSession(
    storeNumber,
    {
        areaId,
        name,
        startSignatureDataUrl,
        forceNew = false,
        clientMeta = null,
        createdByUsername = null,
    } = {}
) {
    const store = normalizeStoreKey(storeNumber);
    const area = getAreaById(areaId);
    if (!area) return { ok: false, error: 'Unknown Square One area.' };

    const conductorName = String(name || '').trim();
    if (!conductorName) return { ok: false, error: 'Name is required.' };
    if (!String(startSignatureDataUrl || '').trim()) return { ok: false, error: 'Start signature is required.' };

    const schedule = getCurrentSchedule();
    const periodKey = schedule.periodKey;
    const due = getDueAreasForSlot(schedule.squareSlot);
    if (!due.some((d) => d.id === area.id)) {
        return { ok: false, error: `${area.dashboardLabel} is not due this week.` };
    }

    pruneOldRecords(store, periodKey);

    if (completedSessionForArea(store, periodKey, area.id)) {
        return { ok: false, error: `${area.dashboardLabel} is already complete for this week.` };
    }

    const existing = inProgressSessionForArea(store, periodKey, area.id);
    if (!forceNew && existing && userOwnsSession(existing, createdByUsername, conductorName)) {
        return { ok: true, session: existing, resumed: true };
    }

    const cfg = getStoreConfig(store) || {};
    const session = {
        id: newSessionId(),
        storeNumber: store,
        storeName: String(cfg.storeName || store).trim(),
        periodKey,
        areaId: area.id,
        areaTitle: area.title,
        dashboardLabel: area.dashboardLabel,
        dateKey: storeDateKey(store),
        status: 'in_progress',
        startedAt: new Date().toISOString(),
        completedAt: null,
        conductor: { name: conductorName, startSignatureDataUrl: String(startSignatureDataUrl).trim() },
        createdByUsername: String(createdByUsername || '').trim(),
        signOff: { name: '', signatureDataUrl: '', acknowledgedAt: null },
        answers: {},
        actions: {},
        notes: {},
        photos: {},
        clientMeta: clientMeta && typeof clientMeta === 'object' ? clientMeta : null,
    };
    saveSession(session);
    setActivePointer(store, area.id, session.id, periodKey);
    return { ok: true, session, resumed: false };
}

function getSessionById(storeNumber, sessionId, periodKey) {
    const store = normalizeStoreKey(storeNumber);
    const key = periodKey || getDismissalPeriodKey();
    return loadSession(store, key, sessionId);
}

function findSessionAcrossPeriods(storeNumber, sessionId) {
    const store = normalizeStoreKey(storeNumber);
    const storeRoot = path.join(DATA_DIR, store);
    if (!fs.existsSync(storeRoot)) return null;
    for (const entry of fs.readdirSync(storeRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
        const session = loadSession(store, entry.name, sessionId);
        if (session) return session;
    }
    return null;
}

function updateSession(storeNumber, sessionId, updates = {}, access = {}) {
    const store = normalizeStoreKey(storeNumber);
    let session = getSessionById(store, sessionId, updates.periodKey) || findSessionAcrossPeriods(store, sessionId);
    if (!session) return { ok: false, error: 'Session not found.' };
    if (session.status === 'completed') return { ok: false, error: 'This Square One audit is already completed.' };
    if (!canContributeToCollaborativeInProgress(session, access)) {
        return { ok: false, error: inProgressAccessError(true) };
    }

    applyCollaborativeUpdates(session, updates, access, {
        getQuestionById: (questionId) => getQuestionById(questionId, session.areaId),
        normalizeActionUpdate,
    });
    syncUpdatedActionsToRegistry(store, 'square-one', session, updates, access, (questionId) =>
        getQuestionById(questionId, session.areaId)
    );
    if (updates.signOff && typeof updates.signOff === 'object') {
        session.signOff = { ...session.signOff, ...updates.signOff };
    }
    if (updates.clientMeta && typeof updates.clientMeta === 'object' && !session.clientMeta) {
        session.clientMeta = updates.clientMeta;
    }
    session.updatedAt = new Date().toISOString();
    saveSession(session);
    setActivePointer(store, session.areaId, session.id, session.periodKey);
    return { ok: true, session, nonCompliant: collectNonCompliant(session), score: scoreSession(session) };
}

function reopenSession(storeNumber, sessionId, periodKey, access = {}) {
    const store = normalizeStoreKey(storeNumber);
    let session = getSessionById(store, sessionId, periodKey) || findSessionAcrossPeriods(store, sessionId);
    if (!session) return { ok: false, error: 'Session not found.' };
    if (session.status !== 'completed') {
        return { ok: false, error: 'Only completed audits can be reopened for editing.' };
    }
    if (!userOwnsSession(session, access.username, access.conductorFullName)) {
        return { ok: false, error: 'Only the crew member who conducted this audit can reopen it for editing.' };
    }

    session.status = 'in_progress';
    session.completedAt = null;
    session.updatedAt = new Date().toISOString();
    saveSession(session);
    setActivePointer(store, session.areaId, session.id, session.periodKey);
    return { ok: true, session, nonCompliant: collectNonCompliant(session) };
}

function submitSession(storeNumber, sessionId, signOff = {}, access = {}) {
    const store = normalizeStoreKey(storeNumber);
    let session = getSessionById(store, sessionId) || findSessionAcrossPeriods(store, sessionId);
    if (!session) return { ok: false, error: 'Session not found.' };
    if (session.status === 'completed') return { ok: true, session, auditLabel: session.dashboardLabel };
    if (!canContributeToCollaborativeInProgress(session, access)) {
        return { ok: false, error: inProgressAccessError(true) };
    }
    if (!canCompleteAudit(access)) {
        return { ok: false, error: inCompleteAccessError() };
    }

    session.signOff = {
        name: String(signOff.name || session.signOff?.name || '').trim(),
        signatureDataUrl: String(signOff.signatureDataUrl || session.signOff?.signatureDataUrl || '').trim(),
        acknowledgedAt: new Date().toISOString(),
    };

    const validation = validateSessionComplete(session);
    if (!validation.ok) return { ok: false, error: validation.error };

    const due = getDueAreasForSlot(getCurrentSchedule().squareSlot);
    if (!due.some((d) => d.id === session.areaId)) {
        return { ok: false, error: 'This area is not due in the current week.' };
    }

    session.status = 'completed';
    session.completedAt = new Date().toISOString();
    session.nonCompliant = collectNonCompliant(session);
    session.score = scoreSession(session);
    promoteSessionActionsOnSubmit(store, 'square-one', session, collectNonCompliant, access);
    saveSession(session);
    clearActivePointer(store, session.areaId);
    afterAuditSubmit({ storeNumber: store, auditType: 'square-one', session });
    return { ok: true, session, auditLabel: session.dashboardLabel || AUDIT_LABEL };
}

function validateSessionSection(storeNumber, sessionId, sectionId, access = {}) {
    const session = getSessionById(storeNumber, sessionId) || findSessionAcrossPeriods(storeNumber, sessionId);
    if (!session) return { ok: false, error: 'Session not found.' };
    if (session.status === 'in_progress' && !canContributeToCollaborativeInProgress(session, access)) {
        return { ok: false, error: inProgressAccessError(true) };
    }
    return validateSection(session, sectionId);
}

function summarizeOpenAudit(session) {
    return {
        id: session.id,
        periodKey: session.periodKey,
        areaId: session.areaId,
        areaTitle: session.areaTitle,
        dashboardLabel: session.dashboardLabel,
        conductorName: session.conductor?.name || '',
        startedAt: session.startedAt,
        updatedAt: session.updatedAt || null,
    };
}

function listOpenAudits(storeNumber, options = {}) {
    const store = normalizeStoreKey(storeNumber);
    const storeRoot = path.join(DATA_DIR, store);
    if (!fs.existsSync(storeRoot)) return [];
    const access = options.access || {
        username: options.username || '',
        conductorFullName: options.conductorFullName || '',
        canAccessDfsc: Boolean(options.canAccessDfsc),
        isAdmin: Boolean(options.isAdmin),
    };
    const open = [];
    for (const entry of fs.readdirSync(storeRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
        for (const session of listSessionsForPeriod(store, entry.name)) {
            if (!shouldListOpenAudit(session, access, { collaborative: true })) continue;
            open.push(summarizeOpenAudit(session));
        }
    }
    return open.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
}

function deleteOpenAudit(storeNumber, sessionId, access = {}) {
    const store = normalizeStoreKey(storeNumber);
    const id = String(sessionId || '').trim();
    if (!id) return { ok: false, error: 'Session id is required.' };

    const session = getSessionById(store, id) || findSessionAcrossPeriods(store, id);
    if (!session) return { ok: false, error: 'Audit not found.' };
    if (session.status === 'completed') {
        return { ok: false, error: 'Completed audits cannot be deleted.' };
    }
    if (!userOwnsSession(session, access.username, access.conductorFullName)) {
        return { ok: false, error: 'Only the crew member who started this audit can delete it.' };
    }

    const filePath = sessionFilePath(session.storeNumber, session.periodKey, session.id);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    clearActivePointer(store, session.areaId);
    return { ok: true, deletedId: id };
}

function summarizeCompletedAudit(session) {
    const nonCompliant = Array.isArray(session.nonCompliant)
        ? session.nonCompliant
        : collectNonCompliant(session);
    const score = session.score ?? scoreSession(session);
    const started = Date.parse(session.startedAt || '');
    const completed = Date.parse(session.completedAt || '');
    let durationMinutes = null;
    if (Number.isFinite(started) && Number.isFinite(completed) && completed >= started) {
        durationMinutes = Math.round((completed - started) / 60000);
    }
    return {
        id: session.id,
        periodKey: session.periodKey,
        areaId: session.areaId,
        areaTitle: session.areaTitle,
        dashboardLabel: session.dashboardLabel,
        conductorName: session.conductor?.name || '',
        signOffName: session.signOff?.name || '',
        startedAt: session.startedAt,
        completedAt: session.completedAt,
        durationMinutes,
        nonCompliantCount: nonCompliant.length,
        score,
    };
}

function listInspectionHistory(storeNumber, options = {}) {
    const store = normalizeStoreKey(storeNumber);
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    const storeRoot = path.join(DATA_DIR, store);
    if (!fs.existsSync(storeRoot)) return [];

    pruneOldRecords(store, getDismissalPeriodKey());
    const completed = [];
    for (const entry of fs.readdirSync(storeRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
        for (const session of listSessionsForPeriod(store, entry.name)) {
            if (session.status === 'completed') completed.push(summarizeCompletedAudit(session));
        }
    }
    return completed
        .sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')))
        .slice(0, limit);
}

function listPhotoCandidatesForPeriod(storeNumber, periodKey) {
    const store = normalizeStoreKey(storeNumber);
    const candidates = [];
    for (const session of listSessionsForPeriod(store, periodKey)) {
        if (session.status !== 'completed') continue;
        const area = session.areaTitle || session.dashboardLabel || 'Square One';
        for (const [questionId, photo] of Object.entries(session.photos || {})) {
            if (!photo) continue;
            if (String(session.answers?.[questionId] || '').toLowerCase() !== 'complete') continue;
            const question = getQuestionById(questionId, session.areaId);
            candidates.push({
                id: `${session.id}:${questionId}`,
                sessionId: session.id,
                questionId,
                areaId: session.areaId,
                area: session.areaTitle || area,
                label: session.dashboardLabel || area,
                caption: question?.label?.slice(0, 80) || 'Photo',
                dataUrl: photo.dataUrl || photo.url || '',
                completedAt: session.completedAt || null,
            });
        }
    }
    return candidates;
}

function buildPeriodSummary(storeNumber, periodKey, squareSlot) {
    const areas = buildAreaSummaries(storeNumber, periodKey, squareSlot);
    const allComplete = areas.length > 0 && areas.every((a) => a.periodCompleted);
    return {
        periodKey,
        dueAreas: areas,
        periodCompleted: allComplete,
        completedCount: areas.filter((a) => a.periodCompleted).length,
        dueCount: areas.length,
    };
}

module.exports = {
    RETENTION_WEEKS,
    AUDIT_LABEL,
    normalizeStoreKey,
    storeDateKey,
    storeTimeLabel,
    getContext,
    getDueAreas,
    createSession,
    getSessionById,
    findSessionAcrossPeriods,
    updateSession,
    reopenSession,
    submitSession,
    validateSessionSection,
    listSessionsForPeriod,
    listOpenAudits,
    deleteOpenAudit,
    listInspectionHistory,
    summarizeCompletedAudit,
    buildPeriodSummary,
    buildAreaSummaries,
    listPhotoCandidatesForPeriod,
    buildSchemaPayload,
    userOwnsSession,
    canUserAccessSession: sharedCanUserAccessSession,
};
