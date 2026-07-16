#!/usr/bin/env node
/**
 * Smoke-test continuous per-store sales workers for a short window.
 *
 *   node scripts/test-continuous-scrapers.js
 *   TEST_DURATION_MINUTES=5 node scripts/test-continuous-scrapers.js
 */
const path = require('path');
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

const DURATION_MS = Math.max(1, Number(process.env.TEST_DURATION_MINUTES || 3)) * 60 * 1000;
const scrapeCounts = new Map();

async function scrapeStore(store) {
    const key = String(store.storeNumber || '').trim();
    const result = await scrapeMacromatix({
        storeNumbers: [key],
        skipPendingVendors: true,
        scrapeReason: 'continuous',
    });
    const row = (result.stores || []).find((s) => String(s.storeNumber) === key);
    const count = (scrapeCounts.get(key) || 0) + 1;
    scrapeCounts.set(key, count);
    const actualTotal = Array.isArray(row?.actual)
        ? row.actual.reduce((sum, value) => sum + (Number(value) || 0), 0)
        : 0;
    console.log(
        `[test-continuous] Store ${key} scrape #${count} - actual total ${actualTotal.toFixed(2)}` +
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
        console.error('[test-continuous] No active credentialed stores to scrape.');
        process.exit(1);
    }

    console.log(
        `[test-continuous] Running ${stores.length} store worker(s) for ${Math.round(DURATION_MS / 60000)} minute(s)`
    );

    const handle = startContinuousSalesWorkers({
        listStores,
        isStoreActive: (store) => getStoreScrapePhase(store) === 'active',
        scrapeStore,
    });

    const shutdown = async (signal) => {
        console.log(`[test-continuous] Stopping (${signal || 'done'})`);
        handle.cancel();
        await closeAllSessions('test-complete').catch(() => {});
        const summary = [...scrapeCounts.entries()]
            .map(([storeNumber, count]) => `${storeNumber}:${count}`)
            .join(', ');
        console.log(`[test-continuous] Scrape counts: ${summary || '(none)'}`);
        process.exit(0);
    };

    process.on('SIGINT', () => {
        shutdown('SIGINT').catch((err) => {
            console.error(err);
            process.exit(1);
        });
    });

    setTimeout(() => {
        shutdown('timer').catch((err) => {
            console.error(err);
            process.exit(1);
        });
    }, DURATION_MS);
}

main().catch(async (err) => {
    console.error('[test-continuous] Failed:', err.message, err.stack);
    await closeAllSessions('test-error').catch(() => {});
    process.exit(1);
});
