const fs = require('fs');
const path = require('path');
const {
    PROJECT_ROOT: STORE_PROJECT_ROOT,
    normalizeUpsellingStoreKey,
    resolveEnabledStores,
    isUpsellingEnabledForStore,
    resetStoreUpsellingConfigCache,
} = require('./storeUpsellingConfig');

const PROJECT_ROOT = STORE_PROJECT_ROOT;
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'upselling.json');
const TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';

let cache = null;

const DEFAULT_CONFIG = {
    enabledStores: ['teststore'],
    syncStoreNumber: '',
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
    resetStoreUpsellingConfigCache();
}

function isUpsellingStore(storeNumber) {
    return isUpsellingEnabledForStore(storeNumber);
}

const { isTestStore } = require('../testStore');

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

function resolveEnabledStoresForScheduler() {
    return resolveEnabledStores(loadUpsellingConfig());
}

/** When set, upsell BI export is for this store only (no regional multi-store file). */
function resolveUpsellSyncStore(cfg = loadUpsellingConfig()) {
    return String(cfg.syncStoreNumber || '').trim();
}

module.exports = {
    PROJECT_ROOT,
    CONFIG_PATH,
    TIME_ZONE,
    loadUpsellingConfig,
    resetUpsellingConfigCache,
    isUpsellingStore,
    isUpsellingMmxSyncStore,
    resolveEnabledStores: resolveEnabledStoresForScheduler,
    normalizeUpsellingStoreKey,
    upsellingDataDir,
    resolveUpsellReportDateSpec,
    resolveUpsellSyncStore,
};
