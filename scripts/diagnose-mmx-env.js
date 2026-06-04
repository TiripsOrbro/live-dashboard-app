#!/usr/bin/env node
/**
 * Print which Macromatix credentials the app will use (no browser).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env.production'), override: true });

const {
    resolveMacromatixCredentials,
} = require('../src/services/macromatixScraper');

function maskUsername(name) {
    const u = String(name || '').trim();
    if (!u) return '(empty)';
    if (u.length <= 2) return `${u[0]}*`;
    return `${u.slice(0, 2)}…${u.slice(-1)} (${u.length} chars)`;
}

function main() {
    const enc = Boolean(String(process.env.SCRAPER_CREDENTIALS_ENCRYPTED || '').trim());
    const keySet = Boolean(String(process.env.SCRAPER_CREDENTIALS_KEY || '').trim());
    let creds;
    let resolveError = '';
    try {
        creds = resolveMacromatixCredentials({});
    } catch (err) {
        resolveError = err.message || String(err);
        creds = { username: '', password: '' };
    }

    const out = {
        credentialMode: enc ? 'SCRAPER_CREDENTIALS_ENCRYPTED' : 'SCRAPER_USERNAME/PASSWORD',
        decryptKeySet: enc ? keySet : null,
        resolveError: resolveError || null,
        username: maskUsername(creds.username),
        passwordLength: String(creds.password || '').length,
        perUserMode: /^(1|true|yes|on)$/i.test(String(process.env.MMX_USE_PER_USER_CREDENTIALS ?? '')),
        envFiles: ['.env', '.env.production (overrides)'],
    };
    console.log(JSON.stringify(out, null, 2));
    if (resolveError || !creds.username || !creds.password) {
        process.exit(1);
    }
}

main();
