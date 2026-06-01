const fs = require('fs');
const path = require('path');
const { normalizeStoreKey, isTestStore } = require('../testStore');

const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'upselling.json');
const TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';

let cache = null;

const DEFAULT_CONFIG = {
    enabledStores: ['teststore'],
    peakWindows: [
        { start: 12, end: 15 },
        { start: 17, end: 20 },
    ],
    updateIntervalMinutes: 60,
    reportDateMode: 'competition',
    biFolderPath: ['VIC', 'Ash'],
    reportName: 'Upsell by Cashier',
    biReportUrl:
        'https://tacobellau.macromatix.net/reportportal5/Proxy.aspx?reportId=317',
    biEntryUrl:
        'https://tacobellau.macromatix.net/MMS_System_ReportPortal.aspx?MenuCustomItemID=227',
    biMenuLinkText: 'Business Intelligence',
    treeReadyTimeoutMs: 30000,
    exportLinkText: 'excel',
    exportMode: 'scrape',
    skipDatePicker: true,
    reportReadyTimeoutMs: 60000,
    powerBiExportMenuLabels: ['export', 'download'],
    powerBiExcelLabels: ['microsoft excel', 'excel (.xlsx)', 'excel', 'summarized data'],
    downloadWaitMs: 120000,
    navTimeoutMs: 45000,
};

function loadUpsellingConfig() {
    if (cache) return cache;
    let raw = {};
    if (fs.existsSync(CONFIG_PATH)) {
        try {
            raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        } catch (e) {
            console.warn('[Upselling] Invalid config/upselling.json:', e.message);
        }
    }
    cache = { ...DEFAULT_CONFIG, ...raw };
    return cache;
}

function resetUpsellingConfigCache() {
    cache = null;
}

function resolveEnabledStores(cfg) {
    const fromEnv = String(process.env.UPSELLING_ENABLED_STORES || '').trim();
    if (fromEnv) {
        return fromEnv
            .split(/[,;]/)
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
    }
    return (cfg.enabledStores || []).map((s) => String(s).trim().toLowerCase());
}

function normalizeUpsellingStoreKey(storeNumber) {
    const raw = String(storeNumber || '').trim();
    if (isTestStore(raw)) return 'teststore';
    const key = normalizeStoreKey(raw);
    return key ? key.toLowerCase() : raw.toLowerCase();
}

function isUpsellingStore(storeNumber) {
    const cfg = loadUpsellingConfig();
    const want = normalizeUpsellingStoreKey(storeNumber);
    if (!want) return false;
    return resolveEnabledStores(cfg).includes(want);
}

/** Test store uses local .Employees only — no Macromatix BI sync. */
function isUpsellingMmxSyncStore(storeNumber) {
    return isUpsellingStore(storeNumber) && !isTestStore(storeNumber);
}

function upsellingDataDir(storeNumber) {
    return path.join(PROJECT_ROOT, 'data', 'upselling', String(storeNumber || '').trim());
}

function resolveUpsellReportDateSpec(mode) {
    const m = String(mode || 'yesterday').trim().toLowerCase();
    if (m === 'competition') return 'competition';
    if (m === 'today') return 'daysAgo:0';
    if (m === 'yesterday') return 'daysAgo:1';
    return m;
}

module.exports = {
    PROJECT_ROOT,
    CONFIG_PATH,
    TIME_ZONE,
    loadUpsellingConfig,
    resetUpsellingConfigCache,
    isUpsellingStore,
    isUpsellingMmxSyncStore,
    resolveEnabledStores,
    upsellingDataDir,
    resolveUpsellReportDateSpec,
};
