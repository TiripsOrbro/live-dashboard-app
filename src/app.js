const express = require('express');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
/* Production wins over base .env (dotenv does not override by default, so empty SCRAPER_* in .env would block .env.production). */
require('dotenv').config({ path: path.join(__dirname, '../.env.production'), override: true });
/* Force background scraping to stay headless for sales + upselling. */
process.env.SCRAPER_HEADLESS = 'true';

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
const { waitUntilMmxResourceIdle, isMmxResourceBusy } = require('./services/mmxResourceGate');
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
    reopenStockCount,
    clearStockCountDay,
    getCompletedVendorLabelsForStore,
    getStockCountQueueStatus,
    melbourneDateKey,
} = require('./services/stockCountState');
const { getStoreScrapePhase, anyStoreInActiveScrapeWindow } = require('./services/scrapeSchedule');
const { isUpsellingStore } = require('./services/upselling/upsellingConfig');
const { buildLeaderboardPayload } = require('./services/upselling/upsellingScores');
const { startUpsellingScheduler } = require('./services/upselling/upsellingScheduler');
const {
    getLastKnownPendingVendors,
    onStoreOrdersComplete,
    clearStoreScrapeCaches,
    resetScheduledOrdersForNewDay,
} = require('./services/macromatixScraper');
const { prepareStockCountForMmx, applyStockCountSession, cancelStockCountSession, runScheduledOrdersOnly } = require('./services/stockCountMmxPipeline');
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
    isAuthenticated,
    isAdminUser,
    userCanAccessStore,
    filterStoresForUser,
    getLoginRedirectPath,
    sessionCookieOptions,
    nologinCookieOptions,
    isNologinStoreAllowed,
    verifyNologinSecret,
    userProfileForClient,
    timingSafeEqualString,
    readUsersFileSync,
    resolveUsersFilePath,
} = require('./services/dashboardUsers');
const DASHBOARD_ACCESS_KEY = String(process.env.DASHBOARD_ACCESS_KEY || '');
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

function patchSalesCachePendingVendors(storeNumber, pendingVendors) {
    if (!salesCache?.stores) return;
    const key = String(storeNumber);
    salesCache.stores = salesCache.stores.map((store) =>
        String(store.storeNumber) === key ? { ...store, pendingVendors: [...pendingVendors] } : store
    );
}

onStoreOrdersComplete((storeNumber) => {
    patchSalesCachePendingVendors(storeNumber, []);
});
let salesInFlight = null;
let auditStateCache = null;
/** Last scrape phase per store — drives idle wipe and new-day order-check reset. */
const lastScrapePhaseByStore = new Map();

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
    if (/^\/nologin\/\d{3,6}\/?$/i.test(reqPath)) return true;
    if (reqPath === '/icon.svg' || reqPath === '/icon-mark.svg') return true;
    if (reqPath === '/styles/login.css' || reqPath === '/styles/brand-mark.css') return true;
    if (reqPath === '/scripts/login.js' || reqPath === '/scripts/brand-mark.js') return true;
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

/** Kiosk link — sets a long-lived single-store cookie and serves the dashboard in-place (no redirect). */
const DASHBOARD_HTML_PATH = path.join(__dirname, '../public', 'index.html');

function injectKioskToken(html, token) {
    const q = `kiosk=${encodeURIComponent(token)}`;
    const addParam = (url) => {
        if (!url.startsWith('/') || url.includes('kiosk=')) return url;
        return url.includes('?') ? `${url}&${q}` : `${url}?${q}`;
    };
    let out = html.replace(/(\s(?:href|src))="(\/[^"]+)"/g, (_, attr, url) => `${attr}="${addParam(url)}"`);
    const boot = `<script>window.__DASHBOARD_KIOSK__=${JSON.stringify(token)};</script>`;
    out = out.replace('</head>', `${boot}\n</head>`);
    return out;
}

async function sendKioskDashboard(res, token) {
    const html = await fs.readFile(DASHBOARD_HTML_PATH, 'utf8');
    res.type('html').send(injectKioskToken(html, token));
}

app.get(/^\/nologin\/(\d{3,6})\/?$/i, async (req, res) => {
    const storeNumber = normalizeStoreKey((req.path.match(/^\/nologin\/(\d{3,6})\/?$/i) || [])[1]);
    if (!storeNumber || !isNologinStoreAllowed(storeNumber) || !verifyNologinSecret(req.query.key)) {
        res.status(404).send('Not found');
        return;
    }

    const storeEntry = getStoreList().find((s) => String(s.storeNumber) === String(storeNumber));
    if (!storeEntry) {
        res.status(404).send('Not found');
        return;
    }

    const token = createNologinToken(storeNumber, storeEntry.storeName || '');

    res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
    res.clearCookie(LEGACY_COOKIE, sessionCookieOptions());
    res.cookie(NOLOGIN_COOKIE, token, nologinCookieOptions());
    console.log(`[Auth] Nologin: store ${storeNumber} from ${getRequestIp(req)}`);
    try {
        await sendKioskDashboard(res, token);
    } catch (err) {
        console.error('[Auth] Nologin dashboard send failed:', err.message);
        res.status(500).send('Dashboard unavailable');
    }
});

/** Login page assets — must be reachable before authentication (for sign-in screen animation). */
const PUBLIC_ROOT = path.join(__dirname, '../public');
for (const loginAsset of ['/scripts/brand-mark.js', '/styles/brand-mark.css']) {
    app.get(loginAsset, (_req, res) => {
        res.sendFile(path.join(PUBLIC_ROOT, loginAsset.slice(1)));
    });
}

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
    const freshByNum = new Map();
    if (freshPayload && Array.isArray(freshPayload.stores)) {
        for (const s of freshPayload.stores) freshByNum.set(String(s.storeNumber), s);
    }
    const prevByNum = new Map();
    if (prevPayload && Array.isArray(prevPayload.stores)) {
        for (const s of prevPayload.stores) prevByNum.set(String(s.storeNumber), s);
    }
    const allKeys = new Set([...prevByNum.keys(), ...freshByNum.keys()]);
    return [...allKeys].map((key) => {
        const fresh = freshByNum.get(key);
        if (!fresh) return prevByNum.get(key);
        if (storeHasData(fresh) && !fresh.error) return fresh;
        const prev = prevByNum.get(key);
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
        return fresh;
    }).filter(Boolean);
}

function buildCacheShellFromStoreList() {
    const stores = getStoreList().map((store) => {
        const payload = emptyStorePayload(store.storeNumber, store.storeName);
        payload.scrapePhase = getStoreScrapePhase(store);
        return payload;
    });
    return { success: true, timestamp: new Date().toISOString(), stores };
}

function applyScrapeScheduleToCache(cache, now = new Date()) {
    if (!cache) return cache;
    if (!Array.isArray(cache.stores)) cache.stores = [];

    const listed = getStoreList();
    const byNum = new Map(cache.stores.map((s) => [String(s.storeNumber), s]));

    for (const store of listed) {
        const key = String(store.storeNumber);
        if (!byNum.has(key)) {
            const entry = emptyStorePayload(store.storeNumber, store.storeName);
            cache.stores.push(entry);
            byNum.set(key, entry);
        }
    }

    for (const store of cache.stores) {
        const key = String(store.storeNumber);
        const listedStore = listed.find((s) => s.storeNumber === key) || store;
        const phase = getStoreScrapePhase(listedStore, now);
        const prev = lastScrapePhaseByStore.get(key);

        const hours = storeHours(key);
        store.openHour = hours.openHour;
        store.closeHour = hours.closeHour;

        if (phase === 'idle') {
            if (prev && prev !== 'idle') {
                clearStoreScrapeCaches(key);
            }
            store.actual = [];
            store.forecast = [];
            store.pendingVendors = [];
            delete store.error;
            delete store.retained;
            store.scrapePhase = 'idle';
        } else if (phase === 'retain') {
            store.scrapePhase = 'retain';
        } else {
            if (prev === 'idle') {
                resetScheduledOrdersForNewDay(key);
            }
            store.scrapePhase = 'active';
        }

        lastScrapePhaseByStore.set(key, phase);
    }

    return cache;
}

/** Run a scrape and merge it into the cache (per-store retention). De-duped via salesInFlight. */
function runScrapeIntoCache(options) {
    if (salesInFlight) return salesInFlight;
    salesInFlight = (async () => {
        try {
            applyScrapeScheduleToCache(salesCache);

            if (!anyStoreInActiveScrapeWindow()) {
                if (!salesCache) {
                    salesCache = buildCacheShellFromStoreList();
                    salesCacheAt = Date.now();
                }
                applyScrapeScheduleToCache(salesCache);
                return salesCache;
            }

            if (isMmxResourceBusy()) {
                console.log('[Dashboard] Sales scrape waiting — MMX stock count / orders in progress');
                await waitUntilMmxResourceIdle();
            }

            const result = await scrapeWithRetry(options);
            const fresh = {
                success: true,
                timestamp: result.timestamp,
                stores: Array.isArray(result.stores) ? result.stores : [],
            };
            salesCache = {
                success: true,
                timestamp: fresh.timestamp,
                stores: mergeStoresPreservingGood(salesCache, fresh),
            };
            salesCacheAt = Date.now();
            applyScrapeScheduleToCache(salesCache);
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
    applyScrapeScheduleToCache(salesCache);

    if (salesCache) {
        if (anyStoreInActiveScrapeWindow() && !isSalesCacheFresh() && !salesInFlight) {
            runScrapeIntoCache();
        }
        return salesCache;
    }

    if (!anyStoreInActiveScrapeWindow()) {
        salesCache = buildCacheShellFromStoreList();
        salesCacheAt = Date.now();
        applyScrapeScheduleToCache(salesCache);
        return salesCache;
    }

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

function normalizeAreaKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

function areaCodeFromValue(value) {
    const s = String(value || '').trim();
    const m = s.match(/(?:^|\b)area\D*(\d+)\b/i) || s.match(/^a(\d+)$/i) || s.match(/^(\d+)$/);
    if (!m) return '';
    return `A${String(Number(m[1]))}`;
}

function areaMatchTokens(value) {
    const set = new Set();
    const key = normalizeAreaKey(value);
    if (key) set.add(key);
    const lower = String(value || '').trim().toLowerCase();
    if (lower) set.add(lower);
    const code = areaCodeFromValue(value);
    if (code) {
        set.add(code.toLowerCase());
        set.add(normalizeAreaKey(code));
    }
    return set;
}

function areaNameFromStore(store) {
    const area = String(store?.area || '').trim();
    return area || 'Area 22';
}

function buildAreaGroups(stores) {
    const groups = new Map();
    for (const store of stores || []) {
        const area = areaNameFromStore(store);
        if (!groups.has(area)) groups.set(area, []);
        groups.get(area).push(store);
    }
    return [...groups.entries()]
        .map(([name, areaStores]) => ({
            name,
            key: normalizeAreaKey(name),
            stores: areaStores.sort((a, b) =>
                String(a.storeNumber).localeCompare(String(b.storeNumber), undefined, { numeric: true })
            ),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

const RAW_BASE_HOUR = 5;

function getTzYmd(now, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timeZone || 'Australia/Melbourne',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(now);
    const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
    return { year: get('year'), month: get('month'), day: get('day') };
}

function getOffsetMinutesAt(timeZone, instant) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timeZone || 'Australia/Melbourne',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'shortOffset',
        hour12: false,
    }).formatToParts(instant);
    const token = String(parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT+0');
    const m = token.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/i);
    if (!m) return 0;
    const sign = m[1] === '-' ? -1 : 1;
    const hh = Number(m[2] || 0);
    const mm = Number(m[3] || 0);
    return sign * (hh * 60 + mm);
}

function utcMsForStoreLocalHour(now, timeZone, localHour) {
    const { year, month, day } = getTzYmd(now, timeZone);
    const dayShift = Math.floor(localHour / 24);
    const hour = ((localHour % 24) + 24) % 24;
    const utcBase = Date.UTC(year, month - 1, day + dayShift, hour, 0, 0);
    const offsetMin = getOffsetMinutesAt(timeZone, new Date(utcBase));
    return utcBase - offsetMin * 60 * 1000;
}

function stateCodeFromTimeZone(timeZone) {
    const tz = String(timeZone || '').trim();
    const map = {
        'Australia/Melbourne': 'VIC',
        'Australia/Sydney': 'NSW',
        'Australia/Brisbane': 'QLD',
        'Australia/Perth': 'WA',
        'Australia/Adelaide': 'SA',
        'Australia/Darwin': 'NT',
        'Australia/Hobart': 'TAS',
        'Australia/Canberra': 'ACT',
    };
    return map[tz] || tz.replace(/^Australia\//, '').toUpperCase() || 'LOCAL';
}

function combineAreaHourlyByLocalRange(stores, startHour, endHourExclusive) {
    const rows = [];
    const start = Math.trunc(startHour);
    const end = Math.trunc(endHourExclusive);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return rows;

    for (let localHour = start; localHour < end; localHour += 1) {
        let forecast = 0;
        let actual = 0;
        for (const store of stores || []) {
            const openHour = Number.isFinite(store.openHour) ? Math.trunc(store.openHour) : DEFAULT_OPEN_HOUR;
            const closeHour = Number.isFinite(store.closeHour) ? Math.trunc(store.closeHour) : DEFAULT_CLOSE_HOUR;
            if (localHour < openHour || localHour >= closeHour) continue;
            const idx = localHour - RAW_BASE_HOUR;
            const f = Number(Array.isArray(store.forecast) ? store.forecast[idx] : 0) || 0;
            const a = Number(Array.isArray(store.actual) ? store.actual[idx] : 0) || 0;
            forecast += f;
            actual += a;
        }
        rows.push({ localHour, forecast, actual });
    }
    return rows;
}

function combineAreaHourly(stores) {
    const now = new Date();
    const byUtcHour = new Map();
    for (const store of stores || []) {
        const tz = store.timeZone || process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';
        const actual = Array.isArray(store.actual) ? store.actual : [];
        const forecast = Array.isArray(store.forecast) ? store.forecast : [];
        const hours = Math.max(actual.length, forecast.length);
        for (let i = 0; i < hours; i++) {
            const localHour = RAW_BASE_HOUR + i;
            const utcMs = utcMsForStoreLocalHour(now, tz, localHour);
            const bucketMs = Math.floor(utcMs / 3600000) * 3600000;
            const key = String(bucketMs);
            const entry = byUtcHour.get(key) || {
                utcHourMs: bucketMs,
                forecast: 0,
                actual: 0,
                stores: [],
            };
            const f = Number(forecast[i]) || 0;
            const a = Number(actual[i]) || 0;
            entry.forecast += f;
            entry.actual += a;
            entry.stores.push({
                storeNumber: store.storeNumber,
                storeName: store.storeName,
                area: areaNameFromStore(store),
                timeZone: tz,
                localHour,
                forecast: f,
                actual: a,
            });
            byUtcHour.set(key, entry);
        }
    }
    return [...byUtcHour.values()].sort((a, b) => a.utcHourMs - b.utcHourMs);
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
    return slice;
}

function stockCountStoreFromQuery(req) {
    return normalizeStoreKey(req.query.store);
}

function stockCountVendorFromQuery(req) {
    return String(req.query.vendor || '').trim().toLowerCase();
}

function pendingVendorLabelsForStockCount(req, storeNumber) {
    const dateKey = melbourneDateKey();
    let labels = getLastKnownPendingVendors(storeNumber, dateKey);
    if (wantsTestStockCountPending(req)) {
        const configured = listConfiguredVendors().map((v) => v.label);
        labels = [...new Set([...(Array.isArray(labels) ? labels : []), ...configured])].sort((a, b) =>
            a.localeCompare(b)
        );
    }
    return labels;
}

app.get('/welcome', (req, res) => {
    res.redirect('/login');
});

// Root path is the store picker — a grid of clickable store tiles (see public/stores.html).
app.get('/', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    const dest = user ? getLoginRedirectPath(user) : '/';
    if (user && dest !== '/' && dest !== '/login') {
        res.redirect(dest);
        return;
    }
    res.sendFile(path.join(__dirname, '../public', 'stores.html'));
});

// Per-store dashboard pages, e.g. /3811 or /teststore. The SPA reads the store from the path.
// Static assets and /api/* are matched earlier, so this only catches a bare store segment.
app.get(/^\/teststore\/?$/i, (req, res) => {
    if (!assertStoreAccess(req, res, TEST_STORE_SLUG)) return;
    res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

app.get(/^\/(\d{3,6})\/?$/, (req, res) => {
    const storeNumber = (req.path.match(/^\/(\d{3,6})\/?$/) || [])[1];
    if (!assertStoreAccess(req, res, storeNumber)) return;
    res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

app.get(/^\/(area\/[a-z0-9-]+|a\d+)\/?$/i, (req, res) => {
    res.sendFile(path.join(__dirname, '../public', 'area.html'));
});

function sendStockCountPage(req, res, storeNumber) {
    if (!assertStoreAccess(req, res, storeNumber)) return;
    res.sendFile(path.join(__dirname, '../public', 'stock-count.html'));
}

app.get(/^\/(teststore|\d{3,6})\/stock-count\/([a-z0-9-]+)\/?$/i, (req, res) => {
    const storeNumber = normalizeStoreKey((req.path.match(/^\/(teststore|\d{3,6})\/stock-count\/[a-z0-9-]+\/?$/i) || [])[1]);
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
        const status = /already sent|Unknown location/i.test(error.message) ? 400 : 500;
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

app.post('/api/stock-count/reset', async (req, res) => {
    try {
        const store = stockCountStoreFromQuery(req);
        if (!store || !assertStoreAccess(req, res, store)) return;
        const vendorSlug = String(req.query.vendor || req.body?.vendor || '').trim() || null;
        const dateKey = parseScheduledOrdersTestYmd(req.query.date || req.body?.date)?.ymd;
        const result = await clearStockCountDay(store, { vendorSlug, dateKey });
        const labels = result.cleared.map((slug) => getVendorCatalog(slug)?.label || slug);
        console.log(
            `[StockCount] Reset store ${result.storeNumber} date ${result.dateKey}` +
                (labels.length ? `: ${labels.join(', ')}` : ' (nothing to clear)')
        );
        res.json({ success: true, ...result, vendorLabels: labels });
    } catch (error) {
        console.error('API: Error resetting stock count:', error);
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

app.get('/api/stock-count/queue-status', async (req, res) => {
    try {
        const store = stockCountStoreFromQuery(req);
        const vendorSlug = stockCountVendorFromQuery(req);
        if (!store) {
            res.status(400).json({ success: false, error: 'Store is required.' });
            return;
        }
        if (!vendorSlug) {
            res.status(400).json({ success: false, error: 'Vendor is required.' });
            return;
        }
        if (!assertStoreAccess(req, res, store)) return;
        const status = await getStockCountQueueStatus(store, {
            vendorSlug,
            pendingVendorLabels: pendingVendorLabelsForStockCount(req, store),
        });
        res.json({ success: true, ...status });
    } catch (error) {
        console.error('API: Error reading stock count queue status:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/stock-count/reopen', async (req, res) => {
    try {
        const store = stockCountStoreFromQuery(req);
        const vendorSlug = stockCountVendorFromQuery(req);
        if (!store || !vendorSlug || !assertStoreAccess(req, res, store)) return;
        const draft = await reopenStockCount(store, vendorSlug);
        if (!draft) {
            res.status(404).json({ success: false, error: 'Vendor catalog not found.' });
            return;
        }
        res.json(draft);
    } catch (error) {
        console.error('API: Error reopening stock count:', error);
        const status = /already sent|No stock count draft/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
});

app.post('/api/stock-count/send-to-mmx', async (req, res) => {
    try {
        const store = stockCountStoreFromQuery(req);
        const vendorSlug = stockCountVendorFromQuery(req);
        if (!store || !assertStoreAccess(req, res, store)) return;

        console.log(`[StockCount] Send to MMX (prepare) — store ${store} vendor ${vendorSlug}`);
        const result = await prepareStockCountForMmx(store, vendorSlug, {
            pendingVendorLabels: pendingVendorLabelsForStockCount(req, store),
        });
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('API: Error preparing stock count for MMX:', error);
        const status = /No stock count draft|Submit at least one|not found|ready to send|Continue button/i.test(
            error.message
        )
            ? 400
            : 500;
        res.status(status).json({ success: false, error: error.message });
    }
});

app.post('/api/stock-count/send-to-mmx/apply', async (req, res) => {
    try {
        const store = stockCountStoreFromQuery(req);
        const sessionId = String(req.body?.sessionId || req.query.sessionId || '').trim();
        const ordersOnly = /^(1|true|yes|on)$/i.test(String(req.body?.ordersOnly ?? req.query.ordersOnly ?? ''));
        if (!store || !assertStoreAccess(req, res, store)) return;

        if (ordersOnly) {
            console.log(`[StockCount] Scheduled orders only — store ${store}`);
            const skipReportDownload = !/^(0|false|no|off)$/i.test(
                String(req.body?.skipReportDownload ?? req.query.skipReportDownload ?? 'true')
            );
            const result = await runScheduledOrdersOnly(store, { skipReportDownload });
            res.json({ success: true, ...result });
            return;
        }

        if (!sessionId) {
            res.status(400).json({ success: false, error: 'sessionId is required.' });
            return;
        }

        console.log(`[StockCount] Apply MMX count — store ${store} session ${sessionId}`);
        const result = await applyStockCountSession(store, sessionId);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('API: Error applying stock count in MMX:', error);
        const status = /session expired|not found|Apply button|Missing reports/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
});

app.post('/api/stock-count/fill-orders', async (req, res) => {
    try {
        const store = stockCountStoreFromQuery(req);
        if (!store || !assertStoreAccess(req, res, store)) return;

        const skipReportDownload = !/^(0|false|no|off)$/i.test(
            String(req.body?.skipReportDownload ?? req.query.skipReportDownload ?? 'true')
        );
        console.log(`[StockCount] Fill scheduled orders — store ${store}`);
        const result = await runScheduledOrdersOnly(store, { skipReportDownload });
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('API: Error filling scheduled orders:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/stock-count/send-to-mmx/recount', async (req, res) => {
    try {
        const store = stockCountStoreFromQuery(req);
        const sessionId = String(req.body?.sessionId || req.query.sessionId || '').trim();
        if (!store || !assertStoreAccess(req, res, store)) return;

        await cancelStockCountSession(store, sessionId || null);
        res.json({ success: true, storeNumber: store });
    } catch (error) {
        console.error('API: Error cancelling MMX count session:', error);
        res.status(500).json({ success: false, error: error.message });
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
        const status = /No stock count draft|already sent|Enter at least one count/i.test(error.message) ? 400 : 500;
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

// Upselling leaderboard — landscape podium reads this (enabled stores in config/upselling.json).
app.get('/api/upselling', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        if (!store || !isUpsellingStore(store)) {
            return res.json({ enabled: false });
        }
        res.json(buildLeaderboardPayload(store));
    } catch (error) {
        console.error('API: Error loading upselling:', error);
        res.status(500).json({ enabled: false, error: error.message });
    }
});

// List of stores (number, name, trading hours) for the store picker and per-store grid.
// Served straight from `.storelist` so it returns instantly without waiting on a scrape.
app.get('/api/stores', async (req, res) => {
    try {
        let stores = getStoreList().map((s) => ({
            storeNumber: s.storeNumber,
            storeName: s.storeName,
            area: areaNameFromStore(s),
            areaKey: normalizeAreaKey(areaNameFromStore(s)),
            timeZone: s.timeZone || process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne',
            openHour: s.openHour,
            closeHour: s.closeHour,
        }));

        // Fallback: no .storelist configured — use whatever the last scrape discovered.
        if (!stores.length && salesCache) {
            stores = (Array.isArray(salesCache.stores) ? salesCache.stores : []).map((s) => ({
                storeNumber: s.storeNumber,
                storeName: s.storeName,
                area: areaNameFromStore(s),
                areaKey: normalizeAreaKey(areaNameFromStore(s)),
                timeZone: s.timeZone || process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne',
                openHour: Number.isFinite(s.openHour) ? s.openHour : DEFAULT_OPEN_HOUR,
                closeHour: Number.isFinite(s.closeHour) ? s.closeHour : DEFAULT_CLOSE_HOUR,
            }));
        }

        const user = req.dashboardUser || getRequestUser(req);
        stores = filterStoresForUser(user, stores);
        if (isAdminUser(user)) {
            const test = { ...testStoreListEntry(), area: 'Test Store', areaKey: 'test-store', timeZone: 'Australia/Melbourne' };
            stores = [test, ...stores];
        }

        const areas = buildAreaGroups(stores);
        res.json({
            success: true,
            stores,
            areas,
            defaultStore: DASHBOARD_DEFAULT_STORE || (stores[0]?.storeNumber ?? ''),
        });
    } catch (error) {
        console.error('API: Error listing stores:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/area-dashboard', async (req, res) => {
    try {
        const areaParam = String(req.query.area || '').trim();
        if (!areaParam) {
            return res.status(400).json({ success: false, error: 'Missing area query parameter.' });
        }
        const storesCfg = getStoreList().map((s) => ({
            ...s,
            area: areaNameFromStore(s),
            areaKey: normalizeAreaKey(areaNameFromStore(s)),
            timeZone: s.timeZone || process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne',
        }));
        const areaStoresCfg = storesCfg.filter(
            (s) => {
                const wanted = areaMatchTokens(areaParam);
                const storeTokens = areaMatchTokens(s.areaKey);
                areaMatchTokens(s.area).forEach((t) => storeTokens.add(t));
                for (const token of wanted) {
                    if (storeTokens.has(token)) return true;
                }
                return false;
            }
        );
        if (!areaStoresCfg.length) {
            return res.status(404).json({ success: false, error: `Unknown area: ${areaParam}` });
        }
        const user = req.dashboardUser || getRequestUser(req);
        const allowedStores = filterStoresForUser(
            user,
            areaStoresCfg.map((s) => ({ storeNumber: s.storeNumber, storeName: s.storeName }))
        ).map((s) => String(s.storeNumber));
        const filteredCfg = areaStoresCfg.filter((s) => allowedStores.includes(String(s.storeNumber)));
        if (!filteredCfg.length) return sendForbidden(req, res);

        let payload;
        try {
            payload = await getSalesDataCached();
        } catch (error) {
            console.warn('[Area Dashboard] Falling back to cached/empty sales payload:', error.message);
            payload = salesCache || buildCacheShellFromStoreList();
        }
        const liveByNum = new Map((payload.stores || []).map((s) => [String(s.storeNumber), s]));
        const stores = filteredCfg.map((cfg) => {
            const live = liveByNum.get(String(cfg.storeNumber)) || {};
            return {
                storeNumber: cfg.storeNumber,
                storeName: cfg.storeName,
                area: cfg.area,
                timeZone: cfg.timeZone,
                openHour: cfg.openHour,
                closeHour: cfg.closeHour,
                actual: Array.isArray(live.actual) ? live.actual : [],
                forecast: Array.isArray(live.forecast) ? live.forecast : [],
                pendingVendors: Array.isArray(live.pendingVendors) ? live.pendingVendors : [],
            };
        });
        const groupedByTimeZone = new Map();
        for (const store of stores) {
            const tz = store.timeZone || process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';
            const group = groupedByTimeZone.get(tz) || [];
            group.push(store);
            groupedByTimeZone.set(tz, group);
        }
        const dashboards = [...groupedByTimeZone.entries()]
            .map(([timeZone, tzStores]) => {
                const earliestOpen = tzStores.reduce(
                    (min, s) => Math.min(min, Number.isFinite(s.openHour) ? s.openHour : DEFAULT_OPEN_HOUR),
                    Number.POSITIVE_INFINITY
                );
                const latestClose = tzStores.reduce(
                    (max, s) => Math.max(max, Number.isFinite(s.closeHour) ? s.closeHour : DEFAULT_CLOSE_HOUR),
                    Number.NEGATIVE_INFINITY
                );
                const openHour = Number.isFinite(earliestOpen) ? Math.trunc(earliestOpen) : DEFAULT_OPEN_HOUR;
                const closeHour = Number.isFinite(latestClose) ? Math.trunc(latestClose) : DEFAULT_CLOSE_HOUR;
                return {
                    timeZone,
                    state: stateCodeFromTimeZone(timeZone),
                    openHour,
                    closeHour,
                    stores: tzStores.map((s) => ({
                        storeNumber: s.storeNumber,
                        storeName: s.storeName,
                    })),
                    combinedHourly: combineAreaHourlyByLocalRange(tzStores, openHour, closeHour),
                };
            })
            .sort((a, b) => a.state.localeCompare(b.state));
        const combinedHourly = combineAreaHourly(stores);
        const auditsSchedule = getAuditSchedule();
        const requiredAudits = Array.isArray(auditsSchedule?.auditListItems) ? auditsSchedule.auditListItems : [];
        const storesWithOrdersOutstanding = stores
            .filter((s) => s.pendingVendors.length)
            .map((s) => ({
                storeNumber: s.storeNumber,
                storeName: s.storeName,
                timeZone: s.timeZone,
                pendingCount: s.pendingVendors.length,
                pendingVendors: s.pendingVendors,
            }));
        const storesWithAuditsOutstanding = [];
        for (const s of stores) {
            const state = await getAuditState(s.storeNumber);
            const dismissed = new Set((state.dismissed || []).map((x) => String(x).trim()));
            const outstanding = requiredAudits.filter((label) => !dismissed.has(String(label).trim()));
            if (outstanding.length) {
                storesWithAuditsOutstanding.push({
                    storeNumber: s.storeNumber,
                    storeName: s.storeName,
                    timeZone: s.timeZone,
                    outstandingCount: outstanding.length,
                    outstandingAudits: outstanding,
                });
            }
        }

        res.json({
            success: true,
            area: areaStoresCfg[0].area,
            areaKey: areaStoresCfg[0].areaKey,
            timestamp: payload.timestamp,
            stores: stores.map((s) => ({
                storeNumber: s.storeNumber,
                storeName: s.storeName,
                timeZone: s.timeZone,
                openHour: s.openHour,
                closeHour: s.closeHour,
            })),
            dashboards,
            combinedHourly,
            storesWithOrdersOutstanding,
            storesWithAuditsOutstanding,
        });
    } catch (error) {
        console.error('API: Error loading area dashboard:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Background refresh: keep the multi-store cache warm so browser requests never wait through a full scrape.
let refreshTimer = null;
let upsellingSchedulerTimer = null;
function startBackgroundRefresh() {
    if (SALES_REFRESH_SECONDS <= 0) {
        console.log('[Dashboard] Background refresh disabled (SALES_REFRESH_SECONDS <= 0)');
        return;
    }
    const tick = async () => {
        try {
            applyScrapeScheduleToCache(salesCache);
            if (!anyStoreInActiveScrapeWindow()) return;
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
})();

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on http://0.0.0.0:${PORT}`);
    startBackgroundRefresh();
    upsellingSchedulerTimer = startUpsellingScheduler();
});

// Graceful shutdown so PM2 restarts / systemctl stop release the port cleanly.
let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Dashboard] ${signal} received — closing server…`);
    if (refreshTimer) clearInterval(refreshTimer);
    if (upsellingSchedulerTimer) clearInterval(upsellingSchedulerTimer);
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
