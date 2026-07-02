const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const paths = require('../../../src/paths');
const { readUserAccountSecrets, hasMmxCredentialsForUser } = require('./mmxUserCredentials');
const { isTestStore, normalizeStoreKey, TEST_STORE_SLUG } = require('../../../stores/src/testStore');
const { getStoreList } = require('../../../stores/src/storeList');
const {
    normalizeMarketLabel,
    normalizeAreaLabel,
    getAreasForMarket,
    getAllMarketLabels,
    getMarketForArea,
} = require('../../../stores/src/marketsConfig');
const { getAreaIds } = require('../../../stores/src/areasConfig');

const USERS_PATH = path.join(paths.root, '.Users');
const ACCOUNT_AUDIT_LOG = path.join(paths.users.data, 'account-audit.log');
const AUTH_EVENTS_LOG = path.join(paths.users.data, 'auth-events.log');
const PERSISTED_AUTH_SECRET_FILE = path.join(paths.users.data, '.dashboard-auth-secret');
const ACCOUNTS_FILE_NAME = 'accounts.users';

const ROLE_FOLDER_ORDER = ['admins', 'area-coaches', 'stores', 'managers', 'mics', 'tms'];

const LEVEL_TO_ROLE_FOLDER = {
    it: 'admins',
    market: 'admins',
    area: 'area-coaches',
    store: 'stores',
    manager: 'managers',
    mic: 'mics',
    tm: 'tms',
};

function roleFolderForBlock(block) {
    const level = normalizeAccountLevel(block?.accountLevel) || inferAccountLevel(block || {});
    return LEVEL_TO_ROLE_FOLDER[level] || 'stores';
}

function roleAccountsDir(roleFolder) {
    return path.join(paths.users.accounts, roleFolder);
}

function roleAccountsFilePath(roleFolder) {
    return path.join(roleAccountsDir(roleFolder), ACCOUNTS_FILE_NAME);
}

function listAccountFilePaths() {
    const files = [];
    for (const role of ROLE_FOLDER_ORDER) {
        const filePath = roleAccountsFilePath(role);
        if (fs.existsSync(filePath)) files.push(filePath);
    }
    if (!files.length && fs.existsSync(USERS_PATH)) files.push(USERS_PATH);
    return files;
}

function readRoleAccountsFileText(roleFolder) {
    const filePath = roleAccountsFilePath(roleFolder);
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
}

function writeRoleAccountsFileText(roleFolder, text) {
    const dir = roleAccountsDir(roleFolder);
    fs.mkdirSync(dir, { recursive: true });
    const out = String(text || '');
    fs.writeFileSync(
        roleAccountsFilePath(roleFolder),
        out.length && !out.endsWith('\n') ? `${out}\n` : out,
        'utf8'
    );
    invalidateUsersCache();
}

function getAccountsAggregateMtime() {
    let max = 0;
    for (const filePath of listAccountFilePaths()) {
        max = Math.max(max, fs.statSync(filePath).mtimeMs);
    }
    return max;
}

const SESSION_COOKIE = 'dashboard_session';
const LEGACY_COOKIE = 'dashboard_access';
const NOLOGIN_COOKIE = 'dashboard_nologin';
const SESSION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
/** Long-lived cookie for direct /nologin/{store} kiosk links. */
const NOLOGIN_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

const FIELD_LABELS = {
    username: ['username', 'user'],
    password: ['password', 'pass'],
    access: ['access', 'stores', 'store'],
    level: ['level', 'accountlevel', 'account level', 'userlevel', 'user level'],
    colourBlind: ['colourblind', 'colorblind', 'color blind', 'colour blind'],
    micDarkMode: ['micdarkmode', 'mic dark mode', 'darkmode', 'dark mode'],
    auditAutoCollapse: ['auditautocollapse', 'audit auto collapse', 'autocollapse', 'auto collapse'],
    micRoundedTiles: ['microundedtiles', 'mic rounded tiles', 'roundedtiles', 'rounded tiles'],
};

/** Ordered account levels - higher rank = more permissions. */
const ACCOUNT_LEVEL_RANK = {
    it: 100,
    market: 80,
    area: 60,
    store: 40,
    manager: 40,
    mic: 20,
    tm: 10,
};

const VALID_ACCOUNT_LEVELS = Object.keys(ACCOUNT_LEVEL_RANK);

const ACCOUNT_LEVEL_LABELS = {
    it: 'IT',
    market: 'Market',
    area: 'Area',
    store: 'Store',
    manager: 'Manager',
    mic: 'MIC',
    tm: 'Team Member',
};

function getAssignableAccountLevels(user) {
    const actorLevel = getAccountLevel(user);
    if (actorLevel === 'it') {
        return ['it', 'market', 'area', 'store', 'manager', 'mic', 'tm'];
    }
    if (actorLevel === 'market') {
        return ['area', 'store', 'manager', 'mic', 'tm'];
    }
    if (actorLevel === 'area') {
        return ['store', 'manager', 'mic', 'tm'];
    }
    if (actorLevel === 'store' || actorLevel === 'manager') {
        return ['manager', 'mic', 'tm'];
    }
    return [];
}

function canActorAssignAccountLevel(user, targetLevel) {
    const level = normalizeAccountLevel(targetLevel);
    if (!level) return false;
    return getAssignableAccountLevels(user).includes(level);
}

function requiresMmxForAccountLevel(level) {
    return ['manager', 'mic'].includes(normalizeAccountLevel(level));
}

function requiresStorePickerForAccountLevel(level) {
    return ['store', 'manager', 'mic', 'tm'].includes(normalizeAccountLevel(level));
}

function normalizeAccountLevel(raw) {
    const token = String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '');
    if (!token) return '';
    if (token === 'it' || token === 'admin' || token === 'super') return 'it';
    if (token === 'tm' || token === 'teammember' || token === 'team') return 'tm';
    if (VALID_ACCOUNT_LEVELS.includes(token)) return token;
    return '';
}

function accountLevelRank(level) {
    const normalized = normalizeAccountLevel(level);
    return ACCOUNT_LEVEL_RANK[normalized] ?? 0;
}

function isAccountLevelAbove(levelA, levelB) {
    return accountLevelRank(levelA) > accountLevelRank(levelB);
}

function inferAccountLevel(row) {
    const explicit = normalizeAccountLevel(row?.accountLevel);
    if (explicit) return explicit;
    const accessType =
        row?.accessType ||
        (row?.role === 'admin' || row?.stores === '*'
            ? 'super'
            : row?.role === 'market'
              ? 'market'
              : row?.role === 'area'
                ? 'area'
                : 'store');
    if (accessType === 'super' || row?.stores === '*' || row?.role === 'admin') return 'it';
    if (accessType === 'market' || row?.role === 'market') return 'market';
    if (accessType === 'area' || row?.role === 'area') return 'area';
    if (isStorePatternUsername(row?.username)) return 'store';
    return 'manager';
}

function lookupAccountLevelByUsername(username) {
    const name = String(username || '').trim();
    if (!name || name.startsWith('__')) return '';
    for (const row of readUsersFileSync()) {
        if (usernameMatches(row.username, name)) {
            return inferAccountLevel(row);
        }
    }
    return '';
}

function getAccountLevel(user) {
    if (!user) return 'manager';
    if (isNologinUser(user)) return 'tm';
    if (isSuperAdminUser(user)) return 'it';
    const fromUser = normalizeAccountLevel(user.accountLevel);
    if (fromUser) return fromUser;
    const fromFile = lookupAccountLevelByUsername(user.username);
    if (fromFile) return fromFile;
    return inferAccountLevel(user);
}

function canUserCompleteAudits(user) {
    if (!user || isNologinUser(user)) return false;
    if (isSuperAdminUser(user)) return true;
    return getAccountLevel(user) !== 'tm';
}

function canUserStartAudits(user) {
    return canUserCompleteAudits(user);
}

/** Market Manager, IT - coach/customer visit audits (not area coaches). */
function canAccessCoachAudits(user) {
    if (!user || isNologinUser(user)) return false;
    if (isSuperAdminUser(user)) return true;
    return accountLevelRank(getAccountLevel(user)) >= accountLevelRank('market');
}

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

function isPasswordHashed(stored) {
    return String(stored || '').trim().startsWith('scrypt:');
}

function storedPasswordMustChange(stored) {
    const value = String(stored || '').trim();
    return Boolean(value) && !isPasswordHashed(value);
}

const PASSWORD_UPPER_RE = /[A-Z]/;
const PASSWORD_DIGIT_RE = /\d/;
const PASSWORD_SPECIAL_RE = /[^A-Za-z0-9]/;

function validatePasswordComplexity(password, role) {
    const pass = String(password || '');
    if (pass.length < 8) {
        return { ok: false, error: 'Password must be at least 8 characters.' };
    }
    const hasUpper = PASSWORD_UPPER_RE.test(pass);
    const hasSpecial = PASSWORD_SPECIAL_RE.test(pass);
    const hasDigit = PASSWORD_DIGIT_RE.test(pass);
    const admin = role === 'admin';

    if (admin) {
        const missing = [];
        if (!hasUpper) missing.push('a capital letter');
        if (!hasSpecial) missing.push('a special character');
        if (!hasDigit) missing.push('a number');
        if (missing.length) {
            return {
                ok: false,
                error: `Admin password must include ${missing.join(', ')}.`,
            };
        }
        return { ok: true };
    }

    if (!hasUpper && !hasSpecial && !hasDigit) {
        return {
            ok: false,
            error: 'Password must include at least a capital letter, a special character, or a number.',
        };
    }
    return { ok: true };
}

function passwordPolicyForUser(user) {
    const admin = isAdminUser(user);
    return {
        minLength: 8,
        admin,
        requireUpper: admin,
        requireSpecial: admin,
        requireDigit: admin,
        requireAnyOne: !admin,
        label: admin
            ? 'At least 8 characters with a capital letter, a special character, and a number.'
            : 'At least 8 characters with a capital letter, a special character, or a number.',
    };
}

function lookupStoredPassword(username) {
    const name = String(username || '').trim();
    if (!name) return '';
    const blocks = parseUsersFileBlocks(readUsersFileText());
    const block = blocks.find((row) => blockMatchesUsername(row, name));
    return block?.password || '';
}

function userNeedsPasswordChange(username) {
    return storedPasswordMustChange(lookupStoredPassword(username));
}

function userNeedsMmxSetup(username) {
    void username;
    return false;
}

function canUserManageStoreLogins(user) {
    if (!isRealDashboardUser(user) || isNologinUser(user)) return false;
    if (canUserAccessAdminMenu(user)) return true;
    const level = getAccountLevel(user);
    return level === 'store' || level === 'manager' || level === 'mic';
}

function canUserManageSmgNsfSettings(user) {
    return canUserAccessAdminMenu(user) && hasMultiStoreScope(user);
}

function getAccountSetupRedirectPath(user) {
    if (!isRealDashboardUser(user)) return '';
    if (userNeedsMmxSetup(user.username)) return '/mmx-setup';
    if (userNeedsPasswordChange(user.username)) return '/change-password';
    return '';
}

function generateTemporaryPassword(accountLevel = 'store') {
    const admin = normalizeAccountLevel(accountLevel) === 'it';
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lower = 'abcdefghijkmnpqrstuvwxyz';
    const digits = '23456789';
    const special = '!@#$%&*';
    const all = upper + lower + digits + (admin ? special : '');
    const required = [
        upper[Math.floor(Math.random() * upper.length)],
        digits[Math.floor(Math.random() * digits.length)],
    ];
    if (admin) {
        required.push(special[Math.floor(Math.random() * special.length)]);
    } else {
        required.push(lower[Math.floor(Math.random() * lower.length)]);
    }
    while (required.length < 12) {
        required.push(all[Math.floor(Math.random() * all.length)]);
    }
    for (let i = required.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [required[i], required[j]] = [required[j], required[i]];
    }
    return required.join('');
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

function parseAccessScope(raw) {
    const token = stripTrailingPipe(raw);
    if (!token || token === '*' || /^all$/i.test(token)) {
        return { type: 'super', role: 'admin', stores: '*', markets: [], areas: [] };
    }

    const parts = token
        .split(/[,;]+/)
        .map((p) => p.trim())
        .filter(Boolean);
    if (!parts.length) return null;

    if (parts.length === 1 && /^market\s*\d+$/i.test(parts[0])) {
        const market = normalizeMarketLabel(parts[0]);
        return { type: 'market', role: 'market', stores: [], markets: [market], areas: [] };
    }

    if (parts.every((p) => /^area\s*\d+$/i.test(p))) {
        const areas = [...new Set(parts.map(normalizeAreaLabel))];
        return { type: 'area', role: 'area', stores: [], markets: [], areas };
    }

    const hasMarket = parts.some((p) => /^market\s*\d+$/i.test(p));
    const hasArea = parts.some((p) => /^area\s*\d+$/i.test(p));
    if (hasMarket || hasArea) {
        console.warn('[Auth] Ambiguous access token (market/area mixed with other tokens):', token);
        return null;
    }

    const stores = token
        .split(/[,;\s]+/)
        .map((s) => s.replace(/[^0-9]/g, ''))
        .filter(Boolean);
    if (!stores.length) {
        console.warn('[Auth] Unrecognized access token:', token);
        return null;
    }
    return { type: 'store', role: 'store', stores: [...new Set(stores)], markets: [], areas: [] };
}

/** @deprecated use parseAccessScope */
function parseAccessToken(raw) {
    return parseAccessScope(raw);
}

function isCbUsername(name) {
    return /^CB[A-Za-z0-9]+$/i.test(String(name || '').trim());
}

/** `.Users` comment lines - `#` headers or `//` section dividers (ignored except as labels). */
function isUsersCommentLine(trimmed) {
    const line = String(trimmed || '').trim();
    return line.startsWith('#') || line.startsWith('//');
}

/**
 * Display label from a `#` or `//` line. Decorative `//||||//` dividers return ''.
 * `//          3806            //` → `3806`.
 */
function parseUsersCommentLabel(trimmed) {
    const line = String(trimmed || '').trim();
    if (line.startsWith('#')) {
        return line.replace(/^#\s*/, '').trim();
    }
    if (!line.startsWith('//')) return '';

    let body = line.replace(/^\/\/\s*/, '').replace(/\s*\/\/\s*$/, '').trim();
    if (!body || /^[/|=\-_\s\\.]+$/.test(body)) return '';

    const store = body.match(/\b(\d{3,6})\b/);
    if (store) return store[1];

    return body.replace(/\s+/g, ' ').trim();
}

function parseAccessBlock(block) {
    const lines = block.filter((line) => {
        const trimmed = line.trim();
        return trimmed && !isUsersCommentLine(trimmed);
    });
    if (!lines.length) return null;

    let username = '';
    let password = '';
    let accessRaw = '';
    let colourBlindPref = false;
    let micDarkModePref = false;
    let auditAutoCollapsePref = true;
    let micRoundedTilesPref = true;
    let accountLevel = '';

    for (const line of lines) {
        const trimmed = line.trim();
        const lower = trimmed.toLowerCase();
        if (FIELD_LABELS.level.some((k) => lower.startsWith(`${k} `) || lower.startsWith(`${k}|`))) {
            accountLevel = normalizeAccountLevel(parseFieldLine(trimmed, FIELD_LABELS.level));
            continue;
        }
        if (
            FIELD_LABELS.colourBlind.some((k) => lower.startsWith(`${k} `) || lower.startsWith(`${k}|`))
        ) {
            const val = parseFieldLine(trimmed, FIELD_LABELS.colourBlind);
            colourBlindPref = /^(1|true|yes|on)$/i.test(String(val || '').trim());
            continue;
        }
        if (FIELD_LABELS.micDarkMode.some((k) => lower.startsWith(`${k} `) || lower.startsWith(`${k}|`))) {
            const val = parseFieldLine(trimmed, FIELD_LABELS.micDarkMode);
            micDarkModePref = /^(1|true|yes|on)$/i.test(String(val || '').trim());
            continue;
        }
        if (FIELD_LABELS.auditAutoCollapse.some((k) => lower.startsWith(`${k} `) || lower.startsWith(`${k}|`))) {
            const val = parseFieldLine(trimmed, FIELD_LABELS.auditAutoCollapse);
            auditAutoCollapsePref = !/^(0|false|no|off)$/i.test(String(val || '').trim());
            continue;
        }
        if (FIELD_LABELS.micRoundedTiles.some((k) => lower.startsWith(`${k} `) || lower.startsWith(`${k}|`))) {
            const val = parseFieldLine(trimmed, FIELD_LABELS.micRoundedTiles);
            micRoundedTilesPref = !/^(0|false|no|off)$/i.test(String(val || '').trim());
            continue;
        }
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

    const access = parseAccessScope(accessRaw);
    if (!access) return null;

    return {
        username,
        cbUsername,
        password,
        role: access.role,
        accessType: access.type,
        stores: access.stores,
        markets: access.markets || [],
        areas: access.areas || [],
        colourBlindPref,
        micDarkModePref,
        auditAutoCollapsePref,
        micRoundedTilesPref,
        accountLevel,
    };
}

/**
 * Parse `.Users` blocks:
 *   # Display name (optional label)
 *   //||||||||//  /  //  3806  //  /  //||||||||//  three-line store sections
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
                accessType: row.accessType || (row.role === 'admin' ? 'super' : 'store'),
                stores: row.stores,
                markets: row.markets || [],
                areas: row.areas || [],
                accountLevel: inferAccountLevel({ ...row, username: row.username }),
            };
            const micDarkMode = Boolean(row.micDarkModePref);
            const auditAutoCollapse = row.auditAutoCollapsePref !== false;
            const micRoundedTiles = row.micRoundedTilesPref !== false;
            if (row.username && !isCbUsername(row.username)) {
                users.push({
                    ...base,
                    username: row.username,
                    colorBlind: Boolean(row.colourBlindPref),
                    micDarkMode,
                    auditAutoCollapse,
                    micRoundedTiles,
                });
            }
            if (row.cbUsername) {
                users.push({ ...base, username: row.cbUsername, colorBlind: true, micDarkMode, auditAutoCollapse, micRoundedTiles });
            }
            if (row.username && isCbUsername(row.username)) {
                users.push({ ...base, username: row.username, colorBlind: true, micDarkMode, auditAutoCollapse, micRoundedTiles });
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
        if (isUsersCommentLine(trimmed)) {
            const label = parseUsersCommentLabel(trimmed);
            if (label) {
                flushBlock();
                blockName = label;
            }
            continue;
        }
        block.push(rawLine);
    }
    flushBlock();

    return users;
}

function parseUsersFileBlocks(text) {
    const blocks = [];
    const lines = String(text || '').split(/\r?\n/);
    let block = [];
    let blockName = '';

    function flushBlock() {
        const row = parseAccessBlock(block);
        if (row) {
            blocks.push({
                displayName: blockName,
                username: row.username,
                cbUsername: row.cbUsername || '',
                password: row.password,
                role: row.role,
                accessType: row.accessType || (row.role === 'admin' ? 'super' : 'store'),
                stores: row.stores,
                markets: row.markets || [],
                areas: row.areas || [],
                colourBlindPref: Boolean(row.colourBlindPref),
                micDarkModePref: Boolean(row.micDarkModePref),
                auditAutoCollapsePref: row.auditAutoCollapsePref !== false,
                micRoundedTilesPref: row.micRoundedTilesPref !== false,
                accountLevel: inferAccountLevel({ ...row, username: row.username }),
            });
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
        if (isUsersCommentLine(trimmed)) {
            const label = parseUsersCommentLabel(trimmed);
            if (label) {
                flushBlock();
                blockName = label;
            }
            continue;
        }
        block.push(rawLine);
    }
    flushBlock();
    return blocks;
}

function formatAccessRaw(block) {
    if (typeof block === 'string' || Array.isArray(block)) {
        const stores = block;
        if (stores === '*') return '*';
        return [...new Set(stores.map(String))].join(', ');
    }
    const accessType = block.accessType || (block.stores === '*' ? 'super' : 'store');
    if (accessType === 'super' || block.stores === '*') return '*';
    if (accessType === 'market' && block.markets?.length) return block.markets[0];
    if (accessType === 'area' && block.areas?.length) return block.areas.join(', ');
    const stores = Array.isArray(block.stores) ? block.stores : [];
    return [...new Set(stores.map(String))].join(', ');
}

function serializeUserBlock(block) {
    const out = [];
    if (block.displayName) out.push(`# ${block.displayName}`);
    out.push(`${block.username} |`);
    if (block.cbUsername) out.push(`${block.cbUsername} |`);
    out.push(`${block.password} |`);
    out.push(`${formatAccessRaw(block)} |`);
    const level = normalizeAccountLevel(block.accountLevel);
    if (level) out.push(`level | ${level}`);
    if (block.colourBlindPref) out.push('colourblind | on');
    if (block.micDarkModePref) out.push('micdarkmode | on');
    if (block.auditAutoCollapsePref === false) out.push('auditautocollapse | off');
    if (block.micRoundedTilesPref === false) out.push('microundedtiles | off');
    out.push('');
    return out.join('\n');
}

function serializeUsersFile(blocks) {
    return blocks.map(serializeUserBlock).join('\n').trimEnd() + '\n';
}

function isStoreSectionLabel(label) {
    const key = normalizeStoreKey(label);
    return Boolean(key && /^\d{3,6}$/.test(key));
}

function storeSectionHeaderText(storeNumber) {
    const store = normalizeStoreKey(storeNumber);
    return [
        '//||||||||||||||||||||||||||||||||||//',
        `//              ${store}                //`,
        '//||||||||||||||||||||||||||||||||||//',
    ].join('\n');
}

function findStoreSectionLabelIndex(lines, storeNumber) {
    const store = normalizeStoreKey(storeNumber);
    if (!store) return -1;
    for (let i = 0; i < lines.length; i += 1) {
        const label = parseUsersCommentLabel(lines[i].trim());
        if (label && normalizeStoreKey(label) === store && isStoreSectionLabel(label)) {
            return i;
        }
    }
    return -1;
}

function findNextStoreSectionLabelIndex(lines, afterIndex) {
    for (let i = afterIndex + 1; i < lines.length; i += 1) {
        const label = parseUsersCommentLabel(lines[i].trim());
        if (label && isStoreSectionLabel(label)) return i;
    }
    return -1;
}

/** Insert a serialized user block under the matching `// 3806 //` section (or create one at EOF). */
function insertUserBlockInStoreSection(fileText, storeNumber, blockText) {
    const store = normalizeStoreKey(storeNumber);
    const lines = String(fileText || '').replace(/\r\n/g, '\n').split('\n');
    const trimmedBlock = String(blockText || '').trimEnd();
    const labelIdx = findStoreSectionLabelIndex(lines, store);

    if (labelIdx < 0) {
        const existing = String(fileText || '').trimEnd();
        const addition = `${storeSectionHeaderText(store)}\n\n${trimmedBlock}`;
        return existing ? `${existing}\n\n${addition}\n` : `${addition}\n`;
    }

    const nextSection = findNextStoreSectionLabelIndex(lines, labelIdx);
    const stop = nextSection >= 0 ? nextSection : lines.length;
    let insertBefore = stop;
    while (insertBefore > labelIdx + 1) {
        const prev = lines[insertBefore - 1].trim();
        if (!prev) {
            insertBefore -= 1;
            continue;
        }
        if (isUsersCommentLine(prev) && !parseUsersCommentLabel(prev)) {
            insertBefore -= 1;
            continue;
        }
        break;
    }

    let lastContent = labelIdx;
    for (let i = labelIdx; i < insertBefore; i += 1) {
        if (lines[i].trim()) lastContent = i;
    }

    const before = lines.slice(0, lastContent + 1);
    const after = lines.slice(insertBefore);
    const merged = [...before, '', ...trimmedBlock.split('\n')];
    if (after.length) merged.push('', ...after);
    return merged.join('\n').trimEnd() + '\n';
}

function invalidateUsersCache() {
    usersCache = null;
    usersCacheMtime = 0;
    usersCachePath = '';
}

function readUsersFileText() {
    const files = listAccountFilePaths();
    if (!files.length) return '';
    return files.map((filePath) => fs.readFileSync(filePath, 'utf8')).join('\n');
}

function writeUsersFileFromBlocks(blocks) {
    const byRole = Object.fromEntries(ROLE_FOLDER_ORDER.map((role) => [role, []]));
    for (const block of blocks || []) {
        byRole[roleFolderForBlock(block)].push(block);
    }
    for (const role of ROLE_FOLDER_ORDER) {
        writeRoleAccountsFileText(role, serializeUsersFile(byRole[role] || []));
    }
    invalidateUsersCache();
}

function writeUsersFileText(text) {
    const blocks = parseUsersFileBlocks(text);
    if (blocks.length) {
        writeUsersFileFromBlocks(blocks);
        return;
    }
    for (const role of ROLE_FOLDER_ORDER) {
        writeRoleAccountsFileText(role, '');
    }
    invalidateUsersCache();
}

function appendAccountAudit(entry) {
    try {
        fs.mkdirSync(path.dirname(ACCOUNT_AUDIT_LOG), { recursive: true });
        fs.appendFileSync(ACCOUNT_AUDIT_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
    } catch (err) {
        console.warn('[Auth] Account audit log write failed:', err.message);
    }
}

function appendAuthEvent(entry) {
    try {
        fs.mkdirSync(path.dirname(AUTH_EVENTS_LOG), { recursive: true });
        fs.appendFileSync(AUTH_EVENTS_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
    } catch (err) {
        console.warn('[Auth] Auth events log write failed:', err.message);
    }
}

function readAuthEventsForUser(username, limit = 50) {
    const name = String(username || '').trim().toLowerCase();
    const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
    if (!name || !fs.existsSync(AUTH_EVENTS_LOG)) return [];
    try {
        const lines = fs.readFileSync(AUTH_EVENTS_LOG, 'utf8').split('\n').filter(Boolean);
        const out = [];
        for (let i = lines.length - 1; i >= 0 && out.length < cap; i -= 1) {
            try {
                const row = JSON.parse(lines[i]);
                if (String(row.username || '').trim().toLowerCase() !== name) continue;
                out.push(row);
            } catch {
                /* skip malformed */
            }
        }
        return out;
    } catch {
        return [];
    }
}

function accountCreatedAtFromAudit(username) {
    const name = String(username || '').trim().toLowerCase();
    if (!name || !fs.existsSync(ACCOUNT_AUDIT_LOG)) return null;
    try {
        const lines = fs.readFileSync(ACCOUNT_AUDIT_LOG, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
            try {
                const row = JSON.parse(line);
                if (row.action !== 'create-account') continue;
                if (String(row.username || '').trim().toLowerCase() !== name) continue;
                return row.at || null;
            } catch {
                /* skip */
            }
        }
    } catch {
        /* ignore */
    }
    return null;
}

function lastLoginAtForUser(username) {
    const events = readAuthEventsForUser(username, 20);
    const hit = events.find((row) => row.success !== false);
    return hit?.at || null;
}

function isPrimaryStoreLogin(user) {
    if (!user || isAdminUser(user)) return false;
    return isStorePatternUsername(user.username);
}

/** Admins and manager-created crew accounts - not primary store logins (3811 / CB3811). */
function canUserAccessDfsc(user) {
    if (!isRealDashboardUser(user)) return false;
    if (isAdminUser(user)) return true;
    return !isPrimaryStoreLogin(user);
}

function fullNameFromSecrets(secrets) {
    if (!secrets) return '';
    return [secrets.firstName, secrets.lastName].filter(Boolean).join(' ').trim();
}

function getDfscConductorName(user) {
    if (!user) return '';
    if (isRealDashboardUser(user)) {
        const full = fullNameFromSecrets(readUserAccountSecrets(user.username));
        if (full) return full;
    }
    return String(user.displayName || lookupDisplayName(user.username) || '').trim();
}

function lookupWelcomeName(username) {
    const name = String(username || '').trim();
    if (!name) return '';
    const secrets = readUserAccountSecrets(name);
    if (secrets?.firstName) return secrets.firstName;
    return lookupDisplayName(name) || name;
}

function isStorePatternUsername(username) {
    const name = String(username || '').trim();
    return /^\d{3,6}$/.test(name) || /^CB\d{3,6}$/i.test(name);
}

function usernameExists(username) {
    const name = String(username || '').trim();
    if (!name) return false;
    return readUsersFileSync().some((row) => usernameMatches(row.username, name));
}

function blockMatchesUsername(block, username) {
    const name = String(username || '').trim();
    if (!name) return false;
    if (usernameMatches(block.username, name)) return true;
    if (block.cbUsername && usernameMatches(block.cbUsername, name)) return true;
    return false;
}

function isSyntheticUser(user) {
    const name = String(user?.username || '');
    return !name || name.startsWith('__');
}

function isRealDashboardUser(user) {
    return Boolean(user && !isSyntheticUser(user) && !isNologinUser(user));
}

function canUserCreateAccounts(user) {
    if (!isRealDashboardUser(user)) return false;
    return accountLevelRank(getAccountLevel(user)) >= accountLevelRank('store');
}

function canUserAccessAdminMenu(user) {
    return canUserCreateAccounts(user);
}

function canUserViewFeatureRequests(user) {
    if (!isRealDashboardUser(user)) return false;
    return accountLevelRank(getAccountLevel(user)) >= accountLevelRank('mic');
}

function canUserEditGlobalBuildTo(user) {
    if (!isRealDashboardUser(user)) return false;
    return accountLevelRank(getAccountLevel(user)) >= accountLevelRank('area');
}

function buildCreateAccountParentFromUser(user, via = 'session') {
    const scope = getUserAccessScope(user);
    return {
        parentUsername: user.username,
        actorLevel: getAccountLevel(user),
        accessType: scope.type,
        stores: user.stores === '*' ? '*' : getEffectiveStoresForUser(user),
        markets: [...scope.markets],
        areas: [...scope.areas],
        addCbAlias: Boolean(user.colorBlind) || /^CB\d{3,6}$/i.test(user.username),
        via,
    };
}

const CREATE_ACCOUNT_LEVEL_ORDER = ['market', 'area', 'manager', 'mic', 'tm'];

function buildCreateAccountScopeTree(actor) {
    const accessibleAreas = new Set((getAccessibleAreasForUser(actor) || []).map(normalizeAreaLabel));
    const effectiveStoreNums = new Set((getEffectiveStoresForUser(actor) || []).map(String));
    const scope = getUserAccessScope(actor);
    const actorLevel = getAccountLevel(actor);

    const storesByArea = {};
    for (const store of getStoreList()) {
        if (isTestStore(store.storeNumber)) continue;
        const storeNumber = String(store.storeNumber);
        if (!effectiveStoreNums.has(storeNumber)) continue;
        const area = normalizeAreaLabel(areaNameFromStoreEntry(store));
        if (!accessibleAreas.has(area)) continue;
        if (!storesByArea[area]) storesByArea[area] = [];
        storesByArea[area].push({
            storeNumber,
            storeName: String(store.storeName || storeNumber).trim(),
        });
    }
    for (const area of Object.keys(storesByArea)) {
        storesByArea[area].sort((a, b) =>
            a.storeNumber.localeCompare(b.storeNumber, undefined, { numeric: true })
        );
    }

    const areasByMarket = {};
    const marketsSet = new Set();

    if (actorLevel === 'it') {
        for (const market of getAllMarketLabels()) {
            const areas = getAreasForMarket(market)
                .map(normalizeAreaLabel)
                .filter((area) => accessibleAreas.has(area));
            if (areas.length) {
                areasByMarket[market] = areas;
                marketsSet.add(market);
            }
        }
    } else if (actorLevel === 'market') {
        for (const market of scope.markets) {
            const areas = getAreasForMarket(market)
                .map(normalizeAreaLabel)
                .filter((area) => accessibleAreas.has(area));
            if (areas.length) {
                areasByMarket[market] = areas;
                marketsSet.add(market);
            }
        }
    } else {
        for (const area of accessibleAreas) {
            const market = getMarketForArea(area);
            if (!market) continue;
            if (!areasByMarket[market]) areasByMarket[market] = [];
            if (!areasByMarket[market].includes(area)) areasByMarket[market].push(area);
            marketsSet.add(market);
        }
    }

    for (const market of Object.keys(areasByMarket)) {
        areasByMarket[market].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    }

    const markets = [...marketsSet].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const singleStore = singleStoreForUser(actor);
    let defaultStore = '';
    let defaultArea = '';
    let defaultMarket = '';
    if (singleStore) {
        defaultStore = String(singleStore);
        for (const [area, rows] of Object.entries(storesByArea)) {
            if (rows.some((row) => row.storeNumber === defaultStore)) {
                defaultArea = area;
                break;
            }
        }
    } else {
        const orderedAreas = getAreaIds().filter((area) => storesByArea[area]?.length);
        if (orderedAreas.length) {
            defaultArea = orderedAreas[0];
            defaultStore = storesByArea[defaultArea][0]?.storeNumber || '';
        }
    }
    if (!defaultArea && accessibleAreas.size === 1) {
        defaultArea = [...accessibleAreas][0];
        if (!defaultStore && storesByArea[defaultArea]?.length) {
            defaultStore = storesByArea[defaultArea][0].storeNumber;
        }
    }
    if (defaultArea) {
        defaultMarket = getMarketForArea(defaultArea);
    }
    if (!defaultMarket && markets.length === 1) {
        defaultMarket = markets[0];
    }

    return {
        markets,
        areasByMarket,
        storesByArea,
        areas: getAreaIds().filter((area) => storesByArea[area]?.length),
        defaults: {
            market: defaultMarket,
            area: defaultArea,
            storeNumber: String(defaultStore || ''),
        },
    };
}

function getCreateAccountOptions(actor) {
    const actorLevel = getAccountLevel(actor);
    const assignableLevels = getAssignableAccountLevels(actor);
    const scope = getUserAccessScope(actor);
    const allStores = getStoreList()
        .filter((row) => !isTestStore(row.storeNumber))
        .map((row) => ({
            storeNumber: String(row.storeNumber),
            storeName: String(row.storeName || row.storeNumber).trim(),
        }));
    const effectiveStoreKeys = new Set((getEffectiveStoresForUser(actor) || []).map(String));
    const stores = allStores.filter((row) => effectiveStoreKeys.has(String(row.storeNumber)));

    let areas = getAccessibleAreasForUser(actor);
    let markets = [...scope.markets];
    if (actorLevel === 'it') {
        markets = getAllMarketLabels();
        areas = [...new Set(markets.flatMap((market) => getAreasForMarket(market)))];
    }

    const scopeTree = normalizeScopeTreeForClient(buildCreateAccountScopeTree(actor));
    const levelChoices = CREATE_ACCOUNT_LEVEL_ORDER.filter((level) => assignableLevels.includes(level));

    return {
        actorLevel,
        levelChoices,
        assignableLevels: assignableLevels.map((level) => ({
            value: level,
            label: ACCOUNT_LEVEL_LABELS[level] || level,
            requiresMmx: requiresMmxForAccountLevel(level),
            requiresStore: requiresStorePickerForAccountLevel(level),
            requiresArea: level === 'area' || requiresStorePickerForAccountLevel(level),
            requiresMarket:
                level === 'market' || level === 'area' || requiresStorePickerForAccountLevel(level),
        })),
        scopeTree,
        stores,
        areas,
        markets,
        defaultStore: scopeTree.defaults.storeNumber || singleStoreForUser(actor) || stores[0]?.storeNumber || '',
    };
}

function validateCreateAccountPayload(actor, payload = {}) {
    const targetLevel = normalizeAccountLevel(payload.accountLevel);
    if (!targetLevel) {
        return { ok: false, error: 'Account level is required.' };
    }
    if (!canActorAssignAccountLevel(actor, targetLevel)) {
        return { ok: false, error: 'You cannot assign that account level.' };
    }

    const actorLevel = getAccountLevel(actor);

    if (actorLevel === 'store' || actorLevel === 'manager') {
        const store = normalizeStoreKey(payload.storeNumber);
        if (!store) {
            return { ok: false, error: 'Store is required.' };
        }
        const actorStores = getEffectiveStoresForUser(actor);
        if (!actorStores.includes(store)) {
            return { ok: false, error: 'You can only create accounts for your store.' };
        }
        if (!['manager', 'mic', 'tm'].includes(targetLevel)) {
            return { ok: false, error: 'You can only assign Manager, MIC, or Team Member levels.' };
        }
        const access = parseAccessScope(store);
        if (!access) return { ok: false, error: 'Invalid store.' };
        return { ok: true, accountLevel: targetLevel, accessScope: access, stores: [store] };
    }

    if (targetLevel === 'it') {
        if (actorLevel !== 'it') {
            return { ok: false, error: 'Only IT can create IT accounts.' };
        }
        const access = parseAccessScope('*');
        return { ok: true, accountLevel: 'it', accessScope: access, stores: '*' };
    }

    if (targetLevel === 'market') {
        const market = normalizeMarketLabel(payload.market);
        if (!market) {
            return { ok: false, error: 'Market is required.' };
        }
        if (!isSuperAdminUser(actor) && !userCanAccessMarket(actor, market)) {
            return { ok: false, error: 'That market is outside your scope.' };
        }
        const access = parseAccessScope(market);
        if (!access) return { ok: false, error: 'Invalid market.' };
        return { ok: true, accountLevel: 'market', accessScope: access, market };
    }

    if (targetLevel === 'area') {
        const area = normalizeAreaLabel(payload.area);
        if (!area) {
            return { ok: false, error: 'Area is required.' };
        }
        if (!userCanAccessArea(actor, area)) {
            return { ok: false, error: 'That area is outside your scope.' };
        }
        const access = parseAccessScope(area);
        if (!access) return { ok: false, error: 'Invalid area.' };
        return { ok: true, accountLevel: 'area', accessScope: access, area };
    }

    const store = normalizeStoreKey(payload.storeNumber);
    if (!store) {
        return { ok: false, error: 'Store is required for this account level.' };
    }
    if (!userCanAccessStore(actor, store)) {
        return { ok: false, error: 'That store is outside your scope.' };
    }
    const access = parseAccessScope(store);
    if (!access) return { ok: false, error: 'Invalid store.' };
    return { ok: true, accountLevel: targetLevel, accessScope: access, stores: [store] };
}

function canUserManageStoreAccounts(user, storeNumber) {
    if (!user) return false;
    if (!userCanAccessStore(user, storeNumber)) return false;
    return canUserCreateAccounts(user);
}

function blockGrantsStore(block, storeNumber) {
    const store = normalizeStoreKey(storeNumber);
    if (!store || isTestStore(store)) return false;
    if (block?.stores === '*') return false;
    const normalized = normalizeUser(block);
    return getEffectiveStoresForUser(normalized).includes(store);
}

/** Crew logins created via Create account - not the primary 3811 / CB3811 store login. */
function isManagedStoreAccountBlock(block) {
    if (!block?.username || block.stores === '*') return false;
    if (isStorePatternUsername(block.username)) return false;
    if (isCbUsername(block.username)) return false;
    return true;
}

/** Primary store login for a store number (e.g. 3811), not CB* or manager-created crew accounts. */
function findPrimaryStoreDashboardUsername(storeNumber) {
    const store = normalizeStoreKey(storeNumber);
    if (!store || isTestStore(store)) return '';
    const blocks = parseUsersFileBlocks(readUsersFileText());
    for (const block of blocks) {
        if (isManagedStoreAccountBlock(block)) continue;
        if (isCbUsername(block.username)) continue;
        if (!blockGrantsStore(block, store)) continue;
        if (normalizeStoreKey(block.username) === store) {
            return String(block.username).trim();
        }
    }
    for (const block of blocks) {
        if (isManagedStoreAccountBlock(block)) continue;
        if (isCbUsername(block.username)) continue;
        if (!blockGrantsStore(block, store)) continue;
        if (isStorePatternUsername(block.username)) {
            return String(block.username).trim();
        }
    }
    return store;
}

/** Dashboard usernames to check for per-store MMX credentials (primary login, then crew accounts). */
function listStoreMacromatixDashboardUsers(storeNumber) {
    const store = normalizeStoreKey(storeNumber);
    if (!store || isTestStore(store)) return [];
    const ordered = [];
    const primary = findPrimaryStoreDashboardUsername(store);
    if (primary) ordered.push(primary);
    for (const row of listManagedStoreAccounts(store)) {
        if (row.username) ordered.push(row.username);
    }
    return [...new Set(ordered.map((u) => String(u).trim()).filter(Boolean))];
}

function listManagedStoreAccounts(storeNumber) {
    const store = normalizeStoreKey(storeNumber);
    if (!store || isTestStore(store)) return [];
    const blocks = parseUsersFileBlocks(readUsersFileText());
    return blocks
        .filter((block) => blockGrantsStore(block, store) && isManagedStoreAccountBlock(block))
        .map((block) => {
            const secrets = readUserAccountSecrets(block.username);
            const fullName = fullNameFromSecrets(secrets);
            const username = String(block.username || '').trim();
            const normalized = normalizeUser(block);
            const stores =
                normalized.stores === '*'
                    ? []
                    : [...new Set((normalized.stores || []).map(String))].filter(Boolean);
            return {
                username,
                nickname: fullName || String(block.displayName || block.username || '').trim(),
                accountLevel: getAccountLevel(block),
                stores,
                createdAt: accountCreatedAtFromAudit(username),
                lastLoginAt: lastLoginAtForUser(username),
            };
        })
        .filter((row) => row.username)
        .sort((a, b) => a.nickname.localeCompare(b.nickname, undefined, { sensitivity: 'base' }));
}

function deleteManagedStoreAccount(actor, storeNumber, targetUsername) {
    const store = normalizeStoreKey(storeNumber);
    const target = String(targetUsername || '').trim();
    if (!store) {
        return { ok: false, error: 'Store is required.' };
    }
    if (!target) {
        return { ok: false, error: 'Account username is required.' };
    }
    if (!canUserManageStoreAccounts(actor, store)) {
        return { ok: false, error: 'You do not have permission to manage accounts for this store.' };
    }
    if (usernameMatches(actor?.username, target)) {
        return { ok: false, error: 'You cannot delete your own account here.' };
    }
    if (isStorePatternUsername(target) || isCbUsername(target)) {
        return { ok: false, error: 'Primary store logins cannot be deleted from the dashboard.' };
    }

    const blocks = parseUsersFileBlocks(readUsersFileText());
    const index = blocks.findIndex(
        (block) =>
            blockGrantsStore(block, store) &&
            isManagedStoreAccountBlock(block) &&
            usernameMatches(block.username, target)
    );
    if (index < 0) {
        return { ok: false, error: 'Account not found for this store.' };
    }

    const removed = blocks.splice(index, 1)[0];
    writeUsersFileText(serializeUsersFile(blocks));
    appendAccountAudit({
        action: 'delete-managed-account',
        username: removed.username,
        nickname: removed.displayName || removed.username,
        store,
        deletedBy: String(actor?.username || '').trim(),
    });
    return { ok: true, username: removed.username, nickname: removed.displayName || removed.username };
}

function findManagedAccountBlock(storeNumber, targetUsername) {
    const store = normalizeStoreKey(storeNumber);
    const target = String(targetUsername || '').trim();
    if (!store || !target) return null;
    const blocks = parseUsersFileBlocks(readUsersFileText());
    const index = blocks.findIndex(
        (block) =>
            blockGrantsStore(block, store) &&
            isManagedStoreAccountBlock(block) &&
            usernameMatches(block.username, target)
    );
    if (index < 0) return null;
    return { blocks, index, block: blocks[index] };
}

function updateManagedStoreAccount(actor, storeNumber, targetUsername, patch = {}) {
    const store = normalizeStoreKey(storeNumber);
    const target = String(targetUsername || '').trim();
    if (!store) {
        return { ok: false, error: 'Store is required.' };
    }
    if (!target) {
        return { ok: false, error: 'Account username is required.' };
    }
    if (!canUserManageStoreAccounts(actor, store)) {
        return { ok: false, error: 'You do not have permission to manage accounts for this store.' };
    }
    if (isStorePatternUsername(target) || isCbUsername(target)) {
        return { ok: false, error: 'Primary store logins cannot be edited from the dashboard.' };
    }

    const found = findManagedAccountBlock(store, target);
    if (!found) {
        return { ok: false, error: 'Account not found for this store.' };
    }

    const { blocks, index, block } = found;
    const nextLevel = patch.accountLevel != null ? normalizeAccountLevel(patch.accountLevel) : null;
    const nextStoresRaw = patch.stores != null ? patch.stores : null;

    if (nextLevel) {
        if (!canActorAssignAccountLevel(actor, nextLevel)) {
            return { ok: false, error: 'You cannot assign that account level.' };
        }
        block.accountLevel = nextLevel;
        const inferred = inferAccountLevel(block);
        block.role =
            nextLevel === 'it'
                ? 'admin'
                : nextLevel === 'market'
                  ? 'market'
                  : nextLevel === 'area'
                    ? 'area'
                    : 'store';
        block.accessType =
            nextLevel === 'it' ? 'super' : nextLevel === 'market' ? 'market' : nextLevel === 'area' ? 'area' : 'store';
        if (!inferred) block.accountLevel = nextLevel;
    }

    if (Array.isArray(nextStoresRaw)) {
        const allowed = new Set((getEffectiveStoresForUser(actor) || []).map(String));
        const cleaned = [...new Set(nextStoresRaw.map((s) => normalizeStoreKey(s)).filter(Boolean))];
        if (!cleaned.length) {
            return { ok: false, error: 'At least one store is required.' };
        }
        for (const s of cleaned) {
            if (!allowed.has(String(s))) {
                return { ok: false, error: `Store ${s} is outside your scope.` };
            }
        }
        block.stores = cleaned;
        block.accessType = 'store';
        block.role = 'store';
        if (!nextLevel) {
            block.accountLevel = normalizeAccountLevel(block.accountLevel) || 'mic';
        }
    }

    blocks[index] = block;
    writeUsersFileText(serializeUsersFile(blocks));
    appendAccountAudit({
        action: 'update-managed-account',
        username: block.username,
        store,
        updatedBy: String(actor?.username || '').trim(),
        accountLevel: getAccountLevel(block),
        stores: block.stores,
    });
    return {
        ok: true,
        username: block.username,
        accountLevel: getAccountLevel(block),
        stores: block.stores === '*' ? [] : [...(block.stores || [])].map(String),
    };
}

function listLoginHistoryForStore(actor, storeNumber, options = {}) {
    const store = normalizeStoreKey(storeNumber);
    if (!store || !canUserManageStoreAccounts(actor, store)) {
        return { ok: false, error: 'You do not have permission to view login history for this store.' };
    }
    const usernameFilter = String(options.username || '').trim();
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    const accounts = listManagedStoreAccounts(store);
    const usernames = usernameFilter
        ? accounts.filter((row) => usernameMatches(row.username, usernameFilter)).map((row) => row.username)
        : accounts.map((row) => row.username);
    const events = [];
    for (const name of usernames) {
        for (const row of readAuthEventsForUser(name, limit)) {
            events.push({ ...row, username: name });
        }
    }
    events.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    return { ok: true, storeNumber: store, events: events.slice(0, limit) };
}

function changeUserPassword(username, currentPassword, newPassword) {
    const name = String(username || '').trim();
    const current = String(currentPassword || '');
    const next = String(newPassword || '');
    if (!name || !current || !next) {
        return { ok: false, error: 'Current and new password are required.' };
    }
    const verified = authenticate(name, current);
    if (!verified) {
        return { ok: false, error: 'Current password is incorrect.' };
    }
    const complexity = validatePasswordComplexity(next, verified.role);
    if (!complexity.ok) return complexity;
    if (timingSafeEqualString(current, next)) {
        return { ok: false, error: 'Choose a new password different from your current one.' };
    }
    const blocks = parseUsersFileBlocks(readUsersFileText());
    const block = blocks.find((row) => blockMatchesUsername(row, name));
    if (!block) {
        return { ok: false, error: 'Account not found.' };
    }
    block.password = hashPassword(next);
    writeUsersFileText(serializeUsersFile(blocks));
    appendAccountAudit({ action: 'change-password', username: name });
    return { ok: true };
}

/** First login - replace a temporary plaintext password with a hashed one. */
function completePasswordSetup(username, currentPassword, newPassword) {
    const name = String(username || '').trim();
    const current = String(currentPassword || '');
    const next = String(newPassword || '');
    if (!name || !current || !next) {
        return { ok: false, error: 'Current and new password are required.' };
    }
    if (!userNeedsPasswordChange(name)) {
        return { ok: false, error: 'Your password is already set. Sign in normally or use Change password in settings.' };
    }
    const verified = authenticate(name, current);
    if (!verified) {
        return { ok: false, error: 'Current password is incorrect.' };
    }
    const complexity = validatePasswordComplexity(next, verified.role);
    if (!complexity.ok) return complexity;
    const blocks = parseUsersFileBlocks(readUsersFileText());
    const block = blocks.find((row) => blockMatchesUsername(row, name));
    if (!block) {
        return { ok: false, error: 'Account not found.' };
    }
    block.password = hashPassword(next);
    writeUsersFileText(serializeUsersFile(blocks));
    appendAccountAudit({ action: 'complete-password-setup', username: name });
    return { ok: true, user: { ...verified, passwordChangeRequired: false } };
}

function setAccountColourBlindPreference(username, enabled) {
    const name = String(username || '').trim();
    if (!name) {
        return { ok: false, error: 'Not signed in.' };
    }
    const blocks = parseUsersFileBlocks(readUsersFileText());
    const block = blocks.find((row) => blockMatchesUsername(row, name));
    if (!block) {
        return { ok: false, error: 'Account not found.' };
    }
    block.colourBlindPref = Boolean(enabled);
    writeUsersFileText(serializeUsersFile(blocks));
    appendAccountAudit({
        action: 'colour-blind-pref',
        username: block.username,
        enabled: block.colourBlindPref,
        setBy: name,
    });
    const colorBlind =
        block.colourBlindPref || (block.cbUsername && usernameMatches(block.cbUsername, name));
    return { ok: true, colorBlind: Boolean(colorBlind) };
}

function setAccountMicDarkModePreference(username, enabled) {
    const name = String(username || '').trim();
    if (!name) {
        return { ok: false, error: 'Not signed in.' };
    }
    const blocks = parseUsersFileBlocks(readUsersFileText());
    const block = blocks.find((row) => blockMatchesUsername(row, name));
    if (!block) {
        return { ok: false, error: 'Account not found.' };
    }
    block.micDarkModePref = Boolean(enabled);
    writeUsersFileText(serializeUsersFile(blocks));
    appendAccountAudit({
        action: 'mic-dark-mode-pref',
        username: block.username,
        enabled: block.micDarkModePref,
        setBy: name,
    });
    return { ok: true, micDarkMode: Boolean(block.micDarkModePref) };
}

function setAccountAuditAutoCollapsePreference(username, enabled) {
    const name = String(username || '').trim();
    if (!name) {
        return { ok: false, error: 'Not signed in.' };
    }
    const blocks = parseUsersFileBlocks(readUsersFileText());
    const block = blocks.find((row) => blockMatchesUsername(row, name));
    if (!block) {
        return { ok: false, error: 'Account not found.' };
    }
    block.auditAutoCollapsePref = Boolean(enabled);
    writeUsersFileText(serializeUsersFile(blocks));
    appendAccountAudit({
        action: 'audit-auto-collapse-pref',
        username: block.username,
        enabled: block.auditAutoCollapsePref,
        setBy: name,
    });
    return { ok: true, auditAutoCollapse: Boolean(block.auditAutoCollapsePref) };
}

function setAccountMicRoundedTilesPreference(username, enabled) {
    const name = String(username || '').trim();
    if (!name) {
        return { ok: false, error: 'Not signed in.' };
    }
    const blocks = parseUsersFileBlocks(readUsersFileText());
    const block = blocks.find((row) => blockMatchesUsername(row, name));
    if (!block) {
        return { ok: false, error: 'Account not found.' };
    }
    block.micRoundedTilesPref = enabled !== false;
    writeUsersFileText(serializeUsersFile(blocks));
    appendAccountAudit({
        action: 'mic-rounded-tiles-pref',
        username: block.username,
        enabled: block.micRoundedTilesPref,
        setBy: name,
    });
    return { ok: true, micRoundedTiles: block.micRoundedTilesPref !== false };
}

function appendDashboardUser({
    username,
    password,
    displayName,
    createdBy,
    accountLevel,
    accessScope,
    addCbAlias = false,
    passwordIsTemporary = false,
}) {
    const name = String(username || '').trim();
    const pass = String(password || '');
    const creator = String(createdBy || '').trim();
    const level = normalizeAccountLevel(accountLevel);
    const access = accessScope && typeof accessScope === 'object' ? accessScope : null;
    if (!name || !pass) {
        return { ok: false, error: 'Username and password are required.' };
    }
    if (!access) {
        return { ok: false, error: 'Account access scope is required.' };
    }
    if (!level) {
        return { ok: false, error: 'Account level is required.' };
    }
    if (pass.length < 8) {
        return { ok: false, error: 'Password must be at least 8 characters.' };
    }
    const complexity = validatePasswordComplexity(pass, level === 'it' ? 'admin' : 'store');
    if (!complexity.ok) return complexity;
    if (/^CB/i.test(name) && isCbUsername(name)) {
        return { ok: false, error: 'Create the main username; a colour-blind alias is added automatically when applicable.' };
    }
    if (usernameExists(name)) {
        return { ok: false, error: 'That username is already in use.' };
    }

    const storeList =
        access.stores === '*'
            ? '*'
            : [...new Set((access.stores || []).map(String))].filter(Boolean);
    if (access.type === 'store' && storeList !== '*' && !storeList.length) {
        return { ok: false, error: 'Store accounts cannot be created without store access.' };
    }
    if (access.type === 'market' && !access.markets?.length) {
        return { ok: false, error: 'Market accounts require a market.' };
    }
    if (access.type === 'area' && !access.areas?.length) {
        return { ok: false, error: 'Area accounts require an area.' };
    }

    let cbUsername = '';
    if (addCbAlias && access.type === 'store' && storeList !== '*' && storeList.length === 1) {
        cbUsername = `CB${storeList[0]}`;
        if (usernameExists(cbUsername) && !usernameMatches(cbUsername, name)) {
            cbUsername = '';
        }
    }

    const block = {
        displayName: String(displayName || name).trim(),
        username: name,
        cbUsername,
        password: passwordIsTemporary ? pass : hashPassword(pass),
        role: access.role,
        accessType: access.type,
        stores: storeList === '*' ? '*' : storeList,
        markets: access.markets || [],
        areas: access.areas || [],
        accountLevel: level,
    };
    const addition = serializeUserBlock(block);
    const roleFolder = roleFolderForBlock(block);
    const existing = readRoleAccountsFileText(roleFolder);
    const nextText =
        access.type === 'store' && storeList !== '*' && storeList.length === 1
            ? insertUserBlockInStoreSection(existing, storeList[0], addition)
            : (() => {
                  const trimmed = existing.trimEnd();
                  const joined = trimmed ? `${trimmed}\n\n${addition}` : addition;
                  return joined.endsWith('\n') ? joined : `${joined}\n`;
              })();
    writeRoleAccountsFileText(roleFolder, nextText);
    appendAccountAudit({
        action: 'create-account',
        username: name,
        createdBy: creator,
        accountLevel: level,
        accessType: access.type,
        stores: storeList === '*' ? '*' : storeList,
        markets: access.markets || [],
        areas: access.areas || [],
        temporaryPassword: Boolean(passwordIsTemporary),
    });
    return {
        ok: true,
        username: name,
        cbUsername: cbUsername || null,
        accountLevel: level,
        stores: storeList === '*' ? '*' : storeList,
        temporaryPassword: Boolean(passwordIsTemporary),
    };
}

function appendStoreUser({ username, password, stores, displayName, createdBy, addCbAlias = false, accountLevel = 'manager' }) {
    const storeList = stores === '*' ? '*' : [...new Set((stores || []).map(String))].filter(Boolean);
    if (storeList !== '*' && !storeList.length) {
        return { ok: false, error: 'Store accounts cannot be created without store access.' };
    }
    const access = parseAccessScope(storeList === '*' ? '*' : storeList.join(', '));
    if (!access) {
        return { ok: false, error: 'Invalid store access.' };
    }
    return appendDashboardUser({
        username,
        password,
        displayName,
        createdBy,
        accountLevel,
        accessScope: access,
        addCbAlias,
    });
}

function resolveUsersFilePath() {
    return USERS_PATH;
}

function readUsersFileSync() {
    try {
        const files = listAccountFilePaths();
        if (!files.length) return [];
        const mtime = getAccountsAggregateMtime();
        const cacheKey = files.join('|');
        if (usersCache && cacheKey === usersCachePath && mtime === usersCacheMtime) {
            return usersCache;
        }
        const parsed = parseUsersFile(readUsersFileText());
        usersCache = parsed;
        usersCacheMtime = mtime;
        usersCachePath = cacheKey;
        return parsed;
    } catch {
        return [];
    }
}

function usersFileConfigured() {
    try {
        return readUsersFileSync().length > 0;
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
        const user = normalizeUser(row);
        user.passwordChangeRequired = storedPasswordMustChange(row.password);
        return user;
    }
    return null;
}

function areaNameFromStoreEntry(store) {
    const area = String(store?.area || '').trim();
    return area || 'Area 22';
}

function normalizeUser(row) {
    const stores = row.stores === '*' ? '*' : [...new Set((row.stores || []).map(String))];
    const accessType =
        row.accessType ||
        (row.role === 'admin' || stores === '*' ? 'super' : row.role === 'market' ? 'market' : row.role === 'area' ? 'area' : 'store');
    return {
        username: row.username,
        displayName: row.displayName || '',
        role: row.role === 'admin' ? 'admin' : row.role || 'store',
        accessType,
        stores,
        markets: [...new Set((row.markets || []).map(normalizeMarketLabel))],
        areas: [...new Set((row.areas || []).map(normalizeAreaLabel))],
        colorBlind: Boolean(row.colorBlind),
        micDarkMode: Boolean(row.micDarkMode),
        auditAutoCollapse: row.auditAutoCollapse !== false,
        micRoundedTiles: row.micRoundedTiles !== false,
        accountLevel: inferAccountLevel(row),
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

// Without a configured secret, sign tokens with a persistent file-backed key
// (or a one-time random key if the file cannot be written). Set
// DASHBOARD_AUTH_SECRET in .env so sessions survive deploys across machines.
function readPersistedAuthSecret() {
    try {
        if (!fs.existsSync(PERSISTED_AUTH_SECRET_FILE)) return '';
        return String(fs.readFileSync(PERSISTED_AUTH_SECRET_FILE, 'utf8')).trim();
    } catch {
        return '';
    }
}

function writePersistedAuthSecret(secret) {
    try {
        fs.mkdirSync(paths.users.data, { recursive: true });
        fs.writeFileSync(PERSISTED_AUTH_SECRET_FILE, secret, { encoding: 'utf8', mode: 0o600 });
        return true;
    } catch (err) {
        console.warn('[auth] Could not persist session secret:', err.message);
        return false;
    }
}

let ephemeralAuthSecret = null;
function authSecret() {
    const configured = String(process.env.DASHBOARD_AUTH_SECRET || process.env.DASHBOARD_ACCESS_KEY || '').trim();
    if (configured) return configured;

    const persisted = readPersistedAuthSecret();
    if (persisted) return persisted;

    if (!ephemeralAuthSecret) {
        ephemeralAuthSecret = crypto.randomBytes(32).toString('hex');
        if (writePersistedAuthSecret(ephemeralAuthSecret)) {
            console.warn(
                '[auth] DASHBOARD_AUTH_SECRET not set; created a persistent session secret on disk. Set DASHBOARD_AUTH_SECRET in .env for explicit control.'
            );
        } else {
            console.warn(
                '[auth] DASHBOARD_AUTH_SECRET not set and secret file could not be written; sessions will reset on every process restart.'
            );
        }
    }
    return ephemeralAuthSecret;
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
    if (!payload?.u) return null;
    const accessType =
        payload.at ||
        (payload.r === 'admin' ? 'super' : payload.r === 'market' ? 'market' : payload.r === 'area' ? 'area' : 'store');
    const role =
        accessType === 'super'
            ? 'admin'
            : accessType === 'market'
              ? 'market'
              : accessType === 'area'
                ? 'area'
                : 'store';
    const stores = payload.s === '*' ? '*' : String(payload.s || '').split(',').filter(Boolean);
    const markets = payload.mk ? String(payload.mk).split('|').filter(Boolean).map(normalizeMarketLabel) : [];
    const areas = payload.ar ? String(payload.ar).split('|').filter(Boolean).map(normalizeAreaLabel) : [];
    if (accessType === 'store' && stores !== '*' && !stores.length) return null;
    if (accessType === 'market' && !markets.length) return null;
    if (accessType === 'area' && !areas.length) return null;
    return {
        username: payload.u,
        role,
        accessType,
        stores,
        markets,
        areas,
        displayName: String(payload.d || '').trim(),
        colorBlind: payload.c === 1,
        micDarkMode: payload.m === 1,
        auditAutoCollapse: payload.ac !== 0,
        micRoundedTiles: payload.rt !== 0,
    };
}

function createSessionToken(user) {
    const accessType = getUserAccessScope(user).type;
    const stores = user.stores === '*' ? '*' : (user.stores || []).join(',');
    return signSessionPayload({
        u: user.username,
        d: user.displayName || lookupDisplayName(user.username) || '',
        r: user.role,
        at: accessType,
        s: stores,
        mk: (user.markets || []).join('|'),
        ar: (user.areas || []).join('|'),
        c: user.colorBlind ? 1 : 0,
        m: user.micDarkMode ? 1 : 0,
        ac: user.auditAutoCollapse === false ? 0 : 1,
        rt: user.micRoundedTiles === false ? 0 : 1,
        exp: Date.now() + SESSION_MAX_AGE_MS,
    });
}

function nologinEnabled() {
    return /^(1|true|yes|on)$/i.test(String(process.env.DASHBOARD_NOLOGIN_ENABLED ?? '').trim());
}

function nologinAllowedStoreNumbers() {
    const raw = String(process.env.DASHBOARD_NOLOGIN_STORES ?? '*').trim();
    if (!raw || raw === '*' || /^all$/i.test(raw)) return null;
    return raw
        .split(/[,;\s]+/)
        .map((s) => normalizeStoreKey(s))
        .filter(Boolean);
}

function isNologinStoreAllowed(storeNumber) {
    if (!nologinEnabled()) return false;
    const num = normalizeStoreKey(storeNumber);
    if (!num) return false;
    const allowlist = nologinAllowedStoreNumbers();
    if (allowlist && !allowlist.includes(num)) return false;
    return true;
}

function nologinSecretRequired() {
    return String(process.env.DASHBOARD_NOLOGIN_SECRET || '').trim();
}

function verifyNologinSecret(provided) {
    const expected = nologinSecretRequired();
    if (!expected) return true;
    return timingSafeEqualString(String(provided || '').trim(), expected);
}

function createNologinToken(storeNumber, displayName = '') {
    return signSessionPayload({
        u: '__nologin__',
        d: String(displayName || '').trim(),
        r: 'store',
        s: String(storeNumber),
        c: 0,
        exp: Date.now() + NOLOGIN_MAX_AGE_MS,
    });
}

function parseNologinSession(token) {
    const user = parseSessionToken(token);
    if (!user || user.username !== '__nologin__') return null;
    if (user.role !== 'store' || user.stores === '*' || user.stores.length !== 1) return null;
    return user;
}

function isNologinUser(user) {
    return Boolean(user && user.username === '__nologin__');
}

function nologinSameSiteMode() {
    const raw = String(process.env.DASHBOARD_NOLOGIN_SAMESITE ?? 'none').trim().toLowerCase();
    if (raw === 'strict' || raw === 'lax' || raw === 'none') return raw;
    return 'none';
}

function nologinCookieOptions() {
    const sameSite = nologinSameSiteMode();
    const secureCookie =
        sameSite === 'none' ||
        /^(1|true|yes|on)$/i.test(String(process.env.DASHBOARD_SECURE_COOKIE ?? '').trim());
    return {
        httpOnly: true,
        sameSite,
        secure: secureCookie,
        maxAge: NOLOGIN_MAX_AGE_MS,
        path: '/',
    };
}

function resolveNologinToken(token) {
    const user = parseNologinSession(String(token || '').trim());
    if (!user || !isNologinStoreAllowed(user.stores[0])) return null;
    return user;
}

function legacyAccessToken(accessKey) {
    return crypto.createHmac('sha256', authSecret()).update(`dashboard:${accessKey}`).digest('hex');
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

    const nologin = resolveNologinToken(cookies[NOLOGIN_COOKIE]);
    if (nologin) return nologin;

    const kioskQuery = String(req.query?.kiosk || '').trim();
    if (kioskQuery) {
        const kioskUser = resolveNologinToken(kioskQuery);
        if (kioskUser) return kioskUser;
    }

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

function isSuperAdminUser(user) {
    return Boolean(user && (user.accessType === 'super' || user.stores === '*' || user.role === 'admin'));
}

/** Break-glass full access (`*` in `.Users`). */
function isAdminUser(user) {
    return isSuperAdminUser(user);
}

function getUserAccessScope(user) {
    if (!user) {
        return { type: 'store', markets: [], areas: [], stores: [] };
    }
    if (isSuperAdminUser(user)) {
        return { type: 'super', markets: [], areas: [], stores: '*' };
    }
    const type =
        user.accessType ||
        (user.role === 'market' ? 'market' : user.role === 'area' ? 'area' : 'store');
    return {
        type,
        markets: [...new Set((user.markets || []).map(normalizeMarketLabel))],
        areas: [...new Set((user.areas || []).map(normalizeAreaLabel))],
        stores:
            user.stores === '*'
                ? []
                : [
                      ...new Set(
                          (Array.isArray(user.stores)
                              ? user.stores
                              : user.stores != null && user.stores !== ''
                                ? [user.stores]
                                : []
                          ).map(String)
                      ),
                  ],
    };
}

function getAccessibleAreasForUser(user) {
    if (!user) return [];
    if (isSuperAdminUser(user)) {
        return [...new Set(getAllMarketLabels().flatMap((market) => getAreasForMarket(market)))];
    }
    const scope = getUserAccessScope(user);
    if (scope.type === 'market') {
        const areas = [];
        for (const market of scope.markets) {
            areas.push(...getAreasForMarket(market));
        }
        return [...new Set(areas.map(normalizeAreaLabel))];
    }
    if (scope.type === 'area') {
        return Array.isArray(scope.areas) ? scope.areas.map(normalizeAreaLabel) : [];
    }
    const storeNums = new Set(
        scope.type === 'store'
            ? (Array.isArray(scope.stores) ? scope.stores : []).map(String)
            : getEffectiveStoresForUser(user).map(String)
    );
    return [
        ...new Set(
            getStoreList()
                .filter((s) => storeNums.has(String(s.storeNumber)))
                .map(areaNameFromStoreEntry)
        ),
    ];
}

function getEffectiveStoresForUser(user) {
    if (!user) return [];
    if (isSuperAdminUser(user)) {
        return getStoreList().map((s) => String(s.storeNumber));
    }
    const scope = getUserAccessScope(user);
    if (scope.type === 'store') {
        return Array.isArray(scope.stores) ? scope.stores.map(String) : [];
    }
    if (scope.type === 'area') {
        const allowedAreas = new Set(
            (Array.isArray(scope.areas) ? scope.areas : []).map(normalizeAreaLabel)
        );
        if (!allowedAreas.size) return [];
        return getStoreList()
            .filter((s) => allowedAreas.has(areaNameFromStoreEntry(s)))
            .map((s) => String(s.storeNumber));
    }
    if (scope.type === 'market') {
        const allowedAreas = new Set();
        for (const market of scope.markets || []) {
            for (const area of getAreasForMarket(market)) {
                allowedAreas.add(normalizeAreaLabel(area));
            }
        }
        if (!allowedAreas.size) return [];
        return getStoreList()
            .filter((s) => allowedAreas.has(areaNameFromStoreEntry(s)))
            .map((s) => String(s.storeNumber));
    }
    return Array.isArray(scope.stores) ? scope.stores.map(String) : [];
}

function userCanAccessMarket(user, marketLabel) {
    if (!user) return false;
    if (isSuperAdminUser(user)) return true;
    const scope = getUserAccessScope(user);
    if (scope.type !== 'market') return false;
    const label = normalizeMarketLabel(marketLabel);
    return scope.markets.includes(label);
}

function userCanAccessArea(user, areaName) {
    if (!user) return false;
    if (isSuperAdminUser(user)) return true;
    const label = normalizeAreaLabel(areaName);
    return getAccessibleAreasForUser(user).includes(label);
}

function hasMultiStoreScope(user) {
    if (!user || isSuperAdminUser(user)) return true;
    const scope = getUserAccessScope(user);
    return scope.type === 'market' || scope.type === 'area';
}

function getOverviewScope(user) {
    if (!user) return 'store';
    if (isSuperAdminUser(user)) return 'super';
    const scope = getUserAccessScope(user);
    if (scope.type === 'market') return 'market';
    if (scope.type === 'area') return 'area';
    return 'store';
}

function canViewCrossStoreAccounts(user) {
    if (!user) return false;
    return isSuperAdminUser(user) || hasMultiStoreScope(user);
}

function userCanAccessStore(user, storeNumber) {
    if (!user) return false;
    if (isTestStore(storeNumber)) {
        if (isSuperAdminUser(user)) return true;
        return false;
    }
    if (isSuperAdminUser(user)) return true;
    const num = normalizeStoreKey(storeNumber);
    if (!num) return false;
    return getEffectiveStoresForUser(user).includes(num);
}

function filterStoresForUser(user, stores) {
    if (!user || isSuperAdminUser(user)) return stores;
    const allowed = new Set((getEffectiveStoresForUser(user) || []).map(String));
    return stores.filter((s) => allowed.has(String(s.storeNumber)));
}

function storeNumberFromCbUsername(username) {
    const match = String(username || '').trim().match(/^CB(\d{3,6})$/i);
    return match ? match[1] : '';
}

function storeNumberFromUsername(username) {
    const name = String(username || '').trim();
    if (/^\d{3,6}$/.test(name)) return name;
    return storeNumberFromCbUsername(name);
}

/** Single-store destination for store logins (3811, CB3811, etc.). Empty when picker applies. */
function singleStoreForUser(user) {
    if (!user || isSuperAdminUser(user) || hasMultiStoreScope(user)) return '';
    const stores = getEffectiveStoresForUser(user);
    if (stores.length === 1) return stores[0];
    const fromUsername = storeNumberFromUsername(user.username);
    if (fromUsername && stores.includes(fromUsername)) return fromUsername;
    return '';
}

function getAdminRedirectPath() {
    return getMicOverviewPath();
}

function getMicOverviewPath() {
    return '/overview';
}

function getOverviewPath() {
    return getMicOverviewPath();
}

function getMicStorePath(storeNumber) {
    const slug = String(storeNumber || '').trim().toLowerCase();
    if (slug === 'teststore') return '/MIC/teststore';
    const num = String(storeNumber || '').replace(/[^0-9]/g, '');
    return num ? `/MIC/${num}` : getMicOverviewPath();
}

function getAdminAreaPath(areaCodeOrName) {
    const { getAdminAreaPath: areaPath } = require('../../../stores/src/areasConfig');
    return areaPath(areaCodeOrName);
}

function getKioskRedirectPath(user) {
    if (!user) return '/kiosk';
    if (isAdminUser(user)) return '/admin';
    const store = singleStoreForUser(user);
    if (store) return `/kiosk/${store}`;
    return '/kiosk';
}

function getLoginRedirectPath(user, mode = 'mic') {
    if (!user) return '/login';
    if (isSuperAdminUser(user) || hasMultiStoreScope(user)) return getMicOverviewPath();
    const store = singleStoreForUser(user);
    if (store) return getMicOverviewPath();
    // Authenticated crew accounts always land on overview (store picker when needed).
    if (isRealDashboardUser(user)) return getMicOverviewPath();
    return '/login';
}

function sessionCookieOptions(options = {}) {
    const secureCookie = /^(1|true|yes|on)$/i.test(String(process.env.DASHBOARD_SECURE_COOKIE ?? '').trim());
    return {
        httpOnly: true,
        sameSite: 'strict',
        secure: secureCookie,
        path: '/',
        maxAge: SESSION_MAX_AGE_MS,
    };
}

/** res.clearCookie options - same path/domain/flags as set, without maxAge (Express 5 deprecates maxAge on clear). */
function cookieClearOptions(setOptions) {
    if (!setOptions || typeof setOptions !== 'object') return { path: '/' };
    const { maxAge, expires, ...rest } = setOptions;
    return rest;
}

function sessionCookieClearOptions(options = {}) {
    return cookieClearOptions(sessionCookieOptions(options));
}

function nologinCookieClearOptions() {
    return cookieClearOptions(nologinCookieOptions());
}

function layoutCapabilitiesForClient(user, overviewScope) {
    if (isNologinUser(user)) {
        return {
            showBackNav: false,
            showSettings: false,
            showScopeNav: false,
            overviewMode: 'store',
        };
    }
    return {
        showBackNav: true,
        showSettings: true,
        showScopeNav: overviewScope !== 'store',
        overviewMode: overviewScope,
    };
}

function tileVisibilityForClient(user, overviewScope) {
    return {
        dfsc: canUserAccessDfsc(user),
        areaStoresLeaderboard: overviewScope !== 'store',
        storeSales: true,
        auditAction: canUserStartAudits(user) ? 'Start' : 'View',
        featureRequests: canUserViewFeatureRequests(user),
    };
}

function userProfileForClient(user) {
    if (isNologinUser(user)) {
        const stores =
            user.stores === '*'
                ? []
                : (Array.isArray(user.stores) ? user.stores : user.stores != null ? [user.stores] : []).map(
                      String
                  );
        const store = stores[0] || '';
        const displayName = String(user.displayName || '').trim();
        return {
            username: '',
            displayName,
            welcomeName: displayName || (store ? `Store ${store}` : ''),
            role: 'store',
            stores,
            skipStorePicker: true,
            defaultPath: store ? getMicStorePath(store) : '/',
            micPath: store ? getMicOverviewPath() : null,
            canCreateAccount: false,
            canViewManagedAccounts: false,
            colorBlind: false,
            micDarkMode: false,
            auditAutoCollapse: true,
            micRoundedTiles: true,
            nologin: true,
            layoutCapabilities: layoutCapabilitiesForClient(user, 'store'),
            tileVisibility: tileVisibilityForClient(user, 'store'),
        };
    }
    if (!user || user.username.startsWith('__')) {
        const legacyScope = 'super';
        return {
            username: '',
            displayName: '',
            welcomeName: '',
            role: 'admin',
            stores: '*',
            skipStorePicker: false,
            defaultPath: getMicOverviewPath(),
            micPath: getMicOverviewPath(),
            canCreateAccount: false,
            canViewManagedAccounts: true,
            colorBlind: false,
            micDarkMode: false,
            auditAutoCollapse: true,
            micRoundedTiles: true,
            layoutCapabilities: layoutCapabilitiesForClient(user, legacyScope),
            tileVisibility: tileVisibilityForClient(user, legacyScope),
        };
    }
    const overviewScope = getOverviewScope(user);
    const effectiveStores = getEffectiveStoresForUser(user);
    const stores = user.stores === '*' ? '*' : [...effectiveStores];
    const skipStorePicker = Boolean(singleStoreForUser(user));
    const displayName = String(user.displayName || lookupDisplayName(user.username) || '').trim();
    const welcomeName = lookupWelcomeName(user.username) || displayName || user.username;
    const store = singleStoreForUser(user);
    const mustCompleteMmxSetup = isRealDashboardUser(user) && userNeedsMmxSetup(user.username);
    const mustChangePassword = isRealDashboardUser(user) && userNeedsPasswordChange(user.username);
    const accessibleAreas = getAccessibleAreasForUser(user);
    const scope = getUserAccessScope(user);
    const accessibleMarkets = isSuperAdminUser(user)
        ? getAllMarketLabels()
        : Array.isArray(scope.markets)
          ? scope.markets
          : [];
    const setupPath = getAccountSetupRedirectPath(user);
    return {
        username: user.username,
        displayName,
        welcomeName,
        role: user.role,
        overviewScope,
        accessibleAreas: Array.isArray(accessibleAreas) ? accessibleAreas : [],
        accessibleMarkets,
        effectiveStores: Array.isArray(effectiveStores) ? effectiveStores : [],
        stores,
        skipStorePicker,
        defaultPath: setupPath || getMicOverviewPath(),
        micPath: getMicOverviewPath(),
        isSuperAdmin: isSuperAdminUser(user),
        canCreateAccount: canUserCreateAccounts(user),
        canViewManagedAccounts: canUserCreateAccounts(user) || canViewCrossStoreAccounts(user),
        canViewCrossStoreAccounts: canViewCrossStoreAccounts(user),
        canAccessAdminMenu: canUserAccessAdminMenu(user),
        canViewFeatureRequests: canUserViewFeatureRequests(user),
        canManageStoreLogins: canUserManageStoreLogins(user),
        canManageSmgNsfSettings: canUserManageSmgNsfSettings(user),
        canEditGlobalBuildTo: canUserEditGlobalBuildTo(user),
        canAccessDfsc: canUserAccessDfsc(user),
        accountLevel: getAccountLevel(user),
        canCompleteAudits: canUserCompleteAudits(user),
        canStartAudits: canUserStartAudits(user),
        conductorFullName: getDfscConductorName(user),
        colorBlind: Boolean(user.colorBlind),
        micDarkMode: Boolean(user.micDarkMode),
        auditAutoCollapse: user.auditAutoCollapse !== false,
        mustCompleteMmxSetup,
        micRoundedTiles: user.micRoundedTiles !== false,
        mustChangePassword,
        passwordPolicy: mustChangePassword ? passwordPolicyForUser(user) : null,
        layoutCapabilities: layoutCapabilitiesForClient(user, overviewScope),
        tileVisibility: tileVisibilityForClient(user, overviewScope),
    };
}

function normalizeScopeTreeForClient(tree) {
    if (!tree || typeof tree !== 'object') {
        return { areas: [], storesByArea: {}, defaults: {} };
    }
    const storesByArea = {};
    if (tree.storesByArea && typeof tree.storesByArea === 'object') {
        for (const [area, stores] of Object.entries(tree.storesByArea)) {
            storesByArea[area] = Array.isArray(stores) ? stores : [];
        }
    }
    const { getAreaIds: loadAreaIds } = require('../../../stores/src/areasConfig');
    const areas = loadAreaIds().filter((area) => storesByArea[area]?.length);
    const defaults = tree.defaults && typeof tree.defaults === 'object' ? { ...tree.defaults } : {};
    delete defaults.market;
    return {
        areas,
        storesByArea,
        defaults,
    };
}

function getStoreScopeTreeForUser(user) {
    if (!user) return null;
    if (!hasMultiStoreScope(user) && !canUserManageStoreLogins(user) && !canUserAccessAdminMenu(user)) return null;
    try {
        return normalizeScopeTreeForClient(buildCreateAccountScopeTree(user));
    } catch (err) {
        console.error('[Auth] buildCreateAccountScopeTree failed:', err);
        return normalizeScopeTreeForClient(null);
    }
}

module.exports = {
    SESSION_COOKIE,
    LEGACY_COOKIE,
    NOLOGIN_COOKIE,
    SESSION_MAX_AGE_MS,
    NOLOGIN_MAX_AGE_MS,
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
    isAuthenticated,
    isAdminUser,
    isSuperAdminUser,
    getUserAccessScope,
    getEffectiveStoresForUser,
    getAccessibleAreasForUser,
    userCanAccessArea,
    userCanAccessMarket,
    hasMultiStoreScope,
    getOverviewScope,
    canViewCrossStoreAccounts,
    parseAccessScope,
    isNologinUser,
    isNologinStoreAllowed,
    verifyNologinSecret,
    nologinCookieOptions,
    nologinCookieClearOptions,
    cookieClearOptions,
    resolveNologinToken,
    userCanAccessStore,
    filterStoresForUser,
    getLoginRedirectPath,
    getAdminRedirectPath,
    getKioskRedirectPath,
    getMicOverviewPath,
    getOverviewPath,
    getMicStorePath,
    getAdminAreaPath,
    singleStoreForUser,
    sessionCookieOptions,
    sessionCookieClearOptions,
    userProfileForClient,
    getStoreScopeTreeForUser,
    timingSafeEqualString,
    invalidateUsersCache,
    isStorePatternUsername,
    usernameExists,
    changeUserPassword,
    completePasswordSetup,
    validatePasswordComplexity,
    passwordPolicyForUser,
    userNeedsPasswordChange,
    userNeedsMmxSetup,
    getAccountSetupRedirectPath,
    generateTemporaryPassword,
    isPasswordHashed,
    setAccountColourBlindPreference,
    setAccountMicDarkModePreference,
    setAccountAuditAutoCollapsePreference,
    setAccountMicRoundedTilesPreference,
    appendStoreUser,
    appendDashboardUser,
    buildCreateAccountParentFromUser,
    getCreateAccountOptions,
    validateCreateAccountPayload,
    getAssignableAccountLevels,
    canActorAssignAccountLevel,
    requiresMmxForAccountLevel,
    canUserCreateAccounts,
    canUserAccessAdminMenu,
    canUserViewFeatureRequests,
    canUserManageStoreLogins,
    canUserManageSmgNsfSettings,
    canUserEditGlobalBuildTo,
    appendAuthEvent,
    readAuthEventsForUser,
    appendAccountAudit,
    canUserManageStoreAccounts,
    findPrimaryStoreDashboardUsername,
    listStoreMacromatixDashboardUsers,
    listManagedStoreAccounts,
    updateManagedStoreAccount,
    listLoginHistoryForStore,
    deleteManagedStoreAccount,
    isRealDashboardUser,
    isPrimaryStoreLogin,
    canUserAccessDfsc,
    getAccountLevel,
    lookupAccountLevelByUsername,
    accountLevelRank,
    isAccountLevelAbove,
    canUserCompleteAudits,
    canUserStartAudits,
    canAccessCoachAudits,
    normalizeAccountLevel,
    getDfscConductorName,
    lookupWelcomeName,
    isSyntheticUser,
    parseUsersFileBlocks,
    serializeUsersFile,
    inferAccountLevel,
    normalizeUser,
    parseCookies,
    usernameMatches,
    authSecret,
};
