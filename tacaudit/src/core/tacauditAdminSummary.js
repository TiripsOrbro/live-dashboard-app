const { getStoreList, getStoreConfig } = require('../../../stores/src/storeList');
const { getAuditSchedule, getDismissalPeriodKey } = require('../auditRecurrence');
const { getDueAreasForSlot } = require('../../audits/Square One/squareOneAreas');
const { buildAreaSummaries } = require('../../audits/Square One/squareOneStore');
const { buildPeriodSummary: buildPestPeriodSummary, listOpenAudits: listPestOpenAudits } = require('../../audits/Pest Walk/pestWalkStore');
const { buildPeriodSummary: buildRgmPeriodSummary, listOpenAudits: listRgmOpenAudits } = require('../../audits/RGM Cleaning/rgmCleaningStore');
const { buildPeriodSummary: buildPsiPeriodSummary, listOpenAudits: listPsiOpenAudits } = require('../../audits/Periodic Safety Inspection/psiStore');
const { buildPeriodSummary: buildCoreOpsPeriodSummary, listOpenAudits: listCoreOpsOpenAudits } = require('../../audits/CORE Operations/coreOpsStore');
const {
    buildPeriodSummary: buildCoreFoodSafetyPeriodSummary,
    listOpenAudits: listCoreFoodSafetyOpenAudits,
} = require('../../audits/CORE Food Safety/coreFoodSafetyStore');
const { buildPeriodSummary: buildVisitCoachPeriodSummary, listOpenAudits: listVisitCoachOpenAudits } = require('../../audits/Visiting as a Coach/visitCoachStore');
const {
    buildPeriodSummary: buildVisitCustomerPeriodSummary,
    listOpenAudits: listVisitCustomerOpenAudits,
} = require('../../audits/Visiting as a Customer/visitCustomerStore');
const { countOpenActionsForStore } = require('./tacauditActions');
const { getOverridesForArea } = require('./tacauditSplashState');
const { buildSeedCellLookup } = require('./tacauditComplianceSeed');
const { buildDfscWeekCompliance, cellFromDfscWeekCount } = require('./tacauditDfscCompliance');
const { getCurrentOperationalWeek } = require('../auditRecurrence');

const ADMIN_ACCESS = { isAdmin: true, canAccessDfsc: true };

const PLACEHOLDER_ROW_IDS = new Set([]);

const ROW_LABEL_BY_ID = {
    'core-ops': 'Operations',
    'core-food-safety': 'Food Safety',
};

function parseYmd(ymd) {
    return String(ymd || '').trim().slice(0, 10);
}

const STATE_REGION_LABELS = {
    VIC: 'VICTORIA',
    WA: 'WESTERN AUSTRALIA',
    QLD: 'QUEENSLAND',
    NSW: 'NEW SOUTH WALES',
    SA: 'SOUTH AUSTRALIA',
    TAS: 'TASMANIA',
    NT: 'NORTHERN TERRITORY',
    ACT: 'AUSTRALIAN CAPITAL TERRITORY',
};

function stateCodeFromTimeZone(timeZone) {
    const tz = String(timeZone || '').trim();
    const map = {
        'Australia/Melbourne': 'VIC',
        'Australia/Sydney': 'NSW',
        'Australia/Brisbane': 'QLD',
        'Australia/Perth': 'WA',
        'Australia/Adelaide': 'SA',
        'Australia/Darwin': 'NT',
        'Australia/Hobart': 'TAS',
        'Australia/Canberra': 'ACT',
    };
    return map[tz] || tz.replace(/^Australia\//, '').toUpperCase() || 'LOCAL';
}

function regionLabelForState(stateCode) {
    return STATE_REGION_LABELS[stateCode] || stateCode;
}

function weeklyAuditStatus(storeNumber, auditLabel, periodKey) {
    const handlers = {
        'Pest Walk': {
            buildPeriod: buildPestPeriodSummary,
            listOpen: listPestOpenAudits,
        },
        'RGM Cleaning Checklist': {
            buildPeriod: buildRgmPeriodSummary,
            listOpen: listRgmOpenAudits,
        },
        'Period Safety Inspection': {
            buildPeriod: buildPsiPeriodSummary,
            listOpen: listPsiOpenAudits,
        },
        'CORE Operations Self Score': {
            buildPeriod: buildCoreOpsPeriodSummary,
            listOpen: listCoreOpsOpenAudits,
        },
        'CORE Food Safety Self Score': {
            buildPeriod: buildCoreFoodSafetyPeriodSummary,
            listOpen: listCoreFoodSafetyOpenAudits,
        },
        'Visiting as a Coach': {
            buildPeriod: buildVisitCoachPeriodSummary,
            listOpen: listVisitCoachOpenAudits,
        },
        'Visiting as a Customer': {
            buildPeriod: buildVisitCustomerPeriodSummary,
            listOpen: listVisitCustomerOpenAudits,
        },
    };
    const handler = handlers[auditLabel];
    if (!handler) return 'notStarted';
    const period = handler.buildPeriod(storeNumber, periodKey);
    if (period?.periodCompleted) return 'completed';
    if (handler.listOpen(storeNumber, { access: ADMIN_ACCESS }).length > 0) return 'inProgress';
    if (period?.inProgress) return 'inProgress';
    return 'notStarted';
}

function squareOneAreaStatus(storeNumber, area, periodKey, squareSlot) {
    const summary = buildAreaSummaries(storeNumber, periodKey, squareSlot).find((row) => row.id === area.id);
    if (summary?.periodCompleted) return 'completed';
    if (summary?.inProgress) return 'inProgress';
    return 'notStarted';
}

function systemStatusFromWeekly(status) {
    if (status === 'completed') return 'complete';
    if (status === 'inProgress') return 'opened';
    return 'blank';
}

function cellFromStatus(status, options = {}) {
    const scoreDisplay = options.scoreDisplay || '';
    if (status === 'complete') {
        return {
            status: 'complete',
            display: scoreDisplay || 'Complete',
            tone: 'green',
            clickable: Boolean(options.clickable !== false),
        };
    }
    if (status === 'opened') {
        return { status: 'opened', display: 'Opened', tone: 'orange', clickable: Boolean(options.clickable !== false) };
    }
    return { status: 'blank', display: '', tone: 'red', clickable: Boolean(options.clickable !== false) };
}

function cellFromActionCount(count) {
    const n = Math.max(0, Number(count) || 0);
    if (n === 0) return { status: 'complete', display: '0', tone: 'green', clickable: true, kind: 'open-actions' };
    if (n >= 10) return { status: 'count', display: String(n), tone: 'red', clickable: true, kind: 'open-actions' };
    return { status: 'count', display: String(n), tone: 'orange', clickable: true, kind: 'open-actions' };
}

function mergeWithOverride(systemStatus, override, rowId, options = {}) {
    const validateComplete = Boolean(options.validateComplete);
    const isPlaceholder = PLACEHOLDER_ROW_IDS.has(rowId);
    if (override) {
        if (
            validateComplete &&
            override === 'complete' &&
            !isPlaceholder &&
            systemStatus !== 'complete'
        ) {
            return systemStatus;
        }
        return override;
    }
    return systemStatus;
}

function normalizeSummaryRowLabels(rows) {
    if (!Array.isArray(rows)) return rows;
    return rows.map((row) => {
        const next = { ...row };
        const byId = ROW_LABEL_BY_ID[row.id];
        if (byId) {
            next.label = byId;
        } else {
            const legacy = String(row.label || '').trim();
            if (/^self\s*core\s*ops$/i.test(legacy)) next.label = ROW_LABEL_BY_ID['core-ops'];
            if (/^self\s*core\s*food\s*safety$/i.test(legacy)) next.label = ROW_LABEL_BY_ID['core-food-safety'];
        }
        if (row.kind === 'group' && Array.isArray(row.children)) {
            next.children = normalizeSummaryRowLabels(row.children);
        }
        return next;
    });
}

function buildRows(schedule) {
    const dueAreas = getDueAreasForSlot(schedule.squareSlot);
    const squareChildren = dueAreas.map((area) => ({
        id: `square-one:${area.id}`,
        label: area.tileLabel || area.dashboardLabel,
        kind: 'square-one',
        areaId: area.id,
        dashboardLabel: area.dashboardLabel,
    }));

    return [
        { id: 'psi', label: 'PSI', kind: 'weekly', auditLabel: 'Period Safety Inspection' },
        { id: 'pest-walk', label: 'PEST', kind: 'weekly', auditLabel: 'Pest Walk' },
        { id: 'dfsc', label: 'DFSC', kind: 'dfsc-count' },
        {
            id: 'open-actions',
            label: 'Open actions',
            kind: 'open-actions',
        },
        {
            id: 'rgm-cleaning',
            label: 'RGM Cleaning Adult',
            kind: 'weekly',
            auditLabel: 'RGM Cleaning Checklist',
        },
        {
            id: 'square-ones',
            label: 'SQUARE ONES',
            kind: 'group',
            children: squareChildren,
        },
        { id: 'core-ops', label: 'Operations', kind: 'weekly', auditLabel: 'CORE Operations Self Score' },
        { id: 'core-food-safety', label: 'Food Safety', kind: 'weekly', auditLabel: 'CORE Food Safety Self Score' },
        { id: 'visit-coach', label: 'Coach visit', kind: 'weekly', auditLabel: 'Visiting as a Coach' },
        { id: 'visit-customer', label: 'Customer visit', kind: 'weekly', auditLabel: 'Visiting as a Customer' },
    ];
}

function flattenRows(rows) {
    const flat = [];
    for (const row of rows) {
        if (row.kind === 'group' && Array.isArray(row.children)) {
            for (const child of row.children) flat.push(child);
        } else {
            flat.push(row);
        }
    }
    return flat;
}

function systemStatusForRow(storeNumber, row, ctx) {
    if (row.kind === 'weekly') {
        return systemStatusFromWeekly(weeklyAuditStatus(storeNumber, row.auditLabel, ctx.periodKey));
    }
    if (row.kind === 'square-one') {
        const area = ctx.dueAreas.find((a) => a.id === row.areaId);
        if (!area) return 'blank';
        return systemStatusFromWeekly(
            squareOneAreaStatus(storeNumber, area, ctx.periodKey, ctx.schedule.squareSlot)
        );
    }
    if (row.kind === 'placeholder') {
        return 'blank';
    }
    return 'blank';
}

function buildCellForRow(storeNumber, row, ctx, overrides) {
    if (row.kind === 'dfsc-count') {
        const dfsc = ctx.dfscWeekCounts?.get(storeNumber);
        return cellFromDfscWeekCount(dfsc ?? { completed: 0, expected: 0, meetsTarget: false });
    }

    const seedKey = `${storeNumber}:${row.id}`;
    const seedValue = ctx.seedCells?.get(seedKey);
    if (seedValue !== undefined) {
        if (row.kind === 'open-actions') return cellFromActionCount(seedValue);
        return cellFromStatus(seedValue);
    }

    if (row.kind === 'open-actions') {
        const count = ctx.openActionCounts.get(storeNumber) ?? 0;
        return cellFromActionCount(count);
    }

    const overrideKey = seedKey;
    const override = overrides.get(overrideKey) || null;
    const systemStatus = systemStatusForRow(storeNumber, row, ctx);
    const merged = mergeWithOverride(systemStatus, override, row.id, {
        validateComplete: Boolean(ctx.validateComplete),
    });
    let scoreDisplay = '';
    if (merged === 'complete' && row.kind === 'weekly' && row.auditLabel) {
        const handler = {
            'CORE Operations Self Score': buildCoreOpsPeriodSummary,
            'CORE Food Safety Self Score': buildCoreFoodSafetyPeriodSummary,
        }[row.auditLabel];
        if (handler) {
            const period = handler(storeNumber, ctx.periodKey);
            const latest = period?.sessions?.find((s) => s.status === 'completed');
            const rating = latest?.score?.rating;
            if (rating) scoreDisplay = rating;
        }
    }
    const clickable = !['core-ops', 'core-food-safety', 'visit-coach', 'visit-customer'].includes(row.id);
    return cellFromStatus(merged, { scoreDisplay, clickable });
}

function buildTacauditAdminSummary(stores, options = {}) {
    const asOf = options.asOf instanceof Date ? options.asOf : options.asOf ? new Date(options.asOf) : new Date();
    const schedule = getAuditSchedule(asOf);
    const periodKey = getDismissalPeriodKey(asOf);
    const dueAreas = getDueAreasForSlot(schedule.squareSlot);
    const periodNumber = schedule.periodNumber ?? schedule.squareSlot + 1;
    const weekInPeriod = schedule.weekInPeriod ?? schedule.psiWeek ?? 1;

    const openActionCounts = new Map();
    for (const store of stores) {
        const num = String(store.storeNumber || '').trim();
        if (!num) continue;
        try {
            openActionCounts.set(num, countOpenActionsForStore(num));
        } catch {
            openActionCounts.set(num, 0);
        }
    }

    const areaName =
        options.areaName ||
        (stores?.length ? getStoreConfig(stores[0].storeNumber)?.area : '') ||
        '';
    const useTrackedStateOnly = Boolean(options.useTrackedStateOnly);
    const overrides = useTrackedStateOnly ? new Map() : getOverridesForArea(areaName);
    const { seed, lookup: seedCells } = buildSeedCellLookup(areaName);
    const opWeek = getCurrentOperationalWeek(asOf);
    const weekStartYmd = parseYmd(options.weekStartYmd || opWeek?.weekStartYmd);
    const weekEndYmd = parseYmd(options.weekEndYmd || opWeek?.weekEndYmd);

    const rows = buildRows(schedule);
    const storeList = (stores || [])
        .map((s) => ({
            storeNumber: String(s.storeNumber || '').trim(),
            storeName: String(s.storeName || s.storeNumber || '').trim(),
            timeZone: s.timeZone || 'Australia/Melbourne',
            state: stateCodeFromTimeZone(s.timeZone),
        }))
        .filter((s) => s.storeNumber)
        .sort((a, b) => a.storeNumber.localeCompare(b.storeNumber, undefined, { numeric: true }));

    const dfscWeekCounts = new Map();
    for (const store of storeList) {
        dfscWeekCounts.set(
            store.storeNumber,
            buildDfscWeekCompliance(store.storeNumber, {
                now: asOf,
                weekStartYmd,
                weekEndYmd,
                historicalWeek: Boolean(options.historicalWeek),
            })
        );
    }
    if (seed?.dfscMarkAllComplete) {
        for (const [storeNumber, entry] of dfscWeekCounts) {
            dfscWeekCounts.set(storeNumber, {
                ...entry,
                completed: entry.expected,
                meetsTarget: entry.expected > 0,
            });
        }
    }

    const ctx = {
        schedule,
        periodKey,
        dueAreas,
        openActionCounts,
        validateComplete: Boolean(options.validateComplete),
        useTrackedStateOnly,
        seedCells,
        dfscWeekCounts,
    };

    const regions = [];
    const byState = new Map();
    for (const store of storeList) {
        const group = byState.get(store.state) || [];
        group.push(store);
        byState.set(store.state, group);
    }
    for (const [state, regionStores] of [...byState.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        regions.push({
            state,
            label: regionLabelForState(state),
            stores: regionStores,
        });
    }

    const cells = {};
    for (const row of flattenRows(rows)) {
        cells[row.id] = {};
        for (const store of storeList) {
            cells[row.id][store.storeNumber] = buildCellForRow(store.storeNumber, row, ctx, overrides);
        }
    }

    return {
        areaName,
        periodLabel: `PERIOD ${periodNumber}`,
        weekLabel: `WEEK ${weekInPeriod}`,
        periodKey,
        schedule: {
            squareSlot: schedule.squareSlot,
            psiWeek: schedule.psiWeek,
            psiWeekTitle: schedule.psiWeekTitle,
            periodNumber,
            weekInPeriod,
            operationalCalendar: schedule.operationalCalendar || null,
        },
        regions,
        rows: normalizeSummaryRowLabels(rows),
        cells,
        seededFromReference: Boolean(seed),
        generatedAt: new Date().toISOString(),
    };
}

function storesForArea(areaName, allStores) {
    const target = String(areaName || '').trim();
    if (!target) return allStores || [];
    return (allStores || []).filter((s) => String(s.area || '').trim() === target);
}

module.exports = {
    buildTacauditAdminSummary,
    flattenRows,
    normalizeSummaryRowLabels,
    storesForArea,
    stateCodeFromTimeZone,
    regionLabelForState,
    systemStatusForRow,
    mergeWithOverride,
};
