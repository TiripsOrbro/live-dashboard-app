#!/usr/bin/env node
/**
 * Sync upselling leaderboard from MMX or a local export file.
 *
 *   npm run upsell-sync -- 3811
 *   npm run upsell-sync -- 3811 --headed
 *   npm run upsell-sync -- 3811 --headed --slow   (adds SCRAPER_SLOW_MO_MS stepping)
 *   npm run upsell-sync -- 3811 --file path/to/export.xls
 *
 * Prefer MMX Excel download (exportMode "download" in config/upselling.json) over HTML scrape —
 * the OLAP pivot aligns store columns correctly in the spreadsheet.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env.production'), override: true });

if (!process.env.SCRAPER_EXECUTABLE_PATH && process.platform === 'win32') {
    const candidates = [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (found) process.env.SCRAPER_EXECUTABLE_PATH = found;
}

const { isUpsellingStore, isUpsellingMmxSyncStore } = require('../src/services/upselling/upsellingConfig');
const { runUpsellMmxSync, runUpsellFromFile } = require('../src/services/upselling/upsellMmxPipeline');
const { buildLeaderboardPayload } = require('../src/services/upselling/upsellingScores');

async function main() {
    const args = process.argv.slice(2).filter((a) => a !== '--');
    const storeNumber = args[0];
    if (!storeNumber) {
        console.error('Usage: npm run upsell-sync -- <storeNumber> [--file <export.xlsx>]');
        process.exit(1);
    }
    if (!isUpsellingStore(storeNumber)) {
        console.error(`Store ${storeNumber} is not enabled in config/upselling-stores.json.`);
        process.exit(1);
    }

    const fileIdx = args.indexOf('--file');
    const filePath = fileIdx >= 0 ? args[fileIdx + 1] : null;
    const headed = args.includes('--headed');
    const forceScrape = args.includes('--scrape');

    if (filePath) {
        const abs = path.resolve(filePath);
        runUpsellFromFile(storeNumber, abs);
        console.log(`[upsell-sync] Scored from file: ${abs}`);
    } else if (!isUpsellingMmxSyncStore(storeNumber)) {
        console.error(
            `Store ${storeNumber} has no MMX sync (test store). Use: npm run upsell-sync -- ${storeNumber} --file path/to/export.xlsx`
        );
        process.exit(1);
    } else {
        const headless = headed
            ? false
            : !/^(0|false|no)$/i.test(String(process.env.SCRAPER_HEADLESS ?? 'true'));
        const slowDebug = args.includes('--slow');
        await runUpsellMmxSync(storeNumber, {
            browserOptions: { headless, skipSlowMo: !slowDebug },
            exportMode: forceScrape ? 'scrape' : undefined,
        });
    }

    const payload = buildLeaderboardPayload(storeNumber);
    console.log(JSON.stringify(payload, null, 2));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
