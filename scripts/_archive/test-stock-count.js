#!/usr/bin/env node
/**
 * Stock count test helpers - validate catalogs, print URLs, reset saved counts.
 *
 * Usage:
 *   node scripts/test-stock-count.js validate
 *   node scripts/test-stock-count.js urls 3811
 *   node scripts/test-stock-count.js reset 3811 [--vendor americold] [--date 2026-05-30]
 *   node scripts/test-stock-count.js guide 3811
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { listConfiguredVendors, getVendorCatalog } = require('../src/services/vendorCatalog');
const { clearStockCountDay, melbourneDateKey, STATE_FILE } = require('../src/services/stockCountState');

const PORT = process.env.PORT || 3000;
const BASE = String(process.env.DASHBOARD_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

function usage() {
    console.log(`Stock count test helpers

Commands:
  validate              Parse all vendor catalogs and report item/location counts
  urls <store>          Print dashboard + stock-count URLs for manual testing
  reset <store>         Clear today's saved counts (optional --vendor, --date)
  guide <store>         Short walkthrough for end-to-end testing

Examples:
  node scripts/test-stock-count.js validate
  node scripts/test-stock-count.js urls 3811
  node scripts/test-stock-count.js reset 3811 --vendor americold
  node scripts/test-stock-count.js reset 3811

Env (server):
  ENABLE_STOCK_COUNT_TEST=1     Allow test helpers when not logged in
  STOCK_COUNT_TEST_PENDING=1    Always show all configured vendors as pending

Browser:
  /{store}?testStockCountPending=1   Show vendor chips without Macromatix pending data
`);
}

function parseArgs(argv) {
    const args = argv.slice(2);
    const command = args[0];
    const store = args[1] && !args[1].startsWith('--') ? args[1] : null;
    const options = { vendor: null, date: null };
    for (let i = store ? 2 : 1; i < args.length; i++) {
        if (args[i] === '--vendor' && args[i + 1]) options.vendor = args[++i];
        else if (args[i] === '--date' && args[i + 1]) options.date = args[++i];
    }
    return { command, store, options };
}

function validateCatalogs() {
    let ok = true;
    for (const entry of listConfiguredVendors()) {
        const catalog = getVendorCatalog(entry.slug);
        if (!catalog || !catalog.items.length) {
            console.log(`${entry.slug}: MISSING or empty`);
            ok = false;
            continue;
        }
        const noLoc = catalog.items.filter((item) => !item.locations?.length);
        const locSummary = catalog.locations.join(', ');
        console.log(
            `${entry.slug}: ${catalog.items.length} items, locations [${locSummary}]` +
                (noLoc.length ? ` - WARN ${noLoc.length} item(s) without locations` : '')
        );
        if (noLoc.length) ok = false;
    }
    return ok;
}

function printUrls(store) {
    const vendors = listConfiguredVendors().filter((v) => v.configured);
    console.log(`\nStore ${store} - stock count test URLs\n`);
    console.log(`Dashboard (test pending chips):`);
    console.log(`  ${BASE}/${store}?testStockCountPending=1`);
    console.log(`\nDirect stock-count pages:`);
    for (const v of vendors) {
        console.log(`  ${v.label}: ${BASE}/${store}/stock-count/${v.slug}`);
    }
    console.log(`\nReset API (when logged in or ENABLE_STOCK_COUNT_TEST=1):`);
    console.log(`  POST ${BASE}/api/stock-count/test/reset?store=${store}&vendor=americold`);
    console.log(`\nState file: ${STATE_FILE}\n`);
}

function printGuide(store) {
    printUrls(store);
    console.log(`Walkthrough:
  1. Start the server: npm run dev
  2. Log in (or set ENABLE_STOCK_COUNT_TEST=1 in .env)
  3. Open the dashboard URL above - vendor chips appear under "Orders to place (test mode)"
  4. Click a vendor → enter counts per location → Send to MMX → Open MMX
  5. Re-test the same vendor: node scripts/test-stock-count.js reset ${store} --vendor <slug>
`);
}

async function resetStore(store, options) {
    const result = await clearStockCountDay(store, {
        vendorSlug: options.vendor,
        dateKey: options.date || melbourneDateKey(),
    });
    if (!result.cleared.length) {
        console.log(`Nothing to clear for store ${result.storeNumber} on ${result.dateKey}.`);
        return;
    }
    const labels = result.cleared.map((slug) => getVendorCatalog(slug)?.label || slug);
    console.log(`Cleared ${result.dateKey} for store ${result.storeNumber}: ${labels.join(', ')}`);
    console.log('If the dashboard server is already running, it picks up this reset immediately.');
}

async function main() {
    const { command, store, options } = parseArgs(process.argv);
    if (!command || command === 'help' || command === '-h' || command === '--help') {
        usage();
        return;
    }

    if (command === 'validate') {
        const ok = validateCatalogs();
        process.exit(ok ? 0 : 1);
    }

    if (command === 'urls') {
        if (!store) {
            console.error('Usage: node scripts/test-stock-count.js urls <store>');
            process.exit(1);
        }
        printUrls(store);
        return;
    }

    if (command === 'guide') {
        if (!store) {
            console.error('Usage: node scripts/test-stock-count.js guide <store>');
            process.exit(1);
        }
        printGuide(store);
        return;
    }

    if (command === 'reset') {
        if (!store) {
            console.error('Usage: node scripts/test-stock-count.js reset <store> [--vendor slug] [--date YYYY-MM-DD]');
            process.exit(1);
        }
        await resetStore(store, options);
        return;
    }

    console.error(`Unknown command: ${command}\n`);
    usage();
    process.exit(1);
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
