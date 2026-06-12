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
const paths = require('../../../src/paths');
const CONFIG_PATH = path.join(paths.dashboard.config, 'upselling.json');
const TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';

let cache = null;

const DEFAULT_CONFIG = {
    enabledStores: ['teststore'],
    syncStoreNumber: '',
    updateSchedule: 'hourly',
    peakWindows: [
        { start: 12, end: 15 },
        { start: 17, end: 20 },
    ],
    updateIntervalMinutes: 60,
    reportDateMode: 'competition',
    biNavigationMode: 'direct',
    biFolderPath: [],
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

const { isTestStore } = require('../../../stores/src/testStore');

/** Test store uses local leaderboard JSON only — no Macromatix BI sync. */
function isUpsellingMmxSyncStore(storeNumber) {
    return isUpsellingStore(storeNumber) && !isTestStore(storeNumber);
}

function upsellingRootDir() {
    return path.join(paths.dashboard.data, 'upselling');
}

function upsellingSharedPath(filename) {
    return path.join(upsellingRootDir(), String(filename || '').trim());
}

function leaderboardFilePath(storeNumber) {
    const store = String(storeNumber || '').trim();
    return path.join(upsellingRootDir(), `${store}_leaderboard.json`);
}

function upsellingLastSyncPath() {
    return upsellingSharedPath('last-sync.json');
}

function upsellingLastParsePath() {
    return upsellingSharedPath('last-parse.json');
}

function upsellingLastExportPath(ext = '.csv') {
    return upsellingSharedPath(`last-export${ext}`);
}

/** @deprecated All upselling data lives in data/upselling/ (flat layout). */
function upsellingDataDir(_storeNumber) {
    return upsellingRootDir();
}

/** @deprecated Regional export files live in data/upselling/ root. */
function upsellingRegionalDataDir() {
    return upsellingRootDir();
}

function backfillMarkerPath() {
    return upsellingSharedPath('backfill-complete.json');
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

function isSyncAllStores(cfg = loadUpsellingConfig()) {
    if (cfg.syncAllStores === true) return true;
    const store = resolveUpsellSyncStore(cfg);
    return store === '*' || store.toLowerCase() === 'all';
}

function isLeaderboardBackfillComplete() {
    return fs.existsSync(backfillMarkerPath());
}

function markLeaderboardBackfillComplete(meta = {}) {
    const dir = upsellingRootDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        backfillMarkerPath(),
        JSON.stringify(
            {
                at: new Date().toISOString(),
                ...meta,
            },
            null,
            2
        ),
        'utf8'
    );
}

function melbourneTodayIso() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());
}

/** Which fiscal day to score from each sync (default: today only). Set syncDayMode to "all" for full competition export. */
function resolveUpsellSyncDay(cfg = loadUpsellingConfig()) {
    const envOverride = String(process.env.UPSELL_SYNC_DAY || '').trim();
    if (envOverride === 'all' || envOverride === 'competition') return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(envOverride)) return envOverride;

    const mode = String(cfg.syncDayMode || 'today').trim().toLowerCase();
    if (mode === 'all' || mode === 'competition') return null;
    if (mode === 'today') return melbourneTodayIso();
    if (mode === 'yesterday') {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(d);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(mode)) return mode;
    return melbourneTodayIso();
}

/**
 * syncDay for this run: null = every fiscal day in the export, string = one day only.
 * First run with backfillOnFirstSync imports all days once; scheduled syncs then use syncDayMode (today).
 */
function resolveUpsellSyncDayForRun(cfg = loadUpsellingConfig(), options = {}) {
    if (options.allDays || options.backfill) return null;
    if (Object.prototype.hasOwnProperty.call(options, 'syncDay')) {
        return options.syncDay || null;
    }

    if (cfg.backfillOnFirstSync !== false && !isLeaderboardBackfillComplete()) {
        console.log(
            '[Upselling] Leaderboard backfill pending — importing all fiscal days from this export (once)'
        );
        return null;
    }

    return resolveUpsellSyncDay(cfg);
}

function maybeMarkBackfillComplete(syncDay, meta = {}) {
    if (syncDay) return;
    if (!meta.storesUpdated?.length) return;
    markLeaderboardBackfillComplete(meta);
    console.log('[Upselling] Leaderboard backfill complete — future syncs use syncDayMode only');
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
    upsellingRootDir,
    upsellingSharedPath,
    leaderboardFilePath,
    upsellingLastSyncPath,
    upsellingLastParsePath,
    upsellingLastExportPath,
    upsellingDataDir,
    resolveUpsellReportDateSpec,
    resolveUpsellSyncStore,
    resolveUpsellSyncDay,
    resolveUpsellSyncDayForRun,
    isLeaderboardBackfillComplete,
    markLeaderboardBackfillComplete,
    maybeMarkBackfillComplete,
    backfillMarkerPath,
    isSyncAllStores,
    upsellingRegionalDataDir,
    melbourneTodayIso,
};
