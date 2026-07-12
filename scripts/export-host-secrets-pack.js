#!/usr/bin/env node
/**
 * Build a Host secrets pack folder to ship next to the installer:
 *
 *   Taco Bell Dashboard Pack/
 *     Taco Bell Dashboard Installer.exe
 *     secrets/          ← this script fills this
 *
 * Usage (on the current Host):
 *   node scripts/export-host-secrets-pack.js
 *   node scripts/export-host-secrets-pack.js "D:\Share\Taco Bell Dashboard Pack\secrets"
 *
 * Prefer tray → Export Host secrets pack… when using the desktop app.
 */
require('../src/loadEnv').loadEnv();

const path = require('path');
const os = require('os');
const paths = require('../src/paths');
const { exportSecretsPack } = require('../desktop/src/secrets-pack');

function main() {
    const outArg = process.argv[2];
    const outRoot = path.resolve(
        outArg || path.join(os.homedir(), 'Desktop', 'Taco Bell Dashboard Pack', 'secrets')
    );

    const result = exportSecretsPack(paths.root, outRoot);
    console.log(`\nSecrets pack ready:\n  ${result.outRoot}`);
    console.log(
        `env=${result.counts.env} store-logins=${result.counts.storeLogins} accounts=${result.counts.accounts} mmx=${result.counts.mmxUsers} lifelenz=${result.counts.lifelenzUsers} storelist=${result.counts.storelist}`
    );
    console.log('Copy the installer exe into the parent folder, then share the whole pack privately.');
}

main();
