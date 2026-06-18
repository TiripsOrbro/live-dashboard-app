#!/usr/bin/env node
/**
 * Local timing probe: fill Freezer / Fridge / Dry with one line each and measure save gaps.
 *
 * Usage:
 *   node scripts/probe-stock-count-save-timing.js
 *   node scripts/probe-stock-count-save-timing.js 3811
 */
require('../src/loadEnv').loadEnv();

const { getVendorCatalog } = require('../src/services/vendorCatalog');
const { openMacromatixBrowser, closeBrowserQuietly, selectStoreOnPage } = require('../src/services/macromatixScraper');
const { enterCombinedStockCount, loadMmxStockCountConfig } = require('../src/services/mmxReports/mmx-stock-count');
const { GOTO_OPTS } = require('../src/services/mmxReports/mmx-browser');

const PROBE_ITEMS = {
    Freezer: { '40109': { boxes: 1 } },
    Fridge: { '38414': { boxes: 1 } },
    Dry: { '40062A': { boxes: 1 } },
};

function parseSaveTimings(logLines) {
    const saves = [];
    const fills = [];
    for (const line of logLines) {
        const save = line.match(/Stock count tab saved via #(\S+) \((\d+)ms\)/);
        if (save) saves.push({ button: save[1], ms: Number(save[2]) });
        const fill = line.match(/Filling (\S+)/);
        if (fill) fills.push(fill[1]);
    }
    return { saves, fills };
}

async function main() {
    const storeNumber = process.argv[2] || '3811';
    const catalog = getVendorCatalog('americold');
    if (!catalog) throw new Error('Americold catalog missing');

    const logLines = [];
    const origLog = console.log;
    console.log = (...args) => {
        const line = args.map(String).join(' ');
        if (/Stock count tab saved|Filling |Saving stock count/.test(line)) {
            logLines.push(line);
        }
        origLog(...args);
    };

    const cfg = loadMmxStockCountConfig();
    let browser;
    let page;
    const started = Date.now();

    try {
        ({ browser, page } = await openMacromatixBrowser({}));
        await page.goto(cfg.url, { ...GOTO_OPTS, timeout: 45000 });
        const picked = await selectStoreOnPage(page, storeNumber);
        if (!picked) throw new Error(`Could not select store ${storeNumber}`);
        origLog(`[probe] Store: ${picked}`);

        const result = await enterCombinedStockCount(page, {
            storeNumber,
            navTimeoutMs: 45000,
            selectStore: null,
            stopAtConfirm: true,
            vendorEntries: [
                {
                    slug: 'americold',
                    catalog,
                    draftLocations: PROBE_ITEMS,
                },
            ],
        });

        const { saves, fills } = parseSaveTimings(logLines);
        const elapsed = Date.now() - started;
        const maxSaveMs = saves.length ? Math.max(...saves.map((s) => s.ms)) : null;

        origLog('\n[probe] === timing summary ===');
        origLog(`[probe] Tabs filled: ${fills.join(' → ')}`);
        for (const s of saves) {
            origLog(`[probe] Save ${s.button}: ${s.ms}ms`);
        }
        origLog(`[probe] Max save wait: ${maxSaveMs != null ? `${maxSaveMs}ms` : 'n/a'}`);
        origLog(`[probe] Total run: ${elapsed}ms`);
        origLog(`[probe] Variances: ${result.variances?.length ?? 0}`);

        if (maxSaveMs != null && maxSaveMs > 15000) {
            console.error('[probe] FAIL - save still slower than 15s (navigation timeout may still be firing)');
            process.exit(1);
        }
        if (saves.length < 3) {
            console.error(`[probe] FAIL - expected 3 saves, got ${saves.length}`);
            process.exit(1);
        }
        origLog('[probe] PASS - tab saves completed quickly');
    } finally {
        console.log = origLog;
        await closeBrowserQuietly(browser, 'probe-stock-count-save');
    }
}

main().catch((err) => {
    console.error('[probe]', err.message || err);
    process.exit(1);
});
