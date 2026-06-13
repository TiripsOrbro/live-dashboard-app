const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const paths = require('../../../src/paths');
const LIFELENZ_CREDENTIALS_DIR = path.join(paths.users.data, 'lifelenz-users');

function credentialsKey() {
    const keyMaterial = String(
        process.env.LIFELENZ_USER_CREDENTIALS_KEY ||
            process.env.MMX_USER_CREDENTIALS_KEY ||
            process.env.SCRAPER_CREDENTIALS_KEY ||
            ''
    ).trim();
    if (keyMaterial) {
        return crypto.createHash('sha256').update(keyMaterial).digest();
    }
    if (process.env.NODE_ENV === 'production') {
        throw new Error(
            'Set LIFELENZ_USER_CREDENTIALS_KEY or MMX_USER_CREDENTIALS_KEY in production to encrypt per-user LifeLenz credentials.'
        );
    }
    console.warn(
        '[LifeLenz credentials] No encryption key in env — using development-only key. Set LIFELENZ_USER_CREDENTIALS_KEY on the server.'
    );
    return crypto.createHash('sha256').update('dashboard-lifelenz-user-dev').digest();
}

function encryptPayload(payload) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', credentialsKey(), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: data.toString('base64'),
    };
}

function decryptPayload(blob) {
    const iv = Buffer.from(blob.iv, 'base64');
    const tag = Buffer.from(blob.tag, 'base64');
    const data = Buffer.from(blob.data, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', credentialsKey(), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
}

function safeUsernameKey(username) {
    return String(username || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '_');
}

function credentialsPath(dashboardUsername) {
    return path.join(LIFELENZ_CREDENTIALS_DIR, `${safeUsernameKey(dashboardUsername)}.json`);
}

function readCredentialsFileRaw(dashboardUsername) {
    const dashUser = String(dashboardUsername || '').trim();
    if (!dashUser) return null;
    const file = credentialsPath(dashUser);
    if (!fs.existsSync(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function writeUserLifeLenzSecrets(dashboardUsername, secrets) {
    const dashUser = String(dashboardUsername || '').trim();
    const email = String(secrets?.lifelenzEmail || secrets?.email || '').trim();
    const password = String(secrets?.lifelenzPassword || secrets?.password || '');
    if (!dashUser || !email || !password) {
        return { ok: false, error: 'Dashboard user and LifeLenz credentials are required.' };
    }
    try {
        fs.mkdirSync(LIFELENZ_CREDENTIALS_DIR, { recursive: true });
        const encrypted = encryptPayload({
            lifelenzEmail: email,
            lifelenzPassword: password,
            updatedAt: new Date().toISOString(),
        });
        const updatedAt = new Date().toISOString();
        fs.writeFileSync(
            credentialsPath(dashUser),
            JSON.stringify(
                {
                    username: dashUser,
                    encrypted,
                    updatedAt,
                },
                null,
                2
            ),
            'utf8'
        );
        return { ok: true, encrypted: true, updatedAt };
    } catch (error) {
        return { ok: false, error: error.message || 'Could not save LifeLenz credentials.' };
    }
}

function readUserLifeLenzSecrets(dashboardUsername) {
    const dashUser = String(dashboardUsername || '').trim();
    if (!dashUser) return null;
    const raw = readCredentialsFileRaw(dashUser);
    if (!raw) return null;

    if (raw.encrypted?.iv && raw.encrypted?.data && raw.encrypted?.tag) {
        try {
            const decrypted = decryptPayload(raw.encrypted);
            return {
                lifelenzEmail: String(decrypted.lifelenzEmail || '').trim(),
                lifelenzPassword: String(decrypted.lifelenzPassword || ''),
                updatedAt: String(raw.updatedAt || decrypted.updatedAt || '').trim(),
            };
        } catch (error) {
            console.warn(
                `[LifeLenz credentials] Could not decrypt saved login for "${dashUser}" — check LIFELENZ_USER_CREDENTIALS_KEY: ${error.message}`
            );
            return null;
        }
    }

    return null;
}

function saveUserLifeLenzSecrets(dashboardUsername, email, password) {
    return writeUserLifeLenzSecrets(dashboardUsername, { lifelenzEmail: email, lifelenzPassword: password });
}

function readLifeLenzCredentialsForUser(dashboardUsername) {
    const secrets = readUserLifeLenzSecrets(dashboardUsername);
    if (!secrets?.lifelenzEmail) return null;
    return { email: secrets.lifelenzEmail, password: secrets.lifelenzPassword };
}

function hasLifeLenzCredentialsForUser(dashboardUsername) {
    return Boolean(readLifeLenzCredentialsForUser(dashboardUsername)?.email);
}

function getLifeLenzCredentialsStatus(dashboardUsername) {
    const raw = readCredentialsFileRaw(dashboardUsername);
    if (!raw) {
        return { configured: false, updatedAt: null };
    }
    return {
        configured: hasLifeLenzCredentialsForUser(dashboardUsername),
        updatedAt: raw.updatedAt || null,
    };
}

function deleteLifeLenzCredentialsForUser(dashboardUsername) {
    const dashUser = String(dashboardUsername || '').trim();
    if (!dashUser) return { ok: false, error: 'Username is required.' };
    const file = credentialsPath(dashUser);
    if (!fs.existsSync(file)) return { ok: true, removed: false };
    try {
        fs.unlinkSync(file);
        return { ok: true, removed: true };
    } catch (error) {
        return { ok: false, error: error.message || 'Could not remove LifeLenz credentials.' };
    }
}

function listLifeLenzCredentialUsers() {
    if (!fs.existsSync(LIFELENZ_CREDENTIALS_DIR)) return [];
    return fs
        .readdirSync(LIFELENZ_CREDENTIALS_DIR)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.replace(/\.json$/i, ''))
        .filter(Boolean);
}

/**
 * First saved LifeLenz login whose account includes storeNumber.
 * @param {string} storeNumber
 * @param {{ accessCache?: Map<string, Set<string>> }} options
 */
async function resolveLifeLenzCredentialsForStore(storeNumber, options = {}) {
    const store = String(storeNumber || '').trim();
    if (!store) return null;

    const { verifyLifeLenzLogin } = require('../../../lifelenz/src/lifelenzAuth');
    const cache = options.accessCache || new Map();

    for (const dashUser of listLifeLenzCredentialUsers()) {
        const creds = readLifeLenzCredentialsForUser(dashUser);
        if (!creds?.email || !creds?.password) continue;

        if (cache.has(dashUser)) {
            if (cache.get(dashUser).has(store)) {
                return { ...creds, dashboardUsername: dashUser };
            }
            continue;
        }

        const verify = await verifyLifeLenzLogin(creds.email, creds.password, { headless: true });
        if (!verify.ok) continue;
        const storeSet = new Set((verify.stores || []).map((row) => String(row.storeNumber)));
        cache.set(dashUser, storeSet);
        if (storeSet.has(store)) {
            return { ...creds, dashboardUsername: dashUser };
        }
    }
    return null;
}

module.exports = {
    saveUserLifeLenzSecrets,
    readUserLifeLenzSecrets,
    readLifeLenzCredentialsForUser,
    hasLifeLenzCredentialsForUser,
    getLifeLenzCredentialsStatus,
    deleteLifeLenzCredentialsForUser,
    listLifeLenzCredentialUsers,
    resolveLifeLenzCredentialsForStore,
};
