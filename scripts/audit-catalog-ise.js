#!/usr/bin/env node
/**
 * Audit catalog items vs ISE / SOH / SOO for a store.
 * Usage: node scripts/audit-catalog-ise.js 3811 [--vendor americold] [--location Freezer] ...
 */
const path = require('path');
const { getVendorCatalog } = require('../src/services/vendorCatalog');
const {
    parseInventorySpecialEvent,
    parseStockOnHand,
    parseStockOnOrder,
    resolveStoreReports,
    normalizeItemCode,
} = require('../src/services/reportReader');
const { allLookupKeys } = require('../src/services/itemCodes');
const { nameMatchScore } = require('../src/services/orderItemNameMatch');

const REPORTS_DIR = path.join(__dirname, '..', 'Reports');
const MIN_NAME_SCORE = 25;

function parseArgs(argv) {
    const storeNumber = (argv[2] || '').replace(/\D/g, '');
    let vendor = 'americold';
    const locations = [];
    for (let i = 3; i < argv.length; i++) {
        if (argv[i] === '--vendor' && argv[i + 1]) {
            vendor = String(argv[++i]).trim().toLowerCase();
        } else if (argv[i] === '--location' && argv[i + 1]) {
            locations.push(argv[++i]);
        }
    }
    return { storeNumber, vendor, locations };
}

function findInMap(keys, map) {
    if (!map) return null;
    for (const key of keys) {
        const hit = map.get(normalizeItemCode(key));
        if (hit) return { key: normalizeItemCode(key), row: hit };
    }
    return null;
}

function bestIseByName(name, ise, usedCodes) {
    let best = null;
    let bestScore = 0;
    for (const [code, row] of ise.entries()) {
        if (usedCodes.has(code)) continue;
        const score = nameMatchScore(name, row.description);
        if (score > bestScore) {
            bestScore = score;
            best = { code, row, score };
        }
    }
    return best;
}

function itemInLocations(item, locations) {
    if (!locations?.length) return true;
    const locs = item.locations || [];
    return locs.some((l) => locations.includes(l));
}

/** Items that use ISE usage for build-to (KIC lines, oh:N supplies, day-prefixed). */
function shouldAuditItem(item) {
    if (!item.itemCode) return false;
    if (item.buildToManual && !item.buildToOrderManual) return false;
    if (item.buildToOrderManual || item.buildToFixed != null) return false;
    if (item.skipStockCount && item.buildToDays == null) return false;
    return true;
}

function itemBuildToKind(item) {
    if (item.skipStockCount && item.buildToDays != null) return `oh:${item.buildToDays}`;
    if (item.buildToDays != null && item.buildToAdd) return `${item.buildToDays}+${item.buildToAdd}`;
    if (item.buildToDays != null) return String(item.buildToDays);
    return 'default';
}

function main() {
    const { storeNumber, vendor, locations } = parseArgs(process.argv);
    if (!storeNumber) {
        console.error(
            'Usage: node scripts/audit-catalog-ise.js <store> [--vendor slug] [--location Freezer] ...'
        );
        process.exit(1);
    }

    const catalog = getVendorCatalog(vendor);
    if (!catalog) {
        console.error(`Vendor catalog not found: ${vendor}`);
        process.exit(1);
    }

    const files = resolveStoreReports(storeNumber, REPORTS_DIR);
    if (!files.inventorySpecialEvent) {
        console.error(`No ISE report in ${files.storeDir}`);
        process.exit(1);
    }

    const ise = parseInventorySpecialEvent(files.inventorySpecialEvent);
    const soh = files.stockOnHand ? parseStockOnHand(files.stockOnHand, storeNumber) : null;
    const soo = files.stockOnOrder ? parseStockOnOrder(files.stockOnOrder, storeNumber) : null;

    const usedNameFallback = new Set();
    const rows = [];

    for (const item of catalog.items || []) {
        if (!itemInLocations(item, locations)) continue;
        if (!shouldAuditItem(item)) continue;

        const code = normalizeItemCode(item.itemCode);
        const keys = allLookupKeys(code);
        const iseHit = findInMap(keys, ise);
        const sohHit = findInMap(keys, soh);
        const sooHit = findInMap(keys, soo);

        let nameHit = null;
        if (!iseHit) {
            nameHit = bestIseByName(item.name, ise, usedNameFallback);
            if (nameHit && nameHit.score >= MIN_NAME_SCORE) {
                usedNameFallback.add(nameHit.code);
            } else {
                nameHit = null;
            }
        }

        let status = 'missing';
        if (iseHit) status = 'code';
        else if (nameHit) status = 'name-fallback';

        const iseRow = iseHit?.row || nameHit?.row;
        const iseKey = iseHit?.key || nameHit?.code || '';
        const codeAlias = iseHit && iseKey && iseKey !== code;
        const daySum = iseRow?.daySum ?? null;
        const avg = iseRow?.avgDaily ?? null;

        rows.push({
            status,
            code,
            name: item.name,
            kind: itemBuildToKind(item),
            locations: locations.length
                ? (item.locations || []).filter((l) => locations.includes(l)).join(', ')
                : (item.locations || []).join(', '),
            iseKey,
            iseDesc: iseRow?.description || '',
            nameScore: nameHit?.score || 0,
            daySum,
            avg,
            soh: Boolean(sohHit),
            soo: Boolean(sooHit),
            lookupKeys: keys,
            codeAlias,
        });
    }

    const locLabel = locations.length ? locations.join(' + ') : 'all locations';
    console.log(`\n=== ${catalog.label || vendor} - store ${storeNumber} (${locLabel}) ===`);
    console.log(`ISE: ${path.basename(files.inventorySpecialEvent)}`);
    console.log(`SOH: ${files.stockOnHand ? path.basename(files.stockOnHand) : '(missing)'}`);
    console.log('');

    for (const r of rows) {
        const tag =
            r.status === 'code'
                ? 'OK  '
                : r.status === 'name-fallback'
                  ? 'NAME'
                  : 'MISS';
        const usage =
            r.daySum != null ? ` avg=${Number(r.avg).toFixed(4)} sum=${Number(r.daySum).toFixed(2)}` : '';
        const iseInfo = r.iseKey ? ` → ISE ${r.iseKey} "${r.iseDesc}"${usage}` : '';
        const nameNote = r.status === 'name-fallback' ? ` (name score ${r.nameScore})` : '';
        const reports = ` SOH:${r.soh ? 'Y' : 'n'} SOO:${r.soo ? 'Y' : 'n'}`;
        console.log(`${tag} ${r.code}\t[${r.kind}]\t${r.name}${iseInfo}${nameNote}${reports}`);
    }

    const aliases = rows.filter((r) => r.codeAlias);
    if (aliases.length) {
        console.log('\n--- Code aliases in use (.item-codes) ---');
        for (const r of aliases) {
            console.log(`  catalog ${r.code} → ISE/SOH ${r.iseKey}  (${r.name.slice(0, 40)})`);
        }
    }

    const summary = {
        total: rows.length,
        codeMatch: rows.filter((r) => r.status === 'code').length,
        viaAlias: aliases.length,
        nameFallback: rows.filter((r) => r.status === 'name-fallback').length,
        missing: rows.filter((r) => r.status === 'missing').length,
    };
    console.log('\nSummary:', summary);

    const missing = rows.filter((r) => r.status === 'missing');
    if (missing.length) {
        console.log('\n--- Missing items - top ISE name candidates ---');
        for (const m of missing) {
            const candidates = [];
            for (const [c, row] of ise.entries()) {
                const score = nameMatchScore(m.name, row.description);
                if (score >= 15) candidates.push({ code: c, desc: row.description, score });
            }
            candidates.sort((a, b) => b.score - a.score);
            const top = candidates.slice(0, 3);
            console.log(`\n${m.code} ${m.name}`);
            console.log(`  keys: ${m.lookupKeys.join(', ')}`);
            if (!top.length) console.log('  (no name candidates ≥15)');
            for (const t of top) {
                console.log(`  ? ${t.code} "${t.desc}" score=${t.score}`);
            }
        }
    }

    const nameFallback = rows.filter((r) => r.status === 'name-fallback');
    if (nameFallback.length) {
        console.log('\n--- Suggested .item-codes aliases (name fallback) ---');
        for (const r of nameFallback) {
            if (r.code === r.iseKey) continue;
            console.log(`${r.name.split(/\s+/).slice(0, 4).join(' ')} | ${r.code} | ${r.iseKey}`);
        }
    }
}

main();
