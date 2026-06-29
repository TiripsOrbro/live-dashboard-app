const { getStoreConfig } = require('../../../stores/src/storeList');
const { getDismissalPeriodKey } = require('../auditRecurrence');
const { buildStoreDashboardProgress } = require('./tacauditDashboardProgress');
const {
    listInspectionHistory: listDfscInspectionHistory,
    buildDaySummary,
    storeDateKey,
    listOpenAudits: listDfscOpenAudits,
} = require('../../audits/Daily Food Safety Check/dfscStore');
const { formatStoreTileSubtext } = require('../../audits/Daily Food Safety Check/dfscAdmin');
const {
    listInspectionHistory: listPestWalkInspectionHistory,
    buildPeriodSummary: buildPestPeriodSummary,
    listOpenAudits: listPestOpenAudits,
} = require('../../audits/Pest Walk/pestWalkStore');
const {
    listInspectionHistory: listRgmCleaningInspectionHistory,
    buildPeriodSummary: buildRgmPeriodSummary,
    listOpenAudits: listRgmOpenAudits,
} = require('../../audits/RGM Cleaning/rgmCleaningStore');
const {
    listInspectionHistory: listPsiInspectionHistory,
    buildPeriodSummary: buildPsiPeriodSummary,
    listOpenAudits: listPsiOpenAudits,
} = require('../../audits/Periodic Safety Inspection/psiStore');
const {
    listInspectionHistory: listSquareOneInspectionHistory,
    buildPeriodSummary: buildSquareOnePeriodSummary,
    buildAreaSummaries,
    listOpenAudits: listSquareOneOpenAudits,
} = require('../../audits/Square One/squareOneStore');
const {
    listInspectionHistory: listCoreOpsInspectionHistory,
    buildPeriodSummary: buildCoreOpsPeriodSummary,
    listOpenAudits: listCoreOpsOpenAudits,
} = require('../../audits/CORE Operations/coreOpsStore');
const {
    listInspectionHistory: listCoreFoodSafetyInspectionHistory,
    buildPeriodSummary: buildCoreFoodSafetyPeriodSummary,
    listOpenAudits: listCoreFoodSafetyOpenAudits,
} = require('../../audits/CORE Food Safety/coreFoodSafetyStore');
const {
    listInspectionHistory: listVisitCoachInspectionHistory,
    buildPeriodSummary: buildVisitCoachPeriodSummary,
    listOpenAudits: listVisitCoachOpenAudits,
} = require('../../audits/Visiting as a Coach/visitCoachStore');
const {
    listInspectionHistory: listVisitCustomerInspectionHistory,
    buildPeriodSummary: buildVisitCustomerPeriodSummary,
    listOpenAudits: listVisitCustomerOpenAudits,
} = require('../../audits/Visiting as a Customer/visitCustomerStore');
const { getAuditSchedule } = require('../auditRecurrence');
const { getAccessibleAreasForUser, getOverviewScope, canAccessCoachAudits } = require('../../../users/src/core/dashboardUsers');
const { getAllMarketLabels, getAreasForMarket } = require('../../../stores/src/marketsConfig');
const { readArchiveIndex, mergeHistoryWithArchive, ARCHIVE_RETENTION_DAYS } = require('./tacauditArchive');
const { getAuditTypeConfig, isValidAuditType } = require('./auditRegistry');
const { getSettings } = require('./tacauditStore');
const { countOpenActionsForStore, summarizeStoreActions, scanStoreOpenActions } = require('./tacauditActions');
const { getDefaultActionDueDate } = require('./storeActionsStore');

const HISTORY_LISTERS = {
    dfsc: listDfscInspectionHistory,
    'pest-walk': listPestWalkInspectionHistory,
    'rgm-cleaning': listRgmCleaningInspectionHistory,
    psi: listPsiInspectionHistory,
    'square-one': listSquareOneInspectionHistory,
    'core-ops': listCoreOpsInspectionHistory,
    'core-food-safety': listCoreFoodSafetyInspectionHistory,
    'visit-coach': listVisitCoachInspectionHistory,
    'visit-customer': listVisitCustomerInspectionHistory,
};

const ALL_AUDIT_TYPE_LABELS = [
    { id: 'dfsc', label: 'DFSC' },
    { id: 'pest-walk', label: 'Pest Walk' },
    { id: 'rgm-cleaning', label: 'RGM Cleaning' },
    { id: 'psi', label: 'PSI' },
    { id: 'square-one', label: 'Square One' },
    { id: 'core-ops', label: 'CORE Operations' },
    { id: 'core-food-safety', label: 'CORE Food Safety' },
    { id: 'visit-coach', label: 'Visiting as a Coach', coachOnly: true },
    { id: 'visit-customer', label: 'Visiting as a Customer', coachOnly: true },
];

function auditTypesForUser(options = {}) {
    const user = options.user;
    const coachOk = options.canAccessCoachAudits ?? (user ? canAccessCoachAudits(user) : false);
    return ALL_AUDIT_TYPE_LABELS.filter((row) => !row.coachOnly || coachOk);
}

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

function listTacauditAdminHistory(stores, auditType, options = {}) {
    const type = String(auditType || '').trim();
    if (!isValidAuditType(type)) {
        return { ok: false, error: 'Unknown audit type.' };
    }

    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    const rows = [];

    for (const store of stores || []) {
        const num = String(store.storeNumber || store || '').trim();
        if (!num) continue;
        const name = String(store.storeName || num).trim();
        const result = listTacauditHistory(num, type, { limit });
        if (!result.ok) continue;
        for (const row of result.history || []) {
            rows.push({
                ...row,
                auditType: type,
                storeNumber: num,
                storeName: name,
            });
        }
    }

    rows.sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')));

    return {
        ok: true,
        auditType: type,
        history: rows.slice(0, limit),
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

function squareOneAreaSubtext(area) {
    if (area?.periodCompleted) return 'Complete this week';
    if (area?.inProgress) return 'In progress';
    return 'Due this week';
}

function buildSquareOneLaunchTiles(store, periodKey, squareSlot) {
    return buildAreaSummaries(store, periodKey, squareSlot).map((area) => ({
        id: `square-one--${area.id}`,
        label: area.tileLabel || area.dashboardLabel || area.title,
        href: `/${store}/square-one?area=${encodeURIComponent(area.id)}`,
        sub: squareOneAreaSubtext(area),
        complete: Boolean(area.periodCompleted),
    }));
}

function buildSquareOneDueAreasForContext(storeNumber) {
    const store = String(storeNumber || '').trim();
    const periodKey = getDismissalPeriodKey();
    const squareSlot = getAuditSchedule().squareSlot;
    return buildAreaSummaries(store, periodKey, squareSlot).map((area) => ({
        id: area.id,
        label: area.tileLabel || area.dashboardLabel || area.title,
        periodCompleted: Boolean(area.periodCompleted),
        inProgress: Boolean(area.inProgress),
    }));
}

const OPEN_AUDIT_LISTERS = [
    { type: 'dfsc', label: 'DFSC', list: listDfscOpenAudits },
    { type: 'pest-walk', label: 'Pest Walk', list: listPestOpenAudits },
    { type: 'rgm-cleaning', label: 'RGM Cleaning', list: listRgmOpenAudits },
    { type: 'psi', label: 'PSI', list: listPsiOpenAudits },
    { type: 'square-one', label: 'Square One', list: listSquareOneOpenAudits },
    { type: 'core-ops', label: 'CORE Operations', list: listCoreOpsOpenAudits },
    { type: 'core-food-safety', label: 'CORE Food Safety', list: listCoreFoodSafetyOpenAudits },
    { type: 'visit-coach', label: 'Visiting as a Coach', list: listVisitCoachOpenAudits, coachOnly: true },
    { type: 'visit-customer', label: 'Visiting as a Customer', list: listVisitCustomerOpenAudits, coachOnly: true },
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
    const coachOk = options.canAccessCoachAudits ?? false;
    const rows = [];
    for (const { type, label, list, coachOnly } of OPEN_AUDIT_LISTERS) {
        if (coachOnly && !coachOk) continue;
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
    const coachOk = options.canAccessCoachAudits ?? false;
    const coreOpsPeriod = buildCoreOpsPeriodSummary(store, periodKey);
    const coreFsPeriod = buildCoreFoodSafetyPeriodSummary(store, periodKey);
    const visitCoachPeriod = buildVisitCoachPeriodSummary(store, periodKey);
    const visitCustomerPeriod = buildVisitCustomerPeriodSummary(store, periodKey);

    const tiles = [
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
        ...buildSquareOneLaunchTiles(store, periodKey, squareSchedule.squareSlot),
        {
            id: 'core-ops',
            label: 'CORE Operations',
            href: `/${store}/core-ops`,
            sub: weeklyAuditSubtext(coreOpsPeriod, listCoreOpsOpenAudits(store, { access }).length),
            complete: Boolean(coreOpsPeriod.periodCompleted),
        },
        {
            id: 'core-food-safety',
            label: 'CORE Food Safety',
            href: `/${store}/core-food-safety`,
            sub: weeklyAuditSubtext(coreFsPeriod, listCoreFoodSafetyOpenAudits(store, { access }).length),
            complete: Boolean(coreFsPeriod.periodCompleted),
        },
    ];
    if (coachOk) {
        tiles.push(
            {
                id: 'visit-coach',
                label: 'Visiting as a Coach',
                href: `/${store}/visit-coach`,
                sub: weeklyAuditSubtext(visitCoachPeriod, listVisitCoachOpenAudits(store, { access }).length),
                complete: Boolean(visitCoachPeriod.periodCompleted),
            },
            {
                id: 'visit-customer',
                label: 'Visiting as a Customer',
                href: `/${store}/visit-customer`,
                sub: weeklyAuditSubtext(visitCustomerPeriod, listVisitCustomerOpenAudits(store, { access }).length),
                complete: Boolean(visitCustomerPeriod.periodCompleted),
            }
        );
    }
    return tiles;
}

function buildActionsSnapshot(storeNumber) {
    return scanStoreOpenActions(storeNumber)
        .sort((a, b) => {
            if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
            if (a.isDueSoon !== b.isDueSoon) return a.isDueSoon ? -1 : 1;
            return String(a.dueDate || '').localeCompare(String(b.dueDate || ''));
        })
        .slice(0, 3);
}

function getTacauditContext(storeNumber, options = {}) {
    const cfg = getStoreConfig(storeNumber) || {};
    const settings = getSettings(storeNumber);
    const canViewAdminSummary = Boolean(options.canViewAdminSummary);
    const launchTiles = buildLaunchTiles(storeNumber, options);
    const access = buildAccessContext(options);
    return {
        storeNumber: settings.storeNumber,
        storeName: String(cfg.storeName || settings.storeNumber).trim(),
        areaName: String(cfg.area || '').trim(),
        settings,
        canViewAdminSummary,
        launchTiles,
        squareOneDueAreas: buildSquareOneDueAreasForContext(storeNumber),
        dashboardProgress: buildStoreDashboardProgress(storeNumber, launchTiles, { access }),
        inProgressAudits: buildInProgressAudits(storeNumber, options),
        openActionsCount: countOpenActionsForStore(storeNumber),
        actionsSummary: summarizeStoreActions(storeNumber),
        actionsSnapshot: buildActionsSnapshot(storeNumber),
        defaultActionDueDate: getDefaultActionDueDate(storeNumber),
        canAccessCoachAudits: Boolean(options.canAccessCoachAudits),
        auditTypes: auditTypesForUser(options),
        archiveRetentionDays: ARCHIVE_RETENTION_DAYS,
    };
}

function buildAreaLaunchTiles(stores, periodKey, options = {}) {
    const coachOk = options.canAccessCoachAudits ?? false;
    const squareSchedule = getAuditSchedule();
    const squareSlot = squareSchedule.squareSlot;
    let dfscComplete = 0;
    let pestComplete = 0;
    let rgmComplete = 0;
    let psiComplete = 0;
    let squareComplete = 0;
    let coreOpsComplete = 0;
    let coreFsComplete = 0;
    let visitCoachComplete = 0;
    let visitCustomerComplete = 0;
    const total = stores.length;

    for (const store of stores) {
        const num = String(store.storeNumber || '').trim();
        if (!num) continue;
        const dfscDateKey = storeDateKey(num);
        const dfscDay = buildDaySummary(num, dfscDateKey);
        if (dfscDay.amCompleted && dfscDay.pmCompleted) dfscComplete += 1;
        if (buildPestPeriodSummary(num, periodKey)?.periodCompleted) pestComplete += 1;
        if (buildRgmPeriodSummary(num, periodKey)?.periodCompleted) rgmComplete += 1;
        if (buildPsiPeriodSummary(num, periodKey)?.periodCompleted) psiComplete += 1;
        const sq = buildSquareOnePeriodSummary(num, periodKey, squareSlot);
        const due = sq.dueCount || 0;
        const done = sq.completedCount || 0;
        if (due > 0 && done >= due) squareComplete += 1;
        if (buildCoreOpsPeriodSummary(num, periodKey)?.periodCompleted) coreOpsComplete += 1;
        if (buildCoreFoodSafetyPeriodSummary(num, periodKey)?.periodCompleted) coreFsComplete += 1;
        if (buildVisitCoachPeriodSummary(num, periodKey)?.periodCompleted) visitCoachComplete += 1;
        if (buildVisitCustomerPeriodSummary(num, periodKey)?.periodCompleted) visitCustomerComplete += 1;
    }

    const sub = (n) => `${n}/${total} stores complete`;

    const tiles = [
        { id: 'dfsc', label: 'DFSC', sub: sub(dfscComplete), complete: dfscComplete === total && total > 0 },
        { id: 'pest-walk', label: 'Pest Walk', sub: sub(pestComplete), complete: pestComplete === total && total > 0 },
        { id: 'rgm-cleaning', label: 'RGM Cleaning', sub: sub(rgmComplete), complete: rgmComplete === total && total > 0 },
        { id: 'psi', label: 'PSI', sub: sub(psiComplete), complete: psiComplete === total && total > 0 },
        {
            id: 'square-one',
            label: 'Square One',
            sub: sub(squareComplete),
            complete: squareComplete === total && total > 0,
        },
        { id: 'core-ops', label: 'CORE Operations', sub: sub(coreOpsComplete), complete: coreOpsComplete === total && total > 0 },
        {
            id: 'core-food-safety',
            label: 'CORE Food Safety',
            sub: sub(coreFsComplete),
            complete: coreFsComplete === total && total > 0,
        },
    ];
    if (coachOk) {
        tiles.push(
            {
                id: 'visit-coach',
                label: 'Visiting as a Coach',
                sub: sub(visitCoachComplete),
                complete: visitCoachComplete === total && total > 0,
            },
            {
                id: 'visit-customer',
                label: 'Visiting as a Customer',
                sub: sub(visitCustomerComplete),
                complete: visitCustomerComplete === total && total > 0,
            }
        );
    }
    return tiles;
}

function getTacauditScopeMeta(user) {
    const accessibleAreas = getAccessibleAreasForUser(user);
    const overviewScope = getOverviewScope(user);
    const marketAreas = {};
    for (const market of getAllMarketLabels()) {
        const areas = getAreasForMarket(market).filter((area) => accessibleAreas.includes(area));
        if (areas.length) marketAreas[market] = areas;
    }
    return {
        accessibleAreas,
        accessibleMarkets: Object.keys(marketAreas),
        marketAreas,
        overviewScope,
    };
}

function getTacauditAdminContext(stores, options = {}) {
    const periodKey = getDismissalPeriodKey();
    const access = buildAccessContext({ ...options, isAdmin: true, canAccessDfsc: true });
    const inProgressAudits = [];

    for (const store of stores) {
        const num = String(store.storeNumber || '').trim();
        const name = String(store.storeName || num).trim();
        if (!num) continue;
        for (const audit of buildInProgressAudits(num, access)) {
            inProgressAudits.push({ ...audit, storeNumber: num, storeName: name });
        }
    }

    inProgressAudits.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));

    return {
        areaName: String(options.areaName || '').trim(),
        accessibleAreas: options.accessibleAreas || [],
        accessibleMarkets: options.accessibleMarkets || [],
        marketAreas: options.marketAreas || {},
        overviewScope: options.overviewScope || '',
        launchTiles: buildAreaLaunchTiles(stores, periodKey, options),
        inProgressAudits,
        openActionsCount: listOpenActionsForStores(stores).length,
        auditTypes: auditTypesForUser(options),
        archiveRetentionDays: ARCHIVE_RETENTION_DAYS,
        isAdminHub: true,
    };
}

module.exports = {
    listTacauditHistory,
    listTacauditAdminHistory,
    getTacauditContext,
    getTacauditAdminContext,
    getTacauditScopeMeta,
};
