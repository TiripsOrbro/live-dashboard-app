const fs = require('fs');
const path = require('path');
const { normalizeStoreKey } = require('../../../stores/src/testStore');

const paths = require('../../../src/paths');
const TACAUDIT_DATA_DIR = path.join(paths.tacaudit.data, 'tacaudit');

function settingsPath(storeNumber) {
    return path.join(TACAUDIT_DATA_DIR, normalizeStoreKey(storeNumber), 'settings.json');
}

function readJson(filePath, fallback = null) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function isValidEmail(value) {
    const email = String(value || '').trim();
    if (!email) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getSettings(storeNumber) {
    const store = normalizeStoreKey(storeNumber);
    const raw = readJson(settingsPath(store), {});
    return {
        storeNumber: store,
        reportEmail: String(raw.reportEmail || '').trim(),
        lastActionsDigestDate: String(raw.lastActionsDigestDate || '').trim() || null,
        actionsSoonDays: Math.max(1, Math.min(14, Number(raw.actionsSoonDays) || 2)),
        updatedAt: raw.updatedAt || null,
    };
}

function saveSettings(storeNumber, updates = {}) {
    const store = normalizeStoreKey(storeNumber);
    const prev = readJson(settingsPath(store), {});
    const reportEmail =
        updates.reportEmail !== undefined ? String(updates.reportEmail || '').trim() : String(prev.reportEmail || '').trim();
    if (reportEmail && !isValidEmail(reportEmail)) {
        return { ok: false, error: 'Enter a valid email address.' };
    }
    const next = {
        reportEmail,
        lastActionsDigestDate:
            updates.lastActionsDigestDate !== undefined
                ? String(updates.lastActionsDigestDate || '').trim() || null
                : prev.lastActionsDigestDate || null,
        actionsSoonDays:
            updates.actionsSoonDays !== undefined
                ? Math.max(1, Math.min(14, Number(updates.actionsSoonDays) || 2))
                : Math.max(1, Math.min(14, Number(prev.actionsSoonDays) || 2)),
        updatedAt: new Date().toISOString(),
    };
    writeJson(settingsPath(store), next);
    return { ok: true, settings: { storeNumber: store, ...next } };
}

module.exports = {
    TACAUDIT_DATA_DIR,
    isValidEmail,
    getSettings,
    saveSettings,
};
