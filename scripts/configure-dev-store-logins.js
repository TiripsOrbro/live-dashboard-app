#!/usr/bin/env node
/**
 * Seed per-store MMX + LifeLenz logins from .env Temp* vars (local dev only).
 *
 * Usage:
 *   node scripts/configure-dev-store-logins.js
 *   node scripts/configure-dev-store-logins.js 3901 AshOwens
 *
 * Reads:
 *   TempMMXU / TempMMXP       → store MMX primary login
 *   TempLifeLenzU / TempLifeLenzP → store LifeLenz primary login
 */
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('./load-project-env');

const {
    savePrimary,
    getStoreCredentialsSummary,
    storeHasServiceCredentials,
    maskLoginIdentifier,
} = require('../stores/src/storeCredentials');

const STORE = String(process.argv[2] || '3901').trim();
const ACTOR = String(process.argv[3] || process.env.TempDashboardU || 'dev-probe').trim();

function requireEnv(name) {
    const value = String(process.env[name] || '').trim();
    if (!value) {
        console.error(`[configure-store-logins] Missing ${name} in .env`);
        process.exit(1);
    }
    return value;
}

function main() {
    const mmxUsername = requireEnv('TempMMXU');
    const mmxPassword = requireEnv('TempMMXP');
    const lifelenzEmail = requireEnv('TempLifeLenzU');
    const lifelenzPassword = requireEnv('TempLifeLenzP');

    console.log(`[configure-store-logins] Store ${STORE} (actor: ${ACTOR})`);

    const mmxResult = savePrimary(
        STORE,
        'mmx',
        { username: mmxUsername, password: mmxPassword },
        ACTOR
    );
    if (!mmxResult.ok) {
        console.error('[configure-store-logins] MMX save failed:', mmxResult.error);
        process.exit(1);
    }
    console.log(
        '[configure-store-logins] MMX:',
        maskLoginIdentifier('mmx', mmxUsername),
        storeHasServiceCredentials(STORE, 'mmx') ? 'configured' : 'missing'
    );

    const llResult = savePrimary(
        STORE,
        'lifelenz',
        { email: lifelenzEmail, password: lifelenzPassword },
        ACTOR
    );
    if (!llResult.ok) {
        console.error('[configure-store-logins] LifeLenz save failed:', llResult.error);
        process.exit(1);
    }
    console.log(
        '[configure-store-logins] LifeLenz:',
        maskLoginIdentifier('lifelenz', lifelenzEmail),
        storeHasServiceCredentials(STORE, 'lifelenz') ? 'configured' : 'missing'
    );

    const summary = getStoreCredentialsSummary(STORE);
    console.log(
        JSON.stringify(
            {
                storeNumber: summary.storeNumber,
                mmx: summary.services.mmx?.configured,
                lifelenz: summary.services.lifelenz?.configured,
            },
            null,
            2
        )
    );
}

main();
