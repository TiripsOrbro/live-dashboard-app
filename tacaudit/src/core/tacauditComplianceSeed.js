const fs = require('fs');
const path = require('path');
const { getCurrentOperationalWeek } = require('../auditRecurrence');

const paths = require('../../../src/paths');
const SEED_FILE =
    process.env.TACAUDIT_COMPLIANCE_SEED_FILE || path.join(paths.tacaudit.data, 'tacaudit-compliance-seed.json');

function readSeedFile() {
    try {
        if (!fs.existsSync(SEED_FILE)) return null;
        return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    } catch {
        return null;
    }
}

function areaKey(areaName) {
    return String(areaName || '').trim();
}

function activeComplianceSeed(areaName, weekStartYmd) {
    const seed = readSeedFile();
    if (!seed?.enabled) return null;
    if (areaKey(seed.areaName) !== areaKey(areaName)) return null;
    if (seed.weekStartYmd) {
        const currentWeekStart =
            String(weekStartYmd || '').trim() || getCurrentOperationalWeek()?.weekStartYmd || '';
        if (currentWeekStart !== seed.weekStartYmd) return null;
    }
    return seed;
}

function normalizeSeedValue(value) {
    if (value === null || value === undefined) return 'blank';
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const status = String(value).trim().toLowerCase();
    if (status === 'complete' || status === 'opened' || status === 'blank') return status;
    if (status === '' || status === 'red' || status === 'empty') return 'blank';
    return null;
}

function buildSeedCellLookup(areaName, weekStartYmd) {
    const seed = activeComplianceSeed(areaName, weekStartYmd);
    const lookup = new Map();
    if (!seed?.cells || typeof seed.cells !== 'object') {
        return { seed: null, lookup };
    }

    for (const [storeNumber, rows] of Object.entries(seed.cells)) {
        const store = String(storeNumber || '').trim();
        if (!store || !rows || typeof rows !== 'object') continue;
        for (const [rowId, value] of Object.entries(rows)) {
            const row = String(rowId || '').trim();
            const normalized = normalizeSeedValue(value);
            if (!row || normalized === null) continue;
            lookup.set(`${store}:${row}`, normalized);
        }
    }

    return { seed, lookup };
}

function flattenSummaryRows(rows) {
    const flat = [];
    for (const row of rows || []) {
        if (row.kind === 'group' && Array.isArray(row.children)) {
            for (const child of row.children) flat.push(child);
        } else {
            flat.push(row);
        }
    }
    return flat;
}

function cellFromStatus(status) {
    if (status === 'complete') {
        return { status: 'complete', display: 'Complete', tone: 'green', clickable: true };
    }
    if (status === 'opened') {
        return { status: 'opened', display: 'Opened', tone: 'orange', clickable: true };
    }
    return { status: 'blank', display: '', tone: 'red', clickable: true };
}

function cellFromActionCount(count) {
    const n = Math.max(0, Number(count) || 0);
    if (n === 0) {
        return { status: 'complete', display: '0', tone: 'green', clickable: true, kind: 'open-actions' };
    }
    if (n >= 10) {
        return { status: 'count', display: String(n), tone: 'red', clickable: true, kind: 'open-actions' };
    }
    return { status: 'count', display: String(n), tone: 'orange', clickable: true, kind: 'open-actions' };
}

function applyComplianceSeedToSummary(summary, areaName, options = {}) {
    if (!summary || typeof summary !== 'object') return summary;
    const weekStartYmd = options.weekStartYmd || summary.weekStartYmd;
    const { seed, lookup } = buildSeedCellLookup(areaName, weekStartYmd);
    if (!seed || !lookup.size) return summary;

    const stores = (summary.regions || []).flatMap((region) => region.stores || []);
    const cells = { ...(summary.cells || {}) };

    for (const row of flattenSummaryRows(summary.rows)) {
        if (row.kind === 'dfsc-count') continue;
        if (!cells[row.id]) cells[row.id] = {};
        for (const store of stores) {
            const storeNumber = String(store.storeNumber || '').trim();
            const seedValue = lookup.get(`${storeNumber}:${row.id}`);
            if (seedValue === undefined) continue;
            if (row.kind === 'open-actions') {
                cells[row.id][storeNumber] = cellFromActionCount(seedValue);
            } else {
                cells[row.id][storeNumber] = cellFromStatus(seedValue);
            }
        }
    }

    return {
        ...summary,
        cells,
        seededFromReference: true,
    };
}

module.exports = {
    activeComplianceSeed,
    buildSeedCellLookup,
    applyComplianceSeedToSummary,
};
