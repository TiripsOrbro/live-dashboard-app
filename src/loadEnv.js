const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

/**
 * Load dashboard environment variables.
 *
 * - DASHBOARD_ENV=production (PM2 on AshDash): only `.env.production`
 * - Otherwise: `.env` then `.env.production` overrides (local dev)
 */
function loadEnv(options = {}) {
    const root = options.root || path.join(__dirname, '..');
    /* AshDash / Linux servers: default to .env.production only unless DASHBOARD_ENV=development */
    if (!process.env.DASHBOARD_ENV && process.platform !== 'win32') {
        process.env.DASHBOARD_ENV = 'production';
    }
    const productionOnly = /^(1|true|yes|on|production)$/i.test(
        String(process.env.DASHBOARD_ENV || '').trim()
    );

    const basePath = path.join(root, '.env');
    const prodPath = path.join(root, '.env.production');

    if (productionOnly) {
        if (fs.existsSync(prodPath)) {
            dotenv.config({ path: prodPath });
            return { mode: 'production-only', loaded: ['.env.production'] };
        }
        if (fs.existsSync(basePath)) {
            dotenv.config({ path: basePath });
            return { mode: 'production-only-fallback', loaded: ['.env'] };
        }
        return { mode: 'production-only', loaded: [] };
    }

    const loaded = [];
    if (fs.existsSync(basePath)) {
        dotenv.config({ path: basePath });
        loaded.push('.env');
    }
    if (fs.existsSync(prodPath)) {
        dotenv.config({ path: prodPath, override: true });
        loaded.push('.env.production');
    }
    return { mode: loaded.length > 1 ? 'layered' : loaded[0] || 'none', loaded };
}

module.exports = { loadEnv };
