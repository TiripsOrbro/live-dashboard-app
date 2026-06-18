const { loadGrid } = require('../../../vendors/src/reportReader');
const { normalizeLabel } = require('./pointsFile');
const { melbourneTodayIso } = require('./upsellingConfig');

const ONLINE_CASHIER_RE = /online\s*\d*\s*cashier/i;
/** Store / entity label rows in the BI grid - not a person. */
const STORE_ENTITY_RE = /^\d{4}\s+[a-z]|^entity\b|chirnside\s+park$/i;
/** MMX category group headers (BOX_MEALS, DESSERTS) - not leaf item columns. */
const CATEGORY_COLUMN_RE = /^[A-Z][A-Z0-9_]*$/;
const TOTAL_COLUMN_RE = /^(total|points|score|competition\s*total|grand\s*total)$/i;
function isDateColumnHeader(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return false;
    if (/^\d{4}-\d{2}-\d{2}(?:\b|\s|$)/.test(s)) return true;
    if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(s)) return true;
    if (/^(mon|tue|wed|thu|fri|sat|sun)\b/i.test(s)) return true;
    return false;
}

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function findHeaderRow(grid) {
    let best = null;
    for (let r = 0; r < grid.length; r++) {
        const row = grid[r] || [];
        for (let c = 0; c < row.length; c++) {
            const cell = String(row[c] || '').trim().toLowerCase();
            if (cell !== 'cashier name') continue;
            const hasFiscal = row.some((x) => /^fiscal\s+ypwd/i.test(String(x || '').trim()));
            const hasDateNoise = row.some((x) => /^\d{4}-\d{2}-\d{2}$/.test(String(x || '').trim()));
            const hasHugeCell = row.some((x) => String(x || '').length > 250);
            const score =
                (hasFiscal ? 2000 : 0) +
                (hasDateNoise ? -3000 : 0) +
                (hasHugeCell ? -3000 : 0) +
                Math.max(0, 800 - row.length) +
                r;
            if (!best || score > best.score) {
                best = { rowIndex: r, cashierCol: c, headerRow: row, score };
            }
        }
    }
    if (best) {
        const { rowIndex, cashierCol, headerRow } = best;
        return { rowIndex, cashierCol, headerRow };
    }
    return { rowIndex: 0, cashierCol: 0, headerRow: grid[0] || [] };
}

function findFiscalDayColumn(headerRow, cashierCol) {
    for (let c = 0; c < headerRow.length; c++) {
        if (c === cashierCol) continue;
        const raw = String(headerRow[c] ?? '').trim().toLowerCase();
        if (/fiscal|ypwd|week|period/i.test(raw)) return c;
    }
    return -1;
}

function isDateLabel(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return true;
    const s = String(value || '').trim();
    if (/^all$/i.test(s)) return false;
    if (/^\d{4}-\d{2}-\d{2}(?:T|\b|\s|$)/.test(s)) return true;
    return /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(s);
}

/** MMX "today only" export uses All in the fiscal column instead of a date. */
function isAllPeriodDayLabel(value) {
    return /^all$/i.test(String(value || '').trim());
}

function resolveDefaultReportDay(options = {}) {
    const override = String(options.reportDay || options.syncDay || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
    return melbourneTodayIso();
}

/** When the CSV has no Entity column, infer store from "3811 Chirnside Park" text anywhere in the grid. */
function inferDominantStoreFromGrid(grid) {
    const counts = new Map();
    const storeRe = /\b(38\d{2}|39\d{2})\b/g;
    for (const row of grid || []) {
        for (const cell of row || []) {
            const text = String(cell ?? '');
            if (!text) continue;
            let match;
            while ((match = storeRe.exec(text)) !== null) {
                const store = match[1];
                counts.set(store, (counts.get(store) || 0) + 1);
            }
        }
    }
    let best = '';
    let max = 0;
    for (const [store, n] of counts) {
        if (n > max) {
            max = n;
            best = store;
        }
    }
    return best;
}

function normalizeDayIso(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString().slice(0, 10);
    }
    const s = String(value || '').trim();
    const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];
    const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (!dmy) return '';
    let year = Number(dmy[3]);
    if (year < 100) year += 2000;
    const month = String(dmy[2]).padStart(2, '0');
    const day = String(dmy[1]).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function cellText(value) {
    if (value == null || value === '') return '';
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString();
    }
    return String(value).trim();
}

function findTotalColumn(headerRow, cashierCol) {
    for (let c = 0; c < headerRow.length; c++) {
        if (c === cashierCol) continue;
        const raw = String(headerRow[c] ?? '').trim();
        if (TOTAL_COLUMN_RE.test(raw)) return c;
    }
    return -1;
}

function findDateColumns(headerRow, cashierCol) {
    const cols = [];
    for (let c = 0; c < headerRow.length; c++) {
        if (c === cashierCol) continue;
        const raw = String(headerRow[c] ?? '').trim();
        if (!raw || TOTAL_COLUMN_RE.test(raw)) continue;
        if (!isDateColumnHeader(raw)) continue;
        cols.push(c);
    }
    return cols;
}

function buildColumnMeta(headerRow) {
    const columns = [];
    for (let c = 0; c < headerRow.length; c++) {
        let raw = String(headerRow[c] ?? '').trim();
        raw = raw.replace(/^expand\s+/i, '').trim();
        if (!raw) continue;
        const norm = normalizeLabel(raw);
        const isCategory = CATEGORY_COLUMN_RE.test(raw.replace(/\s+/g, '_').toUpperCase());
        columns.push({ index: c, raw, norm, isCategory });
    }
    return columns;
}

/**
 * Prefer leaf item columns: drop category totals when a non-category column shares the same
 * normalized prefix family (e.g. BOX_MEALS vs "Boss Burrito Box").
 */
function looksLikeDateOrGroupLabel(name) {
    const s = String(name || '').trim();
    if (!s) return true;
    if (/^fiscal\b/i.test(s)) return true;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return true;
    if (/^total\b/i.test(s) || /^sum$/i.test(s)) return true;
    if (/^sales\s+item\s+quantity$/i.test(s)) return true;
    if (/^multi-?select$/i.test(s)) return true;
    if (STORE_ENTITY_RE.test(s)) return true;
    return false;
}

function looksLikeCashierName(name, productLabels = null) {
    const s = String(name || '').trim();
    if (!s || s.length < 3) return false;
    if (/^\d+$/.test(s)) return false;
    if (looksLikeDateOrGroupLabel(s)) return false;
    if (ONLINE_CASHIER_RE.test(s) || STORE_ENTITY_RE.test(s)) return false;
    if (/^(box_meals|desserts|entityname|sales items|cashier name)$/i.test(s)) return false;
    if (productLabels && productLabels.has(normalizeLabel(s))) return false;
    if (/\b(taco|burrito|chicken|sauce|churros|nachos|crunchwrap|dessert|box|meal|lava|zesty)\b/i.test(s)) {
        return false;
    }
    const words = s.split(/\s+/).filter(Boolean);
    if (words.length > 5) return false;
    return /[a-z]/i.test(s);
}

function extractRowCashier(row, currentDay, productLabels) {
    let day = currentDay;
    let name = '';
    let nameCol = -1;
    for (let c = 0; c < row.length; c++) {
        const s = String(row[c] ?? '').trim();
        if (!s) continue;
        if (isDateLabel(s)) day = s;
        else if (!name && looksLikeCashierName(s, productLabels)) {
            name = s;
            nameCol = c;
        }
    }
    return { day, name, nameCol };
}

function qtyCellsAfterName(row, nameCol) {
    const values = [];
    if (nameCol < 0) return values;
    for (let c = nameCol + 1; c < row.length; c++) {
        const s = String(row[c] ?? '').trim();
        if (!s) continue;
        if (isDateLabel(s) || /^sum$/i.test(s)) break;
        if (!/^-?\d+(\.\d+)?$/.test(s)) continue;
        values.push(num(s));
    }
    return values;
}

/**
 * OLAP often renders the full pivot as one very wide <tr> with one numeric cell per
 * item×store column (same order as activeCols).
 */
function isMegaOlapRow(row) {
    return (row || []).some((cell) => String(cell || '').length > 500);
}

function extractMegaOlapText(grid) {
    for (const row of grid || []) {
        if (!row) continue;
        for (const cell of row) {
            const s = String(cell || '');
            if (
                s.length > 800 &&
                /cashier name/i.test(s) &&
                /\d{4}-\d{2}-\d{2}/.test(s) &&
                /sales item quantity/i.test(s)
            ) {
                return s;
            }
        }
    }
    return '';
}

function stripMegaOlapRows(grid) {
    return (grid || []).filter((row) => row && row.length && !isMegaOlapRow(row));
}

function isStoreHeaderCandidateRow(row, cashierCol) {
    if (!row || isMegaOlapRow(row)) return false;
    if (row.some((cell) => isDateLabel(cell))) return false;
    if (row.some((cell) => looksLikeCashierName(String(cell || '').trim()))) return false;
    return countStoreCells(row, cashierCol) >= 2;
}

function firstStoreColumn(storeRow, cashierCol) {
    for (let c = cashierCol + 1; c < (storeRow || []).length; c++) {
        if (extractStoreNumber(storeRow[c])) return c;
    }
    return -1;
}

/**
 * Some OLAP exports place qty N columns left of the first store header.
 * Only enable when no cashier uses in-column qty (mixed layouts break store mapping).
 */
function detectQtyColumnShift(grid, headerRowIndex, cashierCol, storeRowIndex) {
    const storeRow = grid[storeRowIndex] || [];
    const firstStoreCol = firstStoreColumn(storeRow, cashierCol);
    if (firstStoreCol < 0) return 0;

    let sawDirectInBlock = false;
    const shiftVotes = new Map();
    let checked = 0;

    for (let r = headerRowIndex + 1; r < grid.length; r++) {
        const row = grid[r];
        if (!row || isMegaOlapRow(row)) continue;
        const name = String(row[cashierCol] ?? '').trim();
        if (!name || !looksLikeCashierName(name)) continue;

        if (num(row[firstStoreCol])) sawDirectInBlock = true;

        for (let c = cashierCol + 1; c < firstStoreCol; c++) {
            if (num(row[c])) {
                const shift = firstStoreCol - c;
                shiftVotes.set(shift, (shiftVotes.get(shift) || 0) + 1);
                break;
            }
        }
        checked++;
        if (checked >= 20) break;
    }

    if (sawDirectInBlock) return 0;

    let bestShift = 0;
    let bestVotes = 0;
    for (const [shift, votes] of shiftVotes.entries()) {
        if (votes > bestVotes) {
            bestVotes = votes;
            bestShift = shift;
        }
    }
    return bestVotes >= 3 ? bestShift : 0;
}

function isFirstStoreInBlock(col, storeRow, cashierCol) {
    if (!extractStoreNumber(storeRow[col])) return false;
    for (let c = col - 1; c > cashierCol; c--) {
        if (extractStoreNumber(storeRow[c])) return false;
    }
    return true;
}

function readQtyAtColumn(row, colIndex, shift, _firstStoreCol = -1, storeRow = null, cashierCol = 0) {
    if (!row || colIndex < 0) return 0;

    const direct = num(row[colIndex]);
    if (direct) return direct;

    if (shift > 0 && storeRow && isFirstStoreInBlock(colIndex, storeRow, cashierCol)) {
        const qtyCol = colIndex - shift;
        if (qtyCol > cashierCol) return num(row[qtyCol]);
    }

    return 0;
}

function pushQtyByStore(qtyByStore, col, value) {
    if (!value || !col?.storeNumber) return;
    if (!qtyByStore.has(col.storeNumber)) qtyByStore.set(col.storeNumber, {});
    const storeQty = qtyByStore.get(col.storeNumber);
    storeQty[col.item] = (storeQty[col.item] || 0) + value;
}

function flushQtyByStore(name, day, qtyByStore, cashiers) {
    for (const [storeNumber, storeQtyByColumn] of qtyByStore.entries()) {
        if (!storeNumber) continue;
        cashiers.push({ name, day, store: storeNumber, qtyByColumn: storeQtyByColumn });
    }
}

function parseMegaOlapCashiers(megaText, activeCols, productLabels) {
    const cashiers = [];
    if (!megaText || !activeCols.length) return cashiers;

    const parts = megaText.split(/(?=\d{4}-\d{2}-\d{2})/);
    for (const part of parts) {
        const head = part.match(/^(\d{4}-\d{2}-\d{2})([\s\S]*)$/);
        if (!head) continue;
        const day = head[1];
        let rest = head[2];
        while (rest.length) {
            const nameMatch = rest.match(
                /^([A-Z][A-Za-z0-9\s'.-]+?)(\d[\s\S]*)$/
            );
            if (!nameMatch) break;
            const name = String(nameMatch[1] || '').trim();
            rest = String(nameMatch[2] || '');
            if (!looksLikeCashierName(name, productLabels)) {
                rest = name + rest;
                break;
            }

            const digits = [];
            let i = 0;
            while (i < rest.length && /\d/.test(rest[i])) {
                digits.push(Number(rest[i]));
                i += 1;
            }
            rest = rest.slice(i);

            const qtyByStore = new Map();
            for (let d = 0; d < digits.length && d < activeCols.length; d++) {
                pushQtyByStore(qtyByStore, activeCols[d], digits[d]);
            }
            flushQtyByStore(name, day, qtyByStore, cashiers);
        }
    }
    return cashiers;
}

function parseRowQtyByStore(row, activeCols, shift, cashierCol = 0, firstStoreCol = -1, storeRow = null) {
    const qtyByStore = new Map();
    for (const col of activeCols) {
        const value = readQtyAtColumn(
            row,
            col.index,
            shift,
            firstStoreCol,
            storeRow,
            cashierCol
        );
        pushQtyByStore(qtyByStore, col, value);
    }
    return qtyByStore;
}

function mergeCashierRecords(primary, secondary) {
    const byKey = new Map();
    for (const row of [...primary, ...secondary]) {
        const key = `${row.day}|${normalizeLabel(row.name)}|${row.store}`;
        const prev = byKey.get(key);
        if (!prev) {
            byKey.set(key, {
                name: row.name,
                day: row.day,
                store: row.store,
                qtyByColumn: { ...(row.qtyByColumn || {}) },
            });
            continue;
        }
        for (const [item, qty] of Object.entries(row.qtyByColumn || {})) {
            prev.qtyByColumn[item] = (prev.qtyByColumn[item] || 0) + (Number(qty) || 0);
        }
    }
    return [...byKey.values()];
}

function extractStoreNumber(label) {
    const m = String(label || '').trim().match(/^(\d{3,6})\b/);
    return m ? m[1] : '';
}

function countStoreCells(row, cashierCol) {
    let n = 0;
    for (let c = 0; c < (row || []).length; c++) {
        if (c === cashierCol) continue;
        if (extractStoreNumber(row[c])) n++;
    }
    return n;
}

/** Store names (3806 Dandenong South, …) sit near the Cashier Name header row. */
function findStoreHeaderRow(grid, headerRowIndex, cashierCol) {
    let best = null;
    const start = Math.max(0, headerRowIndex - 3);
    const end = Math.min(grid.length, headerRowIndex + 8);
    for (let r = start; r < end; r++) {
        if (r === headerRowIndex) continue;
        const row = grid[r] || [];
        if (!isStoreHeaderCandidateRow(row, cashierCol)) continue;
        const storeCount = countStoreCells(row, cashierCol);
        if (!best || storeCount > best.storeCount) {
            best = { rowIndex: r, storeCount, row };
        }
    }
    if (best && best.storeCount >= 2) return best;
    return null;
}

function isCategoryGroupHeader(cell) {
    const s = String(cell || '').trim();
    if (!s || /\s/.test(s)) return false;
    const upper = s.replace(/\s+/g, '_').toUpperCase();
    if (!CATEGORY_COLUMN_RE.test(upper)) return false;
    // Real item names (Churros, Nachos) are single words; OLAP groups are BOX_MEALS-style.
    return upper.includes('_') || upper.length >= 10;
}

function isItemHeaderCell(cell) {
    const s = String(cell || '').trim();
    if (!s) return false;
    if (isHeaderMetaColumn(s)) return false;
    if (extractStoreNumber(s)) return false;
    if (isCategoryGroupHeader(s)) return false;
    return true;
}

/** Product labels (Boss Burrito Box, …) are header rows above the store row; forward-fill colspan. */
function buildColumnItemLabels(grid, storeRowIndex, cashierCol) {
    const maxCol = Math.max(0, ...grid.slice(0, storeRowIndex).map((r) => (r || []).length));
    const items = new Array(maxCol).fill('');

    for (let r = 0; r < storeRowIndex; r++) {
        const row = grid[r] || [];
        if (isMegaOlapRow(row)) continue;
        let rowCarry = '';
        for (let c = 0; c < maxCol; c++) {
            if (c === cashierCol) continue;
            const cell = String(row[c] ?? '').trim();
            if (isItemHeaderCell(cell)) rowCarry = cell;
            if (rowCarry) items[c] = rowCarry;
        }
    }
    return items;
}

function buildItemStoreColsFromGrid(grid, headerRowIndex, cashierCol) {
    const storeHeader = findStoreHeaderRow(grid, headerRowIndex, cashierCol);
    if (!storeHeader) {
        const headerRow = grid[headerRowIndex] || [];
        const storeRow = grid[headerRowIndex + 1] || [];
        return buildItemStoreCols(headerRow, storeRow, cashierCol);
    }

    const storeRow = storeHeader.row;
    const itemLabels = buildColumnItemLabels(grid, storeHeader.rowIndex, cashierCol);
    const cols = [];
    for (let c = 0; c < storeRow.length; c++) {
        if (c === cashierCol) continue;
        const storeNumber = extractStoreNumber(storeRow[c]);
        const item = itemLabels[c] || '';
        if (!storeNumber || !item) continue;
        if (isHeaderMetaColumn(item)) continue;
        cols.push({
            index: c,
            item,
            norm: normalizeLabel(item),
            storeNumber,
        });
    }
    return cols;
}

function buildItemStoreCols(headerRow, storeRow, cashierCol) {
    const cols = [];
    let currentItem = '';
    for (let c = 0; c < headerRow.length; c++) {
        if (c === cashierCol) continue;
        const itemCell = String(headerRow[c] || '').trim();
        const storeCell = String((storeRow && storeRow[c]) || '').trim();
        if (itemCell) currentItem = itemCell;
        const storeNumber = extractStoreNumber(storeCell);
        if (!currentItem || !storeNumber) continue;
        if (isHeaderMetaColumn(currentItem)) continue;
        cols.push({
            index: c,
            item: currentItem,
            norm: normalizeLabel(currentItem),
            storeNumber,
        });
    }
    return cols;
}

function isHeaderMetaColumn(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return true;
    if (/^fiscal|^cashier|^entity|^multi-?select$|^sales\s+item\s+quantity$/i.test(s)) return true;
    if (STORE_ENTITY_RE.test(raw)) return true;
    return false;
}

function selectLeafColumns(columns, pointsByLabel) {
    const itemCols = columns.filter((col) => !col.isCategory);
    const categoryCols = columns.filter((col) => col.isCategory);
    if (!categoryCols.length) return itemCols.length ? itemCols : columns;

    if (itemCols.length) return itemCols;

    const hasMappedItems = columns.some((col) => pointsByLabel.has(col.norm));
    if (hasMappedItems) return columns.filter((col) => pointsByLabel.has(col.norm));

    return columns.filter((col) => !col.isCategory && col.index > 0);
}

function rowHasSalesItemQuantity(row) {
    return (row || []).some((cell) => /sales\s+item\s+quantity/i.test(String(cell || '').trim()));
}

function findEntityColumn(row, fiscalCol, cashierCol) {
    for (let c = 0; c < row.length; c++) {
        if (c === fiscalCol || c === cashierCol) continue;
        const s = String(row[c] ?? '').trim();
        if (
            /^entity/i.test(s) ||
            /^store\s*(#|number|name)?$/i.test(s) ||
            /^site\b/i.test(s)
        ) {
            return c;
        }
    }
    return -1;
}

function resolveRowStore(row, entityCol, filterStore, defaultStore) {
    if (entityCol >= 0) {
        const fromEntity =
            extractStoreNumber(row[entityCol]) || extractStoreNumber(cellText(row[entityCol])) || '';
        if (fromEntity) return fromEntity;
    }
    return filterStore || defaultStore || '';
}

/** BI CSV / flat export: Fiscal YPWD + Cashier Name columns, then item qty columns. */
function findFlatFiscalCashierLayout(grid) {
    for (let r = 0; r < (grid || []).length; r++) {
        const row = grid[r] || [];
        let fiscalCol = -1;
        let cashierCol = -1;
        for (let c = 0; c < row.length; c++) {
            const s = String(row[c] ?? '').trim();
            if (/^fiscal\s+ypwd$/i.test(s)) fiscalCol = c;
            else if (/^cashier\s+name$/i.test(s)) cashierCol = c;
        }
        if (fiscalCol < 0 || cashierCol < 0) continue;

        const entityCol = findEntityColumn(row, fiscalCol, cashierCol);
        const itemHeaders = [];
        for (let c = 0; c < row.length; c++) {
            if (c === fiscalCol || c === cashierCol || c === entityCol) continue;
            const item = String(row[c] ?? '').trim();
            if (!item || isHeaderMetaColumn(item)) continue;
            if (isCategoryGroupHeader(item)) continue;
            if (isDateColumnHeader(item)) continue;
            itemHeaders.push({
                index: c,
                item,
                norm: normalizeLabel(item),
                storeNumber: '',
            });
        }
        const minItemCols = entityCol >= 0 ? 1 : 2;
        if (itemHeaders.length < minItemCols) continue;

        let dataStartRow = r + 1;
        const row1 = grid[r + 1] || [];
        const row2 = grid[r + 2] || [];

        if (entityCol >= 0) {
            const row1LooksLikeData =
                isDateLabel(row1[fiscalCol]) ||
                isAllPeriodDayLabel(row1[fiscalCol]) ||
                looksLikeCashierName(cellText(row1[cashierCol]));
            if (!row1LooksLikeData && rowHasSalesItemQuantity(row1)) {
                dataStartRow = r + 2;
            }
        } else {
            const storeRowLooksLikeStores =
                countStoreCells(row1, cashierCol) >= 1 ||
                itemHeaders.some((col) => extractStoreNumber(row1[col.index]));
            if (storeRowLooksLikeStores) {
                for (const col of itemHeaders) {
                    col.storeNumber = extractStoreNumber(row1[col.index]) || '';
                }
                dataStartRow = r + 2;
                if (rowHasSalesItemQuantity(row2)) {
                    dataStartRow = r + 3;
                }
            }
        }

        return {
            headerRowIndex: r,
            fiscalCol,
            cashierCol,
            entityCol,
            itemHeaders,
            dataStartRow,
        };
    }
    return null;
}

function buildUnassignedRow(rowIndex, row, layout, fields, reason) {
    const { fiscalCol, cashierCol, entityCol } = layout;
    return {
        rowIndex,
        reason,
        day: fields.day || '',
        name: fields.name || '',
        store: fields.store || '',
        storeLabel: fields.storeLabel || '',
        raw: {
            date: cellText(row[fiscalCol]),
            name: cellText(row[cashierCol]),
            entity: entityCol >= 0 ? cellText(row[entityCol]) : '',
        },
        qtyByColumn: fields.qtyByColumn || {},
    };
}

function parseFlatFiscalCashierRows(grid, layout, filterStore, pointsByLabel, options = {}) {
    const { fiscalCol, cashierCol, entityCol, itemHeaders, dataStartRow } = layout;
    let activeCols = itemHeaders;
    const mappedCols = activeCols.filter((col) => pointsByLabel.has(col.norm));
    if (mappedCols.length) activeCols = mappedCols;
    if (filterStore && entityCol < 0) {
        activeCols = activeCols.filter((col) => !col.storeNumber || col.storeNumber === filterStore);
    }

    const inferredStore =
        normalizeFilterStore(options.fallbackStoreNumber) ||
        inferDominantStoreFromGrid(grid) ||
        '';
    const fallbackStore = filterStore || inferredStore;

    const productLabels = new Set(activeCols.map((col) => col.norm));
    const cashiers = [];
    const unassigned = [];
    const defaultReportDay = resolveDefaultReportDay(options);
    let currentDay = '';

    for (let r = dataStartRow; r < grid.length; r++) {
        const row = grid[r];
        if (!row || !row.length || isMegaOlapRow(row)) continue;

        const dateRaw = row[fiscalCol];
        const nameRaw = row[cashierCol];
        const entityRaw = entityCol >= 0 ? row[entityCol] : null;
        const dateCell = cellText(dateRaw);
        const nameCell = cellText(nameRaw);
        const entityCell = cellText(entityRaw);

        if (/^(sum|total)$/i.test(dateCell) || /^(sum|total)$/i.test(nameCell)) break;
        if (!dateCell && !nameCell && !entityCell) continue;

        const qtyByColumn = {};
        for (const col of activeCols) {
            const value = num(row[col.index]);
            if (value) qtyByColumn[col.item] = value;
        }
        const hasQty = Object.keys(qtyByColumn).length > 0;

        // Store label row (e.g. "3811 Chirnside Park" in fiscal col) - not a cashier line.
        if (
            entityCol < 0 &&
            !hasQty &&
            !nameCell &&
            (STORE_ENTITY_RE.test(dateCell) || extractStoreNumber(dateCell))
        ) {
            continue;
        }

        let day = '';
        let name = '';
        let store = '';
        let storeLabel = '';
        let reason = '';

        if (isDateLabel(dateRaw)) {
            // Standard row: col1=date, col2=name, col3=store
            day = normalizeDayIso(dateRaw);
            currentDay = day;
            name = nameCell.trim();
            storeLabel = entityCell.trim();
            store = extractStoreNumber(storeLabel) || '';
            if (!name) reason = 'missing name';
            else if (!store) reason = 'missing store';
        } else if (isAllPeriodDayLabel(dateRaw)) {
            // Today-only export: col1=All, col2=name, col3=store (or no entity column)
            day = defaultReportDay;
            currentDay = day;
            name = nameCell.trim();
            storeLabel = entityCell.trim();
            store = extractStoreNumber(storeLabel) || fallbackStore;
            if (!name) reason = 'missing name';
            else if (!store) reason = 'missing store';
        } else if (
            entityCol < 0
                ? looksLikeCashierName(dateCell, productLabels) &&
                  !isAllPeriodDayLabel(dateRaw) &&
                  !isDateLabel(dateRaw)
                : looksLikeCashierName(dateCell, productLabels) && extractStoreNumber(nameCell)
        ) {
            // Continuation: col1=name, col2=store - or single-store layout with no entity column
            name = dateCell.trim();
            storeLabel = entityCol >= 0 ? nameCell.trim() : '';
            store =
                entityCol >= 0
                    ? extractStoreNumber(storeLabel) || ''
                    : fallbackStore || extractStoreNumber(nameCell) || '';
            day = currentDay;
            if (!day) reason = 'missing date';
            else if (!name) reason = 'missing name';
            else if (!store) reason = 'missing store';
        } else {
            reason = 'column 1 is not a date';
            name = nameCell || dateCell;
            storeLabel = entityCell || nameCell;
            store = extractStoreNumber(storeLabel) || '';
            day = currentDay;
        }

        const incomplete = Boolean(reason || !day || !name || !store);

        if (incomplete) {
            if (hasQty || name || dateCell) {
                unassigned.push(
                    buildUnassignedRow(
                        r,
                        row,
                        layout,
                        { day, name, store, storeLabel, qtyByColumn },
                        reason || 'incomplete row (date, name, or store missing)'
                    )
                );
            }
            continue;
        }

        if (looksLikeDateOrGroupLabel(name)) continue;
        if (ONLINE_CASHIER_RE.test(name) || STORE_ENTITY_RE.test(name)) continue;

        if (!filterStore && !store) {
            unassigned.push(
                buildUnassignedRow(
                    r,
                    row,
                    layout,
                    { day, name, store, storeLabel, qtyByColumn },
                    'missing store'
                )
            );
            continue;
        }
        if (filterStore && store !== filterStore) continue;
        if (!hasQty) continue;

        cashiers.push({
            name,
            day,
            store,
            qtyByColumn,
        });
    }

    return {
        cashiers: mergeCashierRecords([], cashiers),
        unassigned,
    };
}

function normalizeFilterStore(value) {
    const store = String(value || '').trim();
    if (!store || store === '*' || store.toLowerCase() === 'all') return '';
    return store;
}

function parseUpsellGrid(grid, pointsByLabel, options = {}) {
    const filterStore = normalizeFilterStore(options.filterStoreNumber);
    const cleanGrid = stripMegaOlapRows(grid);
    const flatLayout = findFlatFiscalCashierLayout(cleanGrid);
    if (flatLayout) {
        const { cashiers: flatCashiers, unassigned = [] } = parseFlatFiscalCashierRows(
            cleanGrid,
            flatLayout,
            filterStore,
            pointsByLabel,
            options
        );
        let cashiers = flatCashiers;
        if (options.syncDay) {
            cashiers = cashiers.filter((row) => row.day === options.syncDay);
        }
        const columnsUsed = [];
        const seenItems = new Set();
        for (const col of flatLayout.itemHeaders) {
            if (seenItems.has(col.item)) continue;
            seenItems.add(col.item);
            columnsUsed.push(col.item);
        }
        return {
            sheetName: 'MdxView',
            cashierCol: flatLayout.cashierCol,
            headerRowIndex: flatLayout.headerRowIndex,
            columnsUsed,
            scoringMode: 'fiscalItems',
            cashiers,
            unassigned,
        };
    }

    const megaText = extractMegaOlapText(grid);
    const { rowIndex, cashierCol, headerRow } = findHeaderRow(cleanGrid);
    const fiscalCol = findFiscalDayColumn(headerRow, cashierCol);
    const totalCol = findTotalColumn(headerRow, cashierCol);
    const dateCols = totalCol < 0 ? findDateColumns(headerRow, cashierCol) : [];
    const allColsMeta = buildColumnMeta(headerRow).filter((col) => col.index !== cashierCol);
    const mappedItemCols = allColsMeta.filter((col) => pointsByLabel.has(col.norm));
    const useDateColumnMode =
        totalCol < 0 &&
        dateCols.length >= 2 &&
        fiscalCol < 0 &&
        mappedItemCols.length < 2;

    const cashiers = [];
    let columnsUsed = [];
    let scoringMode = 'items';

    if (totalCol >= 0) {
        scoringMode = 'total';
        columnsUsed = [String(headerRow[totalCol] ?? 'Total').trim()];
        for (let r = rowIndex + 1; r < cleanGrid.length; r++) {
            const row = cleanGrid[r];
            if (!row || !row.length) continue;
            const name = String(row[cashierCol] ?? '').trim();
            if (!name || looksLikeDateOrGroupLabel(name)) continue;
            if (ONLINE_CASHIER_RE.test(name) || STORE_ENTITY_RE.test(name)) continue;
            cashiers.push({ name, totalPoints: num(row[totalCol]) });
        }
    } else if (useDateColumnMode) {
        scoringMode = 'competitionDates';
        columnsUsed = dateCols.map((c) => String(headerRow[c] ?? '').trim());
        for (let r = rowIndex + 1; r < cleanGrid.length; r++) {
            const row = cleanGrid[r];
            if (!row || !row.length) continue;
            const name = String(row[cashierCol] ?? '').trim();
            if (!name || looksLikeDateOrGroupLabel(name)) continue;
            if (ONLINE_CASHIER_RE.test(name) || STORE_ENTITY_RE.test(name)) continue;
            let totalPoints = 0;
            const qtyByColumn = {};
            for (const c of dateCols) {
                const v = num(row[c]);
                totalPoints += v;
                const label = String(headerRow[c] ?? '').trim() || `col${c}`;
                qtyByColumn[label] = v;
            }
            cashiers.push({ name, totalPoints, qtyByColumn });
        }
    } else {
        const storeHeader = findStoreHeaderRow(cleanGrid, rowIndex, cashierCol);
        const itemStoreCols = buildItemStoreColsFromGrid(cleanGrid, rowIndex, cashierCol).filter(
            (col) => !isDateColumnHeader(col.item)
        );
        const mappedCols = itemStoreCols.filter((col) => pointsByLabel.has(col.norm));
        let activeCols = mappedCols.length ? mappedCols : itemStoreCols;
        if (filterStore) {
            activeCols = activeCols.filter((col) => col.storeNumber === filterStore);
            if (!activeCols.length) {
                console.warn(
                    `[Upselling] No item columns for store ${filterStore} in BI grid - check report layout`
                );
            }
        }
        const uniqueItems = [];
        const seenItems = new Set();
        for (const col of activeCols) {
            if (seenItems.has(col.item)) continue;
            seenItems.add(col.item);
            uniqueItems.push(col.item);
        }
        columnsUsed = uniqueItems;
        const productLabels = new Set(uniqueItems.map((x) => normalizeLabel(x)));
        const qtyShift =
            storeHeader != null
                ? detectQtyColumnShift(cleanGrid, rowIndex, cashierCol, storeHeader.rowIndex)
                : 0;
        const firstStoreCol =
            storeHeader != null
                ? firstStoreColumn(storeHeader.row, cashierCol)
                : -1;

        const gridCashiers = [];
        let currentDay = '';
        for (let r = rowIndex + 1; r < cleanGrid.length; r++) {
            const row = cleanGrid[r];
            if (!row || !row.length || isMegaOlapRow(row)) continue;

            const { day, name } = extractRowCashier(row, currentDay, productLabels);
            if (day && !name) {
                currentDay = day;
                continue;
            }
            if (!name) continue;
            currentDay = day || currentDay;

            const qtyByStore = parseRowQtyByStore(
                row,
                activeCols,
                qtyShift,
                cashierCol,
                firstStoreCol,
                storeHeader?.row
            );
            flushQtyByStore(name, currentDay, qtyByStore, gridCashiers);
        }

        let mergedCashiers = gridCashiers;
        if (!mergedCashiers.length && megaText) {
            const megaCols = itemStoreCols.filter((col) => pointsByLabel.has(col.norm));
            mergedCashiers = parseMegaOlapCashiers(
                megaText,
                megaCols.length ? megaCols : itemStoreCols,
                productLabels
            );
        }
        if (filterStore) {
            mergedCashiers = mergedCashiers.filter((row) => row.store === filterStore);
        }
        cashiers.push(...mergedCashiers);
    }

    if (options.syncDay) {
        const filtered = cashiers.filter((row) => row.day === options.syncDay);
        cashiers.length = 0;
        cashiers.push(...filtered);
    }

    return {
        sheetName: 'MdxView',
        cashierCol,
        headerRowIndex: rowIndex,
        columnsUsed,
        scoringMode,
        cashiers,
        unassigned: [],
    };
}

function parseUpsellReport(filePath, pointsByLabel, options = {}) {
    const { grid, sheetName } = loadGrid(filePath);
    const parsed = parseUpsellGrid(grid, pointsByLabel, options);
    parsed.sheetName = sheetName;
    return parsed;
}

module.exports = {
    ONLINE_CASHIER_RE,
    CATEGORY_COLUMN_RE,
    parseUpsellGrid,
    parseUpsellReport,
    looksLikeDateOrGroupLabel,
    buildItemStoreColsFromGrid,
    findStoreHeaderRow,
};
