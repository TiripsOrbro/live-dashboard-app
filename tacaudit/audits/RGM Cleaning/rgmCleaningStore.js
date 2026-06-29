const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getStoreConfig } = require('../../../stores/src/storeList');
const { isTestStore, TEST_STORE_SLUG } = require('../../../stores/src/testStore');
const { getDismissalPeriodKey } = require('../../src/auditRecurrence');
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
const {
    buildSchemaPayload,
    validateSection,
    validateSessionComplete,
    collectNonCompliant,
    getQuestionById,
    normalizeActionUpdate,
    scoreSession,
    getSquareOnePhotoCandidates,
    AUDIT_LABEL,
} = require('./rgmCleaningSchema');

const paths = require('../../../src/paths');
const RGM_CLEANING_DATA_DIR = path.join(paths.tacaudit.data, 'rgm-cleaning');
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
        RGM_CLEANING_DATA_DIR,
        safePathSegment(normalizeStoreKey(storeNumber), 'store number'),
        safePathSegment(periodKey, 'period key')
    );
}

function sessionFilePath(storeNumber, periodKey, sessionId) {
    return path.join(sessionDir(storeNumber, periodKey), `${safePathSegment(sessionId, 'session id')}.json`);
}

function activePointerPath(storeNumber) {
    return path.join(RGM_CLEANING_DATA_DIR, normalizeStoreKey(storeNumber), '_active.json');
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
    const storeRoot = path.join(RGM_CLEANING_DATA_DIR, store);
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

function getActivePointer(storeNumber) {
    return readJson(activePointerPath(storeNumber), null);
}

function setActivePointer(storeNumber, sessionId, periodKey) {
    writeJson(activePointerPath(storeNumber), { sessionId, periodKey, updatedAt: new Date().toISOString() });
}

function clearActivePointer(storeNumber) {
    const filePath = activePointerPath(storeNumber);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function listSessionsForPeriod(storeNumber, periodKey) {
    return listSessionFiles(storeNumber, periodKey)
        .map((filePath) => readJson(filePath, null))
        .filter(Boolean)
        .sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')));
}

function canUserAccessSession(session, access = {}) {
    return sharedCanUserAccessSession(session, access, { collaborative: true });
}

function buildPeriodSummary(storeNumber, periodKey) {
    const sessions = listSessionsForPeriod(storeNumber, periodKey);
    const completed = sessions.filter((s) => s.status === 'completed');
    const active = getActivePointer(storeNumber);
    let inProgress = null;
    if (active?.sessionId && active.periodKey === periodKey) {
        inProgress = loadSession(storeNumber, active.periodKey, active.sessionId);
        if (!inProgress || inProgress.status !== 'in_progress') inProgress = null;
    }
    return {
        periodKey,
        sessions,
        completedCount: completed.length,
        periodCompleted: completed.length > 0,
        completedAt: completed[0]?.completedAt || null,
        inProgress,
    };
}

function loadSquareOnePhotoCandidates(storeNumber, periodKey) {
    try {
        const { listPhotoCandidatesForPeriod } = require('../Square One/squareOneStore');
        const sourcePeriodKey = periodKeyWeeksAgo(1, periodKey || getDismissalPeriodKey());
        return listPhotoCandidatesForPeriod(storeNumber, sourcePeriodKey);
    } catch {
        return [];
    }
}

function liveSquareOnePhotoCandidates(session) {
    if (!session || session.status !== 'in_progress') {
        return getSquareOnePhotoCandidates(session, {
            squareOnePhotoCandidates: session?.squareOnePhotoCandidates,
        });
    }
    const live = loadSquareOnePhotoCandidates(session.storeNumber, session.periodKey);
    if (live.length) return live;
    return getSquareOnePhotoCandidates(session, {
        squareOnePhotoCandidates: session.squareOnePhotoCandidates,
    });
}

function getContext(storeNumber, options = {}) {
    const store = normalizeStoreKey(storeNumber);
    const cfg = getStoreConfig(store) || {};
    const periodKey = getDismissalPeriodKey();
    pruneOldRecords(store, periodKey);
    const period = buildPeriodSummary(store, periodKey);
    const access = {
        username: options.username || '',
        conductorFullName: options.conductorFullName || '',
        accountLevel: options.accountLevel || '',
        canAccessDfsc: Boolean(options.canAccessDfsc),
        canCompleteAudits: options.canCompleteAudits !== false,
        canStartAudits: options.canStartAudits !== false,
        isAdmin: Boolean(options.isAdmin),
    };
    const squareOnePhotoCandidates = loadSquareOnePhotoCandidates(store, periodKey);
    const ownedInProgress =
        period.inProgress && canContributeToCollaborativeInProgress(period.inProgress, access)
            ? period.inProgress
            : null;
    return {
        storeNumber: store,
        storeName: String(cfg.storeName || store).trim(),
        periodKey,
        dateKey: storeDateKey(store),
        timeLabel: storeTimeLabel(store),
        timeZone: cfg.timeZone || DEFAULT_TIME_ZONE,
        auditLabel: AUDIT_LABEL,
        conductorFullName: String(access.conductorFullName || '').trim(),
        periodSummary: {
            periodCompleted: period.periodCompleted,
            completedAt: period.completedAt,
            completedCount: period.completedCount,
        },
        inProgress: ownedInProgress
            ? {
                  id: ownedInProgress.id,
                  conductorName: ownedInProgress.conductor?.name || '',
                  startedAt: ownedInProgress.startedAt,
                  periodKey: ownedInProgress.periodKey,
              }
            : null,
        openAudits: listOpenAudits(store, { access }),
        periodCompleted: getCompletedSessions(store, periodKey).map(summarizeCompletedAudit),
        squareOnePhotoCandidates,
        canCompleteAudits: access.canCompleteAudits,
        canStartAudits: access.canStartAudits,
        defaultActionDueDate: getDefaultActionDueDate(store),
        schema: buildSchemaPayload(),
    };
}

function createSession(
    storeNumber,
    { name, startSignatureDataUrl, forceNew = false, clientMeta = null, createdByUsername = null } = {}
) {
    const store = normalizeStoreKey(storeNumber);
    const conductorName = String(name || '').trim();
    if (!conductorName) return { ok: false, error: 'Name is required.' };
    if (!String(startSignatureDataUrl || '').trim()) return { ok: false, error: 'Start signature is required.' };

    const periodKey = getDismissalPeriodKey();
    pruneOldRecords(store, periodKey);

    const active = getActivePointer(store);
    if (!forceNew && active?.sessionId) {
        const existing = loadSession(store, active.periodKey, active.sessionId);
        if (existing?.status === 'in_progress' && userOwnsSession(existing, createdByUsername, conductorName)) {
            return { ok: true, session: existing, resumed: true };
        }
    }

    const cfg = getStoreConfig(store) || {};
    const session = {
        id: newSessionId(),
        storeNumber: store,
        storeName: String(cfg.storeName || store).trim(),
        periodKey,
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
        squareOnePhotoReviews: {},
        squareOnePhotoCandidates: loadSquareOnePhotoCandidates(store, periodKey),
        clientMeta: clientMeta && typeof clientMeta === 'object' ? clientMeta : null,
    };
    saveSession(session);
    setActivePointer(store, session.id, periodKey);
    return { ok: true, session, resumed: false };
}

function getSessionById(storeNumber, sessionId, periodKey) {
    const store = normalizeStoreKey(storeNumber);
    const key = periodKey || getDismissalPeriodKey();
    const session = loadSession(store, key, sessionId);
    if (!session) return null;
    return session;
}

function findSessionAcrossPeriods(storeNumber, sessionId) {
    const store = normalizeStoreKey(storeNumber);
    const storeRoot = path.join(RGM_CLEANING_DATA_DIR, store);
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
    if (session.status === 'completed') return { ok: false, error: 'This RGM cleaning assessment is already completed.' };
    if (!canContributeToCollaborativeInProgress(session, access)) {
        return { ok: false, error: inProgressAccessError(true) };
    }

    applyCollaborativeUpdates(session, updates, access, {
        getQuestionById: (questionId) => getQuestionById(questionId),
        normalizeActionUpdate,
    });
    syncUpdatedActionsToRegistry(store, 'rgm-cleaning', session, updates, access, (questionId) =>
        getQuestionById(questionId)
    );
    if (updates.signOff && typeof updates.signOff === 'object') {
        session.signOff = { ...session.signOff, ...updates.signOff };
    }
    if (updates.clientMeta && typeof updates.clientMeta === 'object' && !session.clientMeta) {
        session.clientMeta = updates.clientMeta;
    }
    if (session.status === 'in_progress') {
        const live = loadSquareOnePhotoCandidates(store, session.periodKey);
        if (live.length || !Array.isArray(session.squareOnePhotoCandidates) || !session.squareOnePhotoCandidates.length) {
            session.squareOnePhotoCandidates = live;
        }
    }
    session.updatedAt = new Date().toISOString();
    saveSession(session);
    setActivePointer(store, session.id, session.periodKey);
    return { ok: true, session, nonCompliant: collectNonCompliant(session), score: scoreSession(session) };
}

function reopenSession(storeNumber, sessionId, periodKey, access = {}) {
    const store = normalizeStoreKey(storeNumber);
    let session = getSessionById(store, sessionId, periodKey) || findSessionAcrossPeriods(store, sessionId);
    if (!session) return { ok: false, error: 'Session not found.' };
    if (session.status !== 'completed') {
        return { ok: false, error: 'Only completed inspections can be reopened for editing.' };
    }
    if (!userOwnsSession(session, access.username, access.conductorFullName)) {
        return { ok: false, error: 'Only the crew member who conducted this audit can reopen it for editing.' };
    }

    session.status = 'in_progress';
    session.completedAt = null;
    session.updatedAt = new Date().toISOString();
    saveSession(session);
    setActivePointer(store, session.id, session.periodKey);
    return { ok: true, session, nonCompliant: collectNonCompliant(session) };
}

function submitSession(storeNumber, sessionId, signOff = {}, access = {}) {
    const store = normalizeStoreKey(storeNumber);
    let session = getSessionById(store, sessionId) || findSessionAcrossPeriods(store, sessionId);
    if (!session) return { ok: false, error: 'Session not found.' };
    if (session.status === 'completed') return { ok: true, session };
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

    const photoOptions = {
        squareOnePhotoCandidates: liveSquareOnePhotoCandidates(session),
    };
    const validation = validateSessionComplete(session, photoOptions);
    if (!validation.ok) return { ok: false, error: validation.error };

    session.status = 'completed';
    session.completedAt = new Date().toISOString();
    session.nonCompliant = collectNonCompliant(session);
    session.score = scoreSession(session);
    promoteSessionActionsOnSubmit(store, 'rgm-cleaning', session, collectNonCompliant, access);
    saveSession(session);
    clearActivePointer(store);
    afterAuditSubmit({ storeNumber: store, auditType: 'rgm-cleaning', session });
    return { ok: true, session, auditLabel: AUDIT_LABEL };
}

function validateSessionSection(storeNumber, sessionId, sectionId, access = {}) {
    const session = getSessionById(storeNumber, sessionId) || findSessionAcrossPeriods(storeNumber, sessionId);
    if (!session) return { ok: false, error: 'Session not found.' };
    if (session.status === 'in_progress' && !canContributeToCollaborativeInProgress(session, access)) {
        return { ok: false, error: inProgressAccessError(true) };
    }
    const photoOptions = {
        squareOnePhotoCandidates: liveSquareOnePhotoCandidates(session),
    };
    return validateSection(session, sectionId, photoOptions);
}

function getCompletedSessions(storeNumber, periodKey) {
    return listSessionsForPeriod(storeNumber, periodKey).filter((s) => s.status === 'completed');
}

function getAuditById(sessionId) {
    const storesRoot = RGM_CLEANING_DATA_DIR;
    if (!fs.existsSync(storesRoot)) return null;
    for (const storeEntry of fs.readdirSync(storesRoot, { withFileTypes: true })) {
        if (!storeEntry.isDirectory()) continue;
        const storeRoot = path.join(storesRoot, storeEntry.name);
        for (const periodEntry of fs.readdirSync(storeRoot, { withFileTypes: true })) {
            if (!periodEntry.isDirectory() || periodEntry.name.startsWith('_')) continue;
            const session = loadSession(storeEntry.name, periodEntry.name, sessionId);
            if (session) return session;
        }
    }
    return null;
}

function summarizeOpenAudit(session) {
    return {
        id: session.id,
        periodKey: session.periodKey,
        conductorName: session.conductor?.name || '',
        startedAt: session.startedAt,
        updatedAt: session.updatedAt || null,
        answerCount: Object.keys(session.answers || {}).filter((k) => {
            const v = session.answers[k];
            return v !== null && v !== undefined && String(v).trim() !== '';
        }).length,
    };
}

function listOpenAudits(storeNumber, options = {}) {
    const store = normalizeStoreKey(storeNumber);
    const storeRoot = path.join(RGM_CLEANING_DATA_DIR, store);
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

    const active = getActivePointer(store);
    if (active?.sessionId === id) clearActivePointer(store);

    return { ok: true, deletedId: id };
}

function summarizeCompletedAudit(session) {
    const nonCompliant = Array.isArray(session.nonCompliant)
        ? session.nonCompliant
        : collectNonCompliant(session);
    const score = session.score || scoreSession(session);
    const started = Date.parse(session.startedAt || '');
    const completed = Date.parse(session.completedAt || '');
    let durationMinutes = null;
    if (Number.isFinite(started) && Number.isFinite(completed) && completed >= started) {
        durationMinutes = Math.round((completed - started) / 60000);
    }
    return {
        id: session.id,
        periodKey: session.periodKey,
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
    const storeRoot = path.join(RGM_CLEANING_DATA_DIR, store);
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

module.exports = {
    RETENTION_WEEKS,
    AUDIT_LABEL,
    normalizeStoreKey,
    storeDateKey,
    storeTimeLabel,
    getContext,
    createSession,
    getSessionById,
    findSessionAcrossPeriods,
    updateSession,
    reopenSession,
    submitSession,
    validateSessionSection,
    listSessionsForPeriod,
    buildPeriodSummary,
    getCompletedSessions,
    getAuditById,
    listOpenAudits,
    deleteOpenAudit,
    listInspectionHistory,
    summarizeCompletedAudit,
    buildSchemaPayload,
    userOwnsSession,
    canUserAccessSession,
};
