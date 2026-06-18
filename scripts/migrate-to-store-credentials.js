#!/usr/bin/env node
/**
 * Migrate per-user MMX and LifeLenz credentials into per-store login files.
 * Does not delete legacy files - review output then remove manually.
 */
const fs = require('fs');
const path = require('path');

require('../src/loadEnv').loadEnv();

const paths = require('../src/paths');
const { readMmxCredentialsForUser } = require('../users/src/core/mmxUserCredentials');
const { readLifeLenzCredentialsForUser } = require('../users/src/core/lifelenzUserCredentials');
const {
    savePrimary,
    addFallback,
    listCredentialCandidates,
    readStoreFileRaw,
} = require('../stores/src/storeCredentials');
const { parseUsersFileBlocks, readUsersFileText, getEffectiveStoresForUser } = require('../users/src/core/dashboardUsers');

const MMX_DIR = path.join(paths.users.data, 'mmx-users');
const LIFELENZ_DIR = path.join(paths.users.data, 'lifelenz-users');

function listJsonFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => path.join(dir, name));
}

function storesForDashboardUser(username) {
    const blocks = parseUsersFileBlocks(readUsersFileText());
    const block = blocks.find((row) => String(row.username || '').trim().toLowerCase() === String(username).trim().toLowerCase());
    if (!block) return [];
    const user = { username: block.username, stores: block.stores, access: block.access };
    const effective = getEffectiveStoresForUser(user);
    return effective.filter(Boolean).map(String);
}

function dedupeKey(service, creds) {
    if (service === 'lifelenz') return String(creds.email || '').trim().toLowerCase();
    return String(creds.username || '').trim().toLowerCase();
}

function alreadyHasLogin(storeNumber, service, key) {
    const candidates = listCredentialCandidates(storeNumber, service);
    for (const row of candidates) {
        const existing =
            service === 'lifelenz'
                ? String(row.email || '').trim().toLowerCase()
                : String(row.username || '').trim().toLowerCase();
        if (existing === key) return true;
    }
    return false;
}

function migrateServiceForStore(storeNumber, service, creds, dashboardUsername, summary) {
    const key = dedupeKey(service, creds);
    if (!key) return;
    if (alreadyHasLogin(storeNumber, service, key)) {
        summary.skipped.push({ storeNumber, service, dashboardUsername, reason: 'duplicate' });
        return;
    }

    const existing = readStoreFileRaw(storeNumber);
    const hasPrimary = Boolean(existing?.services?.[service]?.primary);
    const label = `Migrated from ${dashboardUsername}`;

    if (!hasPrimary) {
        const result = savePrimary(storeNumber, service, creds, dashboardUsername, label);
        if (result.ok) {
            summary.primary.push({ storeNumber, service, dashboardUsername });
        } else {
            summary.errors.push({ storeNumber, service, dashboardUsername, error: result.error });
        }
        return;
    }

    const result = addFallback(storeNumber, service, creds, dashboardUsername, label);
    if (result.ok) {
        summary.fallback.push({ storeNumber, service, dashboardUsername });
    } else {
        summary.errors.push({ storeNumber, service, dashboardUsername, error: result.error });
    }
}

function migrateUserFile(filePath, service, readCreds) {
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
    const dashboardUsername = String(raw.username || path.basename(filePath, '.json')).trim();
    const creds = readCreds(dashboardUsername);
    if (!creds) return null;
    const stores = storesForDashboardUser(dashboardUsername);
    return { dashboardUsername, creds, stores };
}

function main() {
    const summary = { primary: [], fallback: [], skipped: [], errors: [], noStores: [] };

    for (const file of listJsonFiles(MMX_DIR)) {
        const row = migrateUserFile(file, 'mmx', readMmxCredentialsForUser);
        if (!row) continue;
        if (!row.stores.length) {
            summary.noStores.push({ dashboardUsername: row.dashboardUsername, service: 'mmx' });
            continue;
        }
        for (const storeNumber of row.stores) {
            migrateServiceForStore(
                storeNumber,
                'mmx',
                { username: row.creds.username, password: row.creds.password },
                row.dashboardUsername,
                summary
            );
        }
    }

    for (const file of listJsonFiles(LIFELENZ_DIR)) {
        const row = migrateUserFile(file, 'lifelenz', readLifeLenzCredentialsForUser);
        if (!row) continue;
        if (!row.stores.length) {
            summary.noStores.push({ dashboardUsername: row.dashboardUsername, service: 'lifelenz' });
            continue;
        }
        for (const storeNumber of row.stores) {
            migrateServiceForStore(
                storeNumber,
                'lifelenz',
                { email: row.creds.email, password: row.creds.password },
                row.dashboardUsername,
                summary
            );
        }
    }

    console.log('Migration complete.');
    console.log(`Primary saved: ${summary.primary.length}`);
    console.log(`Fallback saved: ${summary.fallback.length}`);
    console.log(`Skipped (duplicate): ${summary.skipped.length}`);
    console.log(`No store scope: ${summary.noStores.length}`);
    console.log(`Errors: ${summary.errors.length}`);

    if (summary.noStores.length) {
        console.log('\nUsers with credentials but no store scope:');
        for (const row of summary.noStores) {
            console.log(`  - ${row.dashboardUsername} (${row.service})`);
        }
    }
    if (summary.errors.length) {
        console.log('\nErrors:');
        for (const row of summary.errors) {
            console.log(`  - store ${row.storeNumber} ${row.service} / ${row.dashboardUsername}: ${row.error}`);
        }
    }
    console.log('\nLegacy files were NOT deleted. Verify store logins in Admin → Setup Store Logins, then remove users/data/mmx-users/ and lifelenz-users/ manually.');
}

main();
