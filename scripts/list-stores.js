#!/usr/bin/env node
/**
 * Discover the stores the Macromatix account can access, printed as ready-to-paste
 * `.storelist` lines. Hours default to 10|22 — edit them afterwards.
 *
 *   node scripts/list-stores.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('./load-project-env');

const { listStores } = require('../src/services/macromatixScraper');

(async () => {
    try {
        const stores = await listStores();
        if (!stores.length) {
            console.log('\nNo stores found. The account may have a single store, or the selector was not detected.');
            process.exit(0);
        }

        const sorted = [...stores].sort((a, b) =>
            String(a.storeNumber).localeCompare(String(b.storeNumber), undefined, { numeric: true })
        );

        console.log(`\nFound ${sorted.length} store(s):\n`);
        for (const s of sorted) {
            console.log(`  ${s.storeNumber}  —  ${s.storeName}`);
        }

        console.log('\n--- Paste into .storelist and adjust the hours (store# | name | openHour | closeHour) ---\n');
        for (const s of sorted) {
            const name = (s.storeName || '').replace(/\s*\|\s*/g, ' / ').trim() || s.storeNumber;
            console.log(`${s.storeNumber} | ${name} | 10 | 22`);
        }
        console.log('');
        process.exit(0);
    } catch (err) {
        console.error('\nFailed to list stores:', err.message);
        process.exit(1);
    }
})();
