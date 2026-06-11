const { getAuditSchedule, getDismissalPeriodKey } = require('../utils/auditRecurrence');
const { getDueAreasForSlot } = require('./squareOne/squareOneAreas');
const { listOpenAudits: listSquareOneOpenAudits, buildAreaSummaries } = require('./squareOne/squareOneStore');
const { buildPeriodSummary: buildPestPeriodSummary, listOpenAudits: listPestOpenAudits } = require('./pestWalk/pestWalkStore');
const { buildPeriodSummary: buildRgmPeriodSummary, listOpenAudits: listRgmOpenAudits } = require('./rgmCleaning/rgmCleaningStore');
const { buildPeriodSummary: buildPsiPeriodSummary, listOpenAudits: listPsiOpenAudits } = require('./periodicSafety/psiStore');
const { weeklyAuditTileLabel, WEEKLY_AUDIT_TILE_LABELS } = require('./weeklyAuditsTileState');

const ADMIN_ACCESS = { isAdmin: true, canAccessDfsc: true };

const WEEKLY_AUDIT_HANDLERS = {
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

function emptyStats() {
    return { notStarted: 0, inProgress: 0, completed: 0 };
}

function bumpStats(stats, status) {
    if (status === 'completed') stats.completed += 1;
    else if (status === 'inProgress') stats.inProgress += 1;
    else stats.notStarted += 1;
}

function formatAdminAuditSub(stats) {
    const notStarted = Number(stats.notStarted) || 0;
    const inProgress = Number(stats.inProgress) || 0;
    const complete = Number(stats.completed) || 0;
    return [
        `${notStarted} store${notStarted === 1 ? '' : 's'} not started`,
        `${inProgress} store${inProgress === 1 ? '' : 's'} in progress`,
        `${complete} store${complete === 1 ? '' : 's'} complete`,
    ].join(' · ');
}

function dismissedSetForStore(auditStateByStore, storeNumber) {
    const raw = auditStateByStore?.get?.(storeNumber)?.dismissed;
    return new Set(
        (Array.isArray(raw) ? raw : []).map((label) => String(label || '').trim()).filter(Boolean)
    );
}

function classifySquareOneArea(storeNumber, area, dismissedSet, periodKey, squareSlot) {
    if (dismissedSet.has(area.dashboardLabel)) return 'completed';
    const areaSummaries = buildAreaSummaries(storeNumber, periodKey, squareSlot);
    const summary = areaSummaries.find((row) => row.id === area.id);
    if (summary?.periodCompleted) return 'completed';
    if (summary?.inProgress) return 'inProgress';
    const open = listSquareOneOpenAudits(storeNumber, { access: ADMIN_ACCESS }).filter(
        (row) => row.areaId === area.id
    );
    if (open.length) return 'inProgress';
    return 'notStarted';
}

function classifyWeeklyAudit(storeNumber, label, dismissedSet, periodKey) {
    if (dismissedSet.has(label)) return 'completed';
    const handler = WEEKLY_AUDIT_HANDLERS[label];
    if (!handler) return 'notStarted';
    const period = handler.buildPeriod(storeNumber, periodKey);
    if (period?.periodCompleted) return 'completed';
    if (handler.listOpen(storeNumber, { access: ADMIN_ACCESS }).length > 0) return 'inProgress';
    if (period?.inProgress) return 'inProgress';
    return 'notStarted';
}

function buildAdminAuditTileSummaries(storeConfigs, auditStateByStore, options = {}) {
    const schedule = getAuditSchedule();
    const periodKey = getDismissalPeriodKey();
    const squareSlot = schedule.squareSlot;
    const required = Array.isArray(options.requiredAudits) ? options.requiredAudits : schedule.auditListItems;
    const dueSquareAreas = getDueAreasForSlot(squareSlot);
    const storeNumbers = (storeConfigs || [])
        .map((cfg) => String(cfg.storeNumber || '').trim())
        .filter(Boolean);

    const tiles = [];

    for (const area of dueSquareAreas) {
        const stats = emptyStats();
        for (const storeNumber of storeNumbers) {
            const dismissed = dismissedSetForStore(auditStateByStore, storeNumber);
            bumpStats(stats, classifySquareOneArea(storeNumber, area, dismissed, periodKey, squareSlot));
        }
        tiles.push({
            label: area.dashboardLabel,
            tileLabel: area.tileLabel,
            kind: 'square-one',
            areaId: area.id,
            stats,
            sub: formatAdminAuditSub(stats),
            done: stats.notStarted === 0 && stats.inProgress === 0,
        });
    }

    for (const label of WEEKLY_AUDIT_TILE_LABELS) {
        if (!required.includes(label)) continue;
        const stats = emptyStats();
        for (const storeNumber of storeNumbers) {
            const dismissed = dismissedSetForStore(auditStateByStore, storeNumber);
            bumpStats(stats, classifyWeeklyAudit(storeNumber, label, dismissed, periodKey));
        }
        tiles.push({
            label,
            tileLabel: weeklyAuditTileLabel(label),
            kind: 'weekly',
            stats,
            sub: formatAdminAuditSub(stats),
            done: stats.notStarted === 0 && stats.inProgress === 0,
        });
    }

    return tiles;
}

function mergeAdminAuditTileSummaries(summaryLists) {
    const byKey = new Map();
    for (const list of summaryLists || []) {
        for (const tile of list || []) {
            const key = `${tile.kind || 'weekly'}\0${tile.label}`;
            const existing = byKey.get(key);
            if (!existing) {
                byKey.set(key, {
                    ...tile,
                    stats: { ...tile.stats },
                });
                continue;
            }
            existing.stats.notStarted += tile.stats.notStarted;
            existing.stats.inProgress += tile.stats.inProgress;
            existing.stats.completed += tile.stats.completed;
            existing.done = existing.stats.notStarted === 0 && existing.stats.inProgress === 0;
            existing.sub = formatAdminAuditSub(existing.stats);
        }
    }
    return [...byKey.values()];
}

module.exports = {
    buildAdminAuditTileSummaries,
    mergeAdminAuditTileSummaries,
    formatAdminAuditSub,
};
