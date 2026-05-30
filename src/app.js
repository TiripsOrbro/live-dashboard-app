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
const { getStoreList, getStoreConfig, DEFAULT_OPEN_HOUR, DEFAULT_CLOSE_HOUR } = require('./services/storeList');
const {
    getDismissalPeriodKey,
    getAuditSchedule,
    instantForYmdInTimeZone,
    loadAuditRecurrenceConfigSync,
} = require('./utils/auditRecurrence');
const app = express();
const PORT = process.env.PORT || 3000;
/** Multi-store scrapes take minutes (≈45-60s per store), so cache the whole cycle for a while. */
const SALES_CACHE_SECONDS = Number(process.env.SALES_CACHE_SECONDS || 300);
/** Background refresh interval — keeps the cache warm for all stores so browser requests never wait on a scrape. */
const SALES_REFRESH_SECONDS = Number(process.env.SALES_REFRESH_SECONDS || 240);
/** Full Macromatix run (login + every store's labour + scheduled orders). ~1 min/store, so allow plenty for a slow Pi. */
const SCRAPE_TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS || 900000);
const SCRAPE_RETRIES = Number(process.env.SCRAPE_RETRIES || 1);
/** Store shown at `/` (no store in the path). Empty = first store the scrape returns. */
const DASHBOARD_DEFAULT_STORE = String(process.env.DASHBOARD_DEFAULT_STORE || '').trim();
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

// Middleware to serve static files. `index: false` so `/` is handled by our store-picker route below
// rather than being auto-served from public/index.html (the per-store dashboard).
app.use(express.static(path.join(__dirname, '../public'), { index: false }));

function isSalesCacheFresh() {
    if (!salesCache || !salesCacheAt) return false;
    return (Date.now() - salesCacheAt) < (SALES_CACHE_SECONDS * 1000);
}

function logDashboardScrapeComplete(payload) {
    const tz = process.env.DASHBOARD_TIME_ZONE || process.env.MMX_TIME_ZONE || 'Australia/Melbourne';
    let when;
    try {
        when = new Date().toLocaleString('en-AU', { timeZone: tz, hour12: false });
    } catch {
        when = payload.timestamp || new Date().toISOString();
    }
    const stores = Array.isArray(payload.stores) ? payload.stores : [];
    const summary = stores
        .map((s) => {
            const actualHours = Array.isArray(s.actual) ? s.actual.length : 0;
            const pending = Array.isArray(s.pendingVendors) ? s.pendingVendors.length : 0;
            const flag = s.error ? ' ERROR' : '';
            return `${s.storeNumber || '?'}(${actualHours}h, ${pending} pending${flag})`;
        })
        .join(', ');
    console.log(
        `[Dashboard] Scrape cycle complete — ${when} ${tz} | ${stores.length} store(s): ${summary || '(none)'}`
    );
}

function normalizeAuditLabels(labels) {
    if (!Array.isArray(labels)) return [];
    return [...new Set(labels.map((label) => String(label || '').trim()).filter(Boolean))];
}

/** Bucket key for a store's dismissals (digits only; falls back to a shared default bucket). */
function auditStoreKey(storeNumber) {
    return String(storeNumber || '').replace(/[^0-9]/g, '') || '__default__';
}

function emptyAuditState() {
    const k = getDismissalPeriodKey();
    return { periodKey: k, weekKey: k, stores: {} };
}

async function readAuditStateFile() {
    try {
        const raw = await fs.readFile(AUDIT_STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        const storedKey = String(parsed.periodKey || parsed.weekKey || '');
        const stores = {};
        if (parsed.stores && typeof parsed.stores === 'object') {
            for (const [k, v] of Object.entries(parsed.stores)) {
                stores[auditStoreKey(k)] = normalizeAuditLabels(v);
            }
        } else if (Array.isArray(parsed.dismissed)) {
            // Migrate a pre-multi-store (global) file into the default bucket.
            stores.__default__ = normalizeAuditLabels(parsed.dismissed);
        }
        return { periodKey: storedKey, weekKey: storedKey, stores };
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn('API: Failed to read audit state file:', error.message);
        }
        return emptyAuditState();
    }
}

async function writeAuditStateFile(state) {
    await fs.mkdir(path.dirname(AUDIT_STATE_FILE), { recursive: true });
    await fs.writeFile(AUDIT_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/** Whole multi-store state, resetting every store's dismissals when the week rolls over. */
async function getAuditStateAll() {
    const currentKey = getDismissalPeriodKey();
    if (!auditStateCache) {
        auditStateCache = await readAuditStateFile();
    }
    if (auditStateCache.periodKey !== currentKey) {
        auditStateCache = emptyAuditState();
        await writeAuditStateFile(auditStateCache);
    }
    return auditStateCache;
}

/** One store's dismissal view: `{ periodKey, weekKey, dismissed }`. */
async function getAuditState(storeNumber) {
    const all = await getAuditStateAll();
    const dismissed = all.stores[auditStoreKey(storeNumber)] || [];
    return { periodKey: all.periodKey, weekKey: all.periodKey, dismissed };
}

async function saveAuditDismissals(storeNumber, labels) {
    const all = await getAuditStateAll();
    const key = auditStoreKey(storeNumber);
    all.stores[key] = normalizeAuditLabels(labels);
    auditStateCache = all;
    await writeAuditStateFile(all);
    return { periodKey: all.periodKey, weekKey: all.periodKey, dismissed: all.stores[key] };
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

/** Does a store payload carry usable hourly data (vs an empty/errored placeholder)? */
function storeHasData(store) {
    return Boolean(
        store &&
            ((Array.isArray(store.actual) && store.actual.length) ||
                (Array.isArray(store.forecast) && store.forecast.length))
    );
}

/**
 * Merge a fresh scrape over the previous cache, per store: if a store's new pull came back
 * empty or errored, keep its previous good actual/forecast (and pending vendors) so the
 * dashboard retains the last-known values instead of blanking out for a cycle. Trading
 * hours/name from the fresh result are carried forward (they may change across the day).
 */
function mergeStoresPreservingGood(prevPayload, freshPayload) {
    const prevByNum = new Map();
    if (prevPayload && Array.isArray(prevPayload.stores)) {
        for (const s of prevPayload.stores) prevByNum.set(String(s.storeNumber), s);
    }
    return (freshPayload.stores || []).map((fresh) => {
        if (storeHasData(fresh) && !fresh.error) return fresh;
        const prev = prevByNum.get(String(fresh.storeNumber));
        if (storeHasData(prev)) {
            return {
                ...prev,
                openHour: Number.isFinite(fresh.openHour) ? fresh.openHour : prev.openHour,
                closeHour: Number.isFinite(fresh.closeHour) ? fresh.closeHour : prev.closeHour,
                storeName: fresh.storeName || prev.storeName,
                pendingVendors: Array.isArray(fresh.pendingVendors) ? fresh.pendingVendors : prev.pendingVendors,
                retained: true,
            };
        }
        return fresh; // no previous good data to fall back on
    });
}

/** Run a scrape and merge it into the cache (per-store retention). De-duped via salesInFlight. */
function runScrapeIntoCache(options) {
    if (salesInFlight) return salesInFlight;
    salesInFlight = (async () => {
        const result = await scrapeWithRetry(options);
        const fresh = {
            success: true,
            timestamp: result.timestamp,
            stores: Array.isArray(result.stores) ? result.stores : [],
        };
        salesCache = { success: true, timestamp: fresh.timestamp, stores: mergeStoresPreservingGood(salesCache, fresh) };
        salesCacheAt = Date.now();
        logDashboardScrapeComplete(salesCache);
        return salesCache;
    })();
    salesInFlight.catch(() => {}).finally(() => {
        salesInFlight = null;
    });
    return salesInFlight;
}

async function getSalesDataCached() {
    // Stale-while-revalidate: as long as we have *any* cached data, serve it instantly and
    // refresh in the background when stale — the dashboard never waits through a scrape.
    if (salesCache) {
        if (!isSalesCacheFresh() && !salesInFlight) {
            runScrapeIntoCache(); // fire-and-forget
        }
        return salesCache;
    }
    // Cold start — nothing cached yet, so this first caller waits for the initial scrape.
    return runScrapeIntoCache();
}

/** Trading hours for a store from `.storelist`, falling back to defaults. */
function storeHours(storeNumber) {
    const cfg = getStoreConfig(storeNumber);
    return {
        openHour: cfg ? cfg.openHour : DEFAULT_OPEN_HOUR,
        closeHour: cfg ? cfg.closeHour : DEFAULT_CLOSE_HOUR,
    };
}

/** Empty per-store grid (no actual/forecast yet) so the dashboard can still render. */
function emptyStorePayload(storeNumber, storeName) {
    const hours = storeHours(storeNumber);
    return {
        actual: [],
        forecast: [],
        pendingVendors: [],
        storeNumber: storeNumber || '',
        storeName: storeName || storeNumber || '',
        openHour: hours.openHour,
        closeHour: hours.closeHour,
    };
}

/** Pick one store out of a multi-store payload, shaped like the old single-store response. */
function storeSliceFromPayload(payload, requestedStore) {
    const stores = Array.isArray(payload.stores) ? payload.stores : [];
    let store = null;
    if (requestedStore) {
        store = stores.find((s) => String(s.storeNumber) === String(requestedStore)) || null;
    } else if (DASHBOARD_DEFAULT_STORE) {
        store = stores.find((s) => String(s.storeNumber) === DASHBOARD_DEFAULT_STORE) || null;
    }
    if (!store) store = stores[0] || null;

    const base = store
        ? {
              actual: Array.isArray(store.actual) ? store.actual : [],
              forecast: Array.isArray(store.forecast) ? store.forecast : [],
              pendingVendors: Array.isArray(store.pendingVendors) ? store.pendingVendors : [],
              storeNumber: store.storeNumber || '',
              storeName: store.storeName || store.storeNumber || '',
              openHour: Number.isFinite(store.openHour) ? store.openHour : storeHours(store.storeNumber).openHour,
              closeHour: Number.isFinite(store.closeHour) ? store.closeHour : storeHours(store.storeNumber).closeHour,
              ...(store.error ? { storeError: store.error } : {}),
          }
        : emptyStorePayload(requestedStore, '');

    return {
        success: true,
        timestamp: payload.timestamp,
        availableStores: stores.map((s) => ({ storeNumber: s.storeNumber, storeName: s.storeName })),
        storeNotFound: requestedStore ? !stores.some((s) => String(s.storeNumber) === String(requestedStore)) : false,
        ...base,
    };
}

// Root path is the store picker — a grid of clickable store tiles (see public/stores.html).
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public', 'stores.html'));
});

// Per-store dashboard pages, e.g. /3811. The SPA reads the store number from the path.
// Static assets and /api/* are matched earlier, so this only catches a bare numeric segment.
app.get(/^\/(\d{3,6})\/?$/, (req, res) => {
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
        const state = await getAuditState(req.query.store);
        res.json({ success: true, store: auditStoreKey(req.query.store), ...state });
    } catch (error) {
        console.error('API: Error reading audit state:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/audits', async (req, res) => {
    try {
        const state = await saveAuditDismissals(req.query.store, req.body?.dismissed);
        res.json({ success: true, store: auditStoreKey(req.query.store), ...state });
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

// Main API endpoint to get sales data (one store's slice of the cached multi-store payload)
app.get('/api/sales', async (req, res) => {
    const requestedStore = String(req.query.store || '').trim();
    try {
        console.log('API: Sales data requested', requestedStore ? `(store ${requestedStore})` : '');
        const testPick = parseScheduledOrdersTestYmd(req.query.testScheduledOrdersDate);
        let fullPayload;
        if (testPick && canRunScheduledOrdersDateTest(req, testPick)) {
            console.log('API: Scheduled-orders test scrape for Melbourne date', testPick.ymd);
            const result = await scrapeWithRetry({
                scheduledOrdersPickYmd: { year: testPick.year, month: testPick.month, day: testPick.day },
                skipScheduledOrdersPersistence: true,
                storeNumber: requestedStore || undefined,
            });
            fullPayload = {
                success: true,
                timestamp: result.timestamp,
                stores: Array.isArray(result.stores) ? result.stores : [],
            };
            logDashboardScrapeComplete(fullPayload);
            const slice = storeSliceFromPayload(fullPayload, requestedStore);
            slice.testScheduledOrdersDate = testPick.ymd;
            res.json(slice);
            return;
        }

        fullPayload = await getSalesDataCached();
        const slice = storeSliceFromPayload(fullPayload, requestedStore);
        res.json(slice);
    } catch (error) {
        console.error('API: Error fetching sales data:', error);
        if (salesCache) {
            const slice = storeSliceFromPayload(salesCache, requestedStore);
            res.json({
                ...slice,
                stale: true,
                staleAgeSeconds: Math.round((Date.now() - salesCacheAt) / 1000),
                warning: 'Serving stale cached sales due to scrape error.',
            });
            return;
        }
        res.status(500).json({ success: false, error: error.message });
    }
});

// List of stores (number, name, trading hours) for the store picker and per-store grid.
// Served straight from `.storelist` so it returns instantly without waiting on a scrape.
app.get('/api/stores', async (req, res) => {
    try {
        let stores = getStoreList().map((s) => ({
            storeNumber: s.storeNumber,
            storeName: s.storeName,
            openHour: s.openHour,
            closeHour: s.closeHour,
        }));

        // Fallback: no .storelist configured — use whatever the last scrape discovered.
        if (!stores.length && salesCache) {
            stores = (Array.isArray(salesCache.stores) ? salesCache.stores : []).map((s) => ({
                storeNumber: s.storeNumber,
                storeName: s.storeName,
                openHour: Number.isFinite(s.openHour) ? s.openHour : DEFAULT_OPEN_HOUR,
                closeHour: Number.isFinite(s.closeHour) ? s.closeHour : DEFAULT_CLOSE_HOUR,
            }));
        }

        res.json({ success: true, stores, defaultStore: DASHBOARD_DEFAULT_STORE || (stores[0]?.storeNumber ?? '') });
    } catch (error) {
        console.error('API: Error listing stores:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Background refresh: keep the multi-store cache warm so browser requests never wait through a full scrape.
let refreshTimer = null;
function startBackgroundRefresh() {
    if (SALES_REFRESH_SECONDS <= 0) {
        console.log('[Dashboard] Background refresh disabled (SALES_REFRESH_SECONDS <= 0)');
        return;
    }
    const tick = async () => {
        try {
            await runScrapeIntoCache();
        } catch (error) {
            console.warn('[Dashboard] Background refresh failed:', error.message);
        }
    };
    // Prime the cache shortly after boot, then on the configured interval.
    setTimeout(tick, 3000).unref?.();
    refreshTimer = setInterval(tick, SALES_REFRESH_SECONDS * 1000);
    refreshTimer.unref?.();
    console.log(`[Dashboard] Background sales refresh every ${SALES_REFRESH_SECONDS}s`);
}

// Start the server (bind all interfaces so other LAN devices can reach the Pi).
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on http://0.0.0.0:${PORT}`);
    startBackgroundRefresh();
});

// Graceful shutdown so PM2 restarts / systemctl stop release the port cleanly.
let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Dashboard] ${signal} received — closing server…`);
    if (refreshTimer) clearInterval(refreshTimer);
    const force = setTimeout(() => {
        console.warn('[Dashboard] Forced exit after shutdown timeout');
        process.exit(0);
    }, 10000);
    force.unref();
    server.close(() => {
        clearTimeout(force);
        console.log('[Dashboard] Server closed — exiting');
        process.exit(0);
    });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A scrape failure must never take the whole dashboard down.
process.on('unhandledRejection', (reason) => {
    console.error('[Dashboard] Unhandled promise rejection:', reason);
});
