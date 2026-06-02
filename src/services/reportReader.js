const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { qtyPerBoxForItem } = require('./convertToBox');

function loadGrid(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.csv' || ext === '.xls' || ext === '.xlsx') {
        const wb = XLSX.readFile(filePath, { cellDates: true, raw: false });
        const sheetName = wb.SheetNames[0];
        const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null, raw: true });
        return { grid, sheetName };
    }
    throw new Error(`Unsupported report format: ${ext}`);
}

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/** CARTON-12x36 → 432, CARTON-8x1.85KG → 14.8, EACH → 1 */
function packSizeFromUnit(unitText) {
    const raw = String(unitText || '').trim().toUpperCase();
    if (!raw || raw === 'EACH' || raw === 'EA') return 1;

    const body = raw.replace(/^(CARTON|BAG|BOX|CASE|PACK)-/i, '');
    const parts = body.split(/X/i).map((p) => p.replace(/[^0-9.]/g, '')).filter(Boolean);
    if (!parts.length) return 1;

    return parts.reduce((acc, p) => acc * Number(p), 1);
}

function normalizeItemCode(code) {
    return String(code || '')
        .trim()
        .toUpperCase()
        .replace(/^0+/, '');
}

function isDataRow(row) {
    if (!row || !row.length) return false;
    const code = normalizeItemCode(row[10] ?? row[4] ?? row[7]);
    return /^\d{3,10}[A-Z]?$/.test(code) || /^[A-Z0-9]{2,12}$/.test(code);
}

/** Inventory Special Event CSV — usage is in cartons (or report unit). */
function parseInventorySpecialEvent(filePath) {
    const { grid } = loadGrid(filePath);
    const items = new Map();

    for (const row of grid) {
        if (!isDataRow(row)) continue;
        const itemCode = normalizeItemCode(row[10]);
        const description = String(row[11] || '').trim();
        const unit = String(row[12] || '').trim();
        const dayValues = row.slice(13, 20).map(num);
        if (!dayValues.some((v) => v > 0)) continue;

        const avgDaily = dayValues.reduce((a, b) => a + b, 0) / dayValues.length;
        items.set(itemCode, {
            itemCode,
            description,
            unit,
            packSize: packSizeFromUnit(unit),
            dayValues,
            avgDaily,
            buildTo10: avgDaily * 10,
        });
    }

    return items;
}

/** SCM Items On Hand (Flat) — filter to one store; qty col 7 in report unit col 6. */
function parseStockOnHand(filePath, storeNumber) {
    const { grid } = loadGrid(filePath);
    const want = String(storeNumber || '').trim();
    const items = new Map();

    for (const row of grid) {
        if (!row || String(row[2] || '').trim() !== want) continue;
        const itemCode = normalizeItemCode(row[4]);
        if (!itemCode) continue;
        items.set(itemCode, {
            itemCode,
            description: String(row[5] || '').trim(),
            unit: String(row[6] || '').trim(),
            quantity: num(row[7]),
        });
    }

    return items;
}

/** SCM Items On Order (Flat) — sum qty in column L (index 11) per item for store. */
function parseStockOnOrder(filePath, storeNumber) {
    const { grid } = loadGrid(filePath);
    const want = String(storeNumber || '').trim();
    const items = new Map();

    for (const row of grid) {
        if (!row || String(row[2] || '').trim() !== want) continue;
        const itemCode = normalizeItemCode(row[7]);
        if (!itemCode) continue;

        const qty = num(row[11]);

        const existing = items.get(itemCode) || {
            itemCode,
            description: String(row[8] || '').trim(),
            unit: String(row[9] || '').trim(),
            vendor: String(row[4] || '').trim(),
            quantity: 0,
        };
        existing.quantity += qty;
        items.set(itemCode, existing);
    }

    return items;
}

function findLatestReportFile(storeDir, basenameHint) {
    if (!fs.existsSync(storeDir)) return null;
    const files = fs
        .readdirSync(storeDir)
        .filter((f) => f.toLowerCase().includes(basenameHint))
        .map((f) => path.join(storeDir, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files[0] || null;
}

function resolveStoreReports(storeNumber, reportsRoot) {
    const storeDir = path.join(reportsRoot, String(storeNumber));
    return {
        storeDir,
        inventorySpecialEvent: findLatestReportFile(storeDir, 'inventory-special-event'),
        stockOnHand: findLatestReportFile(storeDir, 'stock-on-hand'),
        stockOnOrder: findLatestReportFile(storeDir, 'stock-on-order'),
    };
}

function onHandToCartons(onHandRow, iseUnit, isePackSize, itemCode) {
    if (!onHandRow) return 0;
    const qty = onHandRow.quantity;
    if (qty <= 0) return 0;

    const reportUnit = String(onHandRow.unit || '').trim().toUpperCase();
    const iseUnitText = String(iseUnit || '').trim().toUpperCase();
    const overrideQtyPerBox = qtyPerBoxForItem(itemCode || onHandRow.itemCode, reportUnit);
    if (Number.isFinite(overrideQtyPerBox) && overrideQtyPerBox > 0) {
        return qty / overrideQtyPerBox;
    }

    if (reportUnit.startsWith('CARTON') || reportUnit.startsWith('BAG') || reportUnit.startsWith('BOX')) {
        return qty;
    }

    if (reportUnit === 'KG' || reportUnit === 'KGS') {
        const kgPerCarton = isePackSize || packSizeFromUnit(iseUnitText);
        return kgPerCarton > 0 ? qty / kgPerCarton : qty;
    }

    if (reportUnit === 'EACH' || reportUnit === 'EA') {
        const eachPerCarton = isePackSize || packSizeFromUnit(iseUnitText);
        return eachPerCarton > 0 ? qty / eachPerCarton : qty;
    }

    return qty;
}

/** Convert on-order report qty to cartons (same unit rules as on-hand). */
function onOrderToCartons(onOrderRow, iseUnit, isePackSize, itemCode) {
    return onHandToCartons(onOrderRow, iseUnit, isePackSize, itemCode || onOrderRow?.itemCode);
}

/** SCM flat exports often include every store — keep only rows for the target store (col 2 = store #). */
function filterSpreadsheetByStoreColumn(filePath, storeNumber, colIndex = 2) {
    const want = String(storeNumber || '').trim();
    if (!want || !fs.existsSync(filePath)) return { kept: 0, total: 0 };

    const { grid, sheetName } = loadGrid(filePath);
    const total = grid.length;
    const filtered = grid.filter((row) => row && String(row[colIndex] || '').trim() === want);
    if (!filtered.length) {
        return { kept: 0, total, skipped: true };
    }
    if (filtered.length === total) {
        return { kept: filtered.length, total, unchanged: true };
    }

    const wb = XLSX.readFile(filePath, { cellDates: true });
    wb.Sheets[sheetName] = XLSX.utils.aoa_to_sheet(filtered);
    XLSX.writeFile(wb, filePath);
    return { kept: filtered.length, total, removed: total - filtered.length };
}

/**
 * Split a multi-store SCM flat export into per-store files under Reports/{storeNumber}/.
 * Returns { stores: { [storeNumber]: { path, kept } }, totalRows }.
 */
function splitSpreadsheetByStoreColumn(sourcePath, options = {}) {
    const colIndex = options.colIndex ?? 2;
    const storeNumbers = (options.storeNumbers || []).map((s) => String(s).trim()).filter(Boolean);
    const wantSet = storeNumbers.length ? new Set(storeNumbers) : null;
    const runSlug = String(options.runSlug || '').trim();
    const basename = String(options.outputBasename || 'report').trim();
    const reportsRoot = options.reportsRoot || path.join(path.dirname(sourcePath), '..');
    const ext = path.extname(sourcePath) || '.xls';

    if (!fs.existsSync(sourcePath)) {
        return { stores: {}, totalRows: 0, skipped: true };
    }

    const { grid, sheetName } = loadGrid(sourcePath);
    const byStore = new Map();

    for (const row of grid) {
        const store = String(row?.[colIndex] ?? '').trim();
        if (!store || !/^\d{4}$/.test(store)) continue;
        if (wantSet && !wantSet.has(store)) continue;
        if (!byStore.has(store)) byStore.set(store, []);
        byStore.get(store).push(row);
    }

    const wb = XLSX.readFile(sourcePath, { cellDates: true });
    const stores = {};

    for (const [store, rows] of byStore.entries()) {
        const storeDir = path.join(reportsRoot, store);
        fs.mkdirSync(storeDir, { recursive: true });
        const filename = runSlug ? `${runSlug}-${basename}${ext}` : `${basename}${ext}`;
        const dest = path.join(storeDir, filename);
        wb.Sheets[sheetName] = XLSX.utils.aoa_to_sheet(rows);
        XLSX.writeFile(wb, dest);
        stores[store] = { path: dest, kept: rows.length };
    }

    return { stores, totalRows: grid.length, sourcePath };
}

module.exports = {
    loadGrid,
    packSizeFromUnit,
    normalizeItemCode,
    parseInventorySpecialEvent,
    parseStockOnHand,
    parseStockOnOrder,
    findLatestReportFile,
    resolveStoreReports,
    onHandToCartons,
    onOrderToCartons,
    filterSpreadsheetByStoreColumn,
    splitSpreadsheetByStoreColumn,
};
