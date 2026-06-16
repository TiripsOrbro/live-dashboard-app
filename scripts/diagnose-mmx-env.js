#!/usr/bin/env node
/**
 * Print store credential encryption key status and per-store MMX login coverage.
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');

function main() {
    const { loadEnv } = require('../src/loadEnv');
    const loadResult = loadEnv({ root: ROOT });

    const { getStoreList } = require('../stores/src/storeList');
    const { storeHasServiceCredentials } = require('../stores/src/storeCredentials');

    const storeKey = Boolean(String(process.env.STORE_CREDENTIALS_KEY || '').trim());
    const legacyKey = Boolean(String(process.env.MMX_USER_CREDENTIALS_KEY || '').trim());

    const stores = getStoreList();
    const mmxConfigured = [];
    const mmxMissing = [];
    for (const row of stores) {
        const store = String(row.storeNumber || '').trim();
        if (!store) continue;
        if (storeHasServiceCredentials(store, 'mmx')) mmxConfigured.push(store);
        else mmxMissing.push(store);
    }

    const out = {
        loadMode: loadResult.mode,
        loadedFiles: loadResult.loaded,
        encryptionKey: {
            STORE_CREDENTIALS_KEY: storeKey ? 'set' : 'missing',
            MMX_USER_CREDENTIALS_KEY: legacyKey ? 'set (legacy migration only)' : 'not set',
        },
        storeMmxLogins: {
            configured: mmxConfigured.length,
            missing: mmxMissing.length,
            missingStores: mmxMissing,
        },
        note: 'MMX logins are per-store — Admin menu → Setup Store Logins. Global SCRAPER_* env vars are no longer used.',
    };

    console.log(JSON.stringify(out, null, 2));

    if (!storeKey && !legacyKey && process.env.NODE_ENV === 'production') {
        process.exit(1);
    }
    if (mmxMissing.length && stores.length) {
        process.exit(1);
    }
}

main();
