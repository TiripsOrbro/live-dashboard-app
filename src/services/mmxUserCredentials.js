const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const MMX_CREDENTIALS_DIR = path.join(PROJECT_ROOT, 'data', 'mmx-users');

function credentialsKey() {
    const keyMaterial = String(
        process.env.MMX_USER_CREDENTIALS_KEY || process.env.SCRAPER_CREDENTIALS_KEY || ''
    ).trim();
    if (keyMaterial) {
        return crypto.createHash('sha256').update(keyMaterial).digest();
    }
    if (process.env.NODE_ENV === 'production') {
        throw new Error(
            'Set MMX_USER_CREDENTIALS_KEY or SCRAPER_CREDENTIALS_KEY in production to encrypt per-user Macromatix credentials.'
        );
    }
    console.warn(
        '[MMX credentials] No encryption key in env — using development-only key. Set MMX_USER_CREDENTIALS_KEY on the server.'
    );
    return crypto.createHash('sha256').update('dashboard-mmx-user-dev').digest();
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
    return path.join(MMX_CREDENTIALS_DIR, `${safeUsernameKey(dashboardUsername)}.json`);
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

/** AES-256-GCM at rest — only the dashboard username is stored in cleartext for lookup. */
function saveMmxCredentialsForUser(dashboardUsername, mmxUsername, mmxPassword) {
    const dashUser = String(dashboardUsername || '').trim();
    const mmxUser = String(mmxUsername || '').trim();
    const mmxPass = String(mmxPassword || '');
    if (!dashUser || !mmxUser || !mmxPass) {
        return { ok: false, error: 'Dashboard user and Macromatix credentials are required.' };
    }
    try {
        fs.mkdirSync(MMX_CREDENTIALS_DIR, { recursive: true });
        const encrypted = encryptPayload({
            mmxUsername: mmxUser,
            mmxPassword: mmxPass,
            updatedAt: new Date().toISOString(),
        });
        fs.writeFileSync(
            credentialsPath(dashUser),
            JSON.stringify(
                {
                    username: dashUser,
                    encrypted,
                    updatedAt: new Date().toISOString(),
                },
                null,
                2
            ),
            'utf8'
        );
        return { ok: true, encrypted: true };
    } catch (error) {
        return { ok: false, error: error.message || 'Could not save Macromatix credentials.' };
    }
}

function readMmxCredentialsForUser(dashboardUsername) {
    const dashUser = String(dashboardUsername || '').trim();
    if (!dashUser) return null;
    const raw = readCredentialsFileRaw(dashUser);
    if (!raw) return null;

    if (raw.encrypted && raw.encrypted.iv && raw.encrypted.data && raw.encrypted.tag) {
        try {
            const decrypted = decryptPayload(raw.encrypted);
            return {
                username: String(decrypted.mmxUsername || '').trim(),
                password: String(decrypted.mmxPassword || ''),
            };
        } catch {
            return null;
        }
    }

    // Legacy plaintext file — re-save encrypted and remove secrets from disk.
    const legacyUser = String(raw.mmxUsername || '').trim();
    const legacyPass = String(raw.mmxPassword || '');
    if (legacyUser && legacyPass) {
        const migrated = saveMmxCredentialsForUser(dashUser, legacyUser, legacyPass);
        if (migrated.ok) {
            console.log(`[MMX credentials] Migrated plaintext credentials to encrypted storage for ${dashUser}`);
        }
        return { username: legacyUser, password: legacyPass };
    }

    return null;
}

function hasMmxCredentialsForUser(dashboardUsername) {
    return Boolean(readMmxCredentialsForUser(dashboardUsername)?.username);
}

function deleteMmxCredentialsForUser(dashboardUsername) {
    const dashUser = String(dashboardUsername || '').trim();
    if (!dashUser) return { ok: false, error: 'Username is required.' };
    const file = credentialsPath(dashUser);
    if (!fs.existsSync(file)) return { ok: true, removed: false };
    try {
        fs.unlinkSync(file);
        return { ok: true, removed: true };
    } catch (error) {
        return { ok: false, error: error.message || 'Could not remove Macromatix credentials.' };
    }
}

module.exports = {
    saveMmxCredentialsForUser,
    readMmxCredentialsForUser,
    hasMmxCredentialsForUser,
    deleteMmxCredentialsForUser,
};
