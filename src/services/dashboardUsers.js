const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readUserAccountSecrets } = require('./mmxUserCredentials');
const { isTestStore, normalizeStoreKey, TEST_STORE_SLUG } = require('./testStore');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const USERS_PATH = path.join(PROJECT_ROOT, '.Users');
const ACCOUNT_AUDIT_LOG = path.join(PROJECT_ROOT, 'data', 'account-audit.log');

const SESSION_COOKIE = 'dashboard_session';
const LEGACY_COOKIE = 'dashboard_access';
const NOLOGIN_COOKIE = 'dashboard_nologin';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Long-lived cookie for direct /nologin/{store} kiosk links. */
const NOLOGIN_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
/** Browser-session cookie when “Stay signed in” is unchecked (Express: omit maxAge). */

const FIELD_LABELS = {
    username: ['username', 'user'],
    password: ['password', 'pass'],
    access: ['access', 'stores', 'store'],
    colourBlind: ['colourblind', 'colorblind', 'color blind', 'colour blind'],
    micDarkMode: ['micdarkmode', 'mic dark mode', 'darkmode', 'dark mode'],
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
    let colourBlindPref = false;
    let micDarkModePref = false;

    for (const line of lines) {
        const trimmed = line.trim();
        const lower = trimmed.toLowerCase();
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
        colourBlindPref,
        micDarkModePref,
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
            const micDarkMode = Boolean(row.micDarkModePref);
            if (row.username && !isCbUsername(row.username)) {
                users.push({ ...base, username: row.username, colorBlind: Boolean(row.colourBlindPref), micDarkMode });
            }
            if (row.cbUsername) {
                users.push({ ...base, username: row.cbUsername, colorBlind: true, micDarkMode });
            }
            if (row.username && isCbUsername(row.username)) {
                users.push({ ...base, username: row.username, colorBlind: true, micDarkMode });
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
                stores: row.stores,
                colourBlindPref: Boolean(row.colourBlindPref),
                micDarkModePref: Boolean(row.micDarkModePref),
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
        if (trimmed.startsWith('#')) {
            flushBlock();
            blockName = trimmed.replace(/^#\s*/, '').trim();
            continue;
        }
        block.push(rawLine);
    }
    flushBlock();
    return blocks;
}

function formatAccessRaw(stores) {
    if (stores === '*') return '*';
    return [...new Set(stores.map(String))].join(', ');
}

function serializeUserBlock(block) {
    const out = [];
    if (block.displayName) out.push(`# ${block.displayName}`);
    out.push(`${block.username} |`);
    if (block.cbUsername) out.push(`${block.cbUsername} |`);
    out.push(`${block.password} |`);
    out.push(`${formatAccessRaw(block.stores)} |`);
    if (block.colourBlindPref) out.push('colourblind | on');
    if (block.micDarkModePref) out.push('micdarkmode | on');
    out.push('');
    return out.join('\n');
}

function serializeUsersFile(blocks) {
    return blocks.map(serializeUserBlock).join('\n').trimEnd() + '\n';
}

function invalidateUsersCache() {
    usersCache = null;
    usersCacheMtime = 0;
    usersCachePath = '';
}

function readUsersFileText() {
    if (!fs.existsSync(USERS_PATH)) return '';
    return fs.readFileSync(USERS_PATH, 'utf8');
}

function writeUsersFileText(text) {
    fs.mkdirSync(path.dirname(USERS_PATH), { recursive: true });
    fs.writeFileSync(USERS_PATH, String(text || '').endsWith('\n') ? text : `${text}\n`, 'utf8');
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

function isPrimaryStoreLogin(user) {
    if (!user || isAdminUser(user)) return false;
    return isStorePatternUsername(user.username);
}

/** Admins and manager-created crew accounts — not primary store logins (3811 / CB3811). */
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
    return isRealDashboardUser(user) && !isAdminUser(user);
}

function canUserManageStoreAccounts(user, storeNumber) {
    if (!user) return false;
    if (isAdminUser(user)) return userCanAccessStore(user, storeNumber);
    return canUserCreateAccounts(user) && userCanAccessStore(user, storeNumber);
}

function blockGrantsStore(block, storeNumber) {
    const store = normalizeStoreKey(storeNumber);
    if (!store || isTestStore(store)) return false;
    if (block?.stores === '*') return false;
    const list = Array.isArray(block.stores) ? block.stores.map(String) : [];
    return list.includes(store);
}

/** Crew logins created via Create account — not the primary 3811 / CB3811 store login. */
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
        .map((block) => ({
            username: String(block.username || '').trim(),
            nickname: String(block.displayName || block.username || '').trim(),
        }))
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

/** First login — replace a temporary plaintext password with a hashed one. */
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

function appendStoreUser({ username, password, stores, displayName, createdBy, addCbAlias = false }) {
    const name = String(username || '').trim();
    const pass = String(password || '');
    const creator = String(createdBy || '').trim();
    if (!name || !pass) {
        return { ok: false, error: 'Username and password are required.' };
    }
    if (pass.length < 8) {
        return { ok: false, error: 'Password must be at least 8 characters.' };
    }
    const complexity = validatePasswordComplexity(pass, 'store');
    if (!complexity.ok) return complexity;
    if (/^CB/i.test(name) && isCbUsername(name)) {
        return { ok: false, error: 'Create the main username; a colour-blind alias is added automatically when applicable.' };
    }
    if (usernameExists(name)) {
        return { ok: false, error: 'That username is already in use.' };
    }
    const storeList = stores === '*' ? null : [...new Set((stores || []).map(String))].filter(Boolean);
    if (!storeList?.length) {
        return { ok: false, error: 'Store accounts cannot be created without store access.' };
    }
    let cbUsername = '';
    if (addCbAlias && storeList.length === 1) {
        cbUsername = `CB${storeList[0]}`;
        if (usernameExists(cbUsername) && !usernameMatches(cbUsername, name)) {
            cbUsername = '';
        }
    }
    const block = {
        displayName: String(displayName || name).trim(),
        username: name,
        cbUsername,
        password: hashPassword(pass),
        role: 'store',
        stores: storeList,
    };
    const existing = readUsersFileText().trimEnd();
    const addition = serializeUserBlock(block);
    writeUsersFileText(existing ? `${existing}\n\n${addition}` : addition);
    appendAccountAudit({
        action: 'create-account',
        username: name,
        createdBy: creator,
        stores: storeList,
    });
    return { ok: true, username: name, cbUsername: cbUsername || null, stores: storeList };
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
        const user = normalizeUser(row);
        user.passwordChangeRequired = storedPasswordMustChange(row.password);
        return user;
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
        micDarkMode: Boolean(row.micDarkMode),
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
        micDarkMode: payload.m === 1,
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
        m: user.micDarkMode ? 1 : 0,
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

function isAdminUser(user) {
    return Boolean(user && (user.role === 'admin' || user.stores === '*'));
}

function userCanAccessStore(user, storeNumber) {
    if (!user) return false;
    if (isTestStore(storeNumber)) {
        if (isAdminUser(user)) return true;
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
    if (!user || isAdminUser(user)) return '';
    const stores = user.stores === '*' ? [] : Array.isArray(user.stores) ? user.stores.map(String) : [];
    if (stores.length === 1) return stores[0];
    const fromUsername = storeNumberFromUsername(user.username);
    if (fromUsername && stores.includes(fromUsername)) return fromUsername;
    if (fromUsername && stores.length === 0) return fromUsername;
    return '';
}

function getAdminRedirectPath() {
    return '/admin/overview';
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
    if (isAdminUser(user)) return getAdminRedirectPath();
    const store = singleStoreForUser(user);
    if (store) return `/${store}/mic`;
    return '/login';
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
        const stores = user.stores === '*' ? [] : user.stores.map(String);
        const store = stores[0] || '';
        const displayName = String(user.displayName || '').trim();
        return {
            username: '',
            displayName,
            welcomeName: displayName || (store ? `Store ${store}` : ''),
            role: 'store',
            stores,
            skipStorePicker: true,
            defaultPath: store ? `/${store}` : '/',
            micPath: store ? `/${store}/mic` : null,
            canCreateAccount: false,
            canViewManagedAccounts: false,
            colorBlind: false,
            micDarkMode: false,
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
            defaultPath: '/stores',
            micPath: null,
            canCreateAccount: false,
            canViewManagedAccounts: true,
            colorBlind: false,
            micDarkMode: false,
        };
    }
    const stores = user.stores === '*' ? '*' : [...user.stores];
    const skipStorePicker = Boolean(singleStoreForUser(user));
    const displayName = String(user.displayName || lookupDisplayName(user.username) || '').trim();
    const welcomeName = lookupWelcomeName(user.username) || displayName || user.username;
    const store = singleStoreForUser(user);
    const mustChangePassword = isRealDashboardUser(user) && userNeedsPasswordChange(user.username);
    return {
        username: user.username,
        displayName,
        welcomeName,
        role: user.role,
        stores,
        skipStorePicker,
        defaultPath: mustChangePassword
            ? '/change-password'
            : isAdminUser(user)
              ? getAdminRedirectPath()
              : getLoginRedirectPath(user, 'mic'),
        micPath: store ? `/${store}/mic` : null,
        canCreateAccount: canUserCreateAccounts(user),
        canViewManagedAccounts: canUserCreateAccounts(user),
        canAccessDfsc: canUserAccessDfsc(user),
        conductorFullName: getDfscConductorName(user),
        colorBlind: Boolean(user.colorBlind),
        micDarkMode: Boolean(user.micDarkMode),
        mustChangePassword,
        passwordPolicy: mustChangePassword ? passwordPolicyForUser(user) : null,
    };
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
    isNologinUser,
    isNologinStoreAllowed,
    verifyNologinSecret,
    nologinCookieOptions,
    resolveNologinToken,
    userCanAccessStore,
    filterStoresForUser,
    getLoginRedirectPath,
    getAdminRedirectPath,
    getKioskRedirectPath,
    singleStoreForUser,
    sessionCookieOptions,
    userProfileForClient,
    timingSafeEqualString,
    invalidateUsersCache,
    isStorePatternUsername,
    usernameExists,
    changeUserPassword,
    completePasswordSetup,
    validatePasswordComplexity,
    passwordPolicyForUser,
    userNeedsPasswordChange,
    isPasswordHashed,
    setAccountColourBlindPreference,
    setAccountMicDarkModePreference,
    appendStoreUser,
    canUserCreateAccounts,
    canUserManageStoreAccounts,
    findPrimaryStoreDashboardUsername,
    listStoreMacromatixDashboardUsers,
    listManagedStoreAccounts,
    deleteManagedStoreAccount,
    isRealDashboardUser,
    isPrimaryStoreLogin,
    canUserAccessDfsc,
    getDfscConductorName,
    lookupWelcomeName,
    isSyntheticUser,
    parseUsersFileBlocks,
    normalizeUser,
    parseCookies,
    usernameMatches,
};
