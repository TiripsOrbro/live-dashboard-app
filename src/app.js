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
const { notifyScrapeFailure } = require('./services/alertNotifier');
const { getStoreList, getStoreConfig, DEFAULT_OPEN_HOUR, DEFAULT_CLOSE_HOUR } = require('./services/storeList');
const {
    TEST_STORE_SLUG,
    isTestStore,
    normalizeStoreKey,
    buildTestStoreSalesSlice,
    testStoreListEntry,
} = require('./services/testStore');
const { listConfiguredVendors, getVendorCatalog } = require('./services/vendorCatalog');
const {
    getDraft,
    saveDraftLocation,
    getSummary,
    submitStockCount,
    clearStockCountDay,
    getCompletedVendorLabelsForStore,
} = require('./services/stockCountState');
const { sendStockCountToMmx } = require('./services/stockCountMmxPipeline');
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

function isStockCountTestEnabled() {
    return /^(1|true|yes|on)$/i.test(String(process.env.ENABLE_STOCK_COUNT_TEST ?? '').trim());
}

function isStockCountTestPendingAlways() {
    return /^(1|true|yes|on)$/i.test(String(process.env.STOCK_COUNT_TEST_PENDING ?? '').trim());
}

/** Test helpers: explicit env, or any request that already passed dashboard cookie auth. */
function canRunStockCountTest(req) {
    if (isStockCountTestEnabled() || isStockCountTestPendingAlways()) return true;
    if (isNologinUser(req.dashboardUser)) return false;
    if (isAuthenticated(req, DASHBOARD_ACCESS_KEY)) return true;
    return false;
}

function wantsTestStockCountPending(req) {
    if (isStockCountTestPendingAlways()) return true;
    if (!canRunStockCountTest(req)) return false;
    return /^(1|true|yes|on)$/i.test(String(req.query.testStockCountPending ?? '').trim());
}

function applyTestPendingVendors(slice) {
    const labels = listConfiguredVendors()
        .filter((v) => v.configured)
        .map((v) => v.label);
    const merged = new Set([...(Array.isArray(slice.pendingVendors) ? slice.pendingVendors : []), ...labels]);
    slice.pendingVendors = Array.from(merged).sort((a, b) => a.localeCompare(b));
    slice.stockCountTestPending = true;
    return slice;
}

/** Test-date scrapes: explicit env, or any request that already passed dashboard cookie auth. */
function canRunScheduledOrdersDateTest(req, testPick) {
    if (!testPick) return false;
    if (isNologinUser(req.dashboardUser)) return false;
    if (isScheduledOrdersDateTestEnabled()) return true;
    if (isAuthenticated(req, DASHBOARD_ACCESS_KEY)) return true;
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
const {
    SESSION_COOKIE,
    LEGACY_COOKIE,
    NOLOGIN_COOKIE,
    usersFileConfigured,
    authenticate,
    createSessionToken,
    createNologinToken,
    legacyAccessToken,
    resolveUser,
    resolveNologinUser,
    isAuthenticated,
    isNologinUser,
    isAdminUser,
    userCanAccessStore,
    filterStoresForUser,
    getLoginRedirectPath,
    sessionCookieOptions,
    nologinCookieOptions,
    userProfileForClient,
    timingSafeEqualString,
    readUsersFileSync,
    resolveUsersFilePath,
} = require('./services/dashboardUsers');
const DASHBOARD_ACCESS_KEY = String(process.env.DASHBOARD_ACCESS_KEY || '');
const NOLOGIN_LINKS_ENABLED =
    !/^(0|false|no|off)$/i.test(String(process.env.DASHBOARD_NOLOGIN_LINKS ?? '1').trim());
const DASHBOARD_ALLOWED_IPS = String(process.env.DASHBOARD_ALLOWED_IPS || '')
    .split(',')
    .map((ip) => normalizeIp(ip))
    .filter(Boolean);

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

function authRequired() {
    if (usersFileConfigured()) return true;
    return Boolean(DASHBOARD_ACCESS_KEY);
}

function getRequestUser(req) {
    return resolveUser(req, DASHBOARD_ACCESS_KEY);
}

function isApiRequest(req) {
    return req.path.startsWith('/api/') || /\bjson\b/i.test(String(req.headers.accept || ''));
}

function sendUnauthorized(req, res) {
    if (isApiRequest(req)) {
        res.status(401).json({ success: false, error: 'Dashboard login required.' });
        return;
    }
    res.redirect('/login');
}

function sendForbidden(req, res, message = 'You do not have access to this store.') {
    if (isApiRequest(req)) {
        res.status(403).json({ success: false, error: message });
        return;
    }
    const user = getRequestUser(req);
    res.redirect(getLoginRedirectPath(user));
}

function wantsJsonResponse(req) {
    const contentType = String(req.headers['content-type'] || '');
    const accept = String(req.headers.accept || '');
    return /\bapplication\/json\b/i.test(contentType) || /\bjson\b/i.test(accept);
}

function sendLoginSuccess(req, res, user) {
    const profile = userProfileForClient(user);
    const dest = profile.defaultPath || getLoginRedirectPath(user);
    if (wantsJsonResponse(req)) {
        res.json({
            success: true,
            welcomeName: profile.welcomeName || '',
            defaultPath: dest,
        });
        return;
    }
    res.redirect(dest);
}

function sendLoginFailure(req, res, message = 'Incorrect username or password.') {
    if (wantsJsonResponse(req)) {
        res.status(401).json({ success: false, error: message });
        return;
    }
    res.redirect('/login?error=invalid');
}

function setSessionCookie(res, user, remember = true) {
    res.cookie(SESSION_COOKIE, createSessionToken(user), sessionCookieOptions({ remember }));
    res.clearCookie(LEGACY_COOKIE, sessionCookieOptions({ remember }));
}

function setLegacyAccessCookie(res, remember = true) {
    res.cookie(LEGACY_COOKIE, legacyAccessToken(DASHBOARD_ACCESS_KEY), sessionCookieOptions({ remember }));
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions({ remember }));
}

function logAuthLogin(req, user) {
    const ip = getRequestIp(req);
    if (user?.username === '__legacy__') {
        console.log(`[Auth] Login: legacy access key from ${ip}`);
        return;
    }
    const profile = userProfileForClient(user);
    const label = profile.welcomeName || user.username;
    const access = user.stores === '*' ? 'all stores' : user.stores.join(', ');
    console.log(`[Auth] Login: ${user.username} (${label}) — ${access} from ${ip}`);
}

function logAuthLoginFailed(req, username, reason = 'invalid credentials') {
    const ip = getRequestIp(req);
    const who = String(username || '').trim() || '(no username)';
    console.log(`[Auth] Login failed: ${who} — ${reason} from ${ip}`);
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

function isLoginPublicPath(reqPath) {
    if (reqPath === '/login' || reqPath === '/unlock' || reqPath === '/logout') return true;
    if (reqPath === '/icon.svg' || reqPath === '/icon-mark.svg') return true;
    if (reqPath === '/styles/login.css' || reqPath === '/scripts/login.js') return true;
    return false;
}

function isKnownStoreNumber(storeNumber) {
    if (isTestStore(storeNumber)) return true;
    const num = normalizeStoreKey(storeNumber);
    if (!num) return false;
    const stores = getStoreList();
    if (!stores.length) return true;
    return stores.some((s) => String(s.storeNumber) === num);
}

function isDashboardAssetPath(reqPath) {
    if (reqPath.startsWith('/styles/') || reqPath.startsWith('/scripts/') || reqPath.startsWith('/assets/')) {
        return true;
    }
    if (reqPath === '/manifest.json' || reqPath === '/icon.svg' || reqPath === '/icon-mark.svg') {
        return true;
    }
    return false;
}

function nologinAllowsPath(reqPath, storeNumber) {
    const store = normalizeStoreKey(storeNumber);
    if (!store) return false;
    if (isTestStore(store)) {
        if (new RegExp(`^/${TEST_STORE_SLUG}/nologin/?$`, 'i').test(reqPath)) return true;
        if (new RegExp(`^/${TEST_STORE_SLUG}/?$`, 'i').test(reqPath)) return true;
        if (new RegExp(`^/${TEST_STORE_SLUG}/stock-count/[a-z0-9-]+(?:/nologin)?/?$`, 'i').test(reqPath)) return true;
    } else {
        if (new RegExp(`^/${store}/nologin/?$`).test(reqPath)) return true;
        if (new RegExp(`^/${store}/stock-count/[a-z0-9-]+(?:/nologin)?/?$`).test(reqPath)) return true;
    }
    if (isDashboardAssetPath(reqPath)) return true;
    if (reqPath === '/api/me' || reqPath === '/api/audit-schedule') return true;
    if (reqPath === '/api/sales' || reqPath === '/api/audits') return true;
    if (reqPath.startsWith('/api/stock-count')) return true;
    return false;
}

function dashboardAuthMiddleware(req, res, next) {
    if (isLoginPublicPath(req.path)) {
        next();
        return;
    }

    if (isAuthenticated(req, DASHBOARD_ACCESS_KEY)) {
        req.dashboardUser = getRequestUser(req);
        next();
        return;
    }

    const nologinUser = NOLOGIN_LINKS_ENABLED ? resolveNologinUser(req) : null;
    if (nologinUser) {
        req.dashboardUser = nologinUser;
        if (nologinAllowsPath(req.path, nologinUser.stores[0])) {
            next();
            return;
        }
        sendForbidden(req, res, 'This link only provides access to one store dashboard.');
        return;
    }

    if (!authRequired()) {
        req.dashboardUser = getRequestUser(req);
        next();
        return;
    }

    sendUnauthorized(req, res);
}

app.use(ipAllowlistMiddleware);

app.get('/unlock', (req, res) => {
    res.redirect('/login');
});

app.get('/login', (req, res) => {
    if (!authRequired() || isAuthenticated(req, DASHBOARD_ACCESS_KEY)) {
        const user = getRequestUser(req);
        res.redirect(getLoginRedirectPath(user));
        return;
    }
    res.sendFile(path.join(__dirname, '../public', 'login.html'));
});

app.post('/login', (req, res) => {
    if (!authRequired()) {
        if (wantsJsonResponse(req)) {
            res.json({ success: true, welcomeName: '', defaultPath: '/' });
            return;
        }
        res.redirect('/');
        return;
    }

    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || req.body?.accessKey || '');
    const remember = !(req.body?.remember === false || req.body?.remember === '0' || req.body?.remember === 0);

    if (!username && DASHBOARD_ACCESS_KEY && timingSafeEqualString(password, DASHBOARD_ACCESS_KEY)) {
        setLegacyAccessCookie(res, remember);
        logAuthLogin(req, { username: '__legacy__', role: 'admin', stores: '*' });
        sendLoginSuccess(req, res, { username: '__legacy__', role: 'admin', stores: '*' });
        return;
    }

    const user = authenticate(username, password);
    if (!user) {
        logAuthLoginFailed(req, username);
        sendLoginFailure(req, res);
        return;
    }

    setSessionCookie(res, user, remember);
    logAuthLogin(req, user);
    sendLoginSuccess(req, res, user);
});

app.post('/unlock', (req, res) => {
    const password = String(req.body?.accessKey || '');
    if (!authRequired()) {
        if (wantsJsonResponse(req)) {
            res.json({ success: true, welcomeName: '', defaultPath: '/' });
            return;
        }
        res.redirect('/');
        return;
    }
    if (DASHBOARD_ACCESS_KEY && timingSafeEqualString(password, DASHBOARD_ACCESS_KEY)) {
        setLegacyAccessCookie(res, true);
        logAuthLogin(req, { username: '__legacy__', role: 'admin', stores: '*' });
        sendLoginSuccess(req, res, { username: '__legacy__', role: 'admin', stores: '*' });
        return;
    }
    logAuthLoginFailed(req, '', 'invalid access key');
    sendLoginFailure(req, res, 'Incorrect access key.');
});

app.get('/logout', (req, res) => {
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
    res.clearCookie(LEGACY_COOKIE, sessionCookieOptions());
    res.clearCookie(NOLOGIN_COOKIE, nologinCookieOptions());
    res.redirect('/login');
});

// Direct store link without login — e.g. /3811/nologin or /teststore/nologin (not linked from the app UI).
app.get(/^\/(teststore|\d{3,6})\/nologin\/?$/i, (req, res) => {
    const storeNumber = normalizeStoreKey((req.path.match(/^\/(teststore|\d{3,6})\/nologin\/?$/i) || [])[1]);
    if (!NOLOGIN_LINKS_ENABLED) {
        res.status(404).send('Not found.');
        return;
    }
    if (!authRequired()) {
        res.redirect(`/${storeNumber}`);
        return;
    }
    if (isAuthenticated(req, DASHBOARD_ACCESS_KEY)) {
        const user = getRequestUser(req);
        if (userCanAccessStore(user, storeNumber)) {
            res.redirect(`/${storeNumber}`);
            return;
        }
        res.status(403).send('You do not have access to this store.');
        return;
    }
    if (!isKnownStoreNumber(storeNumber)) {
        res.status(404).send('Store not found.');
        return;
    }
    res.cookie(NOLOGIN_COOKIE, createNologinToken(storeNumber), nologinCookieOptions());
    console.log(`[Auth] Nologin link opened: store ${storeNumber} from ${getRequestIp(req)}`);
    res.sendFile(path.join(__dirname, '../public', 'index.html'));
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
    const key = normalizeStoreKey(storeNumber);
    return key || '__default__';
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
        try {
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
        } catch (error) {
            notifyScrapeFailure(error, 'scrape cycle').catch(() => {});
            throw error;
        }
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

function filterSalesSliceForUser(slice, user) {
    if (!slice || isAdminUser(user)) return slice;
    const allowed = new Set((user.stores === '*' ? [] : user.stores).map(String));
    if (!allowed.size) return slice;
    return {
        ...slice,
        availableStores: (Array.isArray(slice.availableStores) ? slice.availableStores : []).filter((s) =>
            allowed.has(String(s.storeNumber))
        ),
    };
}

function assertStoreAccess(req, res, storeNumber) {
    const user = req.dashboardUser || getRequestUser(req);
    if (!userCanAccessStore(user, storeNumber)) {
        sendForbidden(req, res);
        return false;
    }
    return true;
}

async function enrichSalesSliceWithStockCount(slice, options = {}) {
    if (!slice || typeof slice !== 'object') return slice;
    const storeNumber = String(slice.storeNumber || '').trim();
    slice.stockCountVendors = listConfiguredVendors();
    if (!storeNumber) {
        slice.stockCountCompleted = [];
        return slice;
    }
    if (options.testPending) {
        applyTestPendingVendors(slice);
    }
    const completed = await getCompletedVendorLabelsForStore(storeNumber);
    slice.stockCountCompleted = completed;
    if (Array.isArray(slice.pendingVendors)) {
        const done = new Set(completed.map(String));
        slice.pendingVendors = slice.pendingVendors.filter((v) => !done.has(String(v)));
    }
    return slice;
}

function stockCountStoreFromQuery(req) {
    return normalizeStoreKey(req.query.store);
}

function stockCountVendorFromQuery(req) {
    return String(req.query.vendor || '').trim().toLowerCase();
}

app.get('/welcome', (req, res) => {
    res.redirect('/login');
});

// Root path is the store picker — a grid of clickable store tiles (see public/stores.html).
app.get('/', (req, res) => {
    if (isNologinUser(req.dashboardUser)) {
        sendForbidden(req, res, 'Use your direct store link to view this dashboard.');
        return;
    }
    const user = req.dashboardUser || getRequestUser(req);
    if (user && !isAdminUser(user) && user.stores !== '*' && user.stores.length === 1) {
        res.redirect(`/${user.stores[0]}`);
        return;
    }
    res.sendFile(path.join(__dirname, '../public', 'stores.html'));
});

// Per-store dashboard pages, e.g. /3811 or /teststore. The SPA reads the store from the path.
// Static assets and /api/* are matched earlier, so this only catches a bare store segment.
app.get(/^\/teststore\/?$/i, (req, res) => {
    if (isNologinUser(req.dashboardUser) && !userCanAccessStore(req.dashboardUser, TEST_STORE_SLUG)) {
        sendForbidden(req, res, 'Use your direct store link to view this dashboard.');
        return;
    }
    if (!assertStoreAccess(req, res, TEST_STORE_SLUG)) return;
    res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

app.get(/^\/(\d{3,6})\/?$/, (req, res) => {
    const storeNumber = (req.path.match(/^\/(\d{3,6})\/?$/) || [])[1];
    if (isNologinUser(req.dashboardUser)) {
        sendForbidden(req, res, 'Use your direct store link to view this dashboard.');
        return;
    }
    if (!assertStoreAccess(req, res, storeNumber)) return;
    res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

function sendStockCountPage(req, res, storeNumber) {
    if (!assertStoreAccess(req, res, storeNumber)) return;
    res.sendFile(path.join(__dirname, '../public', 'stock-count.html'));
}

app.get(/^\/(teststore|\d{3,6})\/stock-count\/([a-z0-9-]+)\/?$/i, (req, res) => {
    const storeNumber = normalizeStoreKey((req.path.match(/^\/(teststore|\d{3,6})\/stock-count\/[a-z0-9-]+\/?$/i) || [])[1]);
    sendStockCountPage(req, res, storeNumber);
});

app.get(/^\/(teststore|\d{3,6})\/stock-count\/([a-z0-9-]+)\/nologin\/?$/i, (req, res) => {
    const storeNumber = normalizeStoreKey(
        (req.path.match(/^\/(teststore|\d{3,6})\/stock-count\/[a-z0-9-]+\/nologin\/?$/i) || [])[1]
    );
    sendStockCountPage(req, res, storeNumber);
});

app.get('/api/me', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    res.json({ success: true, ...userProfileForClient(user) });
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
        const store = auditStoreKey(req.query.store);
        if (!assertStoreAccess(req, res, store)) return;
        const state = await getAuditState(req.query.store);
        res.json({ success: true, store, ...state });
    } catch (error) {
        console.error('API: Error reading audit state:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/audits', async (req, res) => {
    try {
        const store = auditStoreKey(req.query.store);
        if (!assertStoreAccess(req, res, store)) return;
        const state = await saveAuditDismissals(req.query.store, req.body?.dismissed);
        res.json({ success: true, store, ...state });
    } catch (error) {
        console.error('API: Error saving audit state:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/stock-count/vendors', (req, res) => {
    res.json({ success: true, vendors: listConfiguredVendors() });
});

app.get('/api/stock-count/catalog', (req, res) => {
    const vendorSlug = stockCountVendorFromQuery(req);
    const catalog = getVendorCatalog(vendorSlug);
    if (!catalog) {
        res.status(404).json({ success: false, error: 'Vendor catalog not found.' });
        return;
    }
    res.json({ success: true, catalog });
});

app.get('/api/stock-count/draft', async (req, res) => {
    try {
        const store = stockCountStoreFromQuery(req);
        const vendorSlug = stockCountVendorFromQuery(req);
        if (!store || !assertStoreAccess(req, res, store)) return;
        const draft = await getDraft(store, vendorSlug);
        if (!draft) {
            res.status(404).json({ success: false, error: 'Vendor catalog not found.' });
            return;
        }
        res.json(draft);
    } catch (error) {
        console.error('API: Error reading stock count draft:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/stock-count/draft', async (req, res) => {
    try {
        const store = stockCountStoreFromQuery(req);
        const vendorSlug = stockCountVendorFromQuery(req);
        if (!store || !assertStoreAccess(req, res, store)) return;
        const location = String(req.body?.location || '').trim();
        const items = req.body?.items;
        if (!location) {
            res.status(400).json({ success: false, error: 'Location is required.' });
            return;
        }
        const draft = await saveDraftLocation(store, vendorSlug, location, items);
        res.json(draft);
    } catch (error) {
        console.error('API: Error saving stock count draft:', error);
        const status = /already submitted|Unknown location/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
});

app.get('/api/stock-count/summary', async (req, res) => {
    try {
        const store = stockCountStoreFromQuery(req);
        const vendorSlug = stockCountVendorFromQuery(req);
        if (!store || !assertStoreAccess(req, res, store)) return;
        const summary = await getSummary(store, vendorSlug);
        if (!summary) {
            res.status(404).json({ success: false, error: 'Vendor catalog not found.' });
            return;
        }
        res.json(summary);
    } catch (error) {
        console.error('API: Error reading stock count summary:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/stock-count/completed', async (req, res) => {
    try {
        const store = stockCountStoreFromQuery(req);
        if (!store || !assertStoreAccess(req, res, store)) return;
        const completed = await getCompletedVendorLabelsForStore(store);
        res.json({ success: true, store, completed });
    } catch (error) {
        console.error('API: Error reading stock count completed list:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/stock-count/test/reset', async (req, res) => {
    if (!canRunStockCountTest(req)) {
        res.status(404).json({ success: false, error: 'Stock count test helpers are disabled.' });
        return;
    }
    try {
        const store = stockCountStoreFromQuery(req);
        if (!store || !assertStoreAccess(req, res, store)) return;
        const vendorSlug = String(req.query.vendor || req.body?.vendor || '').trim() || null;
        const dateKey = parseScheduledOrdersTestYmd(req.query.date || req.body?.date)?.ymd;
        const result = await clearStockCountDay(store, { vendorSlug, dateKey });
        const labels = result.cleared.map((slug) => getVendorCatalog(slug)?.label || slug);
        console.log(
            `[StockCount] Test reset store ${result.storeNumber} date ${result.dateKey}` +
                (labels.length ? `: ${labels.join(', ')}` : ' (nothing to clear)')
        );
        res.json({ success: true, ...result, vendorLabels: labels });
    } catch (error) {
        console.error('API: Error resetting stock count test state:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/stock-count/send-to-mmx', async (req, res) => {
    try {
        const store = stockCountStoreFromQuery(req);
        const vendorSlug = stockCountVendorFromQuery(req);
        if (!store || !assertStoreAccess(req, res, store)) return;

        console.log(`[StockCount] Send to MMX — store ${store} vendor ${vendorSlug}`);
        const result = await sendStockCountToMmx(store, vendorSlug);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('API: Error sending stock count to MMX:', error);
        const status = /No stock count draft|already submitted|not found/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
});

app.post('/api/stock-count/submit', async (req, res) => {
    try {
        const store = stockCountStoreFromQuery(req);
        const vendorSlug = stockCountVendorFromQuery(req);
        if (!store || !assertStoreAccess(req, res, store)) return;
        const summary = await submitStockCount(store, vendorSlug);
        if (!summary) {
            res.status(404).json({ success: false, error: 'Vendor catalog not found.' });
            return;
        }
        console.log(
            `[StockCount] Submitted store ${store} vendor ${vendorSlug} — ${summary.items?.length || 0} item(s)`
        );
        res.json({ success: true, ...summary, macromatixPending: true });
    } catch (error) {
        console.error('API: Error submitting stock count:', error);
        const status = /No stock count draft|already submitted/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
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
    if (requestedStore && !assertStoreAccess(req, res, requestedStore)) return;
    try {
        console.log('API: Sales data requested', requestedStore ? `(store ${requestedStore})` : '');
        if (isTestStore(requestedStore)) {
            const slice = await enrichSalesSliceWithStockCount(
                filterSalesSliceForUser(buildTestStoreSalesSlice(), req.dashboardUser || getRequestUser(req)),
                { testPending: true }
            );
            res.json(slice);
            return;
        }
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
            const testPending = wantsTestStockCountPending(req);
            const slice = await enrichSalesSliceWithStockCount(
                filterSalesSliceForUser(
                    storeSliceFromPayload(fullPayload, requestedStore),
                    req.dashboardUser || getRequestUser(req)
                ),
                { testPending }
            );
            slice.testScheduledOrdersDate = testPick.ymd;
            res.json(slice);
            return;
        }

        fullPayload = await getSalesDataCached();
        const testPending = wantsTestStockCountPending(req);
        res.json(
            await enrichSalesSliceWithStockCount(
                filterSalesSliceForUser(
                    storeSliceFromPayload(fullPayload, requestedStore),
                    req.dashboardUser || getRequestUser(req)
                ),
                { testPending }
            )
        );
    } catch (error) {
        console.error('API: Error fetching sales data:', error);
        if (salesCache) {
            res.json(
                await enrichSalesSliceWithStockCount(
                    {
                        ...filterSalesSliceForUser(
                            storeSliceFromPayload(salesCache, requestedStore),
                            req.dashboardUser || getRequestUser(req)
                        ),
                        stale: true,
                        staleAgeSeconds: Math.round((Date.now() - salesCacheAt) / 1000),
                        warning: 'Serving stale cached sales due to scrape error.',
                    },
                    { testPending: wantsTestStockCountPending(req) }
                )
            );
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

        const user = req.dashboardUser || getRequestUser(req);
        stores = filterStoresForUser(user, stores);
        if (isAdminUser(user)) {
            stores = [testStoreListEntry(), ...stores];
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
            notifyScrapeFailure(error, 'background refresh').catch(() => {});
        }
    };
    // Prime the cache shortly after boot, then on the configured interval.
    setTimeout(tick, 3000).unref?.();
    refreshTimer = setInterval(tick, SALES_REFRESH_SECONDS * 1000);
    refreshTimer.unref?.();
    console.log(`[Dashboard] Background sales refresh every ${SALES_REFRESH_SECONDS}s`);
}

// Start the server (bind all interfaces so other LAN devices can reach the Pi).
(function logDashboardAuthMode() {
    if (usersFileConfigured()) {
        console.log(`[Auth] ${readUsersFileSync().length} dashboard account(s) from ${path.basename(resolveUsersFilePath())}`);
    } else if (DASHBOARD_ACCESS_KEY) {
        console.log('[Auth] Legacy access-key mode (.Users not configured)');
    } else {
        console.log('[Auth] Open access (no login configured)');
    }
    if (authRequired() && NOLOGIN_LINKS_ENABLED) {
        console.log('[Auth] Per-store nologin links enabled (/{store}/nologin)');
    }
})();

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
