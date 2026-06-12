const { getStoreList } = require('../../../stores/src/storeList');
const { getAreasForMarket } = require('../../../stores/src/marketsConfig');
const { buildTacauditAdminSummary, flattenRows } = require('./tacauditAdminSummary');

function cellFromFraction(complete, total, inProgress = 0) {
    const t = Math.max(0, Number(total) || 0);
    const c = Math.max(0, Number(complete) || 0);
    const ip = Math.max(0, Number(inProgress) || 0);
    if (t === 0) return { status: 'blank', display: '', tone: 'red', clickable: false };
    if (c >= t) return { status: 'complete', display: `${c}/${t}`, tone: 'green', clickable: false };
    if (c > 0 || ip > 0) return { status: 'opened', display: `${c}/${t}`, tone: 'orange', clickable: false };
    return { status: 'blank', display: `0/${t}`, tone: 'red', clickable: false };
}

function cellFromDfscRollup(counts) {
    const completed = counts.reduce((sum, row) => sum + (row.completed || 0), 0);
    const expected = counts.reduce((sum, row) => sum + (row.expected || 0), 0);
    if (expected === 0) return { status: 'blank', display: '', tone: 'red', clickable: false };
    const tone = completed >= expected ? 'green' : completed > 0 ? 'orange' : 'red';
    return { status: completed >= expected ? 'complete' : 'count', display: `${completed}/${expected}`, tone, clickable: false };
}

function cellFromActionRollup(total) {
    const n = Math.max(0, Number(total) || 0);
    if (n === 0) return { status: 'complete', display: '0', tone: 'green', clickable: false };
    if (n >= 10) return { status: 'count', display: String(n), tone: 'red', clickable: false };
    return { status: 'count', display: String(n), tone: 'orange', clickable: false };
}

function rollupWeeklyRow(areaSummary, rowId) {
    const stores = (areaSummary.regions || []).flatMap((r) => r.stores || []);
    let complete = 0;
    let inProgress = 0;
    for (const store of stores) {
        const cell = areaSummary.cells?.[rowId]?.[store.storeNumber];
        if (cell?.status === 'complete') complete += 1;
        else if (cell?.status === 'opened') inProgress += 1;
    }
    return cellFromFraction(complete, stores.length, inProgress);
}

function rollupDfscRow(areaSummary) {
    const stores = (areaSummary.regions || []).flatMap((r) => r.stores || []);
    const counts = stores.map((store) => {
        const cell = areaSummary.cells?.dfsc?.[store.storeNumber];
        const display = String(cell?.display || '');
        const m = display.match(/^(\d+)\/(\d+)$/);
        return {
            completed: m ? Number(m[1]) : 0,
            expected: m ? Number(m[2]) : 0,
        };
    });
    return cellFromDfscRollup(counts);
}

function rollupOpenActionsRow(areaSummary) {
    const stores = (areaSummary.regions || []).flatMap((r) => r.stores || []);
    let total = 0;
    for (const store of stores) {
        const cell = areaSummary.cells?.['open-actions']?.[store.storeNumber];
        total += Number(cell?.display) || 0;
    }
    return cellFromActionRollup(total);
}

function buildTacauditMarketSummary(marketName, options = {}) {
    const areas = getAreasForMarket(marketName).filter((area) => {
        if (Array.isArray(options.accessibleAreas) && options.accessibleAreas.length) {
            return options.accessibleAreas.includes(area);
        }
        return true;
    });
    const allStores = getStoreList();
    const columns = [];
    const areaSummaries = new Map();

    for (const areaName of areas) {
        const stores = allStores
            .filter((s) => String(s.area || '').trim() === areaName)
            .map((s) => ({
                storeNumber: String(s.storeNumber || '').trim(),
                storeName: String(s.storeName || s.storeNumber || '').trim(),
                timeZone: s.timeZone || 'Australia/Melbourne',
            }))
            .filter((s) => s.storeNumber);
        if (!stores.length) continue;
        const summary = buildTacauditAdminSummary(stores, {
            ...options,
            areaName,
        });
        areaSummaries.set(areaName, summary);
        columns.push({ areaName, storeCount: stores.length });
    }

    if (!columns.length) {
        return { ok: false, status: 404, error: 'No areas found for this market.' };
    }

    const template = areaSummaries.get(columns[0].areaName);
    const rows = template?.rows || [];
    const flatRows = flattenRows(rows);
    const cells = {};

    for (const row of flatRows) {
        cells[row.id] = {};
        for (const col of columns) {
            const areaSummary = areaSummaries.get(col.areaName);
            if (row.kind === 'dfsc-count') {
                cells[row.id][col.areaName] = rollupDfscRow(areaSummary);
            } else if (row.kind === 'open-actions') {
                cells[row.id][col.areaName] = rollupOpenActionsRow(areaSummary);
            } else {
                cells[row.id][col.areaName] = rollupWeeklyRow(areaSummary, row.id);
            }
        }
    }

    return {
        ok: true,
        viewLevel: 'market',
        marketName,
        periodLabel: template?.periodLabel || '',
        weekLabel: template?.weekLabel || '',
        weekStartYmd: template?.weekStartYmd,
        weekEndYmd: template?.weekEndYmd,
        columns,
        rows,
        cells,
        generatedAt: new Date().toISOString(),
    };
}

module.exports = { buildTacauditMarketSummary, cellFromFraction };
