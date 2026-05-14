const express = require('express');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
/* Production wins over base .env (dotenv does not override by default, so empty SCRAPER_* in .env would block .env.production). */
require('dotenv').config({ path: path.join(__dirname, '../.env.production'), override: true });

(function logMacromatixEnvStatus() {
    const enc = String(process.env.SCRAPER_CREDENTIALS_ENCRYPTED || '').trim();
    if (enc) {
        const keyOk = Boolean(String(process.env.SCRAPER_CREDENTIALS_KEY || '').trim());
        console.log(`[Env] Macromatix: SCRAPER_CREDENTIALS_ENCRYPTED set; SCRAPER_CREDENTIALS_KEY ${keyOk ? 'set' : 'MISSING'}`);
        return;
    }
    const u = Boolean(String(process.env.SCRAPER_USERNAME || '').trim());
    const p = Boolean(String(process.env.SCRAPER_PASSWORD || '').trim());
    console.log(`[Env] Macromatix: SCRAPER_USERNAME ${u ? 'set' : 'MISSING'}, SCRAPER_PASSWORD ${p ? 'set' : 'MISSING'}`);
})();

const scrapeData = require('./services/scraper');
const {
    getDismissalPeriodKey,
    getAuditSchedule,
    instantForYmdInTimeZone,
    loadAuditRecurrenceConfigSync,
} = require('./utils/auditRecurrence');

const app = express();
const PORT = process.env.PORT || 3000;
const SALES_CACHE_SECONDS = Number(process.env.SALES_CACHE_SECONDS || 90);
/** Full Macromatix run (login + labour + scheduled orders); default 120s for slow pages */
const SCRAPE_TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS || 120000);
const SCRAPE_RETRIES = Number(process.env.SCRAPE_RETRIES || 1);
const AUDIT_STATE_FILE = process.env.AUDIT_STATE_FILE || path.join(__dirname, '../data/audit-state.json');

function isScheduledOrdersDateTestEnabled() {
    return /^(1|true|yes|on)$/i.test(String(process.env.DASHBOARD_ENABLE_ORDER_DATE_TEST ?? '').trim());
}

/** Test-date scrapes: explicit env, or any request that already passed dashboard cookie auth. */
function canRunScheduledOrdersDateTest(req, testPick) {
    if (!testPick) return false;
    if (isScheduledOrdersDateTestEnabled()) return true;
    if (isDashboardAuthenticated(req)) return true;
    return false;
}

/** Returns `{ year, month, day, ymd }` or null if invalid. */
function parseScheduledOrdersTestYmd(raw) {
    const s = String(raw ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const [y, m, d] = s.split('-').map((x) => parseInt(x, 10));
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dim = new Date(y, m, 0).getDate();
    if (d > dim) return null;
    return { year: y, month: m, day: d, ymd: s };
}
const DASHBOARD_ACCESS_KEY = String(process.env.DASHBOARD_ACCESS_KEY || '');
const DASHBOARD_ALLOWED_IPS = String(process.env.DASHBOARD_ALLOWED_IPS || '')
    .split(',')
    .map((ip) => normalizeIp(ip))
    .filter(Boolean);
const DASHBOARD_COOKIE_NAME = 'dashboard_access';

const cors = require('cors');
if (/^(1|true|yes|on)$/i.test(String(process.env.DASHBOARD_ENABLE_CORS ?? '').trim())) {
    app.use(cors());
}

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

let salesCache = null;
let salesCacheAt = 0;
let salesInFlight = null;
let auditStateCache = null;

function normalizeIp(ip) {
    return String(ip || '')
        .trim()
        .replace(/^::ffff:/, '')
        .replace(/^::1$/, '127.0.0.1');
}

function getRequestIp(req) {
    return normalizeIp(req.socket?.remoteAddress || req.ip);
}

function timingSafeEqualString(a, b) {
    const aBuf = Buffer.from(String(a));
    const bBuf = Buffer.from(String(b));
    return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
}

function parseCookies(header) {
    return String(header || '')
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .reduce((cookies, part) => {
            const eq = part.indexOf('=');
            if (eq < 0) return cookies;
            cookies[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1));
            return cookies;
        }, {});
}

function dashboardAccessToken() {
    const secret = process.env.DASHBOARD_AUTH_SECRET || DASHBOARD_ACCESS_KEY;
    return crypto.createHmac('sha256', secret).update(`dashboard:${DASHBOARD_ACCESS_KEY}`).digest('hex');
}

function isDashboardAuthenticated(req) {
    if (!DASHBOARD_ACCESS_KEY) return true;
    const cookies = parseCookies(req.headers.cookie);
    return timingSafeEqualString(cookies[DASHBOARD_COOKIE_NAME] || '', dashboardAccessToken());
}

function isApiRequest(req) {
    return req.path.startsWith('/api/') || /\bjson\b/i.test(String(req.headers.accept || ''));
}

function sendUnauthorized(req, res) {
    if (isApiRequest(req)) {
        res.status(401).json({ success: false, error: 'Dashboard access required.' });
        return;
    }
    res.redirect('/unlock');
}

function renderUnlockPage(error = '') {
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Dashboard Unlock</title>
    <style>
        body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Arial, sans-serif; background: #231e1f; color: #fff; }
        form { width: min(360px, calc(100vw - 32px)); display: grid; gap: 14px; padding: 28px; background: #312a2c; border: 2px solid #7a3eb1; }
        h1 { margin: 0; font-size: 1.5rem; }
        input, button { font: inherit; padding: 12px; border: 0; }
        button { background: #7a3eb1; color: #fff; font-weight: 700; cursor: pointer; }
        .error { color: #f8cb6f; min-height: 1.2em; }
    </style>
</head>
<body>
    <form method="post" action="/unlock">
        <h1>Unlock Dashboard</h1>
        <label>
            Access key
            <input name="accessKey" type="password" autocomplete="current-password" autofocus required>
        </label>
        <button type="submit">Unlock</button>
        <div class="error">${error}</div>
    </form>
</body>
</html>`;
}

function ipAllowlistMiddleware(req, res, next) {
    if (!DASHBOARD_ALLOWED_IPS.length) {
        next();
        return;
    }

    const ip = getRequestIp(req);
    const isLocal = ip === '127.0.0.1';
    if (isLocal || DASHBOARD_ALLOWED_IPS.includes(ip)) {
        next();
        return;
    }

    res.status(403).send('Forbidden');
}

function dashboardAuthMiddleware(req, res, next) {
    if (req.path === '/unlock') {
        next();
        return;
    }

    if (isDashboardAuthenticated(req)) {
        next();
        return;
    }

    sendUnauthorized(req, res);
}

app.use(ipAllowlistMiddleware);

app.get('/unlock', (req, res) => {
    if (!DASHBOARD_ACCESS_KEY || isDashboardAuthenticated(req)) {
        res.redirect('/');
        return;
    }
    res.send(renderUnlockPage());
});

app.post('/unlock', (req, res) => {
    if (!DASHBOARD_ACCESS_KEY) {
        res.redirect('/');
        return;
    }

    const accessKey = String(req.body?.accessKey || '');
    if (!timingSafeEqualString(accessKey, DASHBOARD_ACCESS_KEY)) {
        res.status(401).send(renderUnlockPage('Incorrect access key.'));
        return;
    }

    const secureCookie = /^(1|true|yes|on)$/i.test(String(process.env.DASHBOARD_SECURE_COOKIE ?? '').trim());
    res.cookie(DASHBOARD_COOKIE_NAME, dashboardAccessToken(), {
        httpOnly: true,
        sameSite: 'strict',
        secure: secureCookie,
        maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    res.redirect('/');
});

app.use(dashboardAuthMiddleware);

// Middleware to serve static files
app.use(express.static(path.join(__dirname, '../public')));

function isSalesCacheFresh() {
    if (!salesCache || !salesCacheAt) return false;
    return (Date.now() - salesCacheAt) < (SALES_CACHE_SECONDS * 1000);
}

function normalizeAuditLabels(labels) {
    if (!Array.isArray(labels)) return [];
    return [...new Set(labels.map((label) => String(label || '').trim()).filter(Boolean))];
}

async function readAuditStateFile() {
    try {
        const raw = await fs.readFile(AUDIT_STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        const storedKey = String(parsed.periodKey || parsed.weekKey || '');
        return {
            weekKey: storedKey,
            periodKey: storedKey,
            dismissed: normalizeAuditLabels(parsed.dismissed),
        };
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn('API: Failed to read audit state file:', error.message);
        }
        return { weekKey: getDismissalPeriodKey(), periodKey: getDismissalPeriodKey(), dismissed: [] };
    }
}

async function writeAuditStateFile(state) {
    await fs.mkdir(path.dirname(AUDIT_STATE_FILE), { recursive: true });
    await fs.writeFile(AUDIT_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

async function getAuditState() {
    const currentKey = getDismissalPeriodKey();
    if (!auditStateCache) {
        auditStateCache = await readAuditStateFile();
    }
    if (auditStateCache.weekKey !== currentKey) {
        auditStateCache = { weekKey: currentKey, periodKey: currentKey, dismissed: [] };
        await writeAuditStateFile(auditStateCache);
    }
    return auditStateCache;
}

async function saveAuditDismissals(labels) {
    const k = getDismissalPeriodKey();
    auditStateCache = {
        weekKey: k,
        periodKey: k,
        dismissed: normalizeAuditLabels(labels),
    };
    await writeAuditStateFile(auditStateCache);
    return auditStateCache;
}

async function withTimeout(promise, ms, onTimeout) {
    let timeoutId;
    let didTimeout = false;
    promise.catch((error) => {
        if (didTimeout) {
            console.warn('API: Timed-out scrape later failed after cleanup:', error.message);
        }
    });
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(async () => {
            didTimeout = true;
            try {
                if (onTimeout) await onTimeout();
            } catch (error) {
                console.warn('API: Scrape timeout cleanup failed:', error.message);
            }
            reject(new Error(`Scrape timed out after ${ms}ms`));
        }, ms);
    });
    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        clearTimeout(timeoutId);
    }
}

async function scrapeWithRetry(scrapeOptions = {}) {
    let lastError;
    const attempts = Math.max(1, SCRAPE_RETRIES + 1);
    for (let attempt = 1; attempt <= attempts; attempt++) {
        let activeBrowser = null;
        try {
            return await withTimeout(
                scrapeData({
                    ...scrapeOptions,
                    onBrowser: (browser) => {
                        activeBrowser = browser;
                    },
                }),
                SCRAPE_TIMEOUT_MS,
                async () => {
                    if (!activeBrowser) return;
                    console.warn('API: Closing active browser after scrape timeout');
                    await activeBrowser.close();
                }
            );
        } catch (error) {
            lastError = error;
            console.error(`API: Scrape attempt ${attempt}/${attempts} failed:`, error.message);
        }
    }
    throw lastError;
}

async function getSalesDataCached() {
    if (isSalesCacheFresh()) {
        return salesCache;
    }

    if (salesInFlight) {
        return salesInFlight;
    }

    salesInFlight = (async () => {
        const result = await scrapeWithRetry();
        const payload = {
            success: true,
            actual: result.actual,
            forecast: result.forecast,
            timestamp: result.timestamp,
            pendingVendors: Array.isArray(result.pendingVendors) ? result.pendingVendors : [],
        };
        salesCache = payload;
        salesCacheAt = Date.now();
        return payload;
    })();

    try {
        return await salesInFlight;
    } finally {
        salesInFlight = null;
    }
}

// Route to serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

app.get('/api/audit-schedule', (req, res) => {
    try {
        const asOf = parseScheduledOrdersTestYmd(req.query.asOfDate);
        const cfg = loadAuditRecurrenceConfigSync();
        const tz = cfg.timeZone || 'Australia/Melbourne';
        const schedule = asOf
            ? getAuditSchedule(instantForYmdInTimeZone(asOf.year, asOf.month, asOf.day, tz))
            : getAuditSchedule(undefined);
        res.json({ success: true, ...schedule, ...(asOf ? { asOfDate: asOf.ymd } : {}) });
    } catch (error) {
        console.error('API: Error reading audit schedule:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/audits', async (req, res) => {
    try {
        const state = await getAuditState();
        res.json({ success: true, ...state });
    } catch (error) {
        console.error('API: Error reading audit state:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/audits', async (req, res) => {
    try {
        const state = await saveAuditDismissals(req.body?.dismissed);
        res.json({ success: true, ...state });
    } catch (error) {
        console.error('API: Error saving audit state:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Test endpoint to trigger scraper
app.get('/api/test-scraper', async (req, res) => {
    if (!/^(1|true|yes|on)$/i.test(String(process.env.ENABLE_TEST_SCRAPER ?? '').trim())) {
        res.status(404).json({ success: false, error: 'Test scraper endpoint is disabled.' });
        return;
    }

    try {
        console.log('API: Scraper test requested');
        const payload = await getSalesDataCached();
        res.json(payload);
    } catch (error) {
        console.error('API: Scraper error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Main API endpoint to get sales data
app.get('/api/sales', async (req, res) => {
    try {
        console.log('API: Sales data requested');
        const testPick = parseScheduledOrdersTestYmd(req.query.testScheduledOrdersDate);
        let payload;
        if (testPick && canRunScheduledOrdersDateTest(req, testPick)) {
            console.log('API: Scheduled-orders test scrape for Melbourne date', testPick.ymd);
            const result = await scrapeWithRetry({
                scheduledOrdersPickYmd: { year: testPick.year, month: testPick.month, day: testPick.day },
                skipScheduledOrdersPersistence: true,
            });
            payload = {
                success: true,
                actual: result.actual,
                forecast: result.forecast,
                timestamp: result.timestamp,
                pendingVendors: Array.isArray(result.pendingVendors) ? result.pendingVendors : [],
                testScheduledOrdersDate: testPick.ymd,
            };
        } else {
            payload = await getSalesDataCached();
        }
        res.json(payload);
    } catch (error) {
        console.error('API: Error fetching sales data:', error);
        if (salesCache) {
            res.json({
                ...salesCache,
                stale: true,
                staleAgeSeconds: Math.round((Date.now() - salesCacheAt) / 1000),
                warning: 'Serving stale cached sales due to scrape error.',
            });
            return;
        }
        res.status(500).json({ success: false, error: error.message });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
