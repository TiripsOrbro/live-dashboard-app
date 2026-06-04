#!/usr/bin/env node
/**
 * Print which Macromatix credentials each env file sets and what the app loads.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_KEYS = [
    'SCRAPER_USERNAME',
    'SCRAPER_PASSWORD',
    'SCRAPER_CREDENTIALS_ENCRYPTED',
    'SCRAPER_CREDENTIALS_KEY',
];

function parseEnvFile(relPath) {
    const filePath = path.join(ROOT, relPath);
    if (!fs.existsSync(filePath)) {
        return { exists: false, values: {} };
    }
    const values = {};
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        for (const key of ENV_KEYS) {
            if (!trimmed.startsWith(`${key}=`)) continue;
            let val = trimmed.slice(key.length + 1).trim();
            if (
                (val.startsWith('"') && val.endsWith('"')) ||
                (val.startsWith("'") && val.endsWith("'"))
            ) {
                val = val.slice(1, -1);
            }
            values[key] = val;
        }
    }
    return { exists: true, values };
}

function summarizeFileValues(values) {
    const out = {};
    if (values.SCRAPER_USERNAME != null) {
        out.SCRAPER_USERNAME = String(values.SCRAPER_USERNAME).trim() || '(empty string)';
    }
    if (values.SCRAPER_PASSWORD != null) {
        const p = String(values.SCRAPER_PASSWORD);
        out.SCRAPER_PASSWORD = p.length ? `(set, ${p.length} chars)` : '(empty string)';
    }
    if (values.SCRAPER_CREDENTIALS_ENCRYPTED != null) {
        const e = String(values.SCRAPER_CREDENTIALS_ENCRYPTED).trim();
        out.SCRAPER_CREDENTIALS_ENCRYPTED = e.length ? `(set, ${e.length} chars)` : '(empty string)';
    }
    if (values.SCRAPER_CREDENTIALS_KEY != null) {
        const k = String(values.SCRAPER_CREDENTIALS_KEY).trim();
        out.SCRAPER_CREDENTIALS_KEY = k.length ? '(set)' : '(empty string)';
    }
    return out;
}

function main() {
    const baseEnv = parseEnvFile('.env');
    const prodEnv = parseEnvFile('.env.production');

    const { loadEnv } = require('../src/loadEnv');
    const loadResult = loadEnv({ root: ROOT });

    const {
        resolveMacromatixCredentials,
    } = require('../src/services/macromatixScraper');

    let creds = { username: '', password: '' };
    let resolveError = '';
    try {
        creds = resolveMacromatixCredentials({});
    } catch (err) {
        resolveError = err.message || String(err);
    }

    const enc = Boolean(String(process.env.SCRAPER_CREDENTIALS_ENCRYPTED || '').trim());
    const out = {
        loadMode: loadResult.mode,
        loadedFiles: loadResult.loaded,
        note:
            loadResult.mode === 'production-only'
                ? 'DASHBOARD_ENV=production — only .env.production is loaded.'
                : '.env.production overrides .env for the same variable name.',
        files: {
            '.env': {
                exists: baseEnv.exists,
                defines: summarizeFileValues(baseEnv.values),
            },
            '.env.production': {
                exists: prodEnv.exists,
                defines: summarizeFileValues(prodEnv.values),
            },
        },
        effectiveAfterLoad: {
            credentialMode: enc ? 'SCRAPER_CREDENTIALS_ENCRYPTED' : 'SCRAPER_USERNAME/PASSWORD',
            SCRAPER_USERNAME: String(creds.username || '').trim() || '(empty)',
            SCRAPER_PASSWORD: String(creds.password || '').length
                ? `(set, ${String(creds.password).length} chars)`
                : '(empty)',
            resolveError: resolveError || null,
        },
        perUserMode: /^(1|true|yes|on)$/i.test(String(process.env.MMX_USE_PER_USER_CREDENTIALS ?? '')),
    };

    const baseUser = String(baseEnv.values.SCRAPER_USERNAME || '').trim();
    const prodUser = String(prodEnv.values.SCRAPER_USERNAME || '').trim();
    if (baseUser && prodUser && baseUser !== prodUser) {
        out.usernameMismatch =
            `.env has "${baseUser}" but .env.production has "${prodUser}" — production wins.`;
    } else if (baseUser && !prodUser && prodEnv.exists) {
        out.hint =
            '.env.production exists but does not set SCRAPER_USERNAME — using .env username.';
    }

    console.log(JSON.stringify(out, null, 2));

    if (resolveError || !creds.username || !creds.password) {
        process.exit(1);
    }
}

main();
