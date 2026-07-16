#!/usr/bin/env node
/**
 * Long-running per-store continuous sales workers (replacement for interval full-market scraper).
 *
 *   node scripts/run-continuous-scrapers.js
 */
const { loadEnv } = require('../src/loadEnv');
loadEnv();

process.env.SCRAPER_PERSISTENT_SESSIONS = process.env.SCRAPER_PERSISTENT_SESSIONS || '1';
process.env.SCRAPER_CONTINUOUS_WORKERS = process.env.SCRAPER_CONTINUOUS_WORKERS || '1';
process.env.SCRAPER_HEADLESS = process.env.SCRAPER_HEADLESS ?? 'true';

const scrapeMacromatix = require('../mmx/src/macromatixScraper');
const { getStoreList } = require('../src/services/storeList');
const { storeHasMmxCredentials } = require('../mmx/src/macromatixScraper');
const { getStoreScrapePhase } = require('../dashboard/src/scrapeSchedule');
const { startContinuousSalesWorkers } = require('../dashboard/src/continuousSalesWorkers');
const { closeAllSessions } = require('../mmx/src/salesSessionPool');

async function scrapeStore(store) {
    const key = String(store.storeNumber || '').trim();
    const result = await scrapeMacromatix({
        storeNumbers: [key],
        skipPendingVendors: true,
        scrapeReason: 'continuous',
    });
    const row = (result.stores || []).find((s) => String(s.storeNumber) === key);
    const actualTotal = Array.isArray(row?.actual)
        ? row.actual.reduce((sum, value) => sum + (Number(value) || 0), 0)
        : 0;
    console.log(
        `[continuous] Store ${key} refreshed - actual total ${actualTotal.toFixed(2)}` +
            (row?.error ? ` ERROR: ${row.error}` : '')
    );
}

function listStores() {
    const filter = String(process.env.CONTINUOUS_TEST_STORES || '')
        .split(/[;,\s]+/)
        .map((value) => value.trim())
        .filter(Boolean);
    return getStoreList()
        .filter((store) => storeHasMmxCredentials(store.storeNumber))
        .filter((store) => getStoreScrapePhase(store) === 'active')
        .filter((store) => !filter.length || filter.includes(String(store.storeNumber)));
}

async function main() {
    const stores = listStores();
    if (!stores.length) {
        console.error('[continuous] No active credentialed stores to scrape.');
        process.exit(1);
    }

    console.log(`[continuous] Starting ${stores.length} store worker(s)`);
    const handle = startContinuousSalesWorkers({
        listStores,
        isStoreActive: (store) => getStoreScrapePhase(store) === 'active',
        scrapeStore,
    });

    const shutdown = async (signal) => {
        console.log(`[continuous] Shutting down (${signal})`);
        handle.cancel();
        await closeAllSessions(signal).catch(() => {});
        process.exit(0);
    };

    process.on('SIGINT', () => {
        shutdown('SIGINT').catch((err) => {
            console.error(err);
            process.exit(1);
        });
    });
    process.on('SIGTERM', () => {
        shutdown('SIGTERM').catch((err) => {
            console.error(err);
            process.exit(1);
        });
    });
}

main().catch(async (err) => {
    console.error('[continuous] Failed:', err.message, err.stack);
    await closeAllSessions('error').catch(() => {});
    process.exit(1);
});
