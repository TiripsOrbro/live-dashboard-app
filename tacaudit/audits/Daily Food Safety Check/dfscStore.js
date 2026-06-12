const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getStoreConfig } = require('../../../stores/src/storeList');
const { isTestStore, TEST_STORE_SLUG } = require('../../../stores/src/testStore');
const {
    getSections,
    getSectionSkipGroups,
    buildSchemaPayload,
    validateSection,
    validateSessionComplete,
    collectNonCompliant,
    isTimeGateOpen,
    getQuestionById,
    normalizeActionUpdate,
    applyAnswerTimestamp,
} = require('./dfscSchema');
const { afterAuditSubmit } = require('../../src/core/tacauditSubmit');
const { listInspectionHistory: listPestWalkInspectionHistory } = require('../Pest Walk/pestWalkStore');
const {
    userOwnsSession,
    canContinueDfscInProgress,
    canUserAccessSession: sharedCanUserAccessSession,
    shouldListOpenAudit,
    inProgressAccessError,
    canCompleteAudit,
    inCompleteAccessError,
} = require('../../src/audit/auditSessionAccess');
const { safePathSegment } = require('../../src/audit/auditPathSafety');

const paths = require('../../../src/paths');
const DFSC_DATA_DIR = path.join(paths.tacaudit.data, 'dfsc');
const RETENTION_DAYS = 45;
const DEFAULT_TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';

function normalizeStoreKey(storeNumber) {
    const raw = String(storeNumber || '').trim();
    if (isTestStore(raw)) return TEST_STORE_SLUG;
    return raw.replace(/[^0-9]/g, '') || raw;
}

function defaultShiftForStore(storeNumber) {
    const cfg = getStoreConfig(normalizeStoreKey(storeNumber)) || {};
    const tz = cfg.timeZone || DEFAULT_TIME_ZONE;
    const hour = Number(
        new Intl.DateTimeFormat('en-AU', {
            timeZone: tz,
            hour: 'numeric',
            hour12: false,
        }).format(new Date())
    );
    return Number.isFinite(hour) && hour >= 12 ? 'PM' : 'AM';
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

function sessionDir(storeNumber, dateKey) {
    return path.join(
        DFSC_DATA_DIR,
        safePathSegment(normalizeStoreKey(storeNumber), 'store number'),
        safePathSegment(dateKey, 'date key')
    );
}

function sessionFilePath(storeNumber, dateKey, sessionId) {
    return path.join(sessionDir(storeNumber, dateKey), `${safePathSegment(sessionId, 'session id')}.json`);
}

function activePointerPath(storeNumber) {
    return path.join(DFSC_DATA_DIR, normalizeStoreKey(storeNumber), '_active.json');
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

function parseDateKey(dateKey) {
    const [y, m, d] = String(dateKey || '').split('-').map(Number);
    if (!y || !m || !d) return null;
    return new Date(Date.UTC(y, m - 1, d));
}

function dateKeyDaysAgo(days, fromDateKey) {
    const base = parseDateKey(fromDateKey) || new Date();
    base.setUTCDate(base.getUTCDate() - days);
    return base.toISOString().slice(0, 10);
}

function pruneOldRecords(storeNumber, referenceDateKey) {
    const store = normalizeStoreKey(storeNumber);
    const storeRoot = path.join(DFSC_DATA_DIR, store);
    if (!fs.existsSync(storeRoot)) return;
    const cutoff = dateKeyDaysAgo(RETENTION_DAYS, referenceDateKey);
    for (const entry of fs.readdirSync(storeRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('_')) continue;
        if (entry.name < cutoff) {
            fs.rmSync(path.join(storeRoot, entry.name), { recursive: true, force: true });
        }
    }
}

function listSessionFiles(storeNumber, dateKey) {
    const dir = sessionDir(storeNumber, dateKey);
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => path.join(dir, name));
}

function loadSession(storeNumber, dateKey, sessionId) {
    const filePath = sessionFilePath(storeNumber, dateKey, sessionId);
    const data = readJson(filePath, null);
    if (!data || data.id !== sessionId) return null;
    return data;
}

function saveSession(session) {
    const filePath = sessionFilePath(session.storeNumber, session.dateKey, session.id);
    writeJson(filePath, session);
    return session;
}

function getActivePointer(storeNumber) {
    return readJson(activePointerPath(storeNumber), null);
}

function setActivePointer(storeNumber, sessionId, dateKey) {
    writeJson(activePointerPath(storeNumber), { sessionId, dateKey, updatedAt: new Date().toISOString() });
}

function clearActivePointer(storeNumber) {
    const filePath = activePointerPath(storeNumber);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function listSessionsForDay(storeNumber, dateKey) {
    return listSessionFiles(storeNumber, dateKey)
        .map((filePath) => readJson(filePath, null))
        .filter(Boolean)
        .sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')));
}

function buildDaySummary(storeNumber, dateKey) {
    const sessions = listSessionsForDay(storeNumber, dateKey);
    const completed = sessions.filter((s) => s.status === 'completed');
    const amCompleted = completed.filter((s) => s.shift === 'AM');
    const pmCompleted = completed.filter((s) => s.shift === 'PM');
    const active = getActivePointer(storeNumber);
    let inProgress = null;
    if (active?.sessionId) {
        inProgress = loadSession(storeNumber, active.dateKey, active.sessionId);
        if (!inProgress || inProgress.status !== 'in_progress') inProgress = null;
    }
    return {
        dateKey,
        sessions,
        completedCount: completed.length,
        amCompleted: amCompleted.length > 0,
        pmCompleted: pmCompleted.length > 0,
        amCompletedAt: amCompleted[0]?.completedAt || null,
        pmCompletedAt: pmCompleted[0]?.completedAt || null,
        extraCount: Math.max(0, completed.length - (amCompleted.length ? 1 : 0) - (pmCompleted.length ? 1 : 0)),
        inProgress,
    };
}

function canUserAccessSession(session, access = {}) {
    return sharedCanUserAccessSession(session, access, { collaborative: false });
}

function getContext(storeNumber, options = {}) {
    const store = normalizeStoreKey(storeNumber);
    const cfg = getStoreConfig(store) || {};
    const dateKey = storeDateKey(store);
    pruneOldRecords(store, dateKey);
    const day = buildDaySummary(store, dateKey);
    const access = {
        username: options.username || '',
        conductorFullName: options.conductorFullName || '',
        accountLevel: options.accountLevel || '',
        canAccessDfsc: Boolean(options.canAccessDfsc),
        canCompleteAudits: options.canCompleteAudits !== false,
        canStartAudits: options.canStartAudits !== false,
        isAdmin: Boolean(options.isAdmin),
    };
    const ownedInProgress =
        day.inProgress && canContinueDfscInProgress(day.inProgress, access) ? day.inProgress : null;
    return {
        storeNumber: store,
        storeName: String(cfg.storeName || store).trim(),
        dateKey,
        timeLabel: storeTimeLabel(store),
        timeZone: cfg.timeZone || DEFAULT_TIME_ZONE,
        defaultShift: defaultShiftForStore(store),
        daySummary: {
            amCompleted: day.amCompleted,
            pmCompleted: day.pmCompleted,
            amCompletedAt: day.amCompletedAt,
            pmCompletedAt: day.pmCompletedAt,
            completedCount: day.completedCount,
            extraCount: day.extraCount,
        },
        inProgress: ownedInProgress
            ? {
                  id: ownedInProgress.id,
                  shift: ownedInProgress.shift,
                  conductorName: ownedInProgress.conductor?.name || '',
                  startedAt: ownedInProgress.startedAt,
                  dateKey: ownedInProgress.dateKey,
              }
            : null,
        openAudits: listOpenAudits(store, { access }),
        todayCompleted: getCompletedSessions(store, dateKey)
            .map(summarizeCompletedAudit)
            .sort((a, b) => String(a.shift || '').localeCompare(String(b.shift || '')) || String(a.completedAt || '').localeCompare(String(b.completedAt || ''))),
        canCompleteAudits: access.canCompleteAudits,
        canStartAudits: access.canStartAudits,
        schema: buildSchemaPayload(),
    };
}

function createSession(
    storeNumber,
    { name, shift, startSignatureDataUrl, forceNew = false, clientMeta = null, createdByUsername = null } = {}
) {
    const store = normalizeStoreKey(storeNumber);
    const conductorName = String(name || '').trim();
    const shiftNorm = String(shift || '').trim().toUpperCase();
    if (!conductorName) return { ok: false, error: 'Name is required.' };
    if (shiftNorm !== 'AM' && shiftNorm !== 'PM') return { ok: false, error: 'Shift must be AM or PM.' };
    if (!String(startSignatureDataUrl || '').trim()) return { ok: false, error: 'Start signature is required.' };

    const dateKey = storeDateKey(store);
    pruneOldRecords(store, dateKey);

    const active = getActivePointer(store);
    if (!forceNew && active?.sessionId) {
        const existing = loadSession(store, active.dateKey, active.sessionId);
        if (existing?.status === 'in_progress' && userOwnsSession(existing, createdByUsername, conductorName)) {
            return { ok: true, session: existing, resumed: true };
        }
    }

    const cfg = getStoreConfig(store) || {};
    const session = {
        id: newSessionId(),
        storeNumber: store,
        storeName: String(cfg.storeName || store).trim(),
        dateKey,
        shift: shiftNorm,
        status: 'in_progress',
        startedAt: new Date().toISOString(),
        completedAt: null,
        conductor: { name: conductorName, startSignatureDataUrl: String(startSignatureDataUrl).trim() },
        createdByUsername: String(createdByUsername || '').trim(),
        signOff: { name: '', signatureDataUrl: '', acknowledgedAt: null },
        answers: {},
        actions: {},
        sectionSkips: [],
        notes: {},
        answerTimestamps: {},
        clientMeta: clientMeta && typeof clientMeta === 'object' ? clientMeta : null,
    };
    saveSession(session);
    setActivePointer(store, session.id, dateKey);
    return { ok: true, session, resumed: false };
}

function getSessionById(storeNumber, sessionId, dateKey) {
    const store = normalizeStoreKey(storeNumber);
    const key = dateKey || storeDateKey(store);
    const session = loadSession(store, key, sessionId);
    if (!session) return null;
    return session;
}

function findSessionAcrossDays(storeNumber, sessionId) {
    const store = normalizeStoreKey(storeNumber);
    const storeRoot = path.join(DFSC_DATA_DIR, store);
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
    let session = getSessionById(store, sessionId, updates.dateKey) || findSessionAcrossDays(store, sessionId);
    if (!session) return { ok: false, error: 'Session not found.' };
    if (session.status === 'completed') return { ok: false, error: 'This DFSC is already completed.' };
    if (!userOwnsSession(session, access.username, access.conductorFullName)) {
        const actionsOnly =
            updates.actions &&
            typeof updates.actions === 'object' &&
            !updates.answers &&
            !updates.sectionSkips &&
            !updates.notes &&
            !updates.signOff;
        if (!(access.isAdmin && actionsOnly)) {
            return { ok: false, error: inProgressAccessError(false) };
        }
    }

    const now = Date.now();
    if (updates.answers && typeof updates.answers === 'object') {
        for (const [questionId, value] of Object.entries(updates.answers)) {
            const question = getQuestionById(questionId);
            if (!question) continue;
            if (!isTimeGateOpen(question, session, now) && value !== '' && value !== null && value !== undefined) {
                return { ok: false, error: `${question.label} is not yet available.` };
            }
            session.answers[questionId] = value;
            applyAnswerTimestamp(session, questionId, value, now);
        }
    }
    if (Array.isArray(updates.sectionSkips)) {
        session.sectionSkips = [...new Set(updates.sectionSkips.map(String))];
    }
    if (updates.actions && typeof updates.actions === 'object') {
        session.actions = session.actions || {};
        for (const [questionId, entry] of Object.entries(updates.actions)) {
            session.actions[questionId] = normalizeActionUpdate(entry, session.actions[questionId]);
        }
    }
    if (updates.notes && typeof updates.notes === 'object') {
        session.notes = { ...session.notes, ...updates.notes };
    }
    if (updates.signOff && typeof updates.signOff === 'object') {
        session.signOff = { ...session.signOff, ...updates.signOff };
    }
    if (updates.clientMeta && typeof updates.clientMeta === 'object' && !session.clientMeta) {
        session.clientMeta = updates.clientMeta;
    }
    session.updatedAt = new Date().toISOString();
    saveSession(session);
    setActivePointer(store, session.id, session.dateKey);
    return { ok: true, session, nonCompliant: collectNonCompliant(session) };
}

function reopenSession(storeNumber, sessionId, dateKey, access = {}) {
    const store = normalizeStoreKey(storeNumber);
    let session = getSessionById(store, sessionId, dateKey) || findSessionAcrossDays(store, sessionId);
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
    setActivePointer(store, session.id, session.dateKey);
    return { ok: true, session, nonCompliant: collectNonCompliant(session) };
}

function submitSession(storeNumber, sessionId, signOff = {}, access = {}) {
    const store = normalizeStoreKey(storeNumber);
    let session = getSessionById(store, sessionId) || findSessionAcrossDays(store, sessionId);
    if (!session) return { ok: false, error: 'Session not found.' };
    if (session.status === 'completed') return { ok: true, session };
    if (!userOwnsSession(session, access.username, access.conductorFullName)) {
        return { ok: false, error: 'Only the crew member who started this audit can submit it.' };
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

    session.status = 'completed';
    session.completedAt = new Date().toISOString();
    session.nonCompliant = collectNonCompliant(session);
    saveSession(session);
    clearActivePointer(store);
    afterAuditSubmit({ storeNumber: store, auditType: 'dfsc', session });
    return { ok: true, session };
}

function validateSessionSection(storeNumber, sessionId, sectionId, access = {}) {
    const session = getSessionById(storeNumber, sessionId) || findSessionAcrossDays(storeNumber, sessionId);
    if (!session) return { ok: false, error: 'Session not found.' };
    if (session.status === 'in_progress' && !userOwnsSession(session, access.username, access.conductorFullName)) {
        return { ok: false, error: inProgressAccessError(false) };
    }
    return validateSection(session, sectionId);
}

function getCompletedSessions(storeNumber, dateKey) {
    return listSessionsForDay(storeNumber, dateKey).filter((s) => s.status === 'completed');
}

function getAuditById(sessionId) {
    const storesRoot = DFSC_DATA_DIR;
    if (!fs.existsSync(storesRoot)) return null;
    for (const storeEntry of fs.readdirSync(storesRoot, { withFileTypes: true })) {
        if (!storeEntry.isDirectory()) continue;
        const storeRoot = path.join(storesRoot, storeEntry.name);
        for (const dayEntry of fs.readdirSync(storeRoot, { withFileTypes: true })) {
            if (!dayEntry.isDirectory() || dayEntry.name.startsWith('_')) continue;
            const session = loadSession(storeEntry.name, dayEntry.name, sessionId);
            if (session) return session;
        }
    }
    return null;
}

function summarizeOpenAudit(session) {
    return {
        id: session.id,
        dateKey: session.dateKey,
        shift: session.shift,
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
    const storeRoot = path.join(DFSC_DATA_DIR, store);
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
        for (const session of listSessionsForDay(store, entry.name)) {
            if (!shouldListOpenAudit(session, access, { collaborative: false })) continue;
            open.push(summarizeOpenAudit(session));
        }
    }
    return open.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
}

function deleteOpenAudit(storeNumber, sessionId, access = {}) {
    const store = normalizeStoreKey(storeNumber);
    const id = String(sessionId || '').trim();
    if (!id) return { ok: false, error: 'Session id is required.' };

    const session = getSessionById(store, id) || findSessionAcrossDays(store, id);
    if (!session) return { ok: false, error: 'Audit not found.' };
    if (session.status === 'completed') {
        return { ok: false, error: 'Completed audits cannot be deleted.' };
    }
    if (!userOwnsSession(session, access.username, access.conductorFullName)) {
        return { ok: false, error: 'Only the crew member who started this audit can delete it.' };
    }

    const filePath = sessionFilePath(session.storeNumber, session.dateKey, session.id);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    const active = getActivePointer(store);
    if (active?.sessionId === id) clearActivePointer(store);

    return { ok: true, deletedId: id };
}

function summarizeCompletedAudit(session) {
    const nonCompliant = Array.isArray(session.nonCompliant)
        ? session.nonCompliant
        : collectNonCompliant(session);
    const started = Date.parse(session.startedAt || '');
    const completed = Date.parse(session.completedAt || '');
    let durationMinutes = null;
    if (Number.isFinite(started) && Number.isFinite(completed) && completed >= started) {
        durationMinutes = Math.round((completed - started) / 60000);
    }
    return {
        id: session.id,
        dateKey: session.dateKey,
        shift: session.shift,
        conductorName: session.conductor?.name || '',
        signOffName: session.signOff?.name || '',
        startedAt: session.startedAt,
        completedAt: session.completedAt,
        durationMinutes,
        nonCompliantCount: nonCompliant.length,
    };
}

function listInspectionHistory(storeNumber, options = {}) {
    const store = normalizeStoreKey(storeNumber);
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    const storeRoot = path.join(DFSC_DATA_DIR, store);
    if (!fs.existsSync(storeRoot)) return [];

    pruneOldRecords(store, storeDateKey(store));
    const completed = [];
    for (const entry of fs.readdirSync(storeRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
        for (const session of listSessionsForDay(store, entry.name)) {
            if (session.status === 'completed') completed.push(summarizeCompletedAudit(session));
        }
    }
    return completed
        .sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')))
        .slice(0, limit);
}

function buildCoreReportData(storeNumber, options = {}) {
    const store = normalizeStoreKey(storeNumber);
    const cfg = getStoreConfig(store) || {};
    const today = storeDateKey(store);
    pruneOldRecords(store, today);
    const days = Math.min(Math.max(Number(options.days) || RETENTION_DAYS, 1), RETENTION_DAYS);

    const dailyCompletion = [];
    let amCompletedTotal = 0;
    let pmCompletedTotal = 0;
    let completedTotal = 0;

    for (let offset = days - 1; offset >= 0; offset -= 1) {
        const dateKey = dateKeyDaysAgo(offset, today);
        const sessions = listSessionsForDay(store, dateKey);
        const completed = sessions.filter((s) => s.status === 'completed');
        const am = completed.filter((s) => s.shift === 'AM').length;
        const pm = completed.filter((s) => s.shift === 'PM').length;
        const total = completed.length;
        amCompletedTotal += am;
        pmCompletedTotal += pm;
        completedTotal += total;
        dailyCompletion.push({ dateKey, am, pm, total });
    }

    const openAudits = listOpenAudits(store).map((audit) => {
        const session = getSessionById(store, audit.id, audit.dateKey) || findSessionAcrossDays(store, audit.id);
        const openActionCount = session
            ? collectNonCompliant(session).filter((row) => !row.actionSubmitted).length
            : 0;
        return { ...audit, openActionCount };
    });

    const openActions = [];
    const storeRoot = path.join(DFSC_DATA_DIR, store);
    if (fs.existsSync(storeRoot)) {
        const fromDateKey = dateKeyDaysAgo(days - 1, today);
        for (const entry of fs.readdirSync(storeRoot, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
            if (entry.name < fromDateKey) continue;
            for (const session of listSessionsForDay(store, entry.name)) {
                if (session.status !== 'in_progress') continue;
                for (const row of collectNonCompliant(session)) {
                    if (row.actionSubmitted) continue;
                    openActions.push({
                        sessionId: session.id,
                        dateKey: session.dateKey,
                        shift: session.shift,
                        conductorName: session.conductor?.name || '',
                        label: row.label,
                        draftAction: row.actionText || '',
                        startedAt: session.startedAt,
                    });
                }
            }
        }
    }

    openActions.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));

    const pestWalkHistory = listPestWalkInspectionHistory(store, { limit: 12 });

    return {
        storeNumber: store,
        storeName: String(cfg.storeName || store).trim(),
        generatedAt: new Date().toISOString(),
        periodDays: days,
        fromDateKey: dateKeyDaysAgo(days - 1, today),
        toDateKey: today,
        dailyCompletion,
        openAudits,
        openActions,
        pestWalkHistory,
        totals: {
            completed: completedTotal,
            amCompleted: amCompletedTotal,
            pmCompleted: pmCompletedTotal,
            openAudits: openAudits.length,
            openActions: openActions.length,
            pestWalkCompleted: pestWalkHistory.length,
        },
    };
}

module.exports = {
    RETENTION_DAYS,
    normalizeStoreKey,
    storeDateKey,
    storeTimeLabel,
    getContext,
    createSession,
    getSessionById,
    findSessionAcrossDays,
    updateSession,
    reopenSession,
    submitSession,
    validateSessionSection,
    listSessionsForDay,
    buildDaySummary,
    getCompletedSessions,
    getAuditById,
    listOpenAudits,
    deleteOpenAudit,
    listInspectionHistory,
    summarizeCompletedAudit,
    buildCoreReportData,
    getSections,
    getSectionSkipGroups,
    buildSchemaPayload,
    userOwnsSession,
    canUserAccessSession,
};
