#!/usr/bin/env node
/**
 * Read-only Key Item Count match test — opens MMX, checks catalog items exist on each tab.
 * Does NOT fill quantities, Save, Continue, or Apply.
 *
 * Usage:
 *   npm run verify-mmx-count -- 3811
 *   npm run verify-mmx-count -- 3811 --vendor americold
 *   npm run verify-mmx-count -- 3811 --headed
 *   npm run verify-mmx-count -- 3811 --allow-create
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env.production'), override: true });

const { listConfiguredVendors, getVendorCatalog } = require('../src/services/vendorCatalog');
const { lookupKeysForMmx, clearItemCodesCache } = require('../src/services/itemCodes');
const { verifyCatalogReportCoverage } = require('../src/services/catalogReportCoverage');

const REPORTS_DIR = path.join(__dirname, '..', 'Reports');
const { openMacromatixBrowser, closeBrowserQuietly, selectStoreOnPage } = require('../src/services/macromatixScraper');
const {
    loadMmxStockCountConfig,
    openKeyItemCountForVerification,
    verifyKeyItemCountCatalog,
} = require('../src/services/mmxReports/mmx-stock-count');

function parseArgs(argv) {
    const args = argv.slice(2);
    const storeNumber = args.find((a) => /^\d{3,6}$/.test(a)) || '3811';
    const vendor =
        args.includes('--vendor') && args[args.indexOf('--vendor') + 1]
            ? args[args.indexOf('--vendor') + 1]
            : null;
    return {
        storeNumber,
        vendor,
        headed: args.includes('--headed'),
        allowCreate: args.includes('--allow-create'),
        json: args.includes('--json'),
    };
}

function printReportResults(reportResults) {
    for (const r of reportResults) {
        console.log(`\n=== Reports: ${r.vendor} (${r.slug}) ===`);
        if (!r.hasAnyReport) {
            console.log(`  No files under ${path.join(r.reportsRoot, '…')} — drop ISE exports in Reports/<store>/ to verify.`);
            continue;
        }
        console.log(
            `  ISE: ${r.files.inventorySpecialEvent ? path.basename(r.files.inventorySpecialEvent) : '—'}`
        );
        console.log(`  On hand: ${r.files.stockOnHand ? path.basename(r.files.stockOnHand) : '—'}`);
        console.log(`  On order: ${r.files.stockOnOrder ? path.basename(r.files.stockOnOrder) : '—'}`);
        console.log(
            `  ISE usage check: ${r.summary.checked} catalog lines  ${r.summary.missing} need alias/usage  ${r.summary.skippedManual} count-driven (reports optional)`
        );
        console.log(
            '  (On-hand / on-order gaps are normal — ordering uses app counts vs build-to, then scheduled orders in MMX.)'
        );
        for (const m of r.missing) {
            const hint = m.diagnosis?.length ? ` — ${m.diagnosis.join('; ')}` : '';
            console.log(
                `    ✗ ${m.itemCode}  ${m.name}  [ISE]  keys: ${m.lookupKeys.join(', ')}${hint}`
            );
        }
    }
}

function printResults(allResults) {
    for (const result of allResults) {
        console.log(`\n=== ${result.vendor} (${result.slug}) ===`);
        console.log(
            `Rows: ${result.summary.found} ok  ${result.summary.missing} not on tab  ${result.summary.columnMissing} column mismatch  Skipped: ${result.summary.skipped}`
        );

        for (const loc of result.locations) {
            console.log(`\n  ${loc.locationName} → MMX "${loc.mmxTab}" (${loc.gridRows} grid rows)`);
            if (loc.error) console.log(`    TAB ERROR: ${loc.error}`);
            for (const f of loc.found) {
                console.log(`    ✓ ${f.itemCode || '—'}  ${f.name}`);
                if (f.columns) console.log(`        ${f.columns}`);
            }
            for (const c of loc.columnIssues || []) {
                const miss = c.columnCheck?.missing || [];
                const mmxSlots = c.columnCheck?.mmxSlots?.join(',') || '?';
                console.log(`    ⚠ ${c.itemCode || '—'}  ${c.name}  (on tab; MMX slots: ${mmxSlots})`);
                for (const col of miss) {
                    console.log(
                        `        catalog "${col.catalogLabel}" needs ${col.mmxLabel} (tbOH${col.mmxSlot}) — not on row`
                    );
                }
            }
            for (const m of loc.missing) {
                console.log(`    ✗ ${m.itemCode || '—'}  ${m.name}${m.reason ? ` (${m.reason})` : ''}`);
            }
        }

        if (result.skippedKeyItemCount.length) {
            console.log(`\n  Skipped Key Item Count (${result.skippedKeyItemCount.length} order= / manual lines):`);
            for (const s of result.skippedKeyItemCount.slice(0, 5)) {
                console.log(`    · ${s.itemCode || '—'}  ${s.name}`);
            }
            if (result.skippedKeyItemCount.length > 5) {
                console.log(`    … +${result.skippedKeyItemCount.length - 5} more`);
            }
        }
    }
}

async function main() {
    const { storeNumber, vendor, headed, allowCreate, json } = parseArgs(process.argv);
    clearItemCodesCache();
    const cfg = loadMmxStockCountConfig();

    const vendors = listConfiguredVendors()
        .filter((v) => v.configured)
        .filter((v) => !vendor || v.slug === vendor);

    if (!vendors.length) {
        throw new Error(vendor ? `Vendor not configured: ${vendor}` : 'No vendor catalogs found');
    }

    let browser;
    let page;
    try {
        ({ browser, page } = await openMacromatixBrowser({ headless: !headed }));
        await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(2000);

        const picked = await selectStoreOnPage(page, storeNumber);
        if (!picked) throw new Error(`Could not select store ${storeNumber} in Macromatix`);
        console.log(`Store: ${picked}`);
        await page.waitForTimeout(1500);

        const countMode = await openKeyItemCountForVerification(page, cfg, { allowCreate });
        console.log(`Key Item Count mode: ${countMode.mode}${countMode.batch ? ` batch ${countMode.batch}` : ''}`);
        console.log('Read-only — no Save, Continue, or Apply will be clicked.\n');

        const allResults = [];
        const reportResults = [];
        for (const entry of vendors) {
            const catalog = getVendorCatalog(entry.slug);
            if (!catalog) continue;
            const result = await verifyKeyItemCountCatalog(page, catalog, cfg, { lookupKeysForMmx });
            allResults.push(result);
            reportResults.push(verifyCatalogReportCoverage(storeNumber, catalog, REPORTS_DIR));
        }

        if (json) {
            console.log(
                JSON.stringify({ storeNumber, countMode, results: allResults, reports: reportResults }, null, 2)
            );
        } else {
            printResults(allResults);
            printReportResults(reportResults);
        }

        const totalMissing = allResults.reduce((n, r) => n + r.summary.missing, 0);
        const totalColumnMissing = allResults.reduce((n, r) => n + r.summary.columnMissing, 0);
        const totalTabErrors = allResults.reduce((n, r) => n + r.summary.tabErrors, 0);
        const totalReportMissing = reportResults.reduce((n, r) => n + r.summary.missing, 0);
        console.log(
            `\nDone. Not on KIC tab: ${totalMissing}, column mismatch: ${totalColumnMissing}, tab errors: ${totalTabErrors}, ISE alias gaps (13-day build-to only): ${totalReportMissing}`
        );
        console.log(
            'MMX slots: 1=Box/carton, 2=Inner/bag, 3=Unit/kg/each — catalog columns map left-to-right to these fields.'
        );
        process.exit(totalMissing || totalColumnMissing || totalTabErrors ? 1 : 0);
    } finally {
        await closeBrowserQuietly(browser, 'verify-mmx-key-item-count');
    }
}

main().catch((err) => {
    console.error('[verify-mmx-key-item-count]', err.message || err);
    process.exit(1);
});
