const { loadGrid } = require('../reportReader');
const { normalizeLabel } = require('./pointsFile');

const ONLINE_CASHIER_RE = /online\s*\d*\s*cashier/i;
/** Store / entity label rows in the BI grid — not a person. */
const STORE_ENTITY_RE = /^\d{4}\s+[a-z]|^entity\b|chirnside\s+park$/i;
/** MMX category group headers (BOX_MEALS, DESSERTS) — not leaf item columns. */
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
            const score = (hasFiscal ? 1000 : 0) + row.length + r;
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
    const s = String(value || '').trim();
    return /^\d{4}-\d{2}-\d{2}|^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(s);
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

/** OLAP often renders the full pivot as one very wide <tr>. */
function parseHorizontalCashierStream(row, leafCols, productLabels) {
    const cashiers = [];
    const itemCount = leafCols.length;
    if (!itemCount) return cashiers;

    let currentDay = '';
    const seen = new Set();
    let i = 0;
    while (i < row.length) {
        const s = String(row[i] ?? '').trim();
        if (!s) {
            i++;
            continue;
        }
        if (isDateLabel(s)) {
            currentDay = s;
            i++;
            continue;
        }
        if (/^sum$/i.test(s)) break;
        if (!looksLikeCashierName(s, productLabels)) {
            i++;
            continue;
        }
        if (!currentDay) {
            i++;
            continue;
        }
        const name = s;
        const dedupeKey = `${currentDay}|${normalizeLabel(name)}`;
        if (seen.has(dedupeKey)) {
            i++;
            while (i < row.length) {
                const cell = String(row[i] ?? '').trim();
                if (!cell) {
                    i++;
                    continue;
                }
                if (isDateLabel(cell) || looksLikeCashierName(cell, productLabels)) break;
                if (/^-?\d+(\.\d+)?$/.test(cell)) {
                    i++;
                    continue;
                }
                i++;
            }
            continue;
        }
        seen.add(dedupeKey);
        i++;
        const qtyValues = [];
        while (qtyValues.length < itemCount && i < row.length) {
            const cell = String(row[i] ?? '').trim();
            if (!cell) {
                i++;
                continue;
            }
            if (isDateLabel(cell) || looksLikeCashierName(cell, productLabels)) break;
            if (/^-?\d+(\.\d+)?$/.test(cell)) {
                qtyValues.push(num(cell));
                i++;
                continue;
            }
            i++;
        }
        const qtyByColumn = {};
        for (let j = 0; j < leafCols.length; j++) {
            qtyByColumn[leafCols[j].raw] = qtyValues[j] ?? 0;
        }
        cashiers.push({ name, day: currentDay, qtyByColumn });
    }
    return cashiers;
}

function isWideDataRow(row) {
    return (row || []).length > 60;
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

function parseUpsellGrid(grid, pointsByLabel) {
    const { rowIndex, cashierCol, headerRow } = findHeaderRow(grid);
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
        for (let r = rowIndex + 1; r < grid.length; r++) {
            const row = grid[r];
            if (!row || !row.length) continue;
            const name = String(row[cashierCol] ?? '').trim();
            if (!name || looksLikeDateOrGroupLabel(name)) continue;
            if (ONLINE_CASHIER_RE.test(name) || STORE_ENTITY_RE.test(name)) continue;
            cashiers.push({ name, totalPoints: num(row[totalCol]) });
        }
    } else if (useDateColumnMode) {
        scoringMode = 'competitionDates';
        columnsUsed = dateCols.map((c) => String(headerRow[c] ?? '').trim());
        for (let r = rowIndex + 1; r < grid.length; r++) {
            const row = grid[r];
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
        const allCols = buildColumnMeta(headerRow).filter(
            (col) =>
                col.index !== cashierCol &&
                !isHeaderMetaColumn(col.raw) &&
                !isDateColumnHeader(col.raw) &&
                !/^-?\d+(\.\d+)?$/.test(col.raw)
        );
        const leafCols = selectLeafColumns(allCols, pointsByLabel);
        columnsUsed = leafCols.map((c) => c.raw);
        const productLabels = new Set(leafCols.map((c) => normalizeLabel(c.raw)));
        const wideRows = grid.filter((row) => isWideDataRow(row));
        if (wideRows.length) {
            const bestWide = wideRows.reduce((a, b) => ((a || []).length >= (b || []).length ? a : b));
            cashiers.push(...parseHorizontalCashierStream(bestWide, leafCols, productLabels));
        } else {
            let currentDay = '';
            for (let r = rowIndex + 1; r < grid.length; r++) {
                const row = grid[r];
                if (!row || !row.length) continue;

                const { day, name, nameCol } = extractRowCashier(row, currentDay, productLabels);
                if (day && !name) {
                    currentDay = day;
                    continue;
                }
                if (!name) continue;
                currentDay = day || currentDay;

                const qtyValues = qtyCellsAfterName(row, nameCol);
                const qtyByColumn = {};
                for (let i = 0; i < leafCols.length; i++) {
                    const col = leafCols[i];
                    qtyByColumn[col.raw] = qtyValues[i] ?? 0;
                }
                cashiers.push({ name, day: currentDay, qtyByColumn });
            }
        }
    }

    return {
        sheetName: 'MdxView',
        cashierCol,
        headerRowIndex: rowIndex,
        columnsUsed,
        scoringMode,
        cashiers,
    };
}

function parseUpsellReport(filePath, pointsByLabel) {
    const { grid, sheetName } = loadGrid(filePath);
    const parsed = parseUpsellGrid(grid, pointsByLabel);
    parsed.sheetName = sheetName;
    return parsed;
}

module.exports = {
    ONLINE_CASHIER_RE,
    CATEGORY_COLUMN_RE,
    parseUpsellGrid,
    parseUpsellReport,
    looksLikeDateOrGroupLabel,
};
