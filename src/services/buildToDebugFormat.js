const path = require('path');
const { normalizeItemCode } = require('./reportReader');
const { allLookupKeys } = require('./itemCodes');

function round4(n) {
    return Math.round(Number(n) * 10000) / 10000;
}

function findIseEntry(items, itemCode) {
    if (!items) return null;
    const keys = allLookupKeys(itemCode);
    for (const key of keys) {
        const hit = items.get(normalizeItemCode(key));
        if (hit) return hit;
    }
    return items.get(normalizeItemCode(itemCode)) || null;
}

function filterByItemCode(code, itemCodeFilter) {
    if (!itemCodeFilter) return true;
    return normalizeItemCode(code) === itemCodeFilter;
}

/**
 * Print ISE day-by-day usage, build-to math, and scheduled-order recommendations.
 */
function printBuildToDebug({
    storeNumber,
    buildTo,
    byVendorId,
    iseFile,
    iseItems,
    iseDayLabels,
    itemCode = '',
    vendorId = '',
}) {
    const itemFilter = itemCode ? normalizeItemCode(itemCode) : '';
    const reportName = iseFile ? path.basename(iseFile) : '(no ISE file)';

    console.log(`\n========== Build-to debug — store ${storeNumber} ==========`);
    console.log(`ISE file: ${reportName}`);
    if (iseDayLabels?.length) {
        console.log(`ISE week columns: ${iseDayLabels.join(' | ')}`);
    }

    const lines = (buildTo?.lines || []).filter((line) => filterByItemCode(line.itemCode, itemFilter));
    if (!lines.length) {
        console.log('  (no matching ISE / build-to lines)');
    }

    for (const line of lines) {
        const code = normalizeItemCode(line.itemCode);
        const ise = findIseEntry(iseItems, code);
        const labels = ise?.dayLabels || iseDayLabels || [];
        const values = ise?.dayValues || [];

        const iseCode = normalizeItemCode(line.iseItemCode || code);
        const codeLabel = iseCode !== code ? `${iseCode} (catalog ${code})` : code;
        console.log(`\n--- ${codeLabel} ${String(line.description || ise?.description || '').trim()} ---`);
        if (ise?.unit) console.log(`  Unit: ${ise.unit}`);
        if (values.length) {
            console.log('  ISE daily usage (cartons):');
            for (let i = 0; i < values.length; i++) {
                const label = labels[i] || `Day${i + 1}`;
                console.log(`    ${label.padEnd(22)} ${values[i]}`);
            }
            const sum = ise?.daySum ?? values.reduce((a, b) => a + b, 0);
            console.log(
                `    ${'7-day sum'.padEnd(22)} ${round4(sum)}  →  avg = ${round4(line.avgDaily ?? ise?.avgDaily)} (${sum} ÷ ${values.length})`
            );
        } else {
            console.log('  ISE: (no row in file — check item code / alias in .item-codes)');
        }

        const days = line.buildToDays ?? '—';
        console.log(`  Build-to: ${round4(line.avgDaily)} avg × ${days} days = ${round4(line.buildTo)} cartons`);
        console.log(
            `  Stock on hand: ${round4(line.onHandCartons)} (${line.onHandSource || '—'})  |  on order: ${round4(line.onOrderCartons)}`
        );
        const rawOrder = round4((line.buildTo || 0) - (line.onHandCartons || 0) - (line.onOrderCartons || 0));
        const matchNote = line.iseMatchSource === 'name' ? ' (ISE matched by name)' : '';
        console.log(
            `  Order (build-to − on-hand − on-order): ${rawOrder}  →  qty used: ${round4(line.orderQty)}  [${line.buildToSource || ''}]${matchNote}`
        );
    }

    console.log('\n--- Scheduled order recommendations (by vendor) ---');
    let anyVendor = false;
    for (const [id, pack] of Object.entries(byVendorId || {})) {
        if (vendorId && id !== vendorId) continue;
        const entries = (pack.buildToEntries || []).filter((entry) => {
            const code = normalizeItemCode(entry.catalogItemCode || entry.iseItemCode);
            return filterByItemCode(code, itemFilter);
        });
        const mmxLines = (pack.lines || []).filter((line) =>
            filterByItemCode(line.itemCode, itemFilter)
        );
        if (!entries.length && !mmxLines.length) continue;
        anyVendor = true;
        console.log(`\n  ${pack.vendor?.label || id} (${id})`);
        for (const entry of entries) {
            const code = normalizeItemCode(entry.catalogItemCode || entry.iseItemCode);
            const bl = (buildTo?.lines || []).find((l) => normalizeItemCode(l.itemCode) === code);
            console.log(
                `    ${code}\trecommended=${round4(entry.orderQty)}\t${entry.buildToSource || ''}\t${entry.catalogName || entry.description || ''}`
            );
            if (bl && round4(entry.orderQty) !== round4(bl.orderQty)) {
                console.log(`      (ISE line order=${round4(bl.orderQty)} — vendor pass may round or merge counts)`);
            }
        }
        for (const line of mmxLines) {
            console.log(`    → MMX grid qty ${round4(line.quantity)}\t${line.itemCode}\t${line.itemName || ''}`);
        }
    }
    if (!anyVendor) console.log('  (no matching vendor order lines)');
    console.log('');
}

module.exports = {
    printBuildToDebug,
    findIseEntry,
};
