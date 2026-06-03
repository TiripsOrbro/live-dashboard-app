/**
 * Force a Macromatix sales scrape outside the normal scrape window (e.g. after close
 * when the dashboard cache was cleared). Writes data/sales-snapshots/{store}.json
 * so `pm2 restart dashboard` can restore the UI.
 *
 * Usage:
 *   npm run force-sales-scrape
 *   npm run force-sales-scrape -- --store 3811
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env.production'), override: true });

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

const scrapeMacromatix = require('../src/services/macromatixScraper');

const SNAPSHOT_DIR = path.join(__dirname, '../data/sales-snapshots');

function sumHourly(arr) {
    return (Array.isArray(arr) ? arr : []).reduce((n, v) => n + (Number(v) || 0), 0);
}

function hasMeaningfulSales(store) {
    return sumHourly(store?.actual) > 0 || sumHourly(store?.forecast) > 0;
}

function writeSnapshot(store) {
    if (!hasMeaningfulSales(store)) return false;
    const key = String(store.storeNumber || '').replace(/[^0-9a-z]/gi, '');
    if (!key) return false;
    const snap = {
        capturedAt: new Date().toISOString(),
        actual: [...store.actual],
        forecast: [...store.forecast],
        pendingVendors: Array.isArray(store.pendingVendors) ? [...store.pendingVendors] : [],
    };
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(SNAPSHOT_DIR, `${key}.json`), JSON.stringify(snap, null, 2), 'utf8');
    return true;
}

function parseArgs(argv) {
    let storeNumber = '';
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--store' && argv[i + 1]) {
            storeNumber = String(argv[++i]).replace(/[^0-9]/g, '');
        } else if (/^\d{4}$/.test(a)) {
            storeNumber = a;
        }
    }
    return { storeNumber };
}

(async () => {
    const { storeNumber } = parseArgs(process.argv);
    const started = Date.now();
    console.log(
        '[force-sales-scrape] Starting (bypassScrapeSchedule=true)' +
            (storeNumber ? ` store=${storeNumber}` : ' all .storelist stores')
    );

    try {
        const result = await scrapeMacromatix({
            bypassScrapeSchedule: true,
            storeNumber: storeNumber || undefined,
        });
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const stores = Array.isArray(result.stores) ? result.stores : [];

        if (result.scrapeSkipped) {
            console.warn('[force-sales-scrape] Scraper returned scrapeSkipped — no browser run.');
            process.exitCode = 1;
            return;
        }

        let saved = 0;
        for (const s of stores) {
            const ok = writeSnapshot(s);
            if (ok) saved++;
            const nz = Array.isArray(s.actual) ? s.actual.filter((v) => Number(v) > 0).length : 0;
            const total = sumHourly(s.actual);
            console.log(
                `  ${s.storeNumber} ${s.storeName || ''} | actual $${total.toFixed(2)} (${nz} hrs >0)` +
                    (ok ? ' → snapshot saved' : ' → no snapshot (all zero)') +
                    (s.error ? ` | ERROR: ${s.error}` : '')
            );
        }

        console.log(`\n[force-sales-scrape] Done in ${elapsed}s — ${stores.length} store(s), ${saved} snapshot(s).`);
        if (saved) {
            console.log('[force-sales-scrape] Run: pm2 restart dashboard  (then refresh the browser)');
        } else {
            console.warn(
                '[force-sales-scrape] Macromatix returned no sales totals. Data may only be recoverable from an older snapshot in data/sales-snapshots/.'
            );
            process.exitCode = 1;
        }
    } catch (err) {
        console.error('[force-sales-scrape] FAILED:', err.message);
        process.exitCode = 1;
    }
})();
