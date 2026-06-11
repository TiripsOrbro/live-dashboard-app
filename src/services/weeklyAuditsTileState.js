const { getAuditSchedule } = require('../utils/auditRecurrence');
const { getDueAreasForSlot } = require('./squareOne/squareOneAreas');

/** Core weekly form audits shown as individual MIC tiles (matches dashboard List of Audits). */
const WEEKLY_AUDIT_TILE_LABELS = [
    'Pest Walk',
    'RGM Cleaning Checklist',
    'Period Safety Inspection',
];

const WEEKLY_AUDIT_ROUTES = {
    'Pest Walk': (store) => `/${store}/pest-walk`,
    'RGM Cleaning Checklist': (store) => `/${store}/rgm-cleaning`,
    'Period Safety Inspection': (store) => `/${store}/psi`,
};

function weeklyAuditTileLabel(label) {
    const text = String(label || '').trim();
    if (text === 'RGM Cleaning Checklist') return 'RGM cleaning';
    if (text === 'Period Safety Inspection') return 'PSI';
    return text;
}

function buildWeeklyAuditTiles(storeNumber, dismissedSet) {
    const store = String(storeNumber || '').trim();
    return WEEKLY_AUDIT_TILE_LABELS.map((label) => {
        const done = dismissedSet.has(label);
        const href = store && WEEKLY_AUDIT_ROUTES[label] ? WEEKLY_AUDIT_ROUTES[label](store) : '';
        return {
            label,
            tileLabel: weeklyAuditTileLabel(label),
            done,
            due: !done,
            href: href || null,
            sub: done ? 'Complete' : 'Due this week',
        };
    });
}

/**
 * Weekly audit checklist tile state for MIC (matches dashboard “List of Audits”).
 */
function buildSquareOneTiles(storeNumber, { dismissed = [] } = {}) {
    const store = String(storeNumber || '').trim();
    const dismissedSet = new Set(
        (Array.isArray(dismissed) ? dismissed : []).map((label) => String(label || '').trim()).filter(Boolean)
    );
    const schedule = getAuditSchedule();
    const dueAreas = getDueAreasForSlot(schedule.squareSlot);
    return dueAreas.map((area) => {
        const done = dismissedSet.has(area.dashboardLabel);
        return {
            label: area.dashboardLabel,
            tileLabel: area.tileLabel,
            areaId: area.id,
            done,
            due: !done,
            href: store ? `/${store}/square-one?area=${encodeURIComponent(area.id)}` : null,
            sub: done ? 'Complete' : 'Due this week',
            kind: 'square-one',
        };
    });
}

function buildWeeklyAuditsTileState(storeNumber, { dismissed = [], requiredAudits = [] } = {}) {
    const store = String(storeNumber || '').trim();
    const dismissedSet = new Set(
        (Array.isArray(dismissed) ? dismissed : []).map((label) => String(label || '').trim()).filter(Boolean)
    );
    const required = Array.isArray(requiredAudits) ? requiredAudits : [];
    const outstanding = required.filter((label) => !dismissedSet.has(String(label || '').trim()));
    const outstandingCount = outstanding.length;
    const active = outstandingCount > 0;

    return {
        active,
        outstandingCount,
        outstandingAudits: outstanding,
        auditTiles: buildWeeklyAuditTiles(store, dismissedSet),
        href: store ? `/${store}` : null,
        message: active
            ? `${outstandingCount} audit${outstandingCount === 1 ? '' : 's'} due this week`
            : 'All weekly audits complete',
    };
}

function buildStoresNeedingAudits(areaGroups, auditStateByStore, requiredAudits, { ensureAllAreaGroups } = {}) {
    const required = Array.isArray(requiredAudits) ? requiredAudits : [];
    const stateMap = auditStateByStore instanceof Map ? auditStateByStore : new Map();
    const groups = typeof ensureAllAreaGroups === 'function' ? ensureAllAreaGroups(areaGroups) : areaGroups || [];
    const seen = new Set();
    const entries = [];

    for (const group of groups) {
        for (const cfg of group.stores || []) {
            const storeNumber = String(cfg.storeNumber || '').trim();
            if (!storeNumber || seen.has(storeNumber)) continue;
            seen.add(storeNumber);
            const dismissed = stateMap.get(storeNumber)?.dismissed || [];
            const tile = buildWeeklyAuditsTileState(storeNumber, { dismissed, requiredAudits: required });
            if (!tile.active) continue;
            entries.push({
                storeNumber,
                storeName: String(cfg.storeName || storeNumber).trim(),
                areaKey: group.key || group.areaKey,
                areaName: group.name,
                href: `/Admin/${storeNumber}`,
                outstandingCount: tile.outstandingCount,
                message: tile.message,
            });
        }
    }

    return entries.sort((a, b) =>
        String(a.storeNumber).localeCompare(String(b.storeNumber), undefined, { numeric: true })
    );
}

module.exports = {
    buildWeeklyAuditsTileState,
    buildSquareOneTiles,
    buildStoresNeedingAudits,
    WEEKLY_AUDIT_TILE_LABELS,
    weeklyAuditTileLabel,
};
