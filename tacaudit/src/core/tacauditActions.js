const fs = require('fs');
const path = require('path');
const { getStoreConfig } = require('../../../stores/src/storeList');
const { collectNonCompliant: collectDfscNonCompliant } = require('../../audits/Daily Food Safety Check/dfscSchema');
const {
    findSessionAcrossDays,
    listSessionsForDay,
    storeDateKey,
    normalizeStoreKey: normalizeDfscStore,
    updateSession: updateDfscSession,
} = require('../../audits/Daily Food Safety Check/dfscStore');
const { collectNonCompliant: collectPestNonCompliant } = require('../../audits/Pest Walk/pestWalkSchema');
const {
    listSessionsForPeriod: listPestSessions,
    updateSession: updatePestSession,
} = require('../../audits/Pest Walk/pestWalkStore');
const { collectNonCompliant: collectRgmNonCompliant } = require('../../audits/RGM Cleaning/rgmCleaningSchema');
const {
    listSessionsForPeriod: listRgmSessions,
    updateSession: updateRgmSession,
} = require('../../audits/RGM Cleaning/rgmCleaningStore');
const { collectNonCompliant: collectPsiNonCompliant } = require('../../audits/Periodic Safety Inspection/psiSchema');
const {
    listSessionsForPeriod: listPsiSessions,
    updateSession: updatePsiSession,
} = require('../../audits/Periodic Safety Inspection/psiStore');

const paths = require('../../../src/paths');
const DFSC_DATA_DIR = path.join(paths.tacaudit.data, 'dfsc');
const PEST_DATA_DIR = path.join(paths.tacaudit.data, 'pest-walk');
const RGM_DATA_DIR = path.join(paths.tacaudit.data, 'rgm-cleaning');
const PSI_DATA_DIR = path.join(paths.tacaudit.data, 'periodic-safety');
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
        draftField: 'actionText',
    },
    {
        auditType: 'pest-walk',
        auditLabel: 'Pest Walk',
        dataDir: PEST_DATA_DIR,
        listSessions(store, bucket) {
            return listPestSessions(store, bucket);
        },
        collectNonCompliant: collectPestNonCompliant,
        draftField: 'actionText',
    },
    {
        auditType: 'rgm-cleaning',
        auditLabel: 'RGM Cleaning',
        dataDir: RGM_DATA_DIR,
        listSessions(store, bucket) {
            return listRgmSessions(store, bucket);
        },
        collectNonCompliant: collectRgmNonCompliant,
        draftField: 'actionText',
    },
    {
        auditType: 'psi',
        auditLabel: 'PSI',
        dataDir: PSI_DATA_DIR,
        listSessions(store, bucket) {
            return listPsiSessions(store, bucket);
        },
        collectNonCompliant: collectPsiNonCompliant,
        draftField: 'actionText',
    },
];

function dateKeyDaysAgo(days, todayKey) {
    const base = new Date(`${todayKey}T12:00:00`);
    base.setDate(base.getDate() - days);
    return base.toISOString().slice(0, 10);
}

function scanStoreOpenActions(storeNumber) {
    const store = normalizeDfscStore(storeNumber);
    const cfg = getStoreConfig(store) || {};
    const storeName = String(cfg.storeName || store).trim();
    const today = storeDateKey(store);
    const fromDateKey = dateKeyDaysAgo(SCAN_DAYS - 1, today);
    const actions = [];

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
                    if (row.actionSubmitted) continue;
                    const draftText = String(row[scanner.draftField] || row.actionText || '').trim();
                    actions.push({
                        id: `${scanner.auditType}:${session.id}:${row.questionId}`,
                        storeNumber: store,
                        storeName,
                        auditType: scanner.auditType,
                        auditLabel: scanner.auditLabel,
                        sessionId: session.id,
                        questionId: row.questionId,
                        label: row.label,
                        draftText,
                        dateKey: session.dateKey || null,
                        periodKey: session.periodKey || null,
                        shift: session.shift || null,
                        areaTitle: session.areaTitle || session.dashboardLabel || null,
                        conductorName: session.conductor?.name || '',
                        startedAt: session.startedAt,
                    });
                }
            }
        }
    }

    actions.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
    return actions;
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

function submitAction(payload, access = {}) {
    const storeNumber = String(payload.storeNumber || '').trim();
    const auditType = String(payload.auditType || '').trim();
    const sessionId = String(payload.sessionId || '').trim();
    const questionId = String(payload.questionId || '').trim();
    const text = String(payload.text || '').trim();
    if (!storeNumber || !auditType || !sessionId || !questionId) {
        return { ok: false, error: 'storeNumber, auditType, sessionId, and questionId are required.' };
    }
    if (!text) return { ok: false, error: 'Action text is required.' };

    const actionEntry = { text, submittedAt: new Date().toISOString() };
    const ctx = access.isAdmin ? adminAccess() : access;

    if (auditType === 'dfsc') {
        const updates = { actions: { [questionId]: actionEntry } };
        if (payload.dateKey) updates.dateKey = payload.dateKey;
        return updateDfscSession(storeNumber, sessionId, updates, ctx);
    }
    if (auditType === 'pest-walk') {
        const updates = { actions: { [questionId]: actionEntry } };
        if (payload.periodKey) updates.periodKey = payload.periodKey;
        return updatePestSession(storeNumber, sessionId, updates, ctx);
    }
    if (auditType === 'rgm-cleaning') {
        const updates = { actions: { [questionId]: actionEntry } };
        if (payload.periodKey) updates.periodKey = payload.periodKey;
        return updateRgmSession(storeNumber, sessionId, updates, ctx);
    }
    if (auditType === 'psi') {
        const updates = { actions: { [questionId]: actionEntry } };
        if (payload.periodKey) updates.periodKey = payload.periodKey;
        return updatePsiSession(storeNumber, sessionId, updates, ctx);
    }
    return { ok: false, error: 'Unknown audit type.' };
}

module.exports = {
    scanStoreOpenActions,
    countOpenActionsForStore,
    listOpenActionsForStores,
    submitAction,
};
