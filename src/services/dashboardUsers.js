const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isTestStore, normalizeStoreKey, TEST_STORE_SLUG } = require('./testStore');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const USERS_PATH = path.join(PROJECT_ROOT, '.Users');

const SESSION_COOKIE = 'dashboard_session';
const LEGACY_COOKIE = 'dashboard_access';
const NOLOGIN_COOKIE = 'dashboard_nologin';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Long-lived cookie for direct /{store}/nologin kiosk links. */
const NOLOGIN_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
/** Browser-session cookie when “Stay signed in” is unchecked (Express: omit maxAge). */

const FIELD_LABELS = {
    username: ['username', 'user'],
    password: ['password', 'pass'],
    access: ['access', 'stores', 'store'],
};

let usersCache = null;
let usersCacheMtime = 0;
let usersCachePath = '';

function timingSafeEqualString(a, b) {
    const aBuf = Buffer.from(String(a));
    const bBuf = Buffer.from(String(b));
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
}

function normalizeUsername(name) {
    return String(name || '').trim().toLowerCase();
}

function usernameMatches(stored, input) {
    return timingSafeEqualString(normalizeUsername(stored), normalizeUsername(input));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('base64url')) {
    const derived = crypto.scryptSync(String(password), salt, 64).toString('base64url');
    return `scrypt:${salt}:${derived}`;
}

function verifyPassword(stored, plain) {
    const value = String(stored || '');
    if (value.startsWith('scrypt:')) {
        const parts = value.split(':');
        if (parts.length !== 3) return false;
        const salt = parts[1];
        const expected = parts[2];
        const derived = crypto.scryptSync(String(plain), salt, 64).toString('base64url');
        return timingSafeEqualString(derived, expected);
    }
    return timingSafeEqualString(value, plain);
}

function stripTrailingPipe(value) {
    return String(value || '')
        .trim()
        .replace(/\|+\s*$/, '')
        .trim();
}

/** Pull the value from `label | value |` or `value |` style lines. */
function parseFieldLine(line, labels) {
    let raw = stripTrailingPipe(line);
    if (!raw) return '';

    const parts = raw.split('|').map((p) => p.trim()).filter((p) => p.length > 0);
    if (parts.length >= 2) {
        const head = parts[0].toLowerCase();
        if (labels.some((label) => head === label || head.startsWith(`${label} `))) {
            return stripTrailingPipe(parts.slice(1).join('|'));
        }
    }

    if (parts.length === 1) return parts[0];
    return stripTrailingPipe(parts[0]);
}

function parseAccessToken(raw) {
    const token = stripTrailingPipe(raw);
    if (!token || token === '*' || /^all$/i.test(token)) {
        return { role: 'admin', stores: '*' };
    }
    const stores = token
        .split(/[,;\s]+/)
        .map((s) => s.replace(/[^0-9]/g, ''))
        .filter(Boolean);
    if (!stores.length) return null;
    return { role: 'store', stores: [...new Set(stores)] };
}

function isCbUsername(name) {
    return /^CB[A-Za-z0-9]+$/i.test(String(name || '').trim());
}

function parseAccessBlock(block) {
    const lines = block.filter((line) => line.trim() && !line.trim().startsWith('#'));
    if (!lines.length) return null;

    let username = '';
    let password = '';
    let accessRaw = '';

    for (const line of lines) {
        const trimmed = line.trim();
        const lower = trimmed.toLowerCase();
        if (!username && FIELD_LABELS.username.some((k) => lower.startsWith(`${k} `) || lower.startsWith(`${k}|`))) {
            username = parseFieldLine(trimmed, FIELD_LABELS.username);
            continue;
        }
        if (!password && FIELD_LABELS.password.some((k) => lower.startsWith(`${k} `) || lower.startsWith(`${k}|`))) {
            password = parseFieldLine(trimmed, FIELD_LABELS.password);
            continue;
        }
        if (
            !accessRaw &&
            FIELD_LABELS.access.some((k) => lower.startsWith(`${k} `) || lower.startsWith(`${k}|`))
        ) {
            accessRaw = parseFieldLine(trimmed, FIELD_LABELS.access);
            continue;
        }
    }

    // Positional fallback: username, [cbUsername], password, access.
    const positional = lines.map((line) => parseFieldLine(line, []));
    if (!username && positional[0]) username = positional[0];
    let cbUsername = '';
    if (positional.length >= 4 && isCbUsername(positional[1])) {
        cbUsername = positional[1];
        if (!password && positional[2]) password = positional[2];
        if (!accessRaw && positional[3]) accessRaw = positional[3];
    } else {
        if (!password && positional[1]) password = positional[1];
        if (!accessRaw && positional[2]) accessRaw = positional[2];
    }

    if (!username || !password || !accessRaw) return null;

    const access = parseAccessToken(accessRaw);
    if (!access) return null;

    return {
        username,
        cbUsername,
        password,
        role: access.role,
        stores: access.stores,
    };
}

/**
 * Parse `.Users` blocks:
 *   # Display name (optional label)
 *   username |
 *   [CBusername |]   optional colour-blind login (same password + welcome name)
 *   password |
 *   access |
 */
function parseUsersFile(text) {
    const users = [];
    const lines = String(text || '').split(/\r?\n/);

    let block = [];
    let blockName = '';

    function flushBlock() {
        const row = parseAccessBlock(block);
        if (row) {
            const base = {
                displayName: blockName,
                password: row.password,
                role: row.role,
                stores: row.stores,
            };
            if (row.username && !isCbUsername(row.username)) {
                users.push({ ...base, username: row.username, colorBlind: false });
            }
            if (row.cbUsername) {
                users.push({ ...base, username: row.cbUsername, colorBlind: true });
            }
            if (row.username && isCbUsername(row.username)) {
                users.push({ ...base, username: row.username, colorBlind: true });
            }
        }
        block = [];
        blockName = '';
    }

    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) {
            flushBlock();
            continue;
        }
        if (trimmed.startsWith('#')) {
            flushBlock();
            blockName = trimmed.replace(/^#\s*/, '').trim();
            continue;
        }
        block.push(rawLine);
    }
    flushBlock();

    return users;
}

function resolveUsersFilePath() {
    return USERS_PATH;
}

function readUsersFileSync() {
    try {
        const filePath = resolveUsersFilePath();
        if (!fs.existsSync(filePath)) return [];
        const stat = fs.statSync(filePath);
        if (usersCache && filePath === usersCachePath && stat.mtimeMs === usersCacheMtime) {
            return usersCache;
        }
        const parsed = parseUsersFile(fs.readFileSync(filePath, 'utf8'));
        usersCache = parsed;
        usersCacheMtime = stat.mtimeMs;
        usersCachePath = filePath;
        return parsed;
    } catch {
        return [];
    }
}

function usersFileConfigured() {
    try {
        return fs.existsSync(USERS_PATH) && readUsersFileSync().length > 0;
    } catch {
        return false;
    }
}

function authenticate(username, password) {
    const name = String(username || '').trim();
    const pass = String(password || '');
    if (!name || !pass) return null;
    for (const row of readUsersFileSync()) {
        if (!usernameMatches(row.username, name)) continue;
        if (!verifyPassword(row.password, pass)) return null;
        return normalizeUser(row);
    }
    return null;
}

function normalizeUser(row) {
    const stores = row.stores === '*' ? '*' : [...new Set(row.stores.map(String))];
    return {
        username: row.username,
        displayName: row.displayName || '',
        role: row.role === 'admin' ? 'admin' : 'store',
        stores,
        colorBlind: Boolean(row.colorBlind),
    };
}

function lookupDisplayName(username) {
    const name = String(username || '').trim();
    if (!name || name.startsWith('__')) return '';
    for (const row of readUsersFileSync()) {
        if (!usernameMatches(row.username, name)) continue;
        return String(row.displayName || '').trim();
    }
    return '';
}

function authSecret() {
    return String(process.env.DASHBOARD_AUTH_SECRET || process.env.DASHBOARD_ACCESS_KEY || 'dashboard-dev-secret');
}

function signSessionPayload(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', authSecret()).update(body).digest('base64url');
    return `${body}.${sig}`;
}

function parseSessionToken(token) {
    const raw = String(token || '');
    const dot = raw.lastIndexOf('.');
    if (dot <= 0) return null;
    const body = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    const expected = crypto.createHmac('sha256', authSecret()).update(body).digest('base64url');
    if (!timingSafeEqualString(sig, expected)) return null;
    let payload;
    try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (!payload?.u || !payload?.exp || Date.now() > Number(payload.exp)) return null;
    const role = payload.r === 'admin' ? 'admin' : 'store';
    const stores = payload.s === '*' ? '*' : String(payload.s || '').split(',').filter(Boolean);
    if (role !== 'admin' && stores !== '*' && !stores.length) return null;
    return {
        username: payload.u,
        role,
        stores,
        displayName: String(payload.d || '').trim(),
        colorBlind: payload.c === 1,
    };
}

function createSessionToken(user) {
    const stores = user.stores === '*' ? '*' : user.stores.join(',');
    return signSessionPayload({
        u: user.username,
        d: user.displayName || lookupDisplayName(user.username) || '',
        r: user.role,
        s: stores,
        c: user.colorBlind ? 1 : 0,
        exp: Date.now() + SESSION_MAX_AGE_MS,
    });
}

function legacyAccessToken(accessKey) {
    return crypto.createHmac('sha256', authSecret()).update(`dashboard:${accessKey}`).digest('hex');
}

function createNologinToken(storeNumber) {
    const store = normalizeStoreKey(storeNumber);
    if (!store) return '';
    return signSessionPayload({
        nl: 1,
        s: store,
        exp: Date.now() + NOLOGIN_MAX_AGE_MS,
    });
}

function parseNologinToken(token) {
    const raw = String(token || '');
    const dot = raw.lastIndexOf('.');
    if (dot <= 0) return null;
    const body = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    const expected = crypto.createHmac('sha256', authSecret()).update(body).digest('base64url');
    if (!timingSafeEqualString(sig, expected)) return null;
    let payload;
    try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (!payload?.nl || !payload?.exp || Date.now() > Number(payload.exp)) return null;
    const store = normalizeStoreKey(payload.s);
    if (!store) return null;
    return store;
}

function resolveNologinUser(req) {
    const cookies = parseCookies(req.headers.cookie);
    const store = parseNologinToken(cookies[NOLOGIN_COOKIE]);
    if (!store) return null;
    return { username: '__nologin__', role: 'nologin', stores: [store] };
}

function isNologinUser(user) {
    return Boolean(user && user.role === 'nologin');
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

function resolveUser(req, legacyAccessKey = '') {
    const cookies = parseCookies(req.headers.cookie);

    const session = parseSessionToken(cookies[SESSION_COOKIE]);
    if (session) return session;

    if (legacyAccessKey && timingSafeEqualString(cookies[LEGACY_COOKIE] || '', legacyAccessToken(legacyAccessKey))) {
        return { username: '__legacy__', role: 'admin', stores: '*' };
    }

    if (!usersFileConfigured() && !legacyAccessKey) {
        return { username: '__open__', role: 'admin', stores: '*' };
    }

    return null;
}

function isAuthenticated(req, legacyAccessKey = '') {
    return Boolean(resolveUser(req, legacyAccessKey));
}

function isAdminUser(user) {
    return Boolean(user && (user.role === 'admin' || user.stores === '*'));
}

function userCanAccessStore(user, storeNumber) {
    if (!user) return false;
    if (isTestStore(storeNumber)) {
        if (isAdminUser(user)) return true;
        if (isNologinUser(user)) return user.stores.includes(TEST_STORE_SLUG);
        return false;
    }
    if (isAdminUser(user)) return true;
    const num = normalizeStoreKey(storeNumber);
    if (!num) return false;
    return user.stores.includes(num);
}

function filterStoresForUser(user, stores) {
    if (!user || isAdminUser(user)) return stores;
    const allowed = new Set(user.stores.map(String));
    return stores.filter((s) => allowed.has(String(s.storeNumber)));
}

function getLoginRedirectPath(user) {
    if (!user) return '/login';
    if (isAdminUser(user)) return '/';
    if (user.stores.length === 1) return `/${user.stores[0]}`;
    return '/';
}

function sessionCookieOptions(options = {}) {
    const remember = options.remember !== false;
    const secureCookie = /^(1|true|yes|on)$/i.test(String(process.env.DASHBOARD_SECURE_COOKIE ?? '').trim());
    const base = {
        httpOnly: true,
        sameSite: 'strict',
        secure: secureCookie,
    };
    if (remember) {
        return { ...base, maxAge: SESSION_MAX_AGE_MS };
    }
    return base;
}

function userProfileForClient(user) {
    if (isNologinUser(user)) {
        const store = user.stores[0] || '';
        return {
            username: '',
            displayName: '',
            welcomeName: '',
            role: 'nologin',
            stores: [...user.stores],
            skipStorePicker: true,
            defaultPath: store ? `/${store}/nologin` : '/login',
            colorBlind: false,
            nologin: true,
        };
    }
    if (!user || user.username.startsWith('__')) {
        return {
            username: '',
            displayName: '',
            welcomeName: '',
            role: 'admin',
            stores: '*',
            skipStorePicker: false,
            defaultPath: '/',
            colorBlind: false,
            nologin: false,
        };
    }
    const stores = user.stores === '*' ? '*' : [...user.stores];
    const skipStorePicker = !isAdminUser(user) && Array.isArray(stores) && stores.length === 1;
    const displayName = String(user.displayName || lookupDisplayName(user.username) || '').trim();
    const welcomeName = displayName || user.username;
    return {
        username: user.username,
        displayName,
        welcomeName,
        role: user.role,
        stores,
        skipStorePicker,
        defaultPath: getLoginRedirectPath(user),
        colorBlind: Boolean(user.colorBlind),
        nologin: false,
    };
}

function nologinCookieOptions() {
    const secureCookie = /^(1|true|yes|on)$/i.test(String(process.env.DASHBOARD_SECURE_COOKIE ?? '').trim());
    return {
        httpOnly: true,
        sameSite: 'strict',
        secure: secureCookie,
        maxAge: NOLOGIN_MAX_AGE_MS,
    };
}

module.exports = {
    SESSION_COOKIE,
    LEGACY_COOKIE,
    NOLOGIN_COOKIE,
    SESSION_MAX_AGE_MS,
    USERS_PATH,
    hashPassword,
    verifyPassword,
    parseUsersFile,
    readUsersFileSync,
    resolveUsersFilePath,
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
};
