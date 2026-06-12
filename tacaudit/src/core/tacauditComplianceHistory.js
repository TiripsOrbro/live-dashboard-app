const fs = require('fs');
const path = require('path');
const { getStoreList } = require('../../../stores/src/storeList');
const {
    loadAuditRecurrenceConfigSync,
    listOperationalWeeksThroughCurrent,
    getCurrentOperationalWeek,
    instantEndOfOperationalWeek,
} = require('../auditRecurrence');
const {
    buildTacauditAdminSummary,
    normalizeSummaryRowLabels,
    storesForArea,
} = require('./tacauditAdminSummary');
const { applyComplianceSeedToSummary } = require('./tacauditComplianceSeed');

const paths = require('../../../src/paths');
const HISTORY_FILE =
    process.env.TACAUDIT_COMPLIANCE_HISTORY_FILE ||
    path.join(paths.tacaudit.data, 'tacaudit-compliance-history.json');

const SCHEMA_VERSION = 1;

function emptyHistory() {
    return { schemaVersion: SCHEMA_VERSION, snapshots: {} };
}

function readHistory() {
    try {
        if (!fs.existsSync(HISTORY_FILE)) return emptyHistory();
        const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        return {
            schemaVersion: parsed.schemaVersion || SCHEMA_VERSION,
            snapshots: parsed.snapshots && typeof parsed.snapshots === 'object' ? parsed.snapshots : {},
        };
    } catch {
        return emptyHistory();
    }
}

function writeHistory(state) {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function uniqueAreasFromStoreList() {
    return [
        ...new Set(
            getStoreList()
                .map((s) => String(s.area || '').trim())
                .filter(Boolean)
        ),
    ].sort((a, b) => a.localeCompare(b));
}

function allStoresWithAreas() {
    return getStoreList().map((s) => ({
        storeNumber: String(s.storeNumber || '').trim(),
        storeName: String(s.storeName || s.storeNumber || '').trim(),
        area: String(s.area || '').trim(),
        timeZone: s.timeZone || 'Australia/Melbourne',
    }));
}

function snapshotSummaryForStorage(summary) {
    if (!summary || typeof summary !== 'object') return null;
    return {
        areaName: summary.areaName,
        periodLabel: summary.periodLabel,
        weekLabel: summary.weekLabel,
        periodKey: summary.periodKey,
        weekStartYmd: summary.weekStartYmd,
        weekEndYmd: summary.weekEndYmd,
        schedule: summary.schedule,
        regions: summary.regions,
        rows: summary.rows,
        cells: summary.cells,
        capturedAt: summary.capturedAt || new Date().toISOString(),
    };
}

function buildLiveSummaryForWeek(areaName, stores, weekMeta, asOf) {
    const summary = buildTacauditAdminSummary(stores, {
        areaName,
        validateComplete: true,
        useTrackedStateOnly: true,
        asOf,
        weekStartYmd: weekMeta.weekStartYmd,
        weekEndYmd: weekMeta.weekEndYmd,
        historicalWeek: true,
    });
    return {
        ...summary,
        weekStartYmd: weekMeta.weekStartYmd,
        weekEndYmd: weekMeta.weekEndYmd,
        capturedAt: asOf.toISOString(),
    };
}

function captureWeekSnapshot(weekMeta) {
    const cfg = loadAuditRecurrenceConfigSync();
    const timeZone = cfg.timeZone || 'Australia/Melbourne';
    const asOf = instantEndOfOperationalWeek(weekMeta.weekEndYmd, timeZone);
    const allStores = allStoresWithAreas();
    const byArea = {};

    for (const areaName of uniqueAreasFromStoreList()) {
        const stores = storesForArea(areaName, allStores);
        if (!stores.length) continue;
        const summary = buildLiveSummaryForWeek(areaName, stores, weekMeta, asOf);
        byArea[areaName] = snapshotSummaryForStorage(summary);
    }

    const state = readHistory();
    state.snapshots[weekMeta.weekStartYmd] = {
        weekStartYmd: weekMeta.weekStartYmd,
        weekEndYmd: weekMeta.weekEndYmd,
        periodNumber: weekMeta.periodNumber,
        weekInPeriod: weekMeta.weekInPeriod,
        capturedAt: new Date().toISOString(),
        byArea,
    };
    writeHistory(state);
    return state.snapshots[weekMeta.weekStartYmd];
}

function ensureCompletedWeekSnapshotsCaptured() {
    const weeks = listOperationalWeeksThroughCurrent();
    const state = readHistory();
    let changed = false;

    for (const week of weeks) {
        if (week.isCurrent) break;
        if (state.snapshots[week.weekStartYmd]) continue;
        captureWeekSnapshot(week);
        changed = true;
    }

    return changed;
}

function listComplianceWeeks() {
    const weeks = listOperationalWeeksThroughCurrent();
    const state = readHistory();
    return weeks.map((week) => ({
        weekStartYmd: week.weekStartYmd,
        weekEndYmd: week.weekEndYmd,
        periodNumber: week.periodNumber,
        weekInPeriod: week.weekInPeriod,
        label: week.label,
        isCurrent: week.isCurrent,
        hasSnapshot: Boolean(state.snapshots[week.weekStartYmd]),
    }));
}

function getStoredAreaSummary(areaName, weekStartYmd) {
    const key = String(weekStartYmd || '').trim();
    const area = String(areaName || '').trim();
    if (!key || !area) return null;
    const snap = readHistory().snapshots[key];
    if (!snap?.byArea?.[area]) return null;
    const stored = snap.byArea[area];
    const summary = applyComplianceSeedToSummary(
        {
            ...stored,
            rows: normalizeSummaryRowLabels(stored.rows),
            readOnly: true,
            isHistorical: true,
        },
        area,
        { weekStartYmd: key }
    );
    return summary;
}

function resolveComplianceSummary(areaName, stores, weekStartYmd) {
    ensureCompletedWeekSnapshotsCaptured();

    const current = getCurrentOperationalWeek();
    const currentWeekStartYmd = current?.weekStartYmd || '';
    const requested = String(weekStartYmd || '').trim() || currentWeekStartYmd;
    const isCurrentWeek = !requested || requested === currentWeekStartYmd;
    const complianceWeeks = listComplianceWeeks();

    if (!isCurrentWeek) {
        const stored = getStoredAreaSummary(areaName, requested);
        if (!stored) {
            const weekMeta = complianceWeeks.find((w) => w.weekStartYmd === requested);
            return {
                ok: false,
                status: 404,
                error: weekMeta?.hasSnapshot
                    ? 'Compliance snapshot is not available for this area.'
                    : 'No compliance snapshot for this week yet.',
                complianceWeeks,
                complianceMeta: {
                    selectedWeekStartYmd: requested,
                    currentWeekStartYmd,
                    isCurrentWeek: false,
                    readOnly: true,
                },
            };
        }
        return {
            ok: true,
            summary: stored,
            complianceWeeks,
            complianceMeta: {
                selectedWeekStartYmd: requested,
                currentWeekStartYmd,
                isCurrentWeek: false,
                readOnly: true,
            },
        };
    }

    const summary = applyComplianceSeedToSummary(
        buildTacauditAdminSummary(stores, {
            areaName,
            validateComplete: true,
            useTrackedStateOnly: true,
            weekStartYmd: currentWeekStartYmd,
            weekEndYmd: current?.weekEndYmd || '',
        }),
        areaName,
        { weekStartYmd: currentWeekStartYmd }
    );
    return {
        ok: true,
        summary: {
            ...summary,
            weekStartYmd: currentWeekStartYmd,
            weekEndYmd: current?.weekEndYmd || '',
            readOnly: false,
            isHistorical: false,
        },
        complianceWeeks,
        complianceMeta: {
            selectedWeekStartYmd: currentWeekStartYmd,
            currentWeekStartYmd,
            isCurrentWeek: true,
            readOnly: false,
        },
    };
}

module.exports = {
    ensureCompletedWeekSnapshotsCaptured,
    listComplianceWeeks,
    resolveComplianceSummary,
    captureWeekSnapshot,
    readHistory,
};
