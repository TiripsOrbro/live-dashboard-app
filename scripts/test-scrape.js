/* Timed multi-store scrape test. Usage: node scripts/test-scrape.js [concurrency] */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env.production'), override: true });

// On Windows (dev), point Puppeteer at a local Chrome/Edge if not already set.
if (!process.env.SCRAPER_EXECUTABLE_PATH && process.platform === 'win32') {
    const candidates = [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (found) process.env.SCRAPER_EXECUTABLE_PATH = found;
}

const concArg = process.argv[2];
if (concArg) process.env.SCRAPER_CONCURRENCY = concArg;

const scrapeMacromatix = require('../src/services/macromatixScraper');

(async () => {
    const started = Date.now();
    try {
        const result = await scrapeMacromatix({});
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        console.log('\n===== RESULT =====');
        console.log(`Concurrency: ${process.env.SCRAPER_CONCURRENCY || '(default 3)'}`);
        console.log(`Elapsed: ${elapsed}s for ${result.stores.length} store(s)`);
        for (const s of result.stores) {
            const actualNonZero = s.actual.filter((v) => Number(v) > 0).length;
            console.log(
                `  ${s.storeNumber} ${s.storeName} | hrs ${s.openHour}-${s.closeHour} | ` +
                    `actual ${s.actual.length}h (${actualNonZero} >0) | forecast ${s.forecast.length}h | ` +
                    `pending [${s.pendingVendors.join(', ')}]` +
                    (s.error ? ` | ERROR: ${s.error}` : '')
            );
        }
    } catch (err) {
        console.error('SCRAPE FAILED:', err.message);
        process.exitCode = 1;
    }
})();
