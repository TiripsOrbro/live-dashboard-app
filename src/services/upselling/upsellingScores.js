const fs = require('fs');
const path = require('path');
const { loadPointsMap, pointsForColumn, normalizeLabel } = require('./pointsFile');
const {
    normalizeCashierName,
    saveRankedEmployees,
    loadEmployees,
    aggregateRowsFromByDay,
    filterByDayForStoreLeaderboard,
} = require('./employeesFile');
const { parseUpsellReport } = require('./upsellReportParser');
const { upsellingDataDir, resolveUpsellSyncStore, TIME_ZONE } = require('./upsellingConfig');

function melbourneTodayIso() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());
}

function scoreCashierRow(qtyByColumn, byLabel) {
    let mmxPoints = 0;
    const unmapped = [];
    for (const [colName, qty] of Object.entries(qtyByColumn || {})) {
        if (!qty) continue;
        const pts = pointsForColumn(byLabel, colName);
        if (pts == null) {
            unmapped.push(colName);
            continue;
        }
        mmxPoints += qty * pts;
    }
    for (const col of unmapped) {
        console.warn(`[Upselling] Unmapped item column "${col}" — scoring as 0 points`);
    }
    return mmxPoints;
}

function scoreParsedReport(parsed, syncStoreNumber = '') {
    const wantStore = String(syncStoreNumber || resolveUpsellSyncStore() || '').trim();
    const { byLabel } = loadPointsMap(wantStore || undefined);
    const mmxByCashier = new Map();
    const displayNames = new Map();
    const byDay = [];

    for (const row of parsed.cashiers || []) {
        const rowStore = String(row.store || '').trim();
        if (wantStore && rowStore && rowStore !== wantStore) continue;
        const store = wantStore || rowStore;
        if (!store) continue;

        const key = normalizeCashierName(row.name);
        let pts;
        if (row.totalPoints != null && parsed.scoringMode !== 'items') {
            pts = Number(row.totalPoints) || 0;
        } else {
            pts = scoreCashierRow(row.qtyByColumn, byLabel);
        }
        if (!pts) continue;

        const day = String(row.day || '').trim() || melbourneTodayIso();
        byDay.push({
            store,
            name: row.name,
            day,
            points: pts,
        });

        mmxByCashier.set(key, (mmxByCashier.get(key) || 0) + pts);
        if (!displayNames.has(key)) displayNames.set(key, row.name);
    }

    const merged = [];
    for (const [key, mmxPoints] of mmxByCashier.entries()) {
        const name = displayNames.get(key) || key;
        merged.push({
            name,
            mmxPoints,
            bonusPoints: 0,
            total: mmxPoints,
        });
    }

    merged.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    byDay.sort((a, b) => a.day.localeCompare(b.day) || b.points - a.points || a.name.localeCompare(b.name));
    return { ranked: merged, byDay };
}

function writeParseDiagnostics(storeNumber, parsed, extra = {}) {
    const dir = upsellingDataDir(storeNumber);
    fs.mkdirSync(dir, { recursive: true });
    const diagPath = path.join(dir, 'last-parse.json');
    fs.writeFileSync(
        diagPath,
        JSON.stringify(
            {
                at: new Date().toISOString(),
                columnsUsed: parsed.columnsUsed,
                scoringMode: parsed.scoringMode || 'items',
                cashierCount: parsed.cashiers.length,
                ...extra,
            },
            null,
            2
        ),
        'utf8'
    );
}

function warnIfPointsMapAllZero(byLabel, source) {
    let maxPts = 0;
    for (const entry of byLabel.values()) {
        maxPts = Math.max(maxPts, Number(entry?.points) || 0);
    }
    if (maxPts > 0) return;
    console.warn(
        `[Upselling] All item points are 0 in ${source || 'points map'}. ` +
            'Create .points from .points.example with real values, or set points in config/upselling-stores.json.'
    );
}

function processParsedReport(parsed, storeNumber, extra = {}) {
    const { byLabel, source: pointsSource } = loadPointsMap(storeNumber);
    warnIfPointsMapAllZero(byLabel, pointsSource);
    const { ranked, byDay } = scoreParsedReport(parsed, storeNumber);
    const gridSample = (parsed.gridSample || []).slice(0, 20);
    writeParseDiagnostics(storeNumber, parsed, { pointsSource, gridSample, ...extra });
    const { rows: savedRows } = saveRankedEmployees(ranked, byDay, storeNumber);
    return { parsed, ranked: savedRows.length ? savedRows : ranked, byDay };
}

function processReportFile(filePath, storeNumber, options = {}) {
    const syncStore = String(storeNumber || resolveUpsellSyncStore() || '').trim();
    const { byLabel, source: pointsSource } = loadPointsMap(syncStore);
    const filterStoreNumber =
        options.filterStoreNumber !== undefined
            ? String(options.filterStoreNumber || '').trim()
            : syncStore;
    const parsed = parseUpsellReport(filePath, byLabel, {
        filterStoreNumber,
    });
    return processParsedReport(parsed, storeNumber, {
        file: path.basename(filePath),
        pointsSource,
        source: options.source || 'file',
    });
}

function buildLeaderboardPayload(storeNumber) {
    const { byDay, bonusByKey, bonusNames } = loadEmployees();
    const wantStore = String(storeNumber || '').trim();
    const filteredByDay = filterByDayForStoreLeaderboard(byDay, wantStore);
    const keysInStore = new Set(
        filteredByDay.map((r) => normalizeCashierName(r.name)).filter(Boolean)
    );
    const storeBonusByKey = new Map();
    const storeBonusNames = new Map();
    for (const [key, bonus] of bonusByKey.entries()) {
        if (!keysInStore.has(key)) continue;
        storeBonusByKey.set(key, bonus);
        storeBonusNames.set(key, bonusNames.get(key) || key);
    }
    const { rows } = aggregateRowsFromByDay(filteredByDay, storeBonusByKey, storeBonusNames);
    const ranked = rows
        .map((r, i) => ({
            rank: i + 1,
            name: r.name,
            mmxPoints: r.mmxPoints,
            bestDay: r.bestDay || '',
            bonusPoints: r.bonusPoints,
            total: r.total,
        }))
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
        .map((r, i) => ({ ...r, rank: i + 1 }));

    const top7 = ranked.slice(0, 7);
    const top5 = top7.slice(0, 5);
    const top3 = top7.slice(0, 3);
    let lastSyncAt = null;
    let reportDate = null;
    const syncPath = path.join(upsellingDataDir(storeNumber), 'last-sync.json');
    if (fs.existsSync(syncPath)) {
        try {
            const sync = JSON.parse(fs.readFileSync(syncPath, 'utf8'));
            lastSyncAt = sync.lastSyncAt || null;
            reportDate = sync.reportDate || null;
        } catch (_) {
            /* ignore */
        }
    }

    return {
        enabled: true,
        storeNumber: String(storeNumber),
        top7,
        top5,
        top3,
        ranks: ranked,
        byDay: filteredByDay,
        lastSyncAt,
        reportDate,
    };
}

module.exports = {
    scoreCashierRow,
    scoreParsedReport,
    processParsedReport,
    processReportFile,
    buildLeaderboardPayload,
};
