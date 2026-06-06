const fs = require('fs');
const path = require('path');
const { loadPointsMap, loadPointsMapForParsing, pointsForColumn, normalizeLabel } = require('./pointsFile');
const {
    mergeSyncScores,
    aggregateLeaderboard,
    loadScores,
    melbourneTodayIso,
} = require('./leaderboardStore');
const { saveUnassignedForReview } = require('./unassignedStore');
const { parseUpsellReport } = require('./upsellReportParser');
const {
    upsellingLastParsePath,
    upsellingLastSyncPath,
    resolveUpsellSyncStore,
    resolveUpsellSyncDay,
    resolveUpsellSyncDayForRun,
    loadUpsellingConfig,
    maybeMarkBackfillComplete,
    isUpsellingMmxSyncStore,
    TIME_ZONE,
} = require('./upsellingConfig');
const { resolveEnabledStores, isUpsellingEnabledForStore } = require('./storeUpsellingConfig');
const { normalizeStoreKey } = require('../testStore');
const { getDailyItemMultipliers } = require('../mic/micStore');

// Guardrail: item quantities in Upsell by Cashier should be small counts, not long ID-like numbers.
const MAX_REASONABLE_ITEM_QTY = Number(process.env.UPSELL_MAX_ITEM_QTY || 500);

function normalizeLeaderboardStoreNumber(value) {
    return String(value || '')
        .trim()
        .replace(/[^0-9]/g, '');
}

function aggregateItemQtyForStore(parsed, storeNumber, syncDay) {
    const want = normalizeLeaderboardStoreNumber(storeNumber);
    const day = String(syncDay || melbourneTodayIso()).trim() || melbourneTodayIso();
    const totals = {};
    for (const row of parsed.cashiers || []) {
        if (String(row.day || '').trim() !== day) continue;
        if (normalizeLeaderboardStoreNumber(row.store) !== want) continue;
        for (const [item, qty] of Object.entries(row.qtyByColumn || {})) {
            const n = Number(qty) || 0;
            if (!n || Math.abs(n) > MAX_REASONABLE_ITEM_QTY) continue;
            totals[item] = (totals[item] || 0) + n;
        }
    }
    return totals;
}

function scoreCashierRow(qtyByColumn, byLabel, options = {}) {
    const micRules = options.micRules || [];
    let mmxPoints = 0;
    const unmapped = [];
    const skippedHuge = [];
    for (const [colName, qty] of Object.entries(qtyByColumn || {})) {
        if (!qty) continue;
        const qtyNum = Number(qty);
        if (!Number.isFinite(qtyNum)) continue;
        if (Math.abs(qtyNum) > MAX_REASONABLE_ITEM_QTY) {
            skippedHuge.push(`${colName}=${qtyNum}`);
            continue;
        }
        let pts = pointsForColumn(byLabel, colName);
        if (pts == null) {
            unmapped.push(colName);
            continue;
        }
        if (micRules.length) {
            const colKey = normalizeLabel(colName);
            let best = pts;
            for (const rule of micRules) {
                if (normalizeLabel(rule.itemLabel) !== colKey) continue;
                const base = Number.isFinite(Number(rule.basePoints)) ? Number(rule.basePoints) : pts;
                const mult = Number(rule.multiplier) || 3;
                best = Math.max(best, base * mult);
            }
            pts = best;
        }
        mmxPoints += qtyNum * pts;
    }
    for (const col of unmapped) {
        console.warn(`[Upselling] Unmapped item column "${col}" — scoring as 0 points`);
    }
    if (skippedHuge.length) {
        console.warn(
            `[Upselling] Skipped ${skippedHuge.length} implausible qty value(s): ${skippedHuge.slice(0, 5).join(', ')}${skippedHuge.length > 5 ? ' ...' : ''}`
        );
    }
    return mmxPoints;
}

function scoreParsedReport(parsed, syncStoreNumber = '', options = {}) {
    const wantStore = String(syncStoreNumber || resolveUpsellSyncStore() || '').trim();
    const syncDay = options.syncDay || null;
    const { byLabel } = loadPointsMap(wantStore || undefined);
    const mmxByCashier = new Map();
    const displayNames = new Map();
    const byDay = [];
    const micByDay = new Map();

    function micRulesForDay(day) {
        const key = String(day || '').trim() || melbourneTodayIso();
        if (!wantStore) return [];
        if (!micByDay.has(key)) {
            micByDay.set(key, getDailyItemMultipliers(wantStore, key));
        }
        return micByDay.get(key);
    }

    for (const row of parsed.cashiers || []) {
        if (syncDay && String(row.day || '').trim() !== syncDay) continue;
        const rowStore = normalizeLeaderboardStoreNumber(row.store);
        if (wantStore) {
            const want = normalizeLeaderboardStoreNumber(wantStore);
            if (!rowStore || rowStore !== want) continue;
        } else if (!rowStore) {
            continue;
        }
        const store = rowStore;

        const key = String(row.name || '')
            .trim()
            .replace(/\s+/g, ' ')
            .toLowerCase();
        let pts;
        if (row.totalPoints != null && parsed.scoringMode !== 'items') {
            pts = Number(row.totalPoints) || 0;
        } else {
            pts = scoreCashierRow(row.qtyByColumn, byLabel, {
                micRules: micRulesForDay(String(row.day || '').trim() || melbourneTodayIso()),
            });
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

function writeParseDiagnostics(parsed, extra = {}) {
    fs.mkdirSync(path.dirname(upsellingLastParsePath()), { recursive: true });
    fs.writeFileSync(
        upsellingLastParsePath(),
        JSON.stringify(
            {
                at: new Date().toISOString(),
                columnsUsed: parsed.columnsUsed,
                scoringMode: parsed.scoringMode || 'items',
                cashierCount: parsed.cashiers.length,
                storesSeen: uniqueStoreNumbersFromParsed(parsed),
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

function normalizeLeaderboardStoreNumber(store) {
    return normalizeStoreKey(store) || String(store || '').trim();
}

function uniqueStoreNumbersFromParsed(parsed) {
    const stores = new Set();
    for (const row of parsed.cashiers || []) {
        const store = normalizeLeaderboardStoreNumber(row.store);
        if (store) stores.add(store);
    }
    return [...stores].sort();
}

function writeRegionalParseDiagnostics(parsed, extra = {}) {
    writeParseDiagnostics(parsed, extra);
}

function scoreAndMergeStore(parsed, storeNumber, options = {}) {
    const store = normalizeLeaderboardStoreNumber(storeNumber);
    const { byLabel, source: pointsSource } = loadPointsMap(store);
    warnIfPointsMapAllZero(byLabel, pointsSource);
    const { ranked, byDay } = scoreParsedReport(parsed, store, {
        syncDay: options.syncDay || null,
    });
    writeParseDiagnostics(parsed, {
        storeNumber: store,
        pointsSource,
        syncDay: options.syncDay || null,
        ...options,
    });
    const { rows: savedRows } = mergeSyncScores(store, byDay, {
        replaceDays: options.syncDay ? [options.syncDay] : undefined,
    });
    return {
        storeNumber: store,
        ranked: savedRows.length ? savedRows : ranked,
        byDay,
        top3: (savedRows.length ? savedRows : ranked).slice(0, 3),
    };
}

function scoreAllStoresFromParsed(parsed, options = {}) {
    const syncDay =
        options.syncDay !== undefined
            ? options.syncDay || null
            : resolveUpsellSyncDayForRun(loadUpsellingConfig(), options);
    const onlyEnabled = options.onlyEnabled !== false;

    writeRegionalParseDiagnostics(parsed, {
        pointsSource: options.pointsSource || null,
        source: options.source || 'parsed',
        syncDay: syncDay || null,
        unassignedCount: (parsed.unassigned || []).length,
    });

    let unassigned = parsed.unassigned || [];
    if (syncDay) {
        unassigned = unassigned.filter((row) => !row.day || row.day === syncDay);
    }
    saveUnassignedForReview(unassigned, {
        source: options.source || 'parsed',
        exportFile: options.file || null,
        syncDay: syncDay || null,
    });

    let storeNumbers = resolveEnabledStores(loadUpsellingConfig())
        .map(normalizeLeaderboardStoreNumber)
        .filter((store) => isUpsellingMmxSyncStore(store));
    if (!onlyEnabled) {
        storeNumbers = uniqueStoreNumbersFromParsed(parsed);
    }

    const results = {};
    for (const store of storeNumbers) {
        results[store] = scoreAndMergeStore(parsed, store, {
            syncDay: syncDay || null,
            source: options.source || 'parsed',
            pointsSource: options.pointsSource || null,
        });
        const top = results[store].top3[0];
        console.log(
            `[Upselling] Store ${store}: ${results[store].byDay.length} cashier-day row(s)` +
                (top ? ` — leader ${top.name} (${top.total} pts on ${top.bestDay || syncDay || '?'})` : '')
        );
    }

    const skipped = uniqueStoreNumbersFromParsed(parsed).filter(
        (store) => !storeNumbers.includes(store)
    );
    if (skipped.length) {
        console.log(
            `[Upselling] Skipped ${skipped.length} store(s) not enabled in config: ${skipped.join(', ')}`
        );
    }

    const storesInExport = uniqueStoreNumbersFromParsed(parsed);
    if (storeNumbers.length > 1 && storesInExport.length <= 1) {
        const missing = storeNumbers.filter((s) => !storesInExport.includes(s));
        console.warn(
            `[Upselling] CSV only has data for: ${storesInExport.join(', ') || '(none)'}. ` +
                `${missing.length} other enabled store(s) got 0 new row(s) today: ${missing.join(', ')}. ` +
                'The BI export is not regional — in MMX add Entity (all sites) to Upsell by Cashier, or export the wide grid with a store row above each item column (see data/upselling/sample-multi-store.csv).'
        );
    }

    return { parsed, stores: results, storeNumbers, skipped, syncDay, storesInExport };
}

/**
 * Parse one regional MMX export (Entity column per row) and score every store found.
 * Only merges scores for stores enabled in config/upselling-stores.json unless onlyEnabled=false.
 */
function processMultiStoreReportFile(filePath, options = {}) {
    const syncDay =
        Object.prototype.hasOwnProperty.call(options, 'syncDay')
            ? options.syncDay || null
            : resolveUpsellSyncDayForRun(loadUpsellingConfig(), options);
    const { byLabel, source: pointsSource } = loadPointsMapForParsing();
    if (syncDay) {
        console.log(`[Upselling] Scoring fiscal day ${syncDay} for all stores in export`);
    } else {
        console.log('[Upselling] Scoring all fiscal days for all stores in export');
    }

    const parsed = parseUpsellReport(filePath, byLabel, {
        filterStoreNumber: '',
        syncDay: syncDay || undefined,
    });

    return scoreAllStoresFromParsed(parsed, {
        ...options,
        syncDay,
        pointsSource,
        file: path.basename(filePath),
        source: options.source || 'file',
    });
}

function processParsedReport(parsed, storeNumber, extra = {}) {
    const { byLabel, source: pointsSource } = loadPointsMap(storeNumber);
    warnIfPointsMapAllZero(byLabel, pointsSource);
    const { ranked, byDay } = scoreParsedReport(parsed, storeNumber, {
        syncDay: extra.syncDay || null,
    });
    saveUnassignedForReview(parsed.unassigned || [], {
        source: extra.source || 'parsed',
        syncDay: extra.syncDay || null,
    });
    const gridSample = (parsed.gridSample || []).slice(0, 20);
    writeParseDiagnostics(parsed, {
        storeNumber,
        pointsSource,
        gridSample,
        syncDay: extra.syncDay || null,
        ...extra,
    });
    const syncDay = String(extra.syncDay || melbourneTodayIso()).trim() || melbourneTodayIso();
    const itemQty = aggregateItemQtyForStore(parsed, storeNumber, syncDay);
    const { rows: savedRows } = mergeSyncScores(storeNumber, byDay, {
        replaceDays: extra.syncDay ? [extra.syncDay] : undefined,
        itemQtyByDay: Object.keys(itemQty).length ? { [syncDay]: itemQty } : undefined,
    });
    return { parsed, ranked: savedRows.length ? savedRows : ranked, byDay };
}

function processReportFile(filePath, storeNumber, options = {}) {
    if (options.allStores) {
        return processMultiStoreReportFile(filePath, options);
    }

    const syncStore = String(storeNumber || resolveUpsellSyncStore() || '').trim();
    const { byLabel, source: pointsSource } = loadPointsMap(syncStore);
    const filterStoreNumber =
        options.filterStoreNumber !== undefined
            ? String(options.filterStoreNumber || '').trim()
            : syncStore;
    const syncDay =
        Object.prototype.hasOwnProperty.call(options, 'syncDay')
            ? options.syncDay || null
            : resolveUpsellSyncDayForRun(loadUpsellingConfig(), options);
    if (syncDay) {
        console.log(`[Upselling] Scoring fiscal day ${syncDay} only (store ${syncStore})`);
    }
    const parsed = parseUpsellReport(filePath, byLabel, {
        filterStoreNumber,
        syncDay: syncDay || undefined,
    });
    return processParsedReport(parsed, storeNumber, {
        file: path.basename(filePath),
        pointsSource,
        source: options.source || 'file',
        syncDay: syncDay || null,
    });
}

function buildLeaderboardPayload(storeNumber) {
    const wantStore = String(storeNumber || '').trim();
    const { rows, byDay, period, weekStart, weekEnd } = aggregateLeaderboard(wantStore, {
        period: 'week',
    });
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
    const scores = loadScores(wantStore);
    let lastSyncAt = scores.lastSyncAt || null;
    let reportDate = null;
    if (fs.existsSync(upsellingLastSyncPath())) {
        try {
            const sync = JSON.parse(fs.readFileSync(upsellingLastSyncPath(), 'utf8'));
            if (!lastSyncAt) lastSyncAt = sync.lastSyncAt || null;
            reportDate = sync.reportDate || null;
        } catch (_) {
            /* ignore */
        }
    }

    const leaderboardDay = melbourneTodayIso();

    return {
        enabled: true,
        storeNumber: wantStore,
        top7,
        top5,
        top3,
        ranks: ranked,
        byDay,
        lastSyncAt,
        reportDate: reportDate || leaderboardDay,
        leaderboardDay,
        leaderboardPeriod: period || 'weekBestDay',
        weekStart: weekStart || null,
        weekEnd: weekEnd || null,
    };
}

module.exports = {
    scoreCashierRow,
    scoreParsedReport,
    processParsedReport,
    processReportFile,
    processMultiStoreReportFile,
    scoreAllStoresFromParsed,
    buildLeaderboardPayload,
};
