#!/usr/bin/env node
/**
 * Verify Macromatix login for a store and that Report Selection stays authenticated.
 *
 * Usage:
 *   node scripts/verify-mmx-session.js --store 3811
 */
const path = require('path');
require('../src/loadEnv').loadEnv();

const {
    openMacromatixBrowser,
    closeBrowserQuietly,
    verifyMacromatixLogin,
    resolveMacromatixCredentialsForStore,
    isMacromatixLoginPage,
} = require('../src/services/macromatixScraper');

function parseStoreArg() {
    const idx = process.argv.indexOf('--store');
    if (idx >= 0 && process.argv[idx + 1]) return String(process.argv[idx + 1]).trim();
    return String(process.env.VERIFY_MMX_STORE || '').trim();
}

async function main() {
    const storeNumber = parseStoreArg();
    if (!storeNumber) {
        console.log(
            JSON.stringify(
                {
                    ok: false,
                    stage: 'args',
                    error: 'Pass --store 3811 (store must have MMX login in Admin → Setup Store Logins).',
                },
                null,
                2
            )
        );
        process.exit(1);
    }

    const reportsUrl =
        'https://tacobellau.macromatix.net/MMS_System_Reports.aspx?MenuCustomItemID=12';

    let creds;
    try {
        creds = resolveMacromatixCredentialsForStore(storeNumber);
    } catch (err) {
        console.log(
            JSON.stringify({ ok: false, stage: 'store-credentials', storeNumber, error: err.message }, null, 2)
        );
        process.exit(1);
    }

    const username = String(creds.username || '').trim();
    const password = String(creds.password || '');
    console.log(
        `[verify-mmx] Store ${storeNumber} via ${creds.source} - username: ${username || '(empty)'}, password length: ${password.length}`
    );

    const loginCheck = await verifyMacromatixLogin(username, password);
    if (!loginCheck.ok) {
        console.log(
            JSON.stringify(
                { ok: false, stage: 'login', storeNumber, error: loginCheck.error, username },
                null,
                2
            )
        );
        process.exit(1);
    }

    let browser;
    let page;
    try {
        ({ browser, page } = await openMacromatixBrowser({ storeNumber }));
        await page.goto(reportsUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(3000);
        const url = page.url();
        const onLogin = await isMacromatixLoginPage(page);
        const ok = !onLogin && !/MMS_Logon/i.test(url);
        console.log(
            JSON.stringify({ ok, stage: 'reports', storeNumber, url, onLogin, username }, null, 2)
        );
        process.exit(ok ? 0 : 1);
    } finally {
        await closeBrowserQuietly(browser, 'verify-mmx-session');
    }
}

main().catch((e) => {
    console.error('[verify-mmx]', e.message);
    process.exit(1);
});
