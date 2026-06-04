#!/usr/bin/env node
/**
 * Verify Macromatix login and that Report Selection stays authenticated.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env.production'), override: true });

const {
    openMacromatixBrowser,
    closeBrowserQuietly,
    verifyMacromatixLogin,
    resolveMacromatixCredentials,
    isMacromatixLoginPage,
} = require('../src/services/macromatixScraper');

async function main() {
    const reportsUrl =
        'https://tacobellau.macromatix.net/MMS_System_Reports.aspx?MenuCustomItemID=12';

    let creds;
    try {
        creds = resolveMacromatixCredentials({});
    } catch (err) {
        console.log(
            JSON.stringify({ ok: false, stage: 'env', error: err.message }, null, 2)
        );
        process.exit(1);
    }

    const username = String(creds.username || '').trim();
    const password = String(creds.password || '');
    console.log(
        `[verify-mmx] Using global credentials — username: ${username || '(empty)'}, password length: ${password.length}`
    );

    if (!username || !password) {
        console.log(
            JSON.stringify(
                {
                    ok: false,
                    stage: 'env',
                    error: 'SCRAPER_USERNAME and SCRAPER_PASSWORD (or encrypted creds) are not set.',
                },
                null,
                2
            )
        );
        process.exit(1);
    }

    const loginCheck = await verifyMacromatixLogin(username, password);
    if (!loginCheck.ok) {
        console.log(
            JSON.stringify(
                { ok: false, stage: 'login', error: loginCheck.error, username },
                null,
                2
            )
        );
        process.exit(1);
    }

    let browser;
    let page;
    try {
        ({ browser, page } = await openMacromatixBrowser({}));
        await page.goto(reportsUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(3000);
        const url = page.url();
        const onLogin = await isMacromatixLoginPage(page);
        const ok = !onLogin && !/MMS_Logon/i.test(url);
        console.log(
            JSON.stringify({ ok, stage: 'reports', url, onLogin, username }, null, 2)
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
