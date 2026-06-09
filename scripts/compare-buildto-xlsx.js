#!/usr/bin/env node
/**
 * Compare store 3811 Excel build-to workbook vs dashboard calculateBuildToOrders.
 */
const path = require('path');
const XLSX = require('xlsx');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { calculateBuildToOrders } = require('../src/services/buildToCalculator');
const { buildOrderLinesByVendorId } = require('../src/services/buildToOrderLines');
const { getVendorCatalog } = require('../src/services/vendorCatalog');
const { normalizeItemCode } = require('../src/services/reportReader');
const { allLookupKeys } = require('../src/services/itemCodes');

const XLSX_PATH =
    process.argv[2] ||
    path.join(__dirname, '../data/buildto-3811-copy.xlsx');
const STORE = process.argv[3] || '3811';

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function parseSheetRows(wb, sheetName, headerMarker) {
    const ws = wb.Sheets[sheetName];
    if (!ws) return [];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    let start = rows.findIndex((r) =>
        (r || []).some((c) => String(c || '').includes(headerMarker))
    );
    if (start < 0) return [];
    start += 1; // data after header row with PER PACK
    const out = [];
    for (let i = start; i < rows.length; i++) {
        const r = rows[i] || [];
        const mmxCode = normalizeItemCode(r[12] ?? r[11] ?? r[1]);
        const orderCode = normalizeItemCode(r[1]);
        const name = String(r[5] || r[4] || r[0] || '').trim();
        const daily = num(r[6]);
        const onHand = num(r[7]);
        const buildTo = num(r[10]);
        const need = num(r[11]);
        if (!mmxCode && !orderCode && !name) {
            if (String(r[4] || '').includes('BUILD TO GUIDE')) break;
            continue;
        }
        if (!mmxCode && !orderCode) continue;
        out.push({
            sheet: sheetName,
            orderCode,
            mmxCode: mmxCode || orderCode,
            name,
            daily,
            onHand,
            buildTo,
            need,
        });
    }
    return out;
}

function catalogIndex() {
    const byCode = new Map();
    for (const slug of ['americold', 'schweppes', 'bega', 'cutfresh']) {
        const cat = getVendorCatalog(slug);
        if (!cat) continue;
        for (const item of cat.items || []) {
            const code = normalizeItemCode(item.itemCode);
            if (!code) continue;
            byCode.set(code, { ...item, catalogSlug: slug });
            for (const key of allLookupKeys(code)) {
                if (key && !byCode.has(key)) byCode.set(key, { ...item, catalogSlug: slug });
            }
        }
    }
    return byCode;
}

function appBuildToForCode(code, buildToResult, orderPack) {
    const keys = [...new Set([code, ...allLookupKeys(code)].filter(Boolean))];
    for (const k of keys) {
        const line = (buildToResult.lines || []).find(
            (l) =>
                normalizeItemCode(l.itemCode) === k ||
                normalizeItemCode(l.iseItemCode) === k
        );
        if (line && line.buildTo != null && !line.buildToManual) {
            return {
                buildTo: line.buildTo,
                orderQty: line.orderQty,
                avgDaily: line.avgDaily,
                buildToDays: line.buildToDays,
                buildToSource: line.buildToSource,
                onHand: line.onHandCartons,
                source: 'ise-line',
            };
        }
    }
    for (const k of keys) {
        for (const pack of Object.values(orderPack?.byVendorId || {})) {
            const entry = (pack.buildToEntries || []).find(
                (e) => normalizeItemCode(e.catalogItemCode || e.iseItemCode) === k
            );
            if (entry) {
                return {
                    buildTo: entry.buildToFixed ?? entry.buildTo ?? null,
                    orderQty: entry.orderQty,
                    buildToSource: entry.buildToSource,
                    source: 'order-entry',
                };
            }
        }
    }
    const cat = catalogIndex().get(code);
    if (cat?.buildToFixed != null) {
        return {
            buildTo: cat.buildToFixed,
            orderQty: null,
            buildToSource: cat.buildToOrderManual ? 'catalog-manual-fixed' : 'catalog-fixed',
            source: 'catalog',
        };
    }
    return null;
}

function closeEnough(a, b, tol = 0.15) {
    if (a == null || b == null) return false;
    if (Math.abs(a - b) <= tol) return true;
    const denom = Math.max(Math.abs(a), Math.abs(b), 0.01);
    return Math.abs(a - b) / denom < 0.1;
}

async function main() {
    const wb = XLSX.readFile(XLSX_PATH);
    const excelRows = [
        ...parseSheetRows(wb, 'DRY', '1 DAY USAGE'),
        ...parseSheetRows(wb, 'FRIDGE & FREEZER', '1 DAY USAGE'),
        ...parseSheetRows(wb, 'SCHWEPPES', '1 DAY USAGE'),
        ...parseSheetRows(wb, 'BEGA', '1 DAY USAGE'),
        ...parseSheetRows(wb, 'CUTFRESH', '1 DAY USAGE'),
    ].filter((r) => r.mmxCode && (r.buildTo != null || r.daily != null));

    let buildToResult;
    let orderPack;
    let reportsMissing = false;
    try {
        buildToResult = await calculateBuildToOrders(STORE, { preferReportOnHand: true });
        orderPack = await buildOrderLinesByVendorId(STORE, { preferReportOnHand: true });
    } catch (e) {
        reportsMissing = true;
        console.error('No local reports — comparing catalog/rules only:', e.message);
        buildToResult = { lines: [] };
        orderPack = { byVendorId: {} };
    }

    const catIdx = catalogIndex();
    const mismatches = [];
    const matches = [];
    const noApp = [];

    for (const row of excelRows) {
        const code = row.mmxCode;
        const app = appBuildToForCode(code, buildToResult, orderPack);
        const cat = catIdx.get(code);
        const excelBt = row.buildTo;
        const appBt = app?.buildTo;

        if (!app && !cat) {
            noApp.push(row);
            continue;
        }

        const expectedDays =
            cat?.buildToDays ??
            (cat?.buildToOrderManual || cat?.buildToManual ? null : 10);
        const impliedDays =
            row.daily > 0 && excelBt != null ? Math.round(excelBt / row.daily) : null;

        if (appBt != null && closeEnough(excelBt, appBt)) {
            matches.push({ ...row, appBt, app });
            continue;
        }

        mismatches.push({
            code,
            name: row.name,
            sheet: row.sheet,
            excelBuildTo: excelBt,
            excelDaily: row.daily,
            excelNeed: row.need,
            excelOnHand: row.onHand,
            impliedExcelDays: impliedDays,
            appBuildTo: appBt,
            appDaily: app?.avgDaily,
            appDays: app?.buildToDays,
            catalogDays: expectedDays,
            catalogRule: cat
                ? `${cat.buildToManual ? 'manual' : ''}${cat.buildToOrderManual ? '=order' : ''}${cat.buildToDays ? `${cat.buildToDays}d` : ''}${cat.buildToFixed != null ? `fixed${cat.buildToFixed}` : ''}`
                : '—',
            appSource: app?.buildToSource,
            orderCode: row.orderCode !== code ? row.orderCode : null,
        });
    }

    console.log(`\n=== Build-to compare: Excel vs app (store ${STORE}) ===`);
    console.log(`Excel rows: ${excelRows.length} | Match (±10%): ${matches.length} | Mismatch: ${mismatches.length} | No catalog/app: ${noApp.length}`);
    if (reportsMissing) console.log('(Reports missing locally — ISE-based build-to from app will be empty)\n');

    const byReason = {
        codeAlias: [],
        daysRule: [],
        manualFixed: [],
        missingIse: [],
        other: [],
    };

    for (const m of mismatches) {
        if (m.orderCode && m.orderCode !== m.code) byReason.codeAlias.push(m);
        else if (m.catalogRule.includes('manual') || m.catalogRule.includes('fixed'))
            byReason.manualFixed.push(m);
        else if (m.appBuildTo == null) byReason.missingIse.push(m);
        else if (m.impliedExcelDays && m.catalogDays && m.impliedExcelDays !== m.catalogDays)
            byReason.daysRule.push(m);
        else byReason.other.push(m);
    }

    console.log('\n--- Mismatch buckets ---');
    console.log(`Order-form vs MMX code column: ${byReason.codeAlias.length}`);
    console.log(`manual=/fixed par (Excel uses packs/different target): ${byReason.manualFixed.length}`);
    console.log(`Different build-to days (Excel ~10d vs catalog 7/13): ${byReason.daysRule.length}`);
    console.log(`No ISE / no app line: ${byReason.missingIse.length}`);
    console.log(`Other (usage/SOH/rounding): ${byReason.other.length}`);

    function printSample(label, arr, n = 12) {
        if (!arr.length) return;
        console.log(`\n--- ${label} (first ${Math.min(n, arr.length)}) ---`);
        for (const m of arr.slice(0, n)) {
            console.log(
                `${m.code} ${m.name?.slice(0, 28) || ''} | Excel BT=${m.excelBuildTo} (daily ${m.excelDaily}) | App BT=${m.appBuildTo} (${m.catalogRule}, appDays=${m.appDays})`
            );
        }
    }

    printSample('Order form code ≠ MMX code', byReason.codeAlias);
    printSample('manual=/fixed lines', byReason.manualFixed);
    printSample('Days rule differences', byReason.daysRule);
    printSample('Missing ISE in app', byReason.missingIse);
    printSample('Other', byReason.other);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
