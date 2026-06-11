const { getStoreList, getStoreConfig } = require('../storeList');
const { getAuditSchedule, getDismissalPeriodKey } = require('../../utils/auditRecurrence');
const { getDueAreasForSlot } = require('../squareOne/squareOneAreas');
const { buildAreaSummaries } = require('../squareOne/squareOneStore');
const { buildPeriodSummary: buildPestPeriodSummary, listOpenAudits: listPestOpenAudits } = require('../pestWalk/pestWalkStore');
const { buildPeriodSummary: buildRgmPeriodSummary, listOpenAudits: listRgmOpenAudits } = require('../rgmCleaning/rgmCleaningStore');
const { buildPeriodSummary: buildPsiPeriodSummary, listOpenAudits: listPsiOpenAudits } = require('../periodicSafety/psiStore');
const { buildCoreReportData } = require('../dfsc/dfscStore');

const ADMIN_ACCESS = { isAdmin: true, canAccessDfsc: true };

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

function dismissedSetForStore(auditStateByStore, storeNumber) {
    const raw = auditStateByStore?.get?.(storeNumber)?.dismissed;
    return new Set(
        (Array.isArray(raw) ? raw : []).map((label) => String(label || '').trim()).filter(Boolean)
    );
}

function weeklyAuditStatus(storeNumber, auditLabel, dismissedSet, periodKey) {
    if (dismissedSet.has(auditLabel)) return 'completed';
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
    };
    const handler = handlers[auditLabel];
    if (!handler) return 'notStarted';
    const period = handler.buildPeriod(storeNumber, periodKey);
    if (period?.periodCompleted) return 'completed';
    if (handler.listOpen(storeNumber, { access: ADMIN_ACCESS }).length > 0) return 'inProgress';
    if (period?.inProgress) return 'inProgress';
    return 'notStarted';
}

function squareOneAreaStatus(storeNumber, area, dismissedSet, periodKey, squareSlot) {
    if (dismissedSet.has(area.dashboardLabel)) return 'completed';
    const summary = buildAreaSummaries(storeNumber, periodKey, squareSlot).find((row) => row.id === area.id);
    if (summary?.periodCompleted) return 'completed';
    if (summary?.inProgress) return 'inProgress';
    return 'notStarted';
}

function cellFromWeeklyStatus(status) {
    if (status === 'completed') {
        return { status: 'complete', display: 'Complete', tone: 'green' };
    }
    if (status === 'inProgress') {
        return { status: 'opened', display: 'Opened', tone: 'orange' };
    }
    return { status: 'notStarted', display: '', tone: 'red' };
}

function cellFromActionCount(count) {
    const n = Math.max(0, Number(count) || 0);
    if (n === 0) return { status: 'complete', display: '0', tone: 'green' };
    if (n >= 10) return { status: 'count', display: String(n), tone: 'red' };
    return { status: 'count', display: String(n), tone: 'orange' };
}

function cellFromPlaceholder() {
    return { status: 'unavailable', display: '', tone: 'red' };
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
        {
            id: 'safety-culture-actions',
            label: 'Open safety culture action items',
            kind: 'safety-actions',
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
        { id: 'core-ops', label: 'Self CORE OPS', kind: 'placeholder' },
        { id: 'core-food-safety', label: 'SELF CORE FOOD SAFETY', kind: 'placeholder' },
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

function buildCellForRow(storeNumber, row, ctx) {
    const dismissed = dismissedSetForStore(ctx.auditStateByStore, storeNumber);
    if (row.kind === 'weekly') {
        return cellFromWeeklyStatus(
            storeNumber,
            row.auditLabel,
            dismissed,
            ctx.periodKey
        );
    }
    if (row.kind === 'square-one') {
        const area = ctx.dueAreas.find((a) => a.id === row.areaId);
        if (!area) return cellFromPlaceholder();
        return cellFromWeeklyStatus(
            squareOneAreaStatus(storeNumber, area, dismissed, ctx.periodKey, ctx.schedule.squareSlot)
        );
    }
    if (row.kind === 'safety-actions') {
        const count = ctx.openActionCounts.get(storeNumber) ?? 0;
        return cellFromActionCount(count);
    }
    if (row.kind === 'placeholder') {
        return cellFromPlaceholder();
    }
    return cellFromPlaceholder();
}

function buildTacauditAdminSummary(stores, auditStateByStore, options = {}) {
    const schedule = getAuditSchedule();
    const periodKey = getDismissalPeriodKey();
    const dueAreas = getDueAreasForSlot(schedule.squareSlot);
    const weekNumber = dueAreas[0]?.week || schedule.psiWeek || 1;

    const openActionCounts = new Map();
    for (const store of stores) {
        const num = String(store.storeNumber || '').trim();
        if (!num) continue;
        try {
            const report = buildCoreReportData(num, { days: 45 });
            openActionCounts.set(num, Number(report?.totals?.openActions) || 0);
        } catch {
            openActionCounts.set(num, 0);
        }
    }

    const ctx = {
        schedule,
        periodKey,
        dueAreas,
        auditStateByStore,
        openActionCounts,
    };

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
            cells[row.id][store.storeNumber] = buildCellForRow(store.storeNumber, row, ctx);
        }
    }

    const areaName =
        options.areaName ||
        (storeList.length ? getStoreConfig(storeList[0].storeNumber)?.area : '') ||
        '';

    return {
        areaName,
        periodLabel: `PERIOD ${schedule.squareSlot + 1}`,
        weekLabel: `WEEK ${weekNumber}`,
        periodKey,
        schedule: {
            squareSlot: schedule.squareSlot,
            psiWeek: schedule.psiWeek,
            psiWeekTitle: schedule.psiWeekTitle,
        },
        regions,
        rows,
        cells,
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
    storesForArea,
    stateCodeFromTimeZone,
    regionLabelForState,
};
