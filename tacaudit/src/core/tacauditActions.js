const fs = require('fs');
const path = require('path');
const { getStoreConfig } = require('../../../stores/src/storeList');
const { collectNonCompliant: collectDfscNonCompliant } = require('../../audits/Daily Food Safety Check/dfscSchema');
const {
    listSessionsForDay,
    storeDateKey,
    normalizeStoreKey: normalizeDfscStore,
    updateSession: updateDfscSession,
    getSessionById: getDfscSessionById,
    findSessionAcrossDays: findDfscSessionAcrossDays,
} = require('../../audits/Daily Food Safety Check/dfscStore');
const { collectNonCompliant: collectPestNonCompliant } = require('../../audits/Pest Walk/pestWalkSchema');
const {
    listSessionsForPeriod: listPestSessions,
    updateSession: updatePestSession,
    getSessionById: getPestSessionById,
    findSessionAcrossPeriods: findPestSessionAcrossPeriods,
} = require('../../audits/Pest Walk/pestWalkStore');
const { collectNonCompliant: collectRgmNonCompliant } = require('../../audits/RGM Cleaning/rgmCleaningSchema');
const {
    listSessionsForPeriod: listRgmSessions,
    updateSession: updateRgmSession,
    getSessionById: getRgmSessionById,
    findSessionAcrossPeriods: findRgmSessionAcrossPeriods,
} = require('../../audits/RGM Cleaning/rgmCleaningStore');
const { collectNonCompliant: collectPsiNonCompliant } = require('../../audits/Periodic Safety Inspection/psiSchema');
const {
    listSessionsForPeriod: listPsiSessions,
    updateSession: updatePsiSession,
    getSessionById: getPsiSessionById,
    findSessionAcrossPeriods: findPsiSessionAcrossPeriods,
} = require('../../audits/Periodic Safety Inspection/psiStore');
const { collectNonCompliant: collectSquareOneNonCompliant } = require('../../audits/Square One/squareOneSchema');
const {
    listSessionsForPeriod: listSquareOneSessions,
    updateSession: updateSquareOneSession,
    getSessionById: getSquareOneSessionById,
    findSessionAcrossPeriods: findSquareOneSessionAcrossPeriods,
} = require('../../audits/Square One/squareOneStore');
const {
    listStoreActions,
    completeAction,
    summarizeStoreActions,
    syncRegistryFromSessionAction,
    getDefaultActionDueDate,
} = require('./storeActionsStore');

const paths = require('../../../src/paths');
const DFSC_DATA_DIR = path.join(paths.tacaudit.data, 'dfsc');
const PEST_DATA_DIR = path.join(paths.tacaudit.data, 'pest-walk');
const RGM_DATA_DIR = path.join(paths.tacaudit.data, 'rgm-cleaning');
const PSI_DATA_DIR = path.join(paths.tacaudit.data, 'periodic-safety');
const SQUARE_ONE_DATA_DIR = path.join(paths.tacaudit.data, 'square-one');
const SCAN_DAYS = 45;

const AUDIT_SCANNERS = [
    {
        auditType: 'dfsc',
        auditLabel: 'DFSC',
        dataDir: DFSC_DATA_DIR,
        listSessions(store, bucket) {
            return listSessionsForDay(store, bucket);
        },
        collectNonCompliant: collectDfscNonCompliant,
        getSession: (store, sessionId, bucket) =>
            getDfscSessionById(store, sessionId, bucket) || findDfscSessionAcrossDays(store, sessionId),
        updateSession: updateDfscSession,
        dateField: 'dateKey',
    },
    {
        auditType: 'pest-walk',
        auditLabel: 'Pest Walk',
        dataDir: PEST_DATA_DIR,
        listSessions(store, bucket) {
            return listPestSessions(store, bucket);
        },
        collectNonCompliant: collectPestNonCompliant,
        getSession: (store, sessionId, bucket) =>
            getPestSessionById(store, sessionId, bucket) || findPestSessionAcrossPeriods(store, sessionId),
        updateSession: updatePestSession,
        dateField: 'periodKey',
    },
    {
        auditType: 'rgm-cleaning',
        auditLabel: 'RGM Cleaning',
        dataDir: RGM_DATA_DIR,
        listSessions(store, bucket) {
            return listRgmSessions(store, bucket);
        },
        collectNonCompliant: collectRgmNonCompliant,
        getSession: (store, sessionId, bucket) =>
            getRgmSessionById(store, sessionId, bucket) || findRgmSessionAcrossPeriods(store, sessionId),
        updateSession: updateRgmSession,
        dateField: 'periodKey',
    },
    {
        auditType: 'psi',
        auditLabel: 'PSI',
        dataDir: PSI_DATA_DIR,
        listSessions(store, bucket) {
            return listPsiSessions(store, bucket);
        },
        collectNonCompliant: collectPsiNonCompliant,
        getSession: (store, sessionId, bucket) =>
            getPsiSessionById(store, sessionId, bucket) || findPsiSessionAcrossPeriods(store, sessionId),
        updateSession: updatePsiSession,
        dateField: 'periodKey',
    },
    {
        auditType: 'square-one',
        auditLabel: 'Square One',
        dataDir: SQUARE_ONE_DATA_DIR,
        listSessions(store, bucket) {
            return listSquareOneSessions(store, bucket);
        },
        collectNonCompliant: collectSquareOneNonCompliant,
        getSession: (store, sessionId, bucket) =>
            getSquareOneSessionById(store, sessionId, bucket) ||
            findSquareOneSessionAcrossPeriods(store, sessionId),
        updateSession: updateSquareOneSession,
        dateField: 'periodKey',
    },
];

function dateKeyDaysAgo(days, todayKey) {
    const base = new Date(`${todayKey}T12:00:00`);
    base.setDate(base.getDate() - days);
    return base.toISOString().slice(0, 10);
}

function scanLegacyInProgressActions(storeNumber) {
    const store = normalizeDfscStore(storeNumber);
    const cfg = getStoreConfig(store) || {};
    const storeName = String(cfg.storeName || store).trim();
    const today = storeDateKey(store);
    const fromDateKey = dateKeyDaysAgo(SCAN_DAYS - 1, today);
    const actions = [];
    const registryIds = new Set(listStoreActions(store, { status: 'open' }).map((a) => a.id));

    for (const scanner of AUDIT_SCANNERS) {
        const storeRoot = path.join(scanner.dataDir, store);
        if (!fs.existsSync(storeRoot)) continue;
        for (const entry of fs.readdirSync(storeRoot, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
            if (scanner.auditType === 'dfsc' && entry.name < fromDateKey) continue;
            const sessions = scanner.listSessions(store, entry.name);
            if (!Array.isArray(sessions)) continue;
            for (const session of sessions) {
                if (session.status !== 'in_progress') continue;
                const rows =
                    typeof scanner.collectNonCompliant === 'function'
                        ? scanner.collectNonCompliant(session)
                        : [];
                if (!Array.isArray(rows)) continue;
                for (const row of rows) {
                    const id = `${scanner.auditType}:${session.id}:${row.questionId}`;
                    if (registryIds.has(id)) continue;
                    if (row.actionSubmitted) continue;
                    const draftText = String(row.actionText || '').trim();
                    const dueDate = session.actions?.[row.questionId]?.dueDate || getDefaultActionDueDate(store);
                    actions.push({
                        id,
                        storeNumber: store,
                        storeName,
                        auditType: scanner.auditType,
                        auditLabel: scanner.auditLabel,
                        sessionId: session.id,
                        questionId: row.questionId,
                        label: row.label,
                        text: draftText,
                        draftText,
                        dueDate,
                        status: 'open',
                        dateKey: session.dateKey || null,
                        periodKey: session.periodKey || null,
                        shift: session.shift || null,
                        areaTitle: session.areaTitle || session.dashboardLabel || null,
                        conductorName: session.conductor?.name || '',
                        createdBy: session.conductor?.name || '',
                        startedAt: session.startedAt,
                        legacyInProgress: true,
                    });
                }
            }
        }
    }

    return actions;
}

function scanStoreOpenActions(storeNumber) {
    const registry = listStoreActions(storeNumber, { status: 'open' });
    const legacy = scanLegacyInProgressActions(storeNumber);
    const merged = [...registry];
    const seen = new Set(registry.map((a) => a.id));
    for (const action of legacy) {
        if (!seen.has(action.id)) merged.push(action);
    }
    merged.sort((a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')));
    return merged;
}

function countOpenActionsForStore(storeNumber) {
    return scanStoreOpenActions(storeNumber).length;
}

function listOpenActionsForStores(stores) {
    const actions = [];
    for (const store of stores || []) {
        const num = String(store.storeNumber || store || '').trim();
        if (!num) continue;
        actions.push(...scanStoreOpenActions(num));
    }
    return actions;
}

function adminAccess() {
    return { isAdmin: true, canAccessDfsc: true, username: '', conductorFullName: '' };
}

function findScanner(auditType) {
    return AUDIT_SCANNERS.find((s) => s.auditType === auditType) || null;
}

function submitAction(payload, access = {}) {
    const storeNumber = String(payload.storeNumber || '').trim();
    const actionId = String(payload.actionId || '').trim();
    const complete = payload.complete === true || payload.markComplete === true;

    if (complete && actionId) {
        return completeAction(storeNumber, actionId, access);
    }

    const auditType = String(payload.auditType || '').trim();
    const sessionId = String(payload.sessionId || '').trim();
    const questionId = String(payload.questionId || '').trim();
    const text = String(payload.text || '').trim();
    if (!storeNumber || !auditType || !sessionId || !questionId) {
        return { ok: false, error: 'storeNumber, auditType, sessionId, and questionId are required.' };
    }
    if (!text) return { ok: false, error: 'Action text is required.' };

    const scanner = findScanner(auditType);
    if (!scanner) return { ok: false, error: 'Unknown audit type.' };

    const ctx = access.isAdmin ? adminAccess() : access;
    const bucket = payload.dateKey || payload.periodKey || null;
    const session = scanner.getSession(storeNumber, sessionId, bucket);
    if (!session) return { ok: false, error: 'Session not found.' };

    const dueDate = payload.dueDate || getDefaultActionDueDate(storeNumber);
    const actionEntry = { text, submittedAt: new Date().toISOString(), dueDate };
    const updates = { actions: { [questionId]: actionEntry } };
    if (scanner.dateField === 'dateKey' && payload.dateKey) updates.dateKey = payload.dateKey;
    if (scanner.dateField === 'periodKey' && payload.periodKey) updates.periodKey = payload.periodKey;

    const result = scanner.updateSession(storeNumber, sessionId, updates, ctx);
    if (!result.ok) return result;

    const row = (scanner.collectNonCompliant(result.session) || []).find((r) => r.questionId === questionId);
    syncRegistryFromSessionAction(
        storeNumber,
        auditType,
        result.session,
        questionId,
        actionEntry,
        ctx,
        row?.label || questionId
    );

    return result;
}

module.exports = {
    AUDIT_SCANNERS,
    scanStoreOpenActions,
    countOpenActionsForStore,
    listOpenActionsForStores,
    summarizeStoreActions,
    submitAction,
};
