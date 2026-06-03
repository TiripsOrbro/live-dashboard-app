#!/usr/bin/env node
/**
 * Sync upselling leaderboard from MMX or a local export file.
 *
 *   npm run upsell-sync -- --all-stores
 *   npm run upsell-sync -- --all-stores --file path/to/regional-export.csv
 *   npm run upsell-sync -- 3811
 *   npm run upsell-sync -- 3811 --headed
 *   npm run upsell-sync -- 3811 --file path/to/export.xls
 *
 * With syncAllStores in config/upselling.json, one CSV export updates every enabled store.
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

const {
    isUpsellingStore,
    isUpsellingMmxSyncStore,
    isSyncAllStores,
    loadUpsellingConfig,
    resolveEnabledStores,
} = require('../src/services/upselling/upsellingConfig');
const { runUpsellMmxSync, runUpsellFromFile } = require('../src/services/upselling/upsellMmxPipeline');
const { buildLeaderboardPayload } = require('../src/services/upselling/upsellingScores');

async function main() {
    const args = process.argv.slice(2).filter((a) => a !== '--');
    const cfg = loadUpsellingConfig();
    const onlyFlags = args.length > 0 && args.every((a) => a.startsWith('--'));
    const allStores =
        args.includes('--all-stores') ||
        ((args.length === 0 || onlyFlags) && isSyncAllStores(cfg));
    const allDays = args.includes('--all-days') || args.includes('--backfill');
    const fileIdx = args.indexOf('--file');
    const filePath = fileIdx >= 0 ? args[fileIdx + 1] : null;
    const headed = args.includes('--headed');
    const forceScrape = args.includes('--scrape');
    const slowDebug = args.includes('--slow');
    const positional = args.filter((a, i) => {
        if (a.startsWith('--')) return false;
        if (fileIdx >= 0 && i === fileIdx + 1) return false;
        return true;
    });
    const storeNumber = allStores ? null : positional.find((a) => !a.startsWith('--'));

    if (!allStores && !storeNumber) {
        console.error(
            'Usage:\n' +
                '  npm run upsell-sync -- --all-stores [--all-days] [--file export.csv] [--headed]\n' +
                '  npm run upsell-sync -- <storeNumber> [--file export.csv] [--headed]'
        );
        process.exit(1);
    }

    if (!allStores && !isUpsellingStore(storeNumber)) {
        console.error(`Store ${storeNumber} is not enabled in config/upselling-stores.json.`);
        process.exit(1);
    }

    const browserOptions = {
        headless: headed ? false : !/^(0|false|no)$/i.test(String(process.env.SCRAPER_HEADLESS ?? 'true')),
        skipSlowMo: headed ? false : !slowDebug,
        slowMo: headed || slowDebug ? 250 : undefined,
        keepBrowserOpen: headed,
    };

    if (headed) {
        console.log('[upsell-sync] Headed mode — Edge/Chrome will open maximized, slow, and stay open 90s at the end');
    }

    if (filePath) {
        const abs = path.resolve(filePath);
        const multi = runUpsellFromFile(allStores ? null : storeNumber, abs, { allStores, allDays });
        console.log(`[upsell-sync] Scored from file: ${abs}`);
        if (allStores) {
            console.log(`[upsell-sync] Updated stores: ${(multi.storeNumbers || []).join(', ') || '(none)'}`);
            for (const store of multi.storeNumbers || []) {
                printStoreSummary(store);
            }
            return;
        }
    } else if (allStores) {
        const mmxStores = resolveEnabledStores(cfg).filter(isUpsellingMmxSyncStore);
        if (!mmxStores.length) {
            console.error('No MMX sync stores enabled in config/upselling-stores.json.');
            process.exit(1);
        }
        const out = await runUpsellMmxSync(null, {
            syncAllStores: true,
            allDays,
            browserOptions,
            exportMode: forceScrape ? 'scrape' : undefined,
        });
        console.log(`[upsell-sync] Regional sync updated: ${(out.storeNumbers || []).join(', ') || '(none)'}`);
        for (const store of out.storeNumbers || []) {
            printStoreSummary(store);
        }
        return;
    } else if (!isUpsellingMmxSyncStore(storeNumber)) {
        console.error(
            `Store ${storeNumber} has no MMX sync (test store). Use: npm run upsell-sync -- ${storeNumber} --file path/to/export.csv`
        );
        process.exit(1);
    } else {
        await runUpsellMmxSync(storeNumber, {
            allDays,
            browserOptions,
            exportMode: forceScrape ? 'scrape' : undefined,
        });
    }

    printStoreSummary(storeNumber);
}

function printStoreSummary(storeNumber) {
    const payload = buildLeaderboardPayload(storeNumber);
    const period =
        (payload.leaderboardPeriod === 'weekBestDay' || payload.leaderboardPeriod === 'week') &&
            payload.weekStart &&
            payload.weekEnd
            ? `best day ${payload.weekStart} – ${payload.weekEnd}`
            : `day ${payload.leaderboardDay || '?'}`;
    console.log(`\n[upsell-sync] Leaderboard ${storeNumber} (${period}):`);
    for (const r of payload.top7 || payload.top5 || []) {
        console.log(`  ${r.rank}. ${r.name} — ${r.total} pts`);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
