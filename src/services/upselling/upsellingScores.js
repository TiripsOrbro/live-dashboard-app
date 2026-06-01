const fs = require('fs');
const path = require('path');
const { loadPointsMap, pointsForColumn, normalizeLabel } = require('./pointsFile');
const { normalizeCashierName, saveRankedEmployees, loadEmployees } = require('./employeesFile');
const { parseUpsellReport } = require('./upsellReportParser');
const { upsellingDataDir } = require('./upsellingConfig');

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

function scoreParsedReport(parsed) {
    const { byLabel } = loadPointsMap();
    const mmxByCashier = new Map();
    const displayNames = new Map();
    const byDay = [];

    for (const row of parsed.cashiers || []) {
        const key = normalizeCashierName(row.name);
        let pts;
        if (row.totalPoints != null && parsed.scoringMode !== 'items') {
            pts = Number(row.totalPoints) || 0;
        } else {
            pts = scoreCashierRow(row.qtyByColumn, byLabel);
        }
        mmxByCashier.set(key, (mmxByCashier.get(key) || 0) + pts);
        if (!displayNames.has(key)) displayNames.set(key, row.name);
        byDay.push({
            name: row.name,
            day: row.day || '',
            points: pts,
        });
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

function processParsedReport(parsed, storeNumber, extra = {}) {
    const { source: pointsSource } = loadPointsMap();
    const { ranked, byDay } = scoreParsedReport(parsed);
    const gridSample = (parsed.gridSample || []).slice(0, 20);
    writeParseDiagnostics(storeNumber, parsed, { pointsSource, gridSample, ...extra });
    const { rows: savedRows } = saveRankedEmployees(ranked, byDay);
    return { parsed, ranked: savedRows.length ? savedRows : ranked, byDay };
}

function processReportFile(filePath, storeNumber) {
    const { byLabel, source: pointsSource } = loadPointsMap();
    const parsed = parseUpsellReport(filePath, byLabel);
    return processParsedReport(parsed, storeNumber, {
        file: path.basename(filePath),
        pointsSource,
    });
}

function buildLeaderboardPayload(storeNumber) {
    const { rows, byDay } = loadEmployees();
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

    const top5 = ranked.slice(0, 5);
    const top3 = top5.slice(0, 3);
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
        top5,
        top3,
        ranks: ranked,
        byDay,
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
