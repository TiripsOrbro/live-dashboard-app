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

function iseDateCellLooksLikeDayLabel(cell) {
    const s = String(cell ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!s) return false;
    return (
        /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(s) ||
        /\d{1,2}-[A-Za-z]{3}-\d{2,4}/.test(s) ||
        /\d{1,2}\/[A-Za-z]{3}\/[0-9]{2,4}/.test(s)
    );
}

/** Day column headers from ISE export (date row under Item Code / Day1…Day7). */
function parseIseDayLabelsFromGrid(grid) {
    const fallback = (i) => `Day${i + 1}`;
    for (let r = 0; r < Math.min(10, grid?.length || 0); r++) {
        const row = grid[r];
        if (!row || row.length < 20) continue;
        if (iseDateCellLooksLikeDayLabel(row[13])) {
            const labels = [];
            for (let c = 13; c < 20; c++) {
                const raw = String(row[c] ?? '')
                    .replace(/\s+/g, ' ')
                    .trim();
                labels.push(raw || fallback(c - 13));
            }
            return labels;
        }
        const col10 = String(row[10] ?? '').toLowerCase();
        if (col10.includes('item') && col10.includes('code')) {
            const labels = [];
            for (let c = 13; c < 20; c++) {
                const raw = String(row[c] ?? '')
                    .replace(/\s+/g, ' ')
                    .trim();
                labels.push(raw || fallback(c - 13));
            }
            if (labels.some((l) => l && !/^day\d$/i.test(l))) return labels;
        }
    }
    const row0 = grid?.[0];
    if (row0 && /^day\s*1$/i.test(String(row0[13] || ''))) {
        return row0.slice(13, 20).map((h, i) => String(h || fallback(i)).trim());
    }
    return Array.from({ length: 7 }, (_, i) => fallback(i));
}

function parseInventorySpecialEventFromGrid(grid) {
    const dayLabels = parseIseDayLabelsFromGrid(grid);
    const items = new Map();

    for (const row of grid) {
        if (!isDataRow(row)) continue;
        const itemCode = normalizeItemCode(row[10]);
        const description = String(row[11] || '').trim();
        const unit = String(row[12] || '').trim();
        const dayValues = row.slice(13, 20).map(num);
        if (!dayValues.some((v) => v > 0)) continue;

        const daySum = dayValues.reduce((a, b) => a + b, 0);
        const avgDaily = daySum / dayValues.length;
        items.set(itemCode, {
            itemCode,
            description,
            unit,
            packSize: packSizeFromUnit(unit),
            dayLabels,
            dayValues,
            daySum,
            avgDaily,
            buildTo10: avgDaily * 10,
        });
    }

    return { items, dayLabels };
}

/** Inventory Special Event CSV — usage is in cartons (or report unit). */
function parseInventorySpecialEvent(filePath) {
    const { grid } = loadGrid(filePath);
    return parseInventorySpecialEventFromGrid(grid).items;
}

/** ISE parse with day labels for debug output. */
function parseInventorySpecialEventFile(filePath) {
    const { grid } = loadGrid(filePath);
    const { items, dayLabels } = parseInventorySpecialEventFromGrid(grid);
    return { items, dayLabels, filePath };
}

/** SCM Items On Hand (Flat) — filter to one store; qty col 7 in report unit col 6. */
function parseStockOnHand(filePath, storeNumber) {
    const { grid } = loadGrid(filePath);
    const want = String(storeNumber || '').trim();
    const items = new Map();

    const detected = detectStoreColumnIndex(grid, [want]);
    const storeCol = detected.matchCount > 0 ? detected.colIndex : 2;
    const itemCol = storeCol === 2 ? 4 : storeCol + 2;

    for (const row of grid) {
        if (!row || storeNumberFromCell(row[storeCol]) !== want) continue;
        const itemCode = normalizeItemCode(row[itemCol] ?? row[4]);
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

    const detected = detectStoreColumnIndex(grid, [want]);
    const storeCol = detected.matchCount > 0 ? detected.colIndex : 2;

    for (const row of grid) {
        if (!row || storeNumberFromCell(row[storeCol]) !== want) continue;
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

/** Macromatix export: YYYYMMDD-HHMM-stock-on-hand.xls (ignore test/recovered copies). */
const REAL_MMX_REPORT_RE =
    /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})-(inventory-special-event|stock-on-hand|stock-on-order)\./i;
const JUNK_REPORT_RE = /^(?:recovered-|test\d*-|t-|debug-)/i;

function isRealMmxReportFilename(name) {
    const base = path.basename(String(name || ''));
    if (!base || JUNK_REPORT_RE.test(base)) return false;
    return REAL_MMX_REPORT_RE.test(base);
}

function reportTimestampFromFilename(name) {
    const m = path.basename(String(name || '')).match(REAL_MMX_REPORT_RE);
    if (!m) return 0;
    return Number(`${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}`);
}

/** YYYY-MM-DD from export filename (Melbourne calendar day of download). */
function reportDateKeyFromFilename(name) {
    const m = path.basename(String(name || '')).match(REAL_MMX_REPORT_RE);
    if (!m) return null;
    return `${m[1]}-${m[2]}-${m[3]}`;
}

function findLatestReportFile(storeDir, basenameHint) {
    if (!fs.existsSync(storeDir)) return null;
    const hint = String(basenameHint || '').toLowerCase();
    const candidates = fs
        .readdirSync(storeDir)
        .filter((f) => f.toLowerCase().includes(hint))
        .filter((f) => isRealMmxReportFilename(f))
        .map((f) => path.join(storeDir, f))
        .sort((a, b) => {
            const ta = reportTimestampFromFilename(a);
            const tb = reportTimestampFromFilename(b);
            if (tb !== ta) return tb - ta;
            return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
        });
    return candidates[0] || null;
}

function describeResolvedStoreReports(files) {
    const pick = (p) => (p ? path.basename(p) : '(missing)');
    return {
        inventorySpecialEvent: pick(files?.inventorySpecialEvent),
        stockOnHand: pick(files?.stockOnHand),
        stockOnOrder: pick(files?.stockOnOrder),
    };
}

/**
 * True when ISE + SOH are real MMX exports from today (Melbourne) with usable SOH rows.
 */
function validateStoreReports(storeNumber, files, options = {}) {
    const issues = [];
    const { melbourneDateKey } = require('./stockCountState');
    const today = options.dateKey || melbourneDateKey();
    const minOnHandRows = Number(options.minOnHandRows) || 10;

    if (!files?.inventorySpecialEvent) {
        issues.push('missing inventory-special-event');
    } else if (!isRealMmxReportFilename(files.inventorySpecialEvent)) {
        issues.push(`ISE is not a Macromatix export (${path.basename(files.inventorySpecialEvent)})`);
    } else {
        const iseDay = reportDateKeyFromFilename(files.inventorySpecialEvent);
        if (iseDay && iseDay !== today) {
            issues.push(`ISE is from ${iseDay} (today ${today})`);
        }
    }

    if (!files?.stockOnHand) {
        issues.push('missing stock-on-hand');
    } else if (!isRealMmxReportFilename(files.stockOnHand)) {
        issues.push(`SOH is not a Macromatix export (${path.basename(files.stockOnHand)})`);
    } else {
        const sohDay = reportDateKeyFromFilename(files.stockOnHand);
        if (sohDay && sohDay !== today) {
            issues.push(`SOH is from ${sohDay} (today ${today})`);
        }
        try {
            const rows = parseStockOnHand(files.stockOnHand, storeNumber);
            if (rows.size < minOnHandRows) {
                issues.push(`SOH only ${rows.size} item row(s) for store ${storeNumber}`);
            }
        } catch (err) {
            issues.push(`SOH unreadable: ${err.message}`);
        }
    }

    if (files?.stockOnOrder && !isRealMmxReportFilename(files.stockOnOrder)) {
        issues.push(`SOO is not a Macromatix export (${path.basename(files.stockOnOrder)})`);
    }

    return { valid: issues.length === 0, issues, today };
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

/** Remove all files under Reports/{storeNumber}/ so the next download is the only source. */
function clearStoreReportFiles(storeNumber, reportsRoot) {
    const storeDir = path.join(reportsRoot, String(storeNumber));
    if (!fs.existsSync(storeDir)) {
        fs.mkdirSync(storeDir, { recursive: true });
        return { storeDir, removed: [] };
    }
    const removed = [];
    for (const name of fs.readdirSync(storeDir)) {
        const filePath = path.join(storeDir, name);
        if (!fs.statSync(filePath).isFile()) continue;
        fs.unlinkSync(filePath);
        removed.push(name);
    }
    removed.sort();
    return { storeDir, removed };
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

/** Extract a 4-digit store number from a cell ("3808" or "3808 Berwick South"). */
function storeNumberFromCell(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
        const n = Math.round(value);
        if (n >= 1000 && n <= 9999) return String(n);
    }
    const s = String(value).trim();
    if (/^\d{4}$/.test(s)) return s;
    const m = s.match(/\b(\d{4})\b/);
    return m ? m[1] : null;
}

function rowContainsStoreNumber(row, storeNumber) {
    const want = String(storeNumber || '').trim();
    if (!want || !row?.length) return false;
    for (const cell of row) {
        if (storeNumberFromCell(cell) === want) return true;
    }
    const joined = row.map((c) => String(c ?? '')).join(' ');
    return new RegExp(`(^|\\D)${want}(\\D|$)`).test(joined);
}

function rowsMatchingStores(grid, storeNumbers) {
    const byStore = new Map();
    for (const num of storeNumbers) byStore.set(num, []);
    for (const row of grid) {
        if (!row?.length) continue;
        for (const num of storeNumbers) {
            if (rowContainsStoreNumber(row, num)) {
                byStore.get(num).push(row);
                break;
            }
        }
    }
    for (const num of storeNumbers) {
        if (!byStore.get(num)?.length) byStore.delete(num);
    }
    return byStore;
}

function sampleGridRows(grid, limit = 2) {
    const samples = [];
    for (const row of grid) {
        if (!row?.length) continue;
        const text = row
            .slice(0, 10)
            .map((c) => String(c ?? '').trim())
            .filter(Boolean)
            .join(' | ');
        if (!text) continue;
        samples.push(text.slice(0, 140));
        if (samples.length >= limit) break;
    }
    return samples;
}

/** Find which column holds store numbers (defaults to col 2 for legacy SCM flat exports). */
function detectStoreColumnIndex(grid, preferredStores = []) {
    const want = new Set(preferredStores.map((s) => String(s).trim()).filter(Boolean));
    const scores = new Map();

    for (const row of grid) {
        if (!row?.length) continue;
        for (let c = 0; c < row.length; c++) {
            const num = storeNumberFromCell(row[c]);
            if (!num) continue;
            if (want.size && !want.has(num)) continue;
            scores.set(c, (scores.get(c) || 0) + 1);
        }
    }

    if (scores.size === 0 && want.size) {
        for (const row of grid) {
            if (!row?.length) continue;
            for (let c = 0; c < row.length; c++) {
                const num = storeNumberFromCell(row[c]);
                if (num) scores.set(c, (scores.get(c) || 0) + 1);
            }
        }
    }

    let colIndex = 2;
    let matchCount = 0;
    for (const [c, n] of scores) {
        if (n > matchCount) {
            matchCount = n;
            colIndex = c;
        }
    }
    return { colIndex, matchCount };
}

/** All distinct 4-digit store numbers present in the grid (for split diagnostics). */
function storesPresentInGrid(grid, colIndex = 2) {
    const detected = detectStoreColumnIndex(grid, []);
    const col = detected.matchCount > 0 ? detected.colIndex : colIndex;
    const found = new Set();
    for (const row of grid) {
        if (!row?.length) continue;
        const store = storeNumberFromCell(row[col]);
        if (store) found.add(store);
    }
    if (!found.size) {
        for (const row of grid) {
            if (!row?.length) continue;
            for (let c = 0; c < row.length; c++) {
                const store = storeNumberFromCell(row[c]);
                if (store) found.add(store);
            }
        }
    }
    return [...found].sort();
}

/** SCM flat exports often include every store — keep only rows for the target store. */
function filterSpreadsheetByStoreColumn(filePath, storeNumber, colIndex = 2) {
    const want = String(storeNumber || '').trim();
    if (!want || !fs.existsSync(filePath)) return { kept: 0, total: 0 };

    const { grid, sheetName } = loadGrid(filePath);
    const total = grid.length;
    const detected = detectStoreColumnIndex(grid, [want]);
    const storeCol = detected.matchCount > 0 ? detected.colIndex : colIndex;
    let filtered = grid.filter((row) => row && storeNumberFromCell(row[storeCol]) === want);
    if (!filtered.length) {
        filtered = (rowsMatchingStores(grid, [want]).get(want) || []).slice();
    }
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
function assignRowToStoreMap(byStore, row, wantSet) {
    if (wantSet) {
        for (let c = 0; c < (row?.length || 0); c++) {
            const store = storeNumberFromCell(row[c]);
            if (!store || !wantSet.has(store)) continue;
            if (!byStore.has(store)) byStore.set(store, []);
            byStore.get(store).push(row);
            return;
        }
        return;
    }
    for (let c = 0; c < (row?.length || 0); c++) {
        const store = storeNumberFromCell(row[c]);
        if (!store) continue;
        if (!byStore.has(store)) byStore.set(store, []);
        byStore.get(store).push(row);
        return;
    }
}

function splitSpreadsheetByStoreColumn(sourcePath, options = {}) {
    const storeNumbers = (options.storeNumbers || []).map((s) => String(s).trim()).filter(Boolean);
    const wantSet = storeNumbers.length ? new Set(storeNumbers) : null;
    const runSlug = String(options.runSlug || '').trim();
    const basename = String(options.outputBasename || 'report').trim();
    const reportsRoot = options.reportsRoot || path.join(path.dirname(sourcePath), '..');
    const ext = path.extname(sourcePath) || '.xls';

    if (!fs.existsSync(sourcePath)) {
        return {
            stores: {},
            totalRows: 0,
            skipped: true,
            storeColumnIndex: 2,
            storesDetected: [],
            storesInFile: [],
        };
    }

    const { grid, sheetName } = loadGrid(sourcePath);
    const detected = detectStoreColumnIndex(grid, storeNumbers);
    const colIndex =
        detected.matchCount > 0 ? detected.colIndex : Number.isFinite(options.colIndex) ? options.colIndex : 2;
    const storesInFile = storesPresentInGrid(grid, colIndex);
    const byStore = new Map();

    for (const row of grid) {
        if (!row?.length) continue;
        const store = storeNumberFromCell(row[colIndex]);
        if (!store) {
            assignRowToStoreMap(byStore, row, wantSet);
            continue;
        }
        if (wantSet && !wantSet.has(store)) continue;
        if (!byStore.has(store)) byStore.set(store, []);
        byStore.get(store).push(row);
    }

    if (wantSet && byStore.size === 0) {
        for (const row of grid) {
            if (!row?.length) continue;
            assignRowToStoreMap(byStore, row, wantSet);
        }
    }

    if (wantSet && byStore.size === 0 && storeNumbers.length) {
        const textMatch = rowsMatchingStores(grid, storeNumbers);
        for (const [store, rows] of textMatch.entries()) {
            byStore.set(store, rows);
        }
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

    return {
        stores,
        totalRows: grid.length,
        sourcePath,
        storeColumnIndex: colIndex,
        storesDetected: [...byStore.keys()].sort(),
        storesInFile,
        sampleRows: byStore.size === 0 ? sampleGridRows(grid) : [],
    };
}

module.exports = {
    loadGrid,
    packSizeFromUnit,
    normalizeItemCode,
    parseInventorySpecialEvent,
    parseInventorySpecialEventFile,
    parseIseDayLabelsFromGrid,
    parseStockOnHand,
    parseStockOnOrder,
    findLatestReportFile,
    isRealMmxReportFilename,
    reportDateKeyFromFilename,
    reportTimestampFromFilename,
    describeResolvedStoreReports,
    validateStoreReports,
    resolveStoreReports,
    clearStoreReportFiles,
    onHandToCartons,
    onOrderToCartons,
    filterSpreadsheetByStoreColumn,
    splitSpreadsheetByStoreColumn,
    storeNumberFromCell,
    detectStoreColumnIndex,
    storesPresentInGrid,
    rowContainsStoreNumber,
    rowsMatchingStores,
    sampleGridRows,
};
