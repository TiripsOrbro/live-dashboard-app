const { getStoreConfig } = require('../storeList');
const { getDismissalPeriodKey } = require('../../utils/auditRecurrence');
const {
    listInspectionHistory: listDfscInspectionHistory,
    buildDaySummary,
    storeDateKey,
    listOpenAudits: listDfscOpenAudits,
} = require('../dfsc/dfscStore');
const { formatStoreTileSubtext } = require('../dfsc/dfscAdmin');
const {
    listInspectionHistory: listPestWalkInspectionHistory,
    buildPeriodSummary: buildPestPeriodSummary,
    listOpenAudits: listPestOpenAudits,
} = require('../pestWalk/pestWalkStore');
const {
    listInspectionHistory: listRgmCleaningInspectionHistory,
    buildPeriodSummary: buildRgmPeriodSummary,
    listOpenAudits: listRgmOpenAudits,
} = require('../rgmCleaning/rgmCleaningStore');
const {
    listInspectionHistory: listPsiInspectionHistory,
    buildPeriodSummary: buildPsiPeriodSummary,
    listOpenAudits: listPsiOpenAudits,
} = require('../periodicSafety/psiStore');
const {
    listInspectionHistory: listSquareOneInspectionHistory,
    buildPeriodSummary: buildSquareOnePeriodSummary,
    listOpenAudits: listSquareOneOpenAudits,
} = require('../squareOne/squareOneStore');
const { getAuditSchedule } = require('../../utils/auditRecurrence');
const { readArchiveIndex, mergeHistoryWithArchive, ARCHIVE_RETENTION_DAYS } = require('./tacauditArchive');
const { getAuditTypeConfig, isValidAuditType } = require('./auditRegistry');
const { getSettings } = require('./tacauditStore');

const HISTORY_LISTERS = {
    dfsc: listDfscInspectionHistory,
    'pest-walk': listPestWalkInspectionHistory,
    'rgm-cleaning': listRgmCleaningInspectionHistory,
    psi: listPsiInspectionHistory,
    'square-one': listSquareOneInspectionHistory,
};

function listTacauditHistory(storeNumber, auditType, options = {}) {
    const type = String(auditType || '').trim();
    if (!isValidAuditType(type)) {
        return { ok: false, error: 'Unknown audit type.' };
    }

    const cfg = getAuditTypeConfig(type);
    if (!cfg || cfg.placeholder) {
        return { ok: true, auditType: type, history: [], retentionDays: ARCHIVE_RETENTION_DAYS };
    }

    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    const lister = HISTORY_LISTERS[type];
    const live = lister ? lister(storeNumber, { limit }) : [];
    const archiveEntries = readArchiveIndex(storeNumber, type);
    const history = mergeHistoryWithArchive(live, archiveEntries, type).slice(0, limit);

    return {
        ok: true,
        auditType: type,
        history,
        retentionDays: ARCHIVE_RETENTION_DAYS,
    };
}

function weeklyAuditSubtext(period, openCount = 0) {
    if (period?.periodCompleted) return 'Complete this week';
    const parts = ['Due this week'];
    if (openCount > 0) parts.push(`${openCount} open`);
    else if (period?.inProgress) parts.push('In progress');
    return parts.join(' · ');
}

const OPEN_AUDIT_LISTERS = [
    { type: 'dfsc', label: 'DFSC', list: listDfscOpenAudits },
    { type: 'pest-walk', label: 'Pest Walk', list: listPestOpenAudits },
    { type: 'rgm-cleaning', label: 'RGM Cleaning', list: listRgmOpenAudits },
    { type: 'psi', label: 'PSI', list: listPsiOpenAudits },
    { type: 'square-one', label: 'Square One', list: listSquareOneOpenAudits },
];

function buildAccessContext(options = {}) {
    return {
        username: options.username || '',
        conductorFullName: options.conductorFullName || '',
        canAccessDfsc: Boolean(options.canAccessDfsc),
        isAdmin: Boolean(options.isAdmin),
    };
}

function buildInProgressAudits(storeNumber, options = {}) {
    const store = String(storeNumber || '').trim();
    const access = buildAccessContext(options);
    const rows = [];
    for (const { type, label, list } of OPEN_AUDIT_LISTERS) {
        for (const audit of list(store, { access })) {
            rows.push({
                ...audit,
                auditType: type,
                auditLabel: label,
            });
        }
    }
    return rows.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
}

function buildLaunchTiles(storeNumber, options = {}) {
    const store = String(storeNumber || '').trim();
    const access = buildAccessContext(options);
    const periodKey = getDismissalPeriodKey();
    const dfscDateKey = storeDateKey(store);
    const dfscDay = buildDaySummary(store, dfscDateKey);
    const dfscOpen = listDfscOpenAudits(store, { access }).length;
    const pestPeriod = buildPestPeriodSummary(store, periodKey);
    const rgmPeriod = buildRgmPeriodSummary(store, periodKey);
    const psiPeriod = buildPsiPeriodSummary(store, periodKey);
    const squareSchedule = getAuditSchedule();
    const squarePeriod = buildSquareOnePeriodSummary(store, periodKey, squareSchedule.squareSlot);
    const squareOpen = listSquareOneOpenAudits(store, { access }).length;
    const squareDue = squarePeriod.dueCount || 0;
    const squareDone = squarePeriod.completedCount || 0;

    return [
        {
            id: 'dfsc',
            label: 'DFSC',
            href: `/${store}/dfsc`,
            sub: formatStoreTileSubtext(
                { amCompleted: dfscDay.amCompleted, pmCompleted: dfscDay.pmCompleted },
                Boolean(dfscDay.inProgress),
                dfscOpen
            ),
            complete: Boolean(dfscDay.amCompleted && dfscDay.pmCompleted),
        },
        {
            id: 'pest-walk',
            label: 'Pest Walk',
            href: `/${store}/pest-walk`,
            sub: weeklyAuditSubtext(pestPeriod, listPestOpenAudits(store, { access }).length),
            complete: Boolean(pestPeriod.periodCompleted),
        },
        {
            id: 'rgm-cleaning',
            label: 'RGM Cleaning',
            href: `/${store}/rgm-cleaning`,
            sub: weeklyAuditSubtext(rgmPeriod, listRgmOpenAudits(store, { access }).length),
            complete: Boolean(rgmPeriod.periodCompleted),
        },
        {
            id: 'psi',
            label: 'PSI',
            href: `/${store}/psi`,
            sub: weeklyAuditSubtext(psiPeriod, listPsiOpenAudits(store, { access }).length),
            complete: Boolean(psiPeriod.periodCompleted),
        },
        {
            id: 'square-one',
            label: 'Square One',
            href: `/${store}/square-one`,
            sub:
                squareDue > 0 && squareDone >= squareDue
                    ? 'Complete this week'
                    : squareOpen > 0
                      ? `${squareOpen} open · ${squareDone}/${squareDue} complete`
                      : `${squareDone}/${squareDue} complete this week`,
            complete: squareDue > 0 && squareDone >= squareDue,
        },
    ];
}

function getTacauditContext(storeNumber, options = {}) {
    const cfg = getStoreConfig(storeNumber) || {};
    const settings = getSettings(storeNumber);
    const canViewAdminSummary = Boolean(options.canViewAdminSummary);
    return {
        storeNumber: settings.storeNumber,
        storeName: String(cfg.storeName || settings.storeNumber).trim(),
        areaName: String(cfg.area || '').trim(),
        settings,
        canViewAdminSummary,
        launchTiles: buildLaunchTiles(storeNumber, options),
        inProgressAudits: buildInProgressAudits(storeNumber, options),
        auditTypes: [
            { id: 'dfsc', label: 'DFSC' },
            { id: 'pest-walk', label: 'Pest Walk' },
            { id: 'rgm-cleaning', label: 'RGM Cleaning' },
            { id: 'psi', label: 'PSI' },
            { id: 'square-one', label: 'Square One' },
        ],
        archiveRetentionDays: ARCHIVE_RETENTION_DAYS,
    };
}

module.exports = {
    listTacauditHistory,
    getTacauditContext,
};
