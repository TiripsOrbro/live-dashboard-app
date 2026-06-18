#!/usr/bin/env node
/**
 * Headed LifeLenz login probe - verify credentials and print accessible stores.
 *
 * Usage:
 *   npm run probe-lifelenz-login
 *   npm run probe-lifelenz-login -- email@example.com mypassword
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('./load-project-env');

process.env.LIFELENZ_SCRAPER_HEADLESS = 'false';

const { verifyLifeLenzLogin, getDevLifeLenzCredentials } = require('../lifelenz/src/lifelenzAuth');

async function main() {
    const emailArg = process.argv[2];
    const passwordArg = process.argv[3];
    const dev = getDevLifeLenzCredentials();
    const email = emailArg || dev?.email;
    const password = passwordArg || dev?.password;

    if (!email || !password) {
        console.error('[probe-lifelenz-login] Provide credentials as args or set TempLifeLenzU / TempLifeLenzP in .env');
        process.exit(1);
    }

    console.log(`[probe-lifelenz-login] Verifying LifeLenz login for ${email}...`);
    const result = await verifyLifeLenzLogin(email, password, { headless: false });
    if (!result.ok) {
        console.error('[probe-lifelenz-login] Failed:', result.error);
        process.exit(1);
    }
    console.log('[probe-lifelenz-login] Accessible stores:');
    for (const store of result.stores) {
        console.log(`  ${store.storeNumber} - ${store.label}`);
    }
}

main().catch((err) => {
    console.error('[probe-lifelenz-login] Error:', err.message);
    process.exit(1);
});
