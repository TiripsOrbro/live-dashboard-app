const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const paths = require('./paths');
const { loadEnv } = require('./loadEnv');
loadEnv();
/* Force background scraping to stay headless for sales data. */
process.env.SCRAPER_HEADLESS = 'true';

(function logMacromatixEnvStatus() {
    const keyOk = Boolean(
        String(process.env.STORE_CREDENTIALS_KEY || process.env.MMX_USER_CREDENTIALS_KEY || '').trim()
    );
    console.log(
        `[Env] Store portal credentials: encryption key ${keyOk ? 'set' : 'MISSING (dev fallback in non-production)'}`
    );
    console.log('[Env] Macromatix/LifeLenz/SMG/NSF logins are per-store - configure in Admin menu → Setup Store Logins');
    const nologinOn = /^(1|true|yes|on)$/i.test(String(process.env.DASHBOARD_NOLOGIN_ENABLED ?? '').trim());
    if (nologinOn && !String(process.env.DASHBOARD_NOLOGIN_SECRET || '').trim()) {
        console.warn(
            '[Env] WARNING: DASHBOARD_NOLOGIN_ENABLED is on without DASHBOARD_NOLOGIN_SECRET - nologin links require no key. Set DASHBOARD_NOLOGIN_SECRET to lock them down.'
        );
    }
})();

const scrapeData = require('./services/scraper');
const { notifyScrapeFailure } = require('./services/alertNotifier');
const { isMmxResourceBusy } = require('./services/mmxResourceGate');
const {
    runWithPriority,
    PRIORITY,
    hasPendingHigherPriority,
    hasBlockingWorkForPriority,
    getQueueSnapshot,
} = require('./services/mmxTaskQueue');
const {
    MmxWorkAbortedError,
    resetSalesScrapeAbort,
    registerSalesScrapeBrowser,
    clearSalesScrapeBrowser,
} = require('./services/salesScrapeAbort');
require('../dashboard/src/forecastMmxAbort');
const { getStoreList, getStoreConfig, DEFAULT_OPEN_HOUR, DEFAULT_CLOSE_HOUR } = require('./services/storeList');
const {
    TEST_STORE_SLUG,
    TEST_STORE_NAME,
    isTestStore,
    normalizeStoreKey,
    buildTestStoreSalesSlice,
    stickyKeyForTestMirror,
    testStoreListEntry,
} = require('./services/testStore');
const { listConfiguredVendors, getVendorCatalog } = require('./services/vendorCatalog');
const {
    buildCombinedStockCountCatalog,
    isCombinedStockCountSlug,
    vendorSlugsFromPendingLabels,
} = require('./services/combinedStockCountCatalog');
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
const {
    getStoreScrapePhase,
    anyStoreInActiveScrapeWindow,
    isPostCloseSalesGrace,
    POST_CLOSE_RETAIN_HOURS,
} = require('./services/scrapeSchedule');
const fsSync = require('fs');
const { touchPresence } = require('./services/scrapePresence');
const { startSalesScrapeScheduler } = require('./services/salesScrapeScheduler');
const {
    getLastKnownPendingVendors,
    onStoreOrdersComplete,
    clearStoreScrapeCaches,
    resetScheduledOrdersForNewDay,
    resetSssgForNewDay,
    getCachedSssgLy,
    storeHasMmxCredentials,
} = require('./services/macromatixScraper');
const { computeSssgPercent } = require('./services/sssg/sssgCalc');
const {
    resetWeeklyLedgerIfNeeded,
    captureEndOfDaySssg,
    updateTodayPartialInLedger,
    finalizeYesterdaySssg,
    finalizePastWeekDays,
    getStoreDateKey,
    getStoreDayEntry,
    getMelbourneWeekStart,
} = require('./services/sssg/sssgWeeklyLedger');
const { getLowStockSummary } = require('../vendors/src/lowStockAlerts');
const {
    prepareStockCountForMmx,
    applyStockCountSession,
    cancelStockCountSession,
    runScheduledOrdersOnly,
    checkStockLevelsForStore,
    getStockCountSendPlan,
    getStockCountPipelineStatus,
    isStockCountPipelineBusy,
    recordStockCountPrepareFailure,
    recordStockCountCheckFailure,
    resetStalePipelineCheckpointsOnStartup,
} = require('./services/stockCountMmxPipeline');
const { buildDailyStockCountCatalog } = require('./services/dailyStockCountCatalog');
const { buildDailyStockCountTileStateAsync } = require('./services/dailyStockCountTileState');
const { buildStockCountTileStateAsync } = require('./services/stockCountTileState');
const {
    getDraft: getDailyCountDraft,
    saveDraftLocation: saveDailyCountDraftLocation,
    getSummary: getDailyCountSummary,
    setStartResolution: setDailyCountStartResolution,
    reopenDraft: reopenDailyCountDraft,
} = require('./services/dailyStockCountState');
const {
    probeOpenCounts,
    prepareDailyCountForMmx,
    applyDailyCountSessionWork,
    cancelDailyCountSession,
    getDailyCountPipelineStatus,
    isDailyCountPipelineBusy,
} = require('./services/dailyStockCountMmxPipeline');
const { hasMmxCredentialsForUser, readMmxCredentialsForUser, saveMmxCredentialsForUser } = require('./services/mmxUserCredentials');
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
/** @deprecated Replaced by interval scheduler (SCRAPE_FAST_INTERVAL_SECONDS, default 120s). */
const SALES_REFRESH_SECONDS = Number(process.env.SALES_REFRESH_SECONDS || 240);
/** Full Macromatix run (login + every store's labour + scheduled orders). ~1 min/store, so allow plenty for a slow Pi. */
const SCRAPE_TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS || 900000);
const SCRAPE_RETRIES = Number(process.env.SCRAPE_RETRIES || 1);
const SCRAPE_INTERVAL_SECONDS = Math.max(30, Number(process.env.SCRAPE_FAST_INTERVAL_SECONDS || 120));
const SCRAPE_BATCH_SIZE = Math.max(1, Number(process.env.SCRAPE_BATCH_SIZE || 4));
const STORE_SCRAPE_STALE_MS = Math.max(
    60_000,
    Number(process.env.STORE_SCRAPE_STALE_MS || SCRAPE_INTERVAL_SECONDS * 1000 * 0.85)
);
/** Store shown at `/` (no store in the path). Empty = first store the scrape returns. */
const DASHBOARD_DEFAULT_STORE = String(process.env.DASHBOARD_DEFAULT_STORE || '').trim();
const AUDIT_STATE_FILE = process.env.AUDIT_STATE_FILE || path.join(paths.tacaudit.data, 'audit-state.json');

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
    isSuperAdminUser,
    getOverviewScope,
    hasMultiStoreScope,
    canViewCrossStoreAccounts,
    getEffectiveStoresForUser,
    userCanAccessArea,
    userCanAccessStore,
    filterStoresForUser,
    getAccessibleAreasForUser,
    getLoginRedirectPath,
    getAdminRedirectPath,
    getKioskRedirectPath,
    getMicOverviewPath,
    getMicStorePath,
    getAdminAreaPath,
    singleStoreForUser,
    sessionCookieOptions,
    sessionCookieClearOptions,
    nologinCookieOptions,
    nologinCookieClearOptions,
    isNologinUser,
    isNologinStoreAllowed,
    verifyNologinSecret,
    userProfileForClient,
    timingSafeEqualString,
    readUsersFileSync,
    resolveUsersFilePath,
    isStorePatternUsername,
    changeUserPassword,
    completePasswordSetup,
    passwordPolicyForUser,
    userNeedsPasswordChange,
    userNeedsMmxSetup,
    getAccountSetupRedirectPath,
    generateTemporaryPassword,
    setAccountColourBlindPreference,
    setAccountMicDarkModePreference,
    setAccountAuditAutoCollapsePreference,
    setAccountMicRoundedTilesPreference,
    appendStoreUser,
    appendDashboardUser,
    buildCreateAccountParentFromUser,
    getCreateAccountOptions,
    getStoreScopeTreeForUser,
    validateCreateAccountPayload,
    requiresMmxForAccountLevel,
    canUserCreateAccounts,
    canUserAccessAdminMenu,
    canUserManageStoreLogins,
    canUserManageSmgNsfSettings,
    canUserEditGlobalBuildTo,
    canUserManageStoreAccounts,
    listManagedStoreAccounts,
    updateManagedStoreAccount,
    listLoginHistoryForStore,
    deleteManagedStoreAccount,
    appendAuthEvent,
    appendAccountAudit,
    isRealDashboardUser,
    isPrimaryStoreLogin,
    canUserAccessDfsc,
    getAccountLevel,
    canUserCompleteAudits,
    canUserStartAudits,
    canAccessCoachAudits,
    getDfscConductorName,
    parseCookies,
    usernameMatches,
} = require('./services/dashboardUsers');
const {
    addDailyItemMultiplier,
    removeDailyItemMultiplier,
    setDailyItemMultiplier,
    clearStoreDailyMultipliers,
} = require('./services/mic/micStore');
const { computeStoreSalesToday, ADMIN_ROTATE_AREAS } = require('./services/mic/adminOverview');
const { buildOverviewPayload } = require('./services/mic/overviewPayload');
const {
    getContext: getDfscContext,
    createSession: createDfscSession,
    getSessionById: getDfscSessionById,
    updateSession: updateDfscSession,
    reopenSession: reopenDfscSession,
    submitSession: submitDfscSession,
    validateSessionSection,
    getAuditById: getDfscAuditById,
    listOpenAudits: listDfscOpenAudits,
    deleteOpenAudit: deleteDfscOpenAudit,
    listInspectionHistory: listDfscInspectionHistory,
    userOwnsSession: dfscUserOwnsSession,
    canUserAccessSession,
} = require('./services/dfsc/dfscStore');
const { buildDfscReportPdf, buildReportFilename } = require('./services/dfsc/dfscReport');
const { buildCoreReportPdf } = require('./services/dfsc/dfscCoreReport');
const { buildStatusForStores, getTargetForecastWeekStarts } = require('../dashboard/src/forecast/forecastStatusLedger');
const {
    runForecastForStores,
    runLifeLenzForecastForStores,
    runCombinedForecastForStores,
    previewForecastForStore,
    previewForecastForStores,
} = require('../dashboard/src/forecast/forecastRunner');
const {
    readManualEntryPack,
    buildManualEntryPlainText,
} = require('../dashboard/src/forecast/forecastManualPack');
const {
    buildHistoryCoverageForStores,
    buildHistoryHourGrid,
    recordForecastHistoryFromStore,
    importForecastHistory,
    upsertManualHistoryDay,
    deleteHistoryDay,
    buildHistoryDayEntry,
    historyDateBounds,
    readStoreHistory,
    finalizeForecastHistoryFromSnapshot,
    sweepForecastHistoryFromSnapshots,
} = require('../dashboard/src/forecast/forecastHistoryLedger');
const {
    readAdjustments,
    writeAdjustments,
    deleteAdjustments,
} = require('../dashboard/src/forecast/forecastAdjustmentsLedger');
const {
    readAutoSubmitSettings,
    writeAutoSubmitSettings,
    buildAutoSubmitStatus,
} = require('../dashboard/src/forecast/forecastAutoSubmitLedger');
const {
    buildForecastUpdatesForStores,
    summarizeForecastUpdates,
} = require('../dashboard/src/forecast/forecastUpdateLedger');
const { buildAdminDfscStatus } = require('../tacaudit/audits/Daily Food Safety Check/dfscAdmin');
const { buildAdminBuildToCatalog, filterOverridesForActor, readOverridesDoc } = require('../vendors/src/buildToAdminCatalog');
const { patchOverrides } = require('../vendors/src/buildToAdminOverrides');
const {
    getContext: getPestWalkContext,
    createSession: createPestWalkSession,
    getSessionById: getPestWalkSessionById,
    updateSession: updatePestWalkSession,
    reopenSession: reopenPestWalkSession,
    submitSession: submitPestWalkSession,
    validateSessionSection: validatePestWalkSection,
    listOpenAudits: listPestWalkOpenAudits,
    deleteOpenAudit: deletePestWalkOpenAudit,
    listInspectionHistory: listPestWalkInspectionHistory,
    userOwnsSession: pestWalkUserOwnsSession,
    canUserAccessSession: canPestWalkUserAccessSession,
    AUDIT_LABEL: PEST_WALK_AUDIT_LABEL,
} = require('./services/pestWalk/pestWalkStore');
const { buildPestWalkReportPdf, buildReportFilename: buildPestWalkReportFilename } = require('./services/pestWalk/pestWalkReport');
const {
    getContext: getRgmCleaningContext,
    createSession: createRgmCleaningSession,
    getSessionById: getRgmCleaningSessionById,
    updateSession: updateRgmCleaningSession,
    reopenSession: reopenRgmCleaningSession,
    submitSession: submitRgmCleaningSession,
    validateSessionSection: validateRgmCleaningSection,
    listOpenAudits: listRgmCleaningOpenAudits,
    deleteOpenAudit: deleteRgmCleaningOpenAudit,
    listInspectionHistory: listRgmCleaningInspectionHistory,
    userOwnsSession: rgmCleaningUserOwnsSession,
    canUserAccessSession: canRgmCleaningUserAccessSession,
    AUDIT_LABEL: RGM_CLEANING_AUDIT_LABEL,
} = require('./services/rgmCleaning/rgmCleaningStore');
const {
    getContext: getPsiContext,
    createSession: createPsiSession,
    getSessionById: getPsiSessionById,
    updateSession: updatePsiSession,
    reopenSession: reopenPsiSession,
    submitSession: submitPsiSession,
    validateSessionSection: validatePsiSection,
    listOpenAudits: listPsiOpenAudits,
    deleteOpenAudit: deletePsiOpenAudit,
    listInspectionHistory: listPsiInspectionHistory,
    userOwnsSession: psiUserOwnsSession,
    canUserAccessSession: canPsiUserAccessSession,
    AUDIT_LABEL: PSI_AUDIT_LABEL,
} = require('./services/periodicSafety/psiStore');
const {
    getContext: getSquareOneContext,
    createSession: createSquareOneSession,
    getSessionById: getSquareOneSessionById,
    updateSession: updateSquareOneSession,
    reopenSession: reopenSquareOneSession,
    submitSession: submitSquareOneSession,
    validateSessionSection: validateSquareOneSection,
    listOpenAudits: listSquareOneOpenAudits,
    deleteOpenAudit: deleteSquareOneOpenAudit,
    listInspectionHistory: listSquareOneInspectionHistory,
    userOwnsSession: squareOneUserOwnsSession,
    canUserAccessSession: canSquareOneUserAccessSession,
    AUDIT_LABEL: SQUARE_ONE_AUDIT_LABEL,
} = require('./services/squareOne/squareOneStore');
const coreOpsStore = require('./services/coreOps/coreOpsStore');
const coreFoodSafetyStore = require('./services/coreFoodSafety/coreFoodSafetyStore');
const visitCoachStore = require('./services/visitCoach/visitCoachStore');
const visitCustomerStore = require('./services/visitCustomer/visitCustomerStore');
const { registerPeriodAuditRoutes } = require('../tacaudit/src/core/periodAuditRoutes');
const { buildPsiReportPdf, buildReportFilename: buildPsiReportFilename } = require('./services/periodicSafety/psiReport');
const {
    buildSquareOneReportPdf,
    buildReportFilename: buildSquareOneReportFilename,
} = require('./services/squareOne/squareOneReport');
const { buildRgmCleaningReportPdf, buildReportFilename: buildRgmCleaningReportFilename } = require('./services/rgmCleaning/rgmCleaningReport');
const { getSettings: getTacauditSettings, saveSettings: saveTacauditSettings } = require('./services/tacaudit/tacauditStore');
const { getArchivePdf } = require('./services/tacaudit/tacauditArchive');
const {
    listTacauditHistory,
    listTacauditAdminHistory,
    getTacauditContext,
    getTacauditAdminContext,
    getTacauditScopeMeta,
} = require('./services/tacaudit/tacauditHistory');
const { buildTacauditAdminSummary, storesForArea } = require('./services/tacaudit/tacauditAdminSummary');
const { buildTacauditMarketSummary } = require('./services/tacaudit/tacauditMarketSummary');
const {
    getSplashStateForArea,
    setCellOverride,
    clearOverridesForArea,
} = require('./services/tacaudit/tacauditSplashState');
const { resolveComplianceSummary, ensureCompletedWeekSnapshotsCaptured } = require('./services/tacaudit/tacauditComplianceHistory');
const { listOpenActionsForStores, submitAction } = require('./services/tacaudit/tacauditActions');
const { getAuditTypeConfig } = require('./services/tacaudit/auditRegistry');
const {
    setAccountGateCookie,
    clearAccountGateCookie,
    resolveCreateAccountActor,
    resolveCreateAccountParent,
} = require('./services/createAccountGate');
const { saveUserAccountSecrets, deleteMmxCredentialsForUser } = require('./services/mmxUserCredentials');
const {
    saveUserLifeLenzSecrets,
    getLifeLenzCredentialsStatus,
    deleteLifeLenzCredentialsForUser,
    readLifeLenzCredentialsForUser,
} = require('./services/lifelenzUserCredentials');
const { getDashboardMeta, readChangelogMarkdown } = require('./services/dashboardMeta');
const {
    listFeatureRequests,
    listFeatureRequestCategories,
    listFeatureRequestPriorities,
    addFeatureRequest,
    addFeatureRequestCategory,
    hideFeatureRequestCategory,
    deleteFeatureRequestCategory,
    updateFeatureRequest,
} = require('./services/featureRequests');
const { verifyMacromatixLogin } = require('./services/macromatixScraper');
const { verifyLifeLenzLogin } = require('../lifelenz/src/lifelenzAuth');
const {
    VALID_SERVICES,
    isValidService,
    getStoreCredentialsSummary,
    savePrimary,
    addFallback,
    removeFallback,
    clearServiceCredentials,
    storeHasServiceCredentials,
} = require('./services/storeCredentials');
const { getSmgPeriodConfig, saveSmgPeriodConfig } = require('../smg/src/smgPeriodConfig');
const { getNsfRoundConfig, saveNsfRoundConfig, defaultRoundsForYear } = require('../nsf/src/nsfRoundConfig');
const {
    createRegistrationOptions,
    verifyRegistration,
    createLoginOptions,
    verifyLogin: verifyPasskeyLogin,
} = require('./services/webauthnPasskeys');
const ENTRY_COOKIE = 'dashboard_entry';
const PUBLIC_ROOT = paths.legacy.public;
const DASHBOARD_ACCESS_KEY = String(process.env.DASHBOARD_ACCESS_KEY || '');
const DASHBOARD_ALLOWED_IPS = String(process.env.DASHBOARD_ALLOWED_IPS || '')
    .split(',')
    .map((ip) => normalizeIp(ip))
    .filter(Boolean);

const cors = require('cors');
if (/^(1|true|yes|on)$/i.test(String(process.env.DASHBOARD_ENABLE_CORS ?? '').trim())) {
    app.use(cors());
}

const JSON_BODY_LIMIT = process.env.DASHBOARD_JSON_BODY_LIMIT || '10mb';
app.use(express.urlencoded({ extended: false, limit: JSON_BODY_LIMIT }));
app.use(express.json({ limit: JSON_BODY_LIMIT }));

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
/** Per-store last successful scrape (epoch ms) — drives batched interval scrapes in per-store login mode. */
const storeLastScrapedAt = new Map();
let lastSalesScrapeCompletedAt = null;
let auditStateCache = null;
/** Last scrape phase per store - drives idle wipe and new-day order-check reset. */
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

const NOT_FOUND_VARIANTS = ['purple', 'grey'];

function sendNotFoundPage(req, res) {
    if (isApiRequest(req)) {
        res.status(404).json({ success: false, error: 'Not found.' });
        return;
    }
    const variant = NOT_FOUND_VARIANTS[Math.floor(Math.random() * NOT_FOUND_VARIANTS.length)];
    res.status(404).sendFile(path.join(paths.legacy.public, `404-${variant}.html`));
}

function sendUnauthorized(req, res) {
    if (isApiRequest(req)) {
        res.status(401).json({ success: false, error: 'Dashboard login required.' });
        return;
    }
    res.redirect('/login');
}

/** Wall displays bookmarking /3811 or /kiosk/3811 - send them to /nologin/3811 when that store is allowlisted. */
function tryRedirectUnauthenticatedToNologin(req, res) {
    if (isApiRequest(req)) return false;
    const match =
        req.path.match(/^\/(\d{3,6})\/?$/) || req.path.match(/^\/kiosk\/(\d{3,6})\/?$/i);
    if (!match) return false;
    const storeNumber = normalizeStoreKey(match[1]);
    if (!storeNumber || !isNologinStoreAllowed(storeNumber) || !verifyNologinSecret(req.query.key)) {
        return false;
    }
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect(302, `/nologin/${storeNumber}${qs}`);
    return true;
}

function redirectNologinUserToWallDashboard(req, res, storeNumber) {
    const user = req.dashboardUser || getRequestUser(req);
    if (!isNologinUser(user)) return false;
    const store = normalizeStoreKey(storeNumber);
    if (!store) return false;
    res.redirect(302, `/nologin/${store}`);
    return true;
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

function entryCookieOptions(remember = true) {
    return sessionCookieOptions({ remember });
}

function dashboardEntryFromRequest(req) {
    const cookies = parseCookies(req.headers?.cookie);
    return String(cookies[ENTRY_COOKIE] || '').trim().toLowerCase();
}

function setEntryCookie(res, entry, remember = true) {
    res.cookie(ENTRY_COOKIE, String(entry || '').trim(), entryCookieOptions(remember));
}

function setSessionCookie(res, user, remember = true, entry = '') {
    res.cookie(SESSION_COOKIE, createSessionToken(user), sessionCookieOptions({ remember }));
    res.clearCookie(LEGACY_COOKIE, sessionCookieClearOptions({ remember }));
    if (entry) setEntryCookie(res, entry, remember);
}

function sendLoginSuccess(req, res, user, destOverride = '') {
    const mode = String(req.body?.mode || 'dashboard').trim().toLowerCase();
    const profile = userProfileForClient(user);
    const setupPath = getAccountSetupRedirectPath(user);
    const dest = setupPath || destOverride || getLoginRedirectPath(user, mode) || profile.defaultPath || '/login';
    if (wantsJsonResponse(req)) {
        res.json({
            success: true,
            welcomeName: profile.welcomeName || '',
            defaultPath: dest,
            mode,
            mustCompleteMmxSetup: Boolean(profile.mustCompleteMmxSetup),
            mustChangePassword: Boolean(profile.mustChangePassword),
            passwordPolicy: profile.passwordPolicy,
        });
        return;
    }
    res.redirect(dest);
}

function sendLoginFailure(req, res, message = 'Incorrect username or password.', returnTo = '/login') {
    if (wantsJsonResponse(req)) {
        res.status(401).json({ success: false, error: message });
        return;
    }
    const base = String(returnTo || '/login').split('?')[0];
    res.redirect(`${base}?error=invalid`);
}

function setLegacyAccessCookie(res, remember = true) {
    res.cookie(LEGACY_COOKIE, legacyAccessToken(DASHBOARD_ACCESS_KEY), sessionCookieOptions({ remember }));
    res.clearCookie(SESSION_COOKIE, sessionCookieClearOptions({ remember }));
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
    console.log(`[Auth] Login: ${user.username} (${label}) - ${access} from ${ip}`);
    appendAuthEvent({
        username: user.username,
        success: true,
        ip,
        stores: user.stores,
    });
}

function logAuthLoginFailed(req, username, reason = 'invalid credentials') {
    const ip = getRequestIp(req);
    const who = String(username || '').trim() || '(no username)';
    console.log(`[Auth] Login failed: ${who} - ${reason} from ${ip}`);
    if (who && who !== '(no username)') {
        appendAuthEvent({
            username: who,
            success: false,
            ip,
            reason,
        });
    }
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
    if (
        reqPath === '/login' ||
        reqPath === '/Create-Account' ||
        reqPath === '/create-account' ||
        reqPath === '/admin' ||
        reqPath === '/kiosk' ||
        reqPath === '/unlock' ||
        reqPath === '/logout'
    ) {
        return true;
    }
    if (reqPath === '/Create-Account/details' || reqPath === '/create-account/details') return true;
    if (reqPath === '/Create-Account/verify' || reqPath === '/create-account/verify') return true;
    if (reqPath === '/icon.svg' || reqPath === '/icon-mark.svg') return true;
    if (
        reqPath === '/styles/login.css' ||
        reqPath === '/styles/brand-mark.css' ||
        reqPath === '/styles/nav-back.css' ||
        reqPath === '/styles/account-modal.css'
    ) {
        return true;
    }
    if (
        reqPath === '/scripts/create-account.js' ||
        reqPath === '/scripts/create-account-details.js' ||
        reqPath === '/scripts/login.js' ||
        reqPath === '/scripts/brand-mark.js' ||
        reqPath === '/scripts/admin-login.js' ||
        reqPath === '/scripts/kiosk-login.js' ||
        reqPath === '/scripts/nav-back.js' ||
        reqPath === '/scripts/account-modal.js'
    ) {
        return true;
    }
    if (reqPath === '/api/account/login-ui') return true;
    if (reqPath === '/api/dashboard/meta') return true;
    if (reqPath === '/scripts/dashboard-meta.js') return true;
    if (reqPath === '/api/account/create') return true;
    if (reqPath === '/api/account/create-options') return true;
    if (reqPath.startsWith('/api/webauthn/')) return true;
    if (reqPath === '/404-grey.html' || reqPath === '/404-purple.html') return true;
    if (reqPath === '/styles/404.css') return true;
    if (reqPath.startsWith('/images/core/404-')) return true;
    return false;
}

function requireAdminPage(req, res, next) {
    const user = req.dashboardUser || getRequestUser(req);
    if (!user || !isAdminUser(user)) {
        sendUnauthorized(req, res);
        return;
    }
    next();
}

function requireMultiStoreScope(req, res, next) {
    const user = req.dashboardUser || getRequestUser(req);
    if (!user || (!isSuperAdminUser(user) && !hasMultiStoreScope(user))) {
        sendUnauthorized(req, res);
        return;
    }
    next();
}

function assertOverviewAccess(req, res) {
    const user = req.dashboardUser || getRequestUser(req);
    if (!isRealDashboardUser(user)) {
        sendUnauthorized(req, res);
        return false;
    }
    return true;
}

function dashboardAuthMiddleware(req, res, next) {
    if (isAuthenticated(req, DASHBOARD_ACCESS_KEY)) {
        req.dashboardUser = getRequestUser(req);
    } else if (!authRequired()) {
        req.dashboardUser = getRequestUser(req);
    }

    if (isLoginPublicPath(req.path)) {
        next();
        return;
    }

    if (req.dashboardUser) {
        next();
        return;
    }

    if (tryRedirectUnauthenticatedToNologin(req, res)) {
        return;
    }

    sendUnauthorized(req, res);
}

function isAccountSetupAllowedPath(reqPath, needsMmx, needsPassword) {
    if (reqPath === '/api/me') return true;
    if (reqPath === '/logout') return true;
    if (reqPath === '/api/account/create-options' || reqPath === '/api/account/create') return true;
    if (
        reqPath === '/styles/login.css' ||
        reqPath === '/styles/brand-mark.css' ||
        reqPath === '/styles/page-scroll.css'
    ) {
        return true;
    }
    if (reqPath === '/scripts/brand-mark.js') return true;
    if (reqPath === '/icon.svg' || reqPath === '/icon-mark.svg') return true;

    if (needsMmx) {
        return (
            reqPath === '/mmx-setup' ||
            reqPath === '/api/account/complete-mmx-setup' ||
            reqPath === '/scripts/mmx-setup.js'
        );
    }
    if (needsPassword) {
        return (
            reqPath === '/change-password' ||
            reqPath === '/api/account/complete-password-setup' ||
            reqPath === '/scripts/change-password.js'
        );
    }
    return false;
}

function accountSetupMiddleware(req, res, next) {
    const user = req.dashboardUser;
    if (!isRealDashboardUser(user)) {
        next();
        return;
    }
    const needsMmx = userNeedsMmxSetup(user.username);
    const needsPassword = userNeedsPasswordChange(user.username);
    if (!needsMmx && !needsPassword) {
        next();
        return;
    }
    if (isAccountSetupAllowedPath(req.path, needsMmx, needsPassword)) {
        next();
        return;
    }
    if (isApiRequest(req)) {
        res.status(403).json({
            success: false,
            error: needsMmx
                ? 'Complete Macromatix setup before continuing.'
                : 'You must set a new password before continuing.',
            mustCompleteMmxSetup: needsMmx,
            mustChangePassword: needsPassword,
        });
        return;
    }
    res.redirect(needsMmx ? '/mmx-setup' : '/change-password');
}

function scrapePresenceMiddleware(req, res, next) {
    touchPresence(req);
    next();
}

app.use(ipAllowlistMiddleware);

app.get('/unlock', (req, res) => {
    res.redirect('/login');
});

app.get('/', (req, res) => {
    if (!isAuthenticated(req, DASHBOARD_ACCESS_KEY)) {
        res.redirect('/login');
        return;
    }
    const user = getRequestUser(req);
    if (!isRealDashboardUser(user)) {
        res.redirect('/login');
        return;
    }
    if (userNeedsMmxSetup(user.username)) {
        res.redirect('/mmx-setup');
        return;
    }
    if (userNeedsPasswordChange(user.username)) {
        res.redirect('/change-password');
        return;
    }
    res.redirect(getLoginRedirectPath(user));
});

app.get('/login', (req, res) => {
    if (isAuthenticated(req, DASHBOARD_ACCESS_KEY)) {
        const user = getRequestUser(req);
        if (!isRealDashboardUser(user)) {
            res.sendFile(path.join(paths.users.public, 'login.html'));
            return;
        }
        if (userNeedsMmxSetup(user.username)) {
            res.redirect('/mmx-setup');
            return;
        }
        if (userNeedsPasswordChange(user.username)) {
            res.redirect('/change-password');
            return;
        }
        const dest = getLoginRedirectPath(user);
        res.redirect(dest === '/login' ? '/login' : dest);
        return;
    }
    res.sendFile(path.join(paths.users.public, 'login.html'));
});

app.get('/admin', (req, res) => {
    if (isAuthenticated(req, DASHBOARD_ACCESS_KEY)) {
        const user = getRequestUser(req);
        if (isSuperAdminUser(user) || hasMultiStoreScope(user)) {
            res.redirect(getMicOverviewPath());
            return;
        }
        res.redirect(getKioskRedirectPath(user));
        return;
    }
    res.sendFile(path.join(paths.users.public, 'admin-login.html'));
});

app.get('/kiosk', (req, res) => {
    if (isAuthenticated(req, DASHBOARD_ACCESS_KEY)) {
        const user = getRequestUser(req);
        if (isAdminUser(user)) {
            res.redirect('/admin');
            return;
        }
        res.redirect(getKioskRedirectPath(user));
        return;
    }
    res.sendFile(path.join(paths.users.public, 'kiosk-login.html'));
});

app.get(['/Create-Account', '/create-account'], (req, res) => {
    if (req.dashboardUser && canUserCreateAccounts(req.dashboardUser)) {
        res.redirect('/Admin/Settings?focusCreate=1#accounts-create');
        return;
    }
    res.sendFile(path.join(paths.users.public, 'create-account.html'));
});

app.get(['/Create-Account/details', '/create-account/details'], (req, res) => {
    res.redirect('/Create-Account');
});

app.post(['/Create-Account/verify', '/create-account/verify'], (req, res) => {
    if (!authRequired()) {
        res.status(503).json({ success: false, error: 'Authentication is not configured.' });
        return;
    }
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const user = authenticate(username, password);
    if (!user || !canUserCreateAccounts(user)) {
        logAuthLoginFailed(req, username, 'create-account gate');
        res.status(401).json({
            success: false,
            error: 'Sign in with a Manager, Store, Area, Market, or IT account to create accounts.',
        });
        return;
    }
    setAccountGateCookie(res, user);
    logAuthLogin(req, user);
    res.json({ success: true, nextPath: '/Create-Account' });
});

app.post('/login', (req, res) => {
    if (!authRequired()) {
        if (wantsJsonResponse(req)) {
            res.json({ success: true, welcomeName: '', defaultPath: '/login' });
            return;
        }
        res.redirect('/login');
        return;
    }

    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || req.body?.accessKey || '');
    const remember = !(req.body?.remember === false || req.body?.remember === '0' || req.body?.remember === 0);

    const user = authenticate(username, password);
    if (!user) {
        logAuthLoginFailed(req, username);
        sendLoginFailure(req, res, 'Incorrect username or password.', '/login');
        return;
    }

    const admin = isAdminUser(user);
    setSessionCookie(res, user, remember, admin ? 'admin' : 'store');
    logAuthLogin(req, user);
    sendLoginSuccess(req, res, user, admin ? getAdminRedirectPath() : getLoginRedirectPath(user, 'mic'));
});

app.post('/admin/login', (req, res) => {
    if (!authRequired()) {
        res.redirect(getAdminRedirectPath());
        return;
    }
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const remember = !(req.body?.remember === false || req.body?.remember === '0' || req.body?.remember === 0);
    const user = authenticate(username, password);
    if (!user || (!isSuperAdminUser(user) && !hasMultiStoreScope(user))) {
        logAuthLoginFailed(req, username, 'admin login');
        sendLoginFailure(req, res, 'Market or area access required.', '/admin');
        return;
    }
    setSessionCookie(res, user, remember, 'admin');
    logAuthLogin(req, user);
    sendLoginSuccess(req, res, user, getMicOverviewPath());
});

app.post('/kiosk/login', (req, res) => {
    if (!authRequired()) {
        res.redirect('/login');
        return;
    }
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const remember = !(req.body?.remember === false || req.body?.remember === '0' || req.body?.remember === 0);
    const user = authenticate(username, password);
    if (!user) {
        logAuthLoginFailed(req, username, 'kiosk login');
        sendLoginFailure(req, res, 'Incorrect username or password.', '/kiosk');
        return;
    }
    if (isSuperAdminUser(user) || hasMultiStoreScope(user)) {
        sendLoginFailure(req, res, 'Market and area accounts should sign in at /login.', '/kiosk');
        return;
    }
    const store = singleStoreForUser(user);
    if (!store) {
        sendLoginFailure(req, res, 'Kiosk login requires a single-store account.', '/kiosk');
        return;
    }
    setSessionCookie(res, user, remember, 'kiosk');
    logAuthLogin(req, user);
    sendLoginSuccess(req, res, user, getKioskRedirectPath(user));
});

app.get('/api/account/login-ui', (req, res) => {
    const username = String(req.query.username || '').trim();
    res.json({
        success: true,
        dualLogin: isStorePatternUsername(username),
    });
});

app.get('/api/dashboard/meta', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...getDashboardMeta() });
});

app.post('/unlock', (req, res) => {
    const password = String(req.body?.accessKey || '');
    if (!authRequired()) {
        if (wantsJsonResponse(req)) {
            res.json({ success: true, welcomeName: '', defaultPath: getMicOverviewPath() });
            return;
        }
        res.redirect(getMicOverviewPath());
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
    res.clearCookie(SESSION_COOKIE, sessionCookieClearOptions());
    res.clearCookie(LEGACY_COOKIE, sessionCookieClearOptions());
    res.clearCookie(NOLOGIN_COOKIE, nologinCookieClearOptions());
    res.clearCookie(ENTRY_COOKIE, sessionCookieClearOptions());
    res.redirect('/login');
});

/** Kiosk link - sets a long-lived single-store cookie and serves the dashboard in-place (no redirect). */
const DASHBOARD_HTML_PATH = path.join(paths.dashboard.public, 'index.html');

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

    res.clearCookie(SESSION_COOKIE, sessionCookieClearOptions());
    res.clearCookie(LEGACY_COOKIE, sessionCookieClearOptions());
    res.cookie(NOLOGIN_COOKIE, token, nologinCookieOptions());
    console.log(`[Auth] Nologin: store ${storeNumber} from ${getRequestIp(req)}`);
    try {
        await sendKioskDashboard(res, token);
    } catch (err) {
        console.error('[Auth] Nologin dashboard send failed:', err.message);
        res.status(500).send('Dashboard unavailable');
    }
});

/** Login page assets - must be reachable before authentication (for sign-in screen animation). */
for (const loginAsset of ['scripts/brand-mark.js', 'styles/brand-mark.css', 'styles/page-scroll.css', 'styles/nav-back.css', 'scripts/nav-back.js']) {
    const handler = (_req, res) => {
        res.sendFile(path.join(paths.sharedPublic, loginAsset));
    };
    app.get(`/shared/${loginAsset}`, handler);
    app.get(`/${loginAsset}`, handler);
}

app.use(dashboardAuthMiddleware);
app.use(accountSetupMiddleware);
app.use(scrapePresenceMiddleware);

// Middleware to serve static files. `index: false` so `/` is handled by our store-picker route below
// rather than being auto-served from public/index.html (the per-store dashboard).
app.use('/shared', express.static(paths.sharedPublic, { index: false }));
// Also serve shared assets at the root so legacy references like /scripts/app-paths.js keep working.
app.use(express.static(paths.sharedPublic, { index: false }));
app.use(express.static(paths.dashboard.public, { index: false }));
app.use(express.static(paths.vendors.public, { index: false }));
app.use(express.static(paths.users.public, { index: false }));
app.use(express.static(paths.tacaudit.public, { index: false }));
app.use(express.static(paths.legacy.public, { index: false }));
app.use(require('../smg/src/routes'));
app.use(require('../nsf/src/routes'));

function isSalesCacheFresh() {
    if (!salesCache || !salesCacheAt) return false;
    return (Date.now() - salesCacheAt) < (SALES_CACHE_SECONDS * 1000);
}

function getSalesUpdatedAt() {
    if (lastSalesScrapeCompletedAt) return String(lastSalesScrapeCompletedAt);
    if (salesCache?.timestamp) return String(salesCache.timestamp);
    if (salesCacheAt) return new Date(salesCacheAt).toISOString();
    return null;
}

function noteStoreScrapeSuccess(storeNumber, when = Date.now()) {
    const key = String(storeNumber || '').trim();
    if (!key) return;
    storeLastScrapedAt.set(key, when);
}

function countMeaningfulScrapeStores(stores) {
    if (!Array.isArray(stores)) return 0;
    return stores.filter((s) => storeHasMeaningfulData(s) && !s.error).length;
}

/** Pick stores due for the next interval tick (per-store logins are slow — rotate batches). */
function pickStoresForIntervalScrape(now = Date.now()) {
    const listed = getStoreList().filter((s) => getStoreScrapePhase(s, now) === 'active');
    const withCreds = listed.filter((s) => storeHasMmxCredentials(s.storeNumber));
    const due = withCreds
        .filter((s) => {
            const last = storeLastScrapedAt.get(String(s.storeNumber)) || 0;
            return now - last >= STORE_SCRAPE_STALE_MS;
        })
        .sort(
            (a, b) =>
                (storeLastScrapedAt.get(String(a.storeNumber)) || 0) -
                (storeLastScrapedAt.get(String(b.storeNumber)) || 0)
        );
    if (!due.length) return [];
    return due.slice(0, SCRAPE_BATCH_SIZE).map((s) => String(s.storeNumber));
}

function prepareSalesScrapeOptions(options = {}) {
    const reason = String(options.scrapeReason || '').trim();
    if (reason === 'interval' && !options.storeNumbers?.length && !options.storeNumber) {
        const batch = pickStoresForIntervalScrape();
        if (!batch.length) return { ...options, skipScrape: true };
        return { ...options, storeNumbers: batch };
    }
    return options;
}

function getSalesScrapeStatus(user) {
    const tz = process.env.DASHBOARD_TIME_ZONE || process.env.MMX_TIME_ZONE || 'Australia/Melbourne';
    let stores = getStoreList();
    if (user) stores = filterStoresForUser(user, stores);
    const storeNums = new Set(stores.map((s) => String(s.storeNumber)));
    const credentialed = stores.filter((s) => storeHasMmxCredentials(s.storeNumber));
    const activeCredentialed = credentialed.filter((s) => getStoreScrapePhase(s) === 'active');
    const withData = (salesCache?.stores || []).filter(
        (s) => storeNums.has(String(s.storeNumber)) && storeHasMeaningfulData(s)
    );
    return {
        salesUpdatedAt: getSalesUpdatedAt(),
        inFlight: Boolean(salesInFlight),
        deferred: salesScrapeShouldDefer(),
        credentialedStores: credentialed.length,
        activeCredentialedStores: activeCredentialed.length,
        storesWithSalesData: withData.length,
        timeZone: tz,
    };
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
        `[Dashboard] Scrape cycle complete - ${when} ${tz} | ${stores.length} store(s): ${summary || '(none)'}`
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
    resetSalesScrapeAbort();
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
                        registerSalesScrapeBrowser(browser);
                    },
                }),
                SCRAPE_TIMEOUT_MS,
                async () => {
                    if (!activeBrowser) return;
                    console.warn('API: Closing active browser after scrape timeout');
                    await activeBrowser.close();
                    clearSalesScrapeBrowser(activeBrowser);
                }
            );
        } catch (error) {
            if (activeBrowser) clearSalesScrapeBrowser(activeBrowser);
            if (error?.aborted || error instanceof MmxWorkAbortedError) {
                throw error;
            }
            lastError = error;
            console.error(`API: Scrape attempt ${attempt}/${attempts} failed:`, error.message);
        }
    }
    throw lastError;
}

function sumHourly(arr) {
    return Array.isArray(arr) ? arr.reduce((sum, v) => sum + (Number(v) || 0), 0) : 0;
}

/** Does a store payload carry usable hourly data (vs an empty/errored placeholder)? */
function storeHasData(store) {
    return Boolean(
        store &&
            ((Array.isArray(store.actual) && store.actual.length) ||
                (Array.isArray(store.forecast) && store.forecast.length))
    );
}

/** Non-empty arrays that are not all zeros (MMX often returns zeros after close). */
function storeHasMeaningfulData(store) {
    if (!store || store.error) return false;
    return sumHourly(store.actual) > 0 || sumHourly(store.forecast) > 0;
}

const POST_CLOSE_SNAPSHOT_DIR = path.join(paths.dashboard.data, 'sales-snapshots');

function postCloseSnapshotPath(storeNumber) {
    const key = String(storeNumber || '').replace(/[^0-9a-z]/gi, '');
    return path.join(POST_CLOSE_SNAPSHOT_DIR, `${key || 'unknown'}.json`);
}

function computeSssgForStore(store) {
    if (!store || !storeHasMeaningfulData(store)) return null;
    const dateKey = getStoreDateKey(store);
    const slots = getCachedSssgLy(store.storeNumber, dateKey);
    if (!Array.isArray(slots) || !slots.length) return store.sssgPercent != null ? store.sssgPercent : null;
    const cfg = getStoreConfig(store.storeNumber);
    const timeZone =
        String(store.timeZone || '').trim() ||
        cfg?.timeZone ||
        process.env.DASHBOARD_TIME_ZONE ||
        'Australia/Melbourne';
    return computeSssgPercent({
        slots,
        actual: store.actual,
        forecast: store.forecast,
        openHour: store.openHour,
        closeHour: store.closeHour,
        timeZone,
        storeNumber: store.storeNumber,
    });
}

function finalizeEndOfYesterdaySssg(store, now = new Date()) {
    if (!store?.storeNumber) return;
    const snap = store.postCloseSnapshot || loadPostCloseSnapshotFromDisk(store.storeNumber);
    finalizePastWeekDays(store, {
        now,
        postCloseSnapshot: snap,
        getSlots: (storeNumber, dateKey) => getCachedSssgLy(storeNumber, dateKey),
    });
}

function syncSssgWeeklyForStore(store, { finalize = false } = {}) {
    if (!store?.storeNumber || !storeHasMeaningfulData(store)) return;
    const slots = getCachedSssgLy(store.storeNumber, getStoreDateKey(store));
    if (!Array.isArray(slots) || !slots.length) return;
    if (finalize) {
        captureEndOfDaySssg(store, slots);
    } else {
        updateTodayPartialInLedger(store, slots);
    }
}

function capturePostCloseSnapshot(store, options = {}) {
    if (!storeHasMeaningfulData(store)) return;
    const cfg = getStoreConfig(store.storeNumber) || {};
    const timeZone =
        String(store.timeZone || '').trim() ||
        cfg?.timeZone ||
        process.env.DASHBOARD_TIME_ZONE ||
        'Australia/Melbourne';
    const dateKey =
        options.historyDateKey ||
        getStoreDateKey({ storeNumber: store.storeNumber, timeZone }, options.now || new Date());
    const sssgPercent =
        store.sssgPercent != null ? store.sssgPercent : computeSssgForStore(store);
    const snap = {
        capturedAt: new Date().toISOString(),
        dateKey,
        openHour: store.openHour,
        closeHour: store.closeHour,
        actual: [...store.actual],
        forecast: [...store.forecast],
        pendingVendors: Array.isArray(store.pendingVendors) ? [...store.pendingVendors] : [],
        sssgPercent: sssgPercent != null ? sssgPercent : null,
    };
    store.postCloseSnapshot = snap;
    try {
        fsSync.mkdirSync(POST_CLOSE_SNAPSHOT_DIR, { recursive: true });
        fsSync.writeFileSync(postCloseSnapshotPath(store.storeNumber), JSON.stringify(snap, null, 2), 'utf8');
    } catch (err) {
        console.warn(`[Dashboard] Could not write post-close snapshot for ${store.storeNumber}:`, err.message);
    }
    if (options.recordForecastHistory) {
        tryFinalizeForecastHistory(store, dateKey, snap, options);
    }
}

function tryFinalizeForecastHistory(store, dateKey, snapshot, options = {}) {
    const storeNumber = String(store?.storeNumber || '').trim();
    const date = String(dateKey || snapshot?.dateKey || '').trim();
    if (!storeNumber || !date || !snapshot) return null;
    try {
        return finalizeForecastHistoryFromSnapshot(storeNumber, date, snapshot, {
            source: options.historySource || 'live-scrape',
            force: options.forceFinalize,
        });
    } catch (err) {
        console.warn(`[Forecast] Could not finalize hourly history for ${storeNumber} ${date}:`, err.message);
        return null;
    }
}

function finalizeForecastHistoryBeforeClear(store, listedStore, now = new Date()) {
    const storeNumber = String(store?.storeNumber || '').trim();
    if (!storeNumber) return;
    const snap = store.postCloseSnapshot || loadPostCloseSnapshotFromDisk(storeNumber);
    if (!snap?.actual?.length) return;
    const cfg = getStoreConfig(storeNumber) || listedStore || {};
    const dateKey =
        snap.dateKey ||
        getStoreDateKey(
            { storeNumber, timeZone: cfg.timeZone || store.timeZone },
            snap.capturedAt ? new Date(snap.capturedAt) : now
        );
    tryFinalizeForecastHistory(store, dateKey, snap, { forceFinalize: true, historySource: 'live-scrape' });
}

function sweepForecastHistoryOnStartup() {
    try {
        const storeNumbers = getStoreList().map((s) => String(s.storeNumber)).filter(Boolean);
        const result = sweepForecastHistoryFromSnapshots(POST_CLOSE_SNAPSHOT_DIR, storeNumbers);
        if (result.imported > 0) {
            console.log(
                `[Forecast] Startup history sweep: backfilled ${result.imported} day(s) for ${result.stores.length} store(s).`
            );
        }
    } catch (err) {
        console.warn('[Forecast] Startup history sweep failed:', err.message);
    }
}

function loadPostCloseSnapshotFromDisk(storeNumber) {
    const filePath = postCloseSnapshotPath(storeNumber);
    if (!fsSync.existsSync(filePath)) return null;
    try {
        const raw = JSON.parse(fsSync.readFileSync(filePath, 'utf8'));
        if (!raw || !Array.isArray(raw.actual) || !Array.isArray(raw.forecast)) return null;
        if (sumHourly(raw.actual) <= 0 && sumHourly(raw.forecast) <= 0) return null;
        return raw;
    } catch {
        return null;
    }
}

function restorePostCloseSnapshot(store) {
    const snap = store.postCloseSnapshot || loadPostCloseSnapshotFromDisk(store.storeNumber);
    if (!snap) return false;
    store.actual = [...snap.actual];
    store.forecast = [...snap.forecast];
    store.pendingVendors = Array.isArray(snap.pendingVendors) ? [...snap.pendingVendors] : [];
    store.sssgPercent =
        snap.sssgPercent != null ? snap.sssgPercent : computeSssgForStore(store);
    store.postCloseSnapshot = snap;
    store.retained = true;
    return true;
}

function clearPostCloseSnapshot(storeNumber) {
    const filePath = postCloseSnapshotPath(storeNumber);
    try {
        if (fsSync.existsSync(filePath)) fsSync.unlinkSync(filePath);
    } catch (_) {
        /* ignore */
    }
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
        if (storeHasMeaningfulData(fresh) && !fresh.error) return fresh;
        const prev = prevByNum.get(key);
        if (storeHasMeaningfulData(prev)) {
            return {
                ...prev,
                openHour: Number.isFinite(fresh.openHour) ? fresh.openHour : prev.openHour,
                closeHour: Number.isFinite(fresh.closeHour) ? fresh.closeHour : prev.closeHour,
                storeName: fresh.storeName || prev.storeName,
                pendingVendors: Array.isArray(fresh.pendingVendors) ? fresh.pendingVendors : prev.pendingVendors,
                sssgPercent: fresh.sssgPercent != null ? fresh.sssgPercent : prev.sssgPercent,
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

    resetWeeklyLedgerIfNeeded(now);

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

        const inPostCloseGrace = isPostCloseSalesGrace(listedStore, now);

        if (phase === 'idle' && !inPostCloseGrace) {
            if (prev && prev !== 'idle') {
                finalizeForecastHistoryBeforeClear(store, listedStore, now);
                clearStoreScrapeCaches(key);
            }
            store.actual = [];
            store.forecast = [];
            store.pendingVendors = [];
            delete store.error;
            delete store.retained;
            delete store.postCloseSnapshot;
            store.scrapePhase = 'idle';
        } else if (phase === 'retain' || inPostCloseGrace) {
            if (storeHasMeaningfulData(store)) {
                const todayKey = getStoreDateKey(listedStore, now);
                const weekStart = getMelbourneWeekStart(now);
                const todayEntry = getStoreDayEntry(key, todayKey, weekStart);
                if (prev === 'active' || !todayEntry?.finalized) {
                    syncSssgWeeklyForStore(store, { finalize: true });
                }
            }
            if (!storeHasMeaningfulData(store)) {
                restorePostCloseSnapshot(store);
            }
            if (storeHasMeaningfulData(store)) {
                const todayKey = getStoreDateKey(listedStore, now);
                capturePostCloseSnapshot(store, {
                    recordForecastHistory: true,
                    historyDateKey: todayKey,
                });
            }
            store.scrapePhase = 'retain';
        } else {
            if (prev === 'idle') {
                finalizeEndOfYesterdaySssg(store, now);
                resetScheduledOrdersForNewDay(key);
                resetSssgForNewDay(key);
                resetWeeklyLedgerIfNeeded(now);
            }
            if (!storeHasMeaningfulData(store)) {
                restorePostCloseSnapshot(store);
            }
            if (store.sssgPercent == null && storeHasMeaningfulData(store)) {
                store.sssgPercent = computeSssgForStore(store);
            }
            if (storeHasMeaningfulData(store)) {
                syncSssgWeeklyForStore(store, { finalize: false });
                capturePostCloseSnapshot(store);
            }
            store.scrapePhase = 'active';
        }

        lastScrapePhaseByStore.set(key, phase);
    }

    return cache;
}

function logScrapeStart(options = {}) {
    const reason = options.scrapeReason || 'refresh';
    const nums = Array.isArray(options.storeNumbers) ? options.storeNumbers.map(String) : [];
    if (nums.length && nums.length <= 6) {
        console.log(`[Dashboard] Sales scrape (${reason}) - ${nums.join(', ')}`);
    } else if (nums.length) {
        console.log(`[Dashboard] Sales scrape (${reason}) - ${nums.length} stores`);
    } else {
        console.log(`[Dashboard] Sales scrape (${reason}) - full market`);
    }
}

function salesScrapeShouldDefer() {
    return (
        isMmxResourceBusy() ||
        hasPendingHigherPriority(PRIORITY.SCRAPE) ||
        hasBlockingWorkForPriority(PRIORITY.SCRAPE)
    );
}

/** Run a scrape and merge it into the cache (per-store retention). De-duped via salesInFlight. */
function runScrapeIntoCache(options = {}) {
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

            if (salesScrapeShouldDefer()) {
                console.log('[Dashboard] Sales scrape paused - higher-priority MMX work queued or in progress');
                if (!salesCache) {
                    salesCache = buildCacheShellFromStoreList();
                    salesCacheAt = Date.now();
                }
                applyScrapeScheduleToCache(salesCache);
                return salesCache;
            }

            const scrapeOpts = prepareSalesScrapeOptions({ ...options });
            if (scrapeOpts.skipScrape) {
                return salesCache || buildCacheShellFromStoreList();
            }

            logScrapeStart(scrapeOpts);
            const result = await runWithPriority(PRIORITY.SCRAPE, {
                type: 'sales-scrape',
                label: `sales scrape (${scrapeOpts.scrapeReason || 'manual'})`,
                run: () => scrapeWithRetry(scrapeOpts),
            });
            const scrapedStores = Array.isArray(result.stores) ? result.stores : [];
            const meaningfulCount = countMeaningfulScrapeStores(scrapedStores);
            const scrapeSkipped = Boolean(result.scrapeSkipped) && meaningfulCount === 0;

            if (!scrapeSkipped && meaningfulCount > 0) {
                const when = Date.now();
                for (const store of scrapedStores) {
                    if (storeHasMeaningfulData(store) && !store.error) {
                        noteStoreScrapeSuccess(store.storeNumber, when);
                    }
                }
                lastSalesScrapeCompletedAt = result.timestamp || new Date(when).toISOString();
            }

            const fresh = {
                success: true,
                timestamp: scrapeSkipped
                    ? salesCache?.timestamp || result.timestamp
                    : result.timestamp || lastSalesScrapeCompletedAt,
                stores: scrapedStores,
            };
            salesCache = {
                success: true,
                timestamp: fresh.timestamp,
                stores: mergeStoresPreservingGood(salesCache, fresh),
            };
            if (!scrapeSkipped && meaningfulCount > 0) {
                salesCacheAt = Date.now();
            }
            for (const store of salesCache.stores) {
                if (storeHasMeaningfulData(store)) {
                    syncSssgWeeklyForStore(store, { finalize: false });
                    capturePostCloseSnapshot(store);
                }
            }
            applyScrapeScheduleToCache(salesCache);
            logDashboardScrapeComplete(salesCache);
            return salesCache;
        } catch (error) {
            if (error?.aborted || error instanceof MmxWorkAbortedError) {
                console.log('[Dashboard] Sales scrape aborted - stock count / orders in progress');
                if (!salesCache) {
                    salesCache = buildCacheShellFromStoreList();
                    salesCacheAt = Date.now();
                }
                applyScrapeScheduleToCache(salesCache);
                return salesCache;
            }
            notifyScrapeFailure(error, 'scrape cycle').catch(() => {});
            throw error;
        }
    })();
    salesInFlight.catch(() => {}).finally(() => {
        salesInFlight = null;
    });
    return salesInFlight;
}

/** After MMX logins are saved, scrape all credentialed stores once the batch settles. */
let bootstrapScrapeTimer = null;
const bootstrapScrapeStores = new Set();

function queueStoreLoginBootstrapScrape(storeNumber) {
    const num = String(storeNumber || '').trim();
    if (!num || isTestStore(num)) return;
    bootstrapScrapeStores.add(num);
    if (bootstrapScrapeTimer) clearTimeout(bootstrapScrapeTimer);
    bootstrapScrapeTimer = setTimeout(() => {
        bootstrapScrapeTimer = null;
        const stores = [...bootstrapScrapeStores];
        bootstrapScrapeStores.clear();
        console.log(
            `[Dashboard] Bootstrap sales scrape after login save (${stores.length} store${stores.length === 1 ? '' : 's'}: ${stores.join(', ')})`
        );
        runScrapeIntoCache({
            scrapeReason: 'store-login-setup',
            bypassScrapeSchedule: true,
            storeNumbers: stores,
        }).catch((error) => {
            console.error('[Dashboard] Bootstrap sales scrape failed:', error.message);
            notifyScrapeFailure(error, 'store login bootstrap scrape').catch(() => {});
        });
    }, 5000);
}

async function getSalesDataCached() {
    applyScrapeScheduleToCache(salesCache);

    if (salesScrapeShouldDefer()) {
        if (!salesCache) {
            salesCache = buildCacheShellFromStoreList();
            salesCacheAt = Date.now();
            applyScrapeScheduleToCache(salesCache);
        }
        return salesCache;
    }

    if (salesCache) {
        if (anyStoreInActiveScrapeWindow() && !isSalesCacheFresh() && !salesInFlight) {
            runScrapeIntoCache({ scrapeReason: 'on-demand' });
        }
        return salesCache;
    }

    if (!anyStoreInActiveScrapeWindow()) {
        salesCache = buildCacheShellFromStoreList();
        salesCacheAt = Date.now();
        applyScrapeScheduleToCache(salesCache);
        return salesCache;
    }

    return runScrapeIntoCache({ scrapeReason: 'on-demand' });
}

/** Trading hours for a store from `.storelist`, falling back to defaults. */
function storeHours(storeNumber) {
    const cfg = getStoreConfig(storeNumber);
    return {
        openHour: cfg ? cfg.openHour : DEFAULT_OPEN_HOUR,
        closeHour: cfg ? cfg.closeHour : DEFAULT_CLOSE_HOUR,
        timeZone: cfg?.timeZone || process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne',
    };
}

/** Empty per-store grid (no actual/forecast yet) so the dashboard can still render. */
function emptyStorePayload(storeNumber, storeName) {
    const hours = storeHours(storeNumber);
    return {
        actual: [],
        forecast: [],
        pendingVendors: [],
        sssgPercent: null,
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
              timeZone:
                  store.timeZone ||
                  storeHours(store.storeNumber).timeZone ||
                  process.env.DASHBOARD_TIME_ZONE ||
                  'Australia/Melbourne',
              postCloseRetainHours: POST_CLOSE_RETAIN_HOURS,
              sssgPercent: store.sssgPercent != null ? store.sssgPercent : null,
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

function resolveAreaFromAdminList(areaParam) {
    const raw = String(areaParam || '').trim();
    if (!raw || /^market\s*\d+$/i.test(raw)) return null;
    for (const name of ADMIN_ROTATE_AREAS) {
        const wanted = areaMatchTokens(areaParam);
        const areaTokens = areaMatchTokens(name);
        for (const token of wanted) {
            if (areaTokens.has(token)) return { name, key: normalizeAreaKey(name) };
        }
    }
    return null;
}

function areaParamMatchesStore(areaParam, store) {
    const wanted = areaMatchTokens(areaParam);
    const storeTokens = areaMatchTokens(store.areaKey);
    areaMatchTokens(store.area).forEach((t) => storeTokens.add(t));
    for (const token of wanted) {
        if (storeTokens.has(token)) return true;
    }
    return false;
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
    if (!slice || isSuperAdminUser(user)) return slice;
    const allowed = new Set((getEffectiveStoresForUser(user) || []).map(String));
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

function assertDfscAccess(req, res) {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserAccessDfsc(user)) {
        if (isApiRequest(req)) {
            res.status(403).json({
                success: false,
                error: 'DFSC is not available on shared store login accounts. Ask your manager to create a personal crew account for you.',
                canAccessDfsc: false,
            });
            return false;
        }
        res.status(403).send('DFSC is not available for this account type.');
        return false;
    }
    return true;
}

function dfscRequestUserContext(req) {
    const user = req.dashboardUser || getRequestUser(req);
    const conductorFullName = getDfscConductorName(user);
    const accountLevel = getAccountLevel(user);
    const canCompleteAudits = canUserCompleteAudits(user);
    const canStartAudits = canUserStartAudits(user);
    return {
        user,
        username: user?.username || '',
        conductorFullName,
        accountLevel,
        canCompleteAudits,
        canStartAudits,
        isAdmin: isAdminUser(user),
        canAccessDfsc: canUserAccessDfsc(user),
        access: {
            username: user?.username || '',
            conductorFullName,
            accountLevel,
            canCompleteAudits,
            canStartAudits,
            canAccessDfsc: canUserAccessDfsc(user),
            isAdmin: isAdminUser(user),
        },
    };
}

function assertCanStartAudit(req, res) {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserStartAudits(user)) {
        const message = 'Team member accounts cannot start new audits.';
        if (isApiRequest(req)) {
            res.status(403).json({ success: false, error: message, canStartAudits: false });
            return false;
        }
        res.status(403).send(message);
        return false;
    }
    return true;
}

function assertCanCompleteAudit(req, res) {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserCompleteAudits(user)) {
        const message =
            'Only a manager or above can mark this audit as complete. Team members can contribute while it is in progress.';
        if (isApiRequest(req)) {
            res.status(403).json({ success: false, error: message, canCompleteAudits: false });
            return false;
        }
        res.status(403).send(message);
        return false;
    }
    return true;
}

function canViewTacauditAdminSummary(user) {
    return isRealDashboardUser(user) && (isAdminUser(user) || hasMultiStoreScope(user));
}

function assertCoachAuditAccess(req, res) {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canAccessCoachAudits(user)) {
        res.status(403).json({ success: false, error: 'Market access or above is required for this audit.' });
        return false;
    }
    return true;
}

function makePeriodAuditSessionAccess(storeModule) {
    return function assertPeriodAuditSessionAccess(req, res, session, { reopen = false } = {}) {
        if (!session) {
            res.status(404).json({ success: false, error: 'Session not found.' });
            return false;
        }
        const ctx = dfscRequestUserContext(req);
        if (ctx.isAdmin) return true;
        if (session.status === 'completed') {
            if (reopen && !storeModule.userOwnsSession(session, ctx.username, ctx.conductorFullName)) {
                res.status(403).json({
                    success: false,
                    error: 'Only the crew member who conducted this audit can reopen it for editing.',
                });
                return false;
            }
            return true;
        }
        const check = storeModule.canUserAccessSession(session, ctx.access);
        if (!check.ok) {
            res.status(check.status || 403).json({ success: false, error: check.error });
            return false;
        }
        return true;
    };
}

function resolveTacauditAreaScope(user, { area: areaParam = '', store: storeParam = '' } = {}) {
    if (!canViewTacauditAdminSummary(user)) {
        return { ok: false, status: 403, error: 'Admin or area access required.' };
    }
    const store = String(storeParam || '').trim();
    const rawAreaParam = String(areaParam || '').trim();
    let areaName = rawAreaParam;
    if (areaName && /^market\s*\d+$/i.test(areaName)) {
        areaName = '';
    }
    if (areaName) {
        const resolved = resolveAreaFromAdminList(areaName);
        if (resolved?.name) areaName = resolved.name;
    }
    if (!areaName && store) {
        const cfg = getStoreConfig(store);
        areaName = String(cfg?.area || '').trim();
    }
    const accessible = getAccessibleAreasForUser(user);
    if (!areaName && accessible.length === 1) {
        areaName = accessible[0];
    }
    if (areaName && !isAdminUser(user) && !userCanAccessArea(user, areaName)) {
        return { ok: false, status: 403, error: 'You do not have access to this area.' };
    }
    let stores = filterStoresForUser(user, buildStoresCfgWithAreas());
    if (areaName) {
        stores = storesForArea(areaName, stores);
    }
    if (!stores.length && accessible.length > 0) {
        for (const candidate of accessible) {
            const scoped = storesForArea(candidate, filterStoresForUser(user, buildStoresCfgWithAreas()));
            if (scoped.length) {
                areaName = candidate;
                stores = scoped;
                break;
            }
        }
    }
    if (!stores.length) {
        return { ok: false, status: 404, error: 'No stores in scope for this area.' };
    }
    return { ok: true, areaName, stores, accessibleAreas: accessible };
}

function assertDfscSessionAccess(req, res, session, { reopen = false } = {}) {
    if (!session) {
        res.status(404).json({ success: false, error: 'Session not found.' });
        return false;
    }
    const ctx = dfscRequestUserContext(req);
    if (session.status === 'completed') {
        if (reopen && !dfscUserOwnsSession(session, ctx.username, ctx.conductorFullName)) {
            res.status(403).json({
                success: false,
                error: 'Only the crew member who conducted this audit can reopen it for editing.',
            });
            return false;
        }
        return true;
    }
    const check = canUserAccessSession(session, ctx.access);
    if (!check.ok) {
        res.status(check.status || 403).json({ success: false, error: check.error });
        return false;
    }
    return true;
}

function assertPestWalkSessionAccess(req, res, session, { reopen = false } = {}) {
    if (!session) {
        res.status(404).json({ success: false, error: 'Session not found.' });
        return false;
    }
    const ctx = dfscRequestUserContext(req);
    if (ctx.isAdmin) return true;
    if (session.status === 'completed') {
        if (reopen && !pestWalkUserOwnsSession(session, ctx.username, ctx.conductorFullName)) {
            res.status(403).json({
                success: false,
                error: 'Only the crew member who conducted this audit can reopen it for editing.',
            });
            return false;
        }
        return true;
    }
    const check = canPestWalkUserAccessSession(session, ctx.access);
    if (!check.ok) {
        res.status(check.status || 403).json({ success: false, error: check.error });
        return false;
    }
    return true;
}

function assertSquareOneSessionAccess(req, res, session, { reopen = false } = {}) {
    if (!session) {
        res.status(404).json({ success: false, error: 'Session not found.' });
        return false;
    }
    const ctx = dfscRequestUserContext(req);
    if (ctx.isAdmin) return true;
    if (session.status === 'completed') {
        if (reopen && !squareOneUserOwnsSession(session, ctx.username, ctx.conductorFullName)) {
            res.status(403).json({
                success: false,
                error: 'Only the crew member who conducted this audit can reopen it for editing.',
            });
            return false;
        }
        return true;
    }
    const check = canSquareOneUserAccessSession(session, ctx.access);
    if (!check.ok) {
        res.status(check.status || 403).json({ success: false, error: check.error });
        return false;
    }
    return true;
}

function assertPsiSessionAccess(req, res, session, { reopen = false } = {}) {
    if (!session) {
        res.status(404).json({ success: false, error: 'Session not found.' });
        return false;
    }
    const ctx = dfscRequestUserContext(req);
    if (ctx.isAdmin) return true;
    if (session.status === 'completed') {
        if (reopen && !psiUserOwnsSession(session, ctx.username, ctx.conductorFullName)) {
            res.status(403).json({
                success: false,
                error: 'Only the crew member who conducted this inspection can reopen it for editing.',
            });
            return false;
        }
        return true;
    }
    const check = canPsiUserAccessSession(session, ctx.access);
    if (!check.ok) {
        res.status(check.status || 403).json({ success: false, error: check.error });
        return false;
    }
    return true;
}

function assertRgmCleaningSessionAccess(req, res, session, { reopen = false } = {}) {
    if (!session) {
        res.status(404).json({ success: false, error: 'Session not found.' });
        return false;
    }
    const ctx = dfscRequestUserContext(req);
    if (ctx.isAdmin) return true;
    if (session.status === 'completed') {
        if (reopen && !rgmCleaningUserOwnsSession(session, ctx.username, ctx.conductorFullName)) {
            res.status(403).json({
                success: false,
                error: 'Only the crew member who conducted this audit can reopen it for editing.',
            });
            return false;
        }
        return true;
    }
    const check = canRgmCleaningUserAccessSession(session, ctx.access);
    if (!check.ok) {
        res.status(check.status || 403).json({ success: false, error: check.error });
        return false;
    }
    return true;
}

async function dismissAuditLabelForStore(storeNumber, label) {
    const auditLabel = String(label || '').trim();
    if (!auditLabel) return;
    const state = await getAuditState(storeNumber);
    const dismissed = [...new Set([...(state.dismissed || []), auditLabel])];
    await saveAuditDismissals(storeNumber, dismissed);
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

function pendingVendorsFromSalesCache(storeNumber) {
    if (!salesCache?.stores) return [];
    const key = String(storeNumber || '').trim();
    const store = salesCache.stores.find((s) => String(s.storeNumber) === key);
    return Array.isArray(store?.pendingVendors) ? store.pendingVendors : [];
}

function pendingVendorLabelsForStockCount(req, storeNumber) {
    const dateKey = melbourneDateKey();
    let labels = getLastKnownPendingVendors(storeNumber, dateKey);
    if (!labels.length) {
        labels = pendingVendorsFromSalesCache(storeNumber);
    }
    if (wantsTestStockCountPending(req)) {
        const configured = listConfiguredVendors().map((v) => v.label);
        labels = [...new Set([...(Array.isArray(labels) ? labels : []), ...configured])].sort((a, b) =>
            a.localeCompare(b)
        );
    }
    return labels;
}

/** Crew accounts use their own MMX login for stock count; store tablet logins use Admin store credentials. */
function stockCountUsesPersonalMmx(user) {
    return Boolean(isRealDashboardUser(user) && !isPrimaryStoreLogin(user));
}

function maskMmxLoginForStatus(username) {
    const raw = String(username || '').trim();
    if (!raw) return '';
    if (raw.length <= 4) return `${raw.slice(0, 1)}***`;
    return `${raw.slice(0, 3)}***${raw.slice(-2)}`;
}

function mmxUserLoginBody(req) {
    return {
        mmxUsername: String(req.body?.mmxUsername || '').trim(),
        mmxPassword: String(req.body?.mmxPassword || ''),
        remember: !/^(0|false|no|off)$/i.test(String(req.body?.remember ?? 'true')),
    };
}

async function verifyAndOptionallySaveUserMmxLogin(req, dashboardUsername) {
    const { mmxUsername, mmxPassword, remember } = mmxUserLoginBody(req);
    if (!mmxUsername || !mmxPassword) {
        return { ok: false, status: 400, error: 'Macromatix username and password are required.' };
    }
    const verified = await verifyMacromatixLogin(mmxUsername, mmxPassword);
    if (!verified.ok) {
        return { ok: false, status: 400, error: verified.error || 'Macromatix login failed.' };
    }
    if (remember) {
        const saved = saveMmxCredentialsForUser(dashboardUsername, mmxUsername, mmxPassword);
        if (!saved.ok) {
            return { ok: false, status: 500, error: saved.error || 'Could not save Macromatix login.' };
        }
    }
    return { ok: true, mmxUsername, mmxPassword, remembered: remember };
}

function assertStockCountUserMmxLogin(req, res) {
    const user = req.dashboardUser || getRequestUser(req);
    if (!stockCountUsesPersonalMmx(user)) return true;
    const dashUser = String(user?.username || '').trim();
    const body = mmxUserLoginBody(req);
    if (body.mmxUsername && body.mmxPassword) return true;
    if (hasMmxCredentialsForUser(dashUser)) return true;
    res.status(403).json({
        success: false,
        needsMmxUserLogin: true,
        error: 'Enter your personal Macromatix login to send counts. This is recorded under your user in Macromatix.',
    });
    return false;
}

/** Pass store + signed-in user so MMX automation uses crew personal login when applicable. */
function mmxAutomationOptions(req, storeNumber, extra = {}) {
    const user = req.dashboardUser || getRequestUser(req);
    const personalMmx = stockCountUsesPersonalMmx(user);
    const body = mmxUserLoginBody(req);
    return {
        ...extra,
        storeNumber: String(storeNumber),
        dashboardUsername: String(user?.username || '').trim(),
        useDashboardUserMmx: personalMmx,
        requireDashboardUserMmx: personalMmx,
        ...(body.mmxUsername && body.mmxPassword
            ? { mmxUsername: body.mmxUsername, mmxPassword: body.mmxPassword }
            : {}),
    };
}

app.get('/welcome', (req, res) => {
    res.redirect('/login');
});

app.get('/stores', (_req, res) => {
    res.redirect(302, getMicOverviewPath());
});

function sendAdminOverviewPage(_req, res) {
    res.redirect(302, getMicOverviewPath());
}

function sendAdminSettingsPage(req, res) {
    const user = req.dashboardUser || getRequestUser(req);
    if (!user || (!canUserAccessAdminMenu(user) && !canUserManageStoreLogins(user))) {
        sendUnauthorized(req, res);
        return;
    }
    const bootId = getDashboardMeta().bootId;
    let html = fsSync.readFileSync(path.join(paths.users.public, 'admin.html'), 'utf8');
    html = html.replace(/src="(\/scripts\/[^"]+\.js)"/g, `src="$1?v=${bootId}"`);
    res.type('html').send(html);
}

app.get(/^\/admin\/overview\/?$/i, sendAdminOverviewPage);
app.get(/^\/Admin\/Overview\/?$/i, sendAdminOverviewPage);
app.get(/^\/admin\/settings\/?$/i, sendAdminSettingsPage);
app.get(/^\/Admin\/Settings\/?$/i, sendAdminSettingsPage);

app.get(/^\/Admin\/A(\d+)\/?$/i, requireMultiStoreScope, (req, res) => {
    res.sendFile(path.join(paths.dashboard.public, 'index.html'));
});

app.get(/^\/Admin\/teststore\/?$/i, requireMultiStoreScope, (req, res) => {
    if (!assertStoreAccess(req, res, TEST_STORE_SLUG)) return;
    res.sendFile(path.join(paths.dashboard.public, 'index.html'));
});

/** /Admin/3811 → /Admin/A22?store=3811 (client strips query after load). */
app.get(/^\/Admin\/(\d{3,6})\/?$/i, requireMultiStoreScope, (req, res) => {
    const storeNumber = (req.path.match(/^\/Admin\/(\d{3,6})\/?$/i) || [])[1];
    if (!assertStoreAccess(req, res, storeNumber)) return;
    const cfg = getStoreConfig(storeNumber);
    const areaCode = areaCodeFromValue(areaNameFromStore(cfg || {})) || 'A22';
    res.redirect(302, `${getAdminAreaPath(areaCode)}?store=${encodeURIComponent(storeNumber)}`);
});

app.get(/^\/admin\/A(\d+)\/?$/i, requireMultiStoreScope, (req, res) => {
    const n = (req.path.match(/^\/admin\/A(\d+)\/?$/i) || [])[1];
    res.redirect(302, getAdminAreaPath(`A${n}`));
});

app.get(/^\/admin\/(\d{3,6})\/?$/i, requireMultiStoreScope, (req, res) => {
    const storeNumber = (req.path.match(/^\/admin\/(\d{3,6})\/?$/i) || [])[1];
    res.redirect(302, `/Admin/${storeNumber}`);
});

app.get(/^\/admin\/teststore\/?$/i, requireMultiStoreScope, (_req, res) => {
    res.redirect(302, '/Admin/teststore');
});

// -- Unified overview (scope-aware tiles) + per-store sales dashboard --
function sendOverviewPage(req, res) {
    if (dashboardEntryFromRequest(req) === 'kiosk') {
        const user = req.dashboardUser || getRequestUser(req);
        res.redirect(getKioskRedirectPath(user));
        return;
    }
    const user = req.dashboardUser || getRequestUser(req);
    if (!user) {
        res.redirect('/login');
        return;
    }
    if (isNologinUser(user)) {
        sendForbidden(req, res, 'Overview is not available on no-login links.');
        return;
    }
    if (!isRealDashboardUser(user)) {
        sendUnauthorized(req, res);
        return;
    }
    if (getOverviewScope(user) === 'store') {
        const store = singleStoreForUser(user);
        if (!store || !assertStoreAccess(req, res, store)) return;
    }
    const bootId = getDashboardMeta().bootId;
    let html = fsSync.readFileSync(path.join(paths.users.public, 'mic.html'), 'utf8');
    html = html.replace(/src="(\/scripts\/[^"]+\.js)"/g, `src="$1?v=${bootId}"`);
    res.type('html').send(html);
}

app.get(/^\/overview\/?$/i, sendOverviewPage);

app.get(/^\/MIC\/Overview\/?$/i, (req, res) => {
    res.redirect(302, getMicOverviewPath());
});

app.get(/^\/MIC\/teststore\/?$/i, (req, res) => {
    if (dashboardEntryFromRequest(req) === 'kiosk') {
        res.redirect('/kiosk/teststore');
        return;
    }
    if (!assertStoreAccess(req, res, TEST_STORE_SLUG)) return;
    res.sendFile(path.join(paths.dashboard.public, 'index.html'));
});

app.get(/^\/MIC\/(\d{3,6})\/?$/i, (req, res) => {
    const storeNumber = (req.path.match(/^\/MIC\/(\d{3,6})\/?$/i) || [])[1];
    if (redirectNologinUserToWallDashboard(req, res, storeNumber)) return;
    if (dashboardEntryFromRequest(req) === 'kiosk') {
        res.redirect(`/kiosk/${storeNumber}`);
        return;
    }
    if (!assertStoreAccess(req, res, storeNumber)) return;
    res.sendFile(path.join(paths.dashboard.public, 'index.html'));
});

app.get(/^\/(\d{3,6})\/mic\/?$/i, (req, res) => {
    res.redirect(302, getMicOverviewPath());
});

app.get(/^\/(\d{3,6})\/MIC\/?$/i, (req, res) => {
    res.redirect(302, getMicOverviewPath());
});

// Kiosk wall dashboard - /kiosk/3811 (no back button; entry cookie kiosk).
app.get(/^\/kiosk\/teststore\/?$/i, (req, res) => {
    if (!assertStoreAccess(req, res, TEST_STORE_SLUG)) return;
    res.sendFile(path.join(paths.dashboard.public, 'index.html'));
});

app.get(/^\/kiosk\/(\d{3,6})\/?$/i, (req, res) => {
    const storeNumber = (req.path.match(/^\/kiosk\/(\d{3,6})\/?$/i) || [])[1];
    if (redirectNologinUserToWallDashboard(req, res, storeNumber)) return;
    if (!assertStoreAccess(req, res, storeNumber)) return;
    res.sendFile(path.join(paths.dashboard.public, 'index.html'));
});

// Legacy numeric store paths → MIC or Admin area workspace.
app.get(/^\/teststore\/?$/i, (req, res) => {
    if (dashboardEntryFromRequest(req) === 'kiosk') {
        res.redirect('/kiosk/teststore');
        return;
    }
    const user = req.dashboardUser || getRequestUser(req);
    if (user && (isSuperAdminUser(user) || hasMultiStoreScope(user))) {
        res.redirect(302, getAdminAreaPath('A22') + '?store=teststore');
        return;
    }
    res.redirect(302, getMicStorePath('teststore'));
});

app.get(/^\/(\d{3,6})\/?$/, (req, res) => {
    const storeNumber = (req.path.match(/^\/(\d{3,6})\/?$/) || [])[1];
    if (redirectNologinUserToWallDashboard(req, res, storeNumber)) return;
    if (dashboardEntryFromRequest(req) === 'kiosk') {
        res.redirect(`/kiosk/${storeNumber}`);
        return;
    }
    if (!assertStoreAccess(req, res, storeNumber)) return;
    const user = req.dashboardUser || getRequestUser(req);
    if (user && (isSuperAdminUser(user) || hasMultiStoreScope(user))) {
        const cfg = getStoreConfig(storeNumber);
        const areaCode = areaCodeFromValue(areaNameFromStore(cfg || {})) || 'A22';
        res.redirect(302, `${getAdminAreaPath(areaCode)}?store=${encodeURIComponent(storeNumber)}`);
        return;
    }
    res.redirect(302, getMicStorePath(storeNumber));
});

app.get(/^\/(area\/[a-z0-9-]+|a\d+)\/?$/i, (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!user || (!isSuperAdminUser(user) && !hasMultiStoreScope(user))) {
        // Store-scoped users have no business on area dashboards - send them home.
        res.redirect(302, '/');
        return;
    }
    if (user && (isSuperAdminUser(user) || hasMultiStoreScope(user))) {
        const codeMatch = req.path.match(/^\/(a\d+)\/?$/i);
        if (codeMatch) {
            const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
            res.redirect(302, `${getAdminAreaPath(codeMatch[1].toUpperCase())}${qs}`);
            return;
        }
        const areaSlugMatch = req.path.match(/^\/area\/([a-z0-9-]+)\/?$/i);
        if (areaSlugMatch) {
            const numMatch = areaSlugMatch[1].match(/(\d+)/);
            if (numMatch) {
                const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
                res.redirect(302, `${getAdminAreaPath(`A${numMatch[1]}`)}${qs}`);
                return;
            }
        }
    }
    res.sendFile(path.join(paths.users.public, 'area.html'));
});

function sendStockCountPage(req, res, storeNumber) {
    if (!assertStoreAccess(req, res, storeNumber)) return;
    res.sendFile(path.join(paths.vendors.public, 'stock-count.html'));
}

app.get(/^\/(teststore|\d{3,6})\/stock-count\/([a-z0-9-]+)\/?$/i, (req, res) => {
    const storeNumber = normalizeStoreKey((req.path.match(/^\/(teststore|\d{3,6})\/stock-count\/[a-z0-9-]+\/?$/i) || [])[1]);
    sendStockCountPage(req, res, storeNumber);
});

function sendDailyStockCountPage(req, res, storeNumber) {
    if (!assertStoreAccess(req, res, storeNumber)) return;
    const bootId = getDashboardMeta().bootId;
    const htmlPath = path.join(paths.vendors.public, 'daily-stock-count.html');
    let html = fsSync.readFileSync(htmlPath, 'utf8');
    html = html.replace(/src="(\/scripts\/[^"]+\.js)"/g, `src="$1?v=${bootId}"`);
    res.type('html').send(html);
}

app.get('/daily-stock-count', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!user) {
        res.redirect(302, '/login');
        return;
    }
    const stores = filterStoresForUser(user, getStoreList());
    const want = normalizeStoreKey(req.query.store);
    if (want && userCanAccessStore(user, want)) {
        res.redirect(302, `/${want}/daily-stock-count`);
        return;
    }
    const first = stores[0]?.storeNumber;
    if (first) {
        res.redirect(302, `/${first}/daily-stock-count`);
        return;
    }
    sendForbidden(req, res, 'No stores available for daily count.');
});

app.get(/^\/(teststore|\d{3,6})\/daily-stock-count\/?$/i, (req, res) => {
    const storeNumber = normalizeStoreKey((req.path.match(/^\/(teststore|\d{3,6})\/daily-stock-count\/?$/i) || [])[1]);
    sendDailyStockCountPage(req, res, storeNumber);
});

function dailyCountStoreFromQuery(req) {
    return normalizeStoreKey(req.query.store || req.body?.store);
}

function assertDailyCountMmxAccess(req, res) {
    const user = req.dashboardUser || getRequestUser(req);
    if (!user?.username || !hasMmxCredentialsForUser(user.username)) {
        res.status(403).json({
            success: false,
            error: 'Macromatix login required. Complete Create account with your MMX username and password.',
            needsMmxCredentials: true,
        });
        return false;
    }
    return true;
}

function sendDfscPage(req, res, storeNumber) {
    if (!assertStoreAccess(req, res, storeNumber)) return;
    if (!assertDfscAccess(req, res)) return;
    const bootId = getDashboardMeta().bootId;
    const htmlPath = path.join(paths.tacaudit.public, 'dfsc.html');
    let html = fsSync.readFileSync(htmlPath, 'utf8');
    html = html.replace(/src="(\/scripts\/[^"]+\.js)"/g, `src="$1?v=${bootId}"`);
    res.type('html').send(html);
}

app.get(/^\/(teststore|\d{3,6})\/dfsc\/?$/i, (req, res) => {
    const storeNumber = normalizeStoreKey((req.path.match(/^\/(teststore|\d{3,6})\/dfsc\/?$/i) || [])[1]);
    sendDfscPage(req, res, storeNumber);
});

app.get(/^\/(teststore|\d{3,6})\/dfsc\/audit\/?$/i, (req, res) => {
    const storeNumber = normalizeStoreKey((req.path.match(/^\/(teststore|\d{3,6})\/dfsc\/audit\/?$/i) || [])[1]);
    sendDfscPage(req, res, storeNumber);
});

function sendPestWalkPage(req, res, storeNumber) {
    if (!assertStoreAccess(req, res, storeNumber)) return;
    if (!assertDfscAccess(req, res)) return;
    const bootId = getDashboardMeta().bootId;
    const htmlPath = path.join(paths.tacaudit.public, 'pest-walk.html');
    let html = fsSync.readFileSync(htmlPath, 'utf8');
    html = html.replace(/src="(\/scripts\/[^"]+\.js)"/g, `src="$1?v=${bootId}"`);
    res.type('html').send(html);
}

app.get(/^\/(teststore|\d{3,6})\/pest-walk\/?$/i, (req, res) => {
    const storeNumber = normalizeStoreKey((req.path.match(/^\/(teststore|\d{3,6})\/pest-walk\/?$/i) || [])[1]);
    sendPestWalkPage(req, res, storeNumber);
});

app.get(/^\/(teststore|\d{3,6})\/pest-walk\/audit\/?$/i, (req, res) => {
    const storeNumber = normalizeStoreKey((req.path.match(/^\/(teststore|\d{3,6})\/pest-walk\/audit\/?$/i) || [])[1]);
    sendPestWalkPage(req, res, storeNumber);
});

function sendRgmCleaningPage(req, res, storeNumber) {
    if (!assertStoreAccess(req, res, storeNumber)) return;
    if (!assertDfscAccess(req, res)) return;
    const bootId = getDashboardMeta().bootId;
    const htmlPath = path.join(paths.tacaudit.public, 'rgm-cleaning.html');
    let html = fsSync.readFileSync(htmlPath, 'utf8');
    html = html.replace(/src="(\/scripts\/[^"]+\.js)"/g, `src="$1?v=${bootId}"`);
    res.type('html').send(html);
}

app.get(/^\/(teststore|\d{3,6})\/rgm-cleaning\/?$/i, (req, res) => {
    const storeNumber = normalizeStoreKey((req.path.match(/^\/(teststore|\d{3,6})\/rgm-cleaning\/?$/i) || [])[1]);
    sendRgmCleaningPage(req, res, storeNumber);
});

app.get(/^\/(teststore|\d{3,6})\/rgm-cleaning\/audit\/?$/i, (req, res) => {
    const storeNumber = normalizeStoreKey((req.path.match(/^\/(teststore|\d{3,6})\/rgm-cleaning\/audit\/?$/i) || [])[1]);
    sendRgmCleaningPage(req, res, storeNumber);
});

function sendPsiPage(req, res, storeNumber) {
    if (!assertStoreAccess(req, res, storeNumber)) return;
    if (!assertDfscAccess(req, res)) return;
    const bootId = getDashboardMeta().bootId;
    const htmlPath = path.join(paths.tacaudit.public, 'psi.html');
    let html = fsSync.readFileSync(htmlPath, 'utf8');
    html = html.replace(/src="(\/scripts\/[^"]+\.js)"/g, `src="$1?v=${bootId}"`);
    res.type('html').send(html);
}

app.get(/^\/(teststore|\d{3,6})\/psi\/?$/i, (req, res) => {
    const storeNumber = normalizeStoreKey((req.path.match(/^\/(teststore|\d{3,6})\/psi\/?$/i) || [])[1]);
    sendPsiPage(req, res, storeNumber);
});

app.get(/^\/(teststore|\d{3,6})\/psi\/audit\/?$/i, (req, res) => {
    const storeNumber = normalizeStoreKey((req.path.match(/^\/(teststore|\d{3,6})\/psi\/audit\/?$/i) || [])[1]);
    sendPsiPage(req, res, storeNumber);
});

function sendSquareOnePage(req, res, storeNumber) {
    if (!assertStoreAccess(req, res, storeNumber)) return;
    if (!assertDfscAccess(req, res)) return;
    const bootId = getDashboardMeta().bootId;
    const htmlPath = path.join(paths.tacaudit.public, 'square-one.html');
    let html = fsSync.readFileSync(htmlPath, 'utf8');
    html = html.replace(/src="(\/scripts\/[^"]+\.js)"/g, `src="$1?v=${bootId}"`);
    res.type('html').send(html);
}

app.get(/^\/(teststore|\d{3,6})\/square-one\/?$/i, (req, res) => {
    const storeNumber = normalizeStoreKey((req.path.match(/^\/(teststore|\d{3,6})\/square-one\/?$/i) || [])[1]);
    sendSquareOnePage(req, res, storeNumber);
});

app.get(/^\/(teststore|\d{3,6})\/square-one\/audit\/?$/i, (req, res) => {
    const storeNumber = normalizeStoreKey((req.path.match(/^\/(teststore|\d{3,6})\/square-one\/audit\/?$/i) || [])[1]);
    sendSquareOnePage(req, res, storeNumber);
});

const PERIOD_AUDIT_PAGE_TYPES = ['core-ops', 'core-food-safety', 'visit-coach', 'visit-customer'];

function sendPeriodAuditPage(req, res, storeNumber, auditType) {
    if (!assertStoreAccess(req, res, storeNumber)) return;
    if (!assertDfscAccess(req, res)) return;
    if (['visit-coach', 'visit-customer'].includes(auditType) && !assertCoachAuditAccess(req, res)) return;
    const bootId = getDashboardMeta().bootId;
    const htmlPath = path.join(paths.tacaudit.public, 'period-audit.html');
    let html = fsSync.readFileSync(htmlPath, 'utf8');
    html = html
        .replace(/__AUDIT_TYPE__/g, auditType)
        .replace(/src="(\/scripts\/[^"]+\.js)"/g, `src="$1?v=${bootId}"`);
    res.type('html').send(html);
}

for (const auditType of PERIOD_AUDIT_PAGE_TYPES) {
    const pagePattern = new RegExp(`^\\/(teststore|\\d{3,6})\\/${auditType}(?:\\/audit)?\\/?$`, 'i');
    app.get(pagePattern, (req, res) => {
        const storeNumber = normalizeStoreKey((req.path.match(pagePattern) || [])[1]);
        sendPeriodAuditPage(req, res, storeNumber, auditType);
    });
}

function sendTacauditHtml(res) {
    const bootId = getDashboardMeta().bootId;
    const htmlPath = path.join(paths.tacaudit.public, 'tacaudit.html');
    let html = fsSync.readFileSync(htmlPath, 'utf8');
    html = html.replace(/src="(\/scripts\/[^"]+\.js)"/g, `src="$1?v=${bootId}"`);
    res.type('html').send(html);
}

function sendTacauditPage(req, res, storeNumber) {
    if (!assertStoreAccess(req, res, storeNumber)) return;
    if (!assertDfscAccess(req, res)) return;
    sendTacauditHtml(res);
}

function sendTacauditSummaryPage(req, res) {
    const user = req.dashboardUser || getRequestUser(req);
    if (!user) {
        res.redirect('/login');
        return;
    }
    if (!isRealDashboardUser(user)) {
        sendUnauthorized(req, res);
        return;
    }
    if (!canViewTacauditAdminSummary(user)) {
        sendForbidden(req, res, 'Area audit summary is not available for this account.');
        return;
    }
    sendTacauditHtml(res);
}

app.get(/^\/tacaudit\/summary\/?$/i, sendTacauditSummaryPage);
app.get(/^\/tacaudit\/actions\/?$/i, sendTacauditSummaryPage);
app.get(/^\/Admin\/tacaudit\/?$/i, (req, res) => {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect(302, `/tacaudit/summary${qs}`);
});
app.get(/^\/admin\/tacaudit\/?$/i, (req, res) => {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect(302, `/tacaudit/summary${qs}`);
});

app.get(/^\/(teststore|\d{3,6})\/tacaudit\/actions\/?$/i, (req, res) => {
    const storeNumber = normalizeStoreKey((req.path.match(/^\/(teststore|\d{3,6})\/tacaudit\/actions\/?$/i) || [])[1]);
    sendTacauditPage(req, res, storeNumber);
});

app.get(/^\/(teststore|\d{3,6})\/tacaudit\/?$/i, (req, res) => {
    const storeNumber = normalizeStoreKey((req.path.match(/^\/(teststore|\d{3,6})\/tacaudit\/?$/i) || [])[1]);
    sendTacauditPage(req, res, storeNumber);
});

app.get('/api/me', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    res.json({ success: true, ...userProfileForClient(user) });
});

app.get('/api/admin/store-scope', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!isRealDashboardUser(user)) {
        res.status(403).json({ success: false, error: 'You do not have permission to browse stores.' });
        return;
    }
    const scopeTree = getStoreScopeTreeForUser(user);
    if (!scopeTree) {
        res.status(403).json({ success: false, error: 'No store scope available.' });
        return;
    }
    res.json({ success: true, scopeTree });
});

app.get('/change-password', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!isRealDashboardUser(user)) {
        res.redirect('/login');
        return;
    }
    if (userNeedsMmxSetup(user.username)) {
        res.redirect('/mmx-setup');
        return;
    }
    if (!userNeedsPasswordChange(user.username)) {
        res.redirect(
            isAdminUser(user) ? getAdminRedirectPath() : getLoginRedirectPath(user, 'mic')
        );
        return;
    }
    res.sendFile(path.join(paths.users.public, 'change-password.html'));
});

app.get('/mmx-setup', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!isRealDashboardUser(user)) {
        res.redirect('/login');
        return;
    }
    res.redirect(getLoginRedirectPath(user, 'mic'));
});

app.get('/changelog', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!isRealDashboardUser(user)) {
        res.redirect('/login');
        return;
    }
    res.sendFile(path.join(paths.dashboard.public, 'changelog.html'));
});

app.get('/api/dashboard/changelog', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!isRealDashboardUser(user)) {
        res.status(401).json({ success: false, error: 'Sign in to view the changelog.' });
        return;
    }
    res.set('Cache-Control', 'no-store');
    res.json({
        success: true,
        version: getDashboardMeta().version,
        markdown: readChangelogMarkdown(),
    });
});

app.get('/requests', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!isSuperAdminUser(user)) {
        sendUnauthorized(req, res);
        return;
    }
    res.sendFile(path.join(paths.dashboard.public, 'requests.html'));
});

app.get('/api/feature-requests', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!isSuperAdminUser(user)) {
        res.status(403).json({ success: false, error: 'Only the dashboard owner can view feature requests.' });
        return;
    }
    res.set('Cache-Control', 'no-store');
    res.json({
        success: true,
        requests: listFeatureRequests(),
        categories: listFeatureRequestCategories(),
        priorities: listFeatureRequestPriorities(),
    });
});

app.post('/api/feature-requests/categories', (req, res) => {
    try {
        const user = req.dashboardUser || getRequestUser(req);
        if (!isSuperAdminUser(user)) {
            res.status(403).json({ success: false, error: 'Only the dashboard owner can create tabs.' });
            return;
        }
        const result = addFeatureRequestCategory(req.body?.label);
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, category: result.category, categories: result.categories });
    } catch (error) {
        console.error('[FeatureRequests] Failed to create tab:', error);
        res.status(500).json({ success: false, error: error.message || 'Could not create tab.' });
    }
});

app.patch('/api/feature-requests/categories/:id', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!isSuperAdminUser(user)) {
        res.status(403).json({ success: false, error: 'Only the dashboard owner can hide tabs.' });
        return;
    }
    if (req.body?.hidden !== true) {
        res.status(400).json({ success: false, error: 'Expected { hidden: true }.' });
        return;
    }
    const result = hideFeatureRequestCategory(req.params.id);
    if (!result.ok) {
        res.status(400).json({ success: false, error: result.error });
        return;
    }
    res.json({
        success: true,
        category: result.category,
        categories: result.categories,
        requests: result.requests,
        unassignedCount: result.unassignedCount,
    });
});

app.delete('/api/feature-requests/categories/:id', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!isSuperAdminUser(user)) {
        res.status(403).json({ success: false, error: 'Only the dashboard owner can delete tabs.' });
        return;
    }
    const result = deleteFeatureRequestCategory(req.params.id);
    if (!result.ok) {
        res.status(400).json({ success: false, error: result.error });
        return;
    }
    res.json({
        success: true,
        category: result.category,
        categories: result.categories,
        requests: result.requests,
        unassignedCount: result.unassignedCount,
    });
});

app.post('/api/feature-requests', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!isRealDashboardUser(user)) {
        res.status(401).json({ success: false, error: 'Sign in to submit a feature request.' });
        return;
    }
    const result = addFeatureRequest({
        text: req.body?.text,
        details: req.body?.details,
        category: req.body?.category,
        username: user.username,
        displayName: user.displayName || user.username,
    });
    if (!result.ok) {
        res.status(400).json({ success: false, error: result.error });
        return;
    }
    res.json({ success: true, request: result.request });
});

app.patch('/api/feature-requests/:id', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!isSuperAdminUser(user)) {
        res.status(403).json({ success: false, error: 'Only the dashboard owner can update feature requests.' });
        return;
    }
    const id = String(req.params.id || '').trim();
    if (!id) {
        res.status(400).json({ success: false, error: 'Missing feature request id.' });
        return;
    }
    const hasCompleted = typeof req.body?.completed === 'boolean';
    const hasCategory = req.body?.category !== undefined;
    const hasDetails = req.body?.details !== undefined;
    const hasMilestones = req.body?.milestones !== undefined;
    const hasPriority = req.body?.priority !== undefined;
    if (!hasCompleted && !hasCategory && !hasDetails && !hasMilestones && !hasPriority) {
        res.status(400).json({ success: false, error: 'Expected at least one field to update.' });
        return;
    }
    const result = updateFeatureRequest(id, {
        completed: hasCompleted ? req.body.completed : undefined,
        category: hasCategory ? req.body.category : undefined,
        details: hasDetails ? req.body.details : undefined,
        milestones: hasMilestones ? req.body.milestones : undefined,
        priority: hasPriority ? req.body.priority : undefined,
    });
    if (!result.ok) {
        res.status(404).json({ success: false, error: result.error });
        return;
    }
    res.json({
        success: true,
        request: result.request,
        requests: result.requests,
        categories: result.categories,
    });
});

app.post('/api/account/complete-password-setup', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!isRealDashboardUser(user)) {
        res.status(403).json({ success: false, error: 'Sign in first to set your password.' });
        return;
    }
    if (userNeedsMmxSetup(user.username)) {
        res.status(403).json({
            success: false,
            error: 'Complete Macromatix setup before setting your password.',
            mustCompleteMmxSetup: true,
        });
        return;
    }
    if (!userNeedsPasswordChange(user.username)) {
        res.status(400).json({ success: false, error: 'Password setup is not required for this account.' });
        return;
    }
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    const confirmPassword = String(req.body?.confirmPassword || '');
    if (newPassword !== confirmPassword) {
        res.status(400).json({ success: false, error: 'New passwords do not match.' });
        return;
    }
    const result = completePasswordSetup(user.username, currentPassword, newPassword);
    if (!result.ok) {
        res.status(400).json({ success: false, error: result.error });
        return;
    }
    const entry = dashboardEntryFromRequest(req) || (isAdminUser(user) ? 'admin' : 'store');
    const refreshed = authenticate(user.username, newPassword);
    setSessionCookie(res, refreshed || user, true, entry);
    const profile = userProfileForClient(refreshed || user);
    res.json({
        success: true,
        defaultPath: profile.defaultPath,
        welcomeName: profile.welcomeName,
    });
});

app.post('/api/account/complete-mmx-setup', async (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!isRealDashboardUser(user)) {
        res.status(403).json({ success: false, error: 'Sign in with your crew account to save Macromatix login.' });
        return;
    }
    const dashUser = String(user.username || '').trim();
    const result = await verifyAndOptionallySaveUserMmxLogin(req, dashUser);
    if (!result.ok) {
        res.status(result.status || 400).json({ success: false, error: result.error });
        return;
    }
    res.json({ success: true, remembered: result.remembered });
});

app.post('/api/account/change-password', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!isRealDashboardUser(user)) {
        res.status(403).json({ success: false, error: 'Account password change is not available for this session.' });
        return;
    }
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    const result = changeUserPassword(user.username, currentPassword, newPassword);
    if (!result.ok) {
        res.status(400).json({ success: false, error: result.error });
        return;
    }
    const entry = dashboardEntryFromRequest(req) || (isAdminUser(user) ? 'admin' : 'store');
    const refreshed = authenticate(user.username, newPassword);
    if (refreshed) {
        setSessionCookie(res, refreshed, true, entry);
    }
    res.json({ success: true });
});

app.post('/api/account/colour-blind-mode', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!isRealDashboardUser(user)) {
        res.status(403).json({ success: false, error: 'Sign in with your store account to change this setting.' });
        return;
    }
    const enabled = !(req.body?.enabled === false || req.body?.enabled === 0 || req.body?.enabled === '0');
    const result = setAccountColourBlindPreference(user.username, enabled);
    if (!result.ok) {
        res.status(400).json({ success: false, error: result.error });
        return;
    }
    const freshUser = { ...user, colorBlind: Boolean(result.colorBlind) };
    setSessionCookie(res, freshUser, true, dashboardEntryFromRequest(req) || 'store');
    res.json({ success: true, colorBlind: Boolean(result.colorBlind) });
});

app.post('/api/account/mic-dark-mode', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!isRealDashboardUser(user)) {
        res.status(403).json({ success: false, error: 'Sign in with your store account to change this setting.' });
        return;
    }
    const enabled = !(req.body?.enabled === false || req.body?.enabled === 0 || req.body?.enabled === '0');
    const result = setAccountMicDarkModePreference(user.username, enabled);
    if (!result.ok) {
        res.status(400).json({ success: false, error: result.error });
        return;
    }
    const freshUser = { ...user, micDarkMode: Boolean(result.micDarkMode) };
    setSessionCookie(res, freshUser, true, dashboardEntryFromRequest(req) || 'store');
    res.json({ success: true, micDarkMode: Boolean(result.micDarkMode) });
});

app.post('/api/account/audit-auto-collapse', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!isRealDashboardUser(user)) {
        res.status(403).json({ success: false, error: 'Sign in with your store account to change this setting.' });
        return;
    }
    const enabled = !(req.body?.enabled === false || req.body?.enabled === 0 || req.body?.enabled === '0');
    const result = setAccountAuditAutoCollapsePreference(user.username, enabled);
    if (!result.ok) {
        res.status(400).json({ success: false, error: result.error });
        return;
    }
    const freshUser = { ...user, auditAutoCollapse: Boolean(result.auditAutoCollapse) };
    setSessionCookie(res, freshUser, true, dashboardEntryFromRequest(req) || 'store');
    res.json({ success: true, auditAutoCollapse: Boolean(result.auditAutoCollapse) });
});

app.post('/api/account/mic-rounded-tiles', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!isRealDashboardUser(user)) {
        res.status(403).json({ success: false, error: 'Sign in with your store account to change this setting.' });
        return;
    }
    const enabled = !(req.body?.enabled === false || req.body?.enabled === 0 || req.body?.enabled === '0');
    try {
        const result = setAccountMicRoundedTilesPreference(user.username, enabled);
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        const freshUser = { ...user, micRoundedTiles: Boolean(result.micRoundedTiles) };
        setSessionCookie(res, freshUser, true, dashboardEntryFromRequest(req) || 'store');
        res.json({ success: true, micRoundedTiles: Boolean(result.micRoundedTiles) });
    } catch (error) {
        console.error('[Auth] mic-rounded-tiles pref save failed:', error);
        res.status(500).json({ success: false, error: error.message || 'Could not save rounded tile preference.' });
    }
});

app.get('/api/account/managed-accounts', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    const store = String(req.query.store || '').trim();
    if (!store || !assertStoreAccess(req, res, store)) return;
    if (!canUserManageStoreAccounts(user, store)) {
        res.status(403).json({ success: false, error: 'You do not have permission to view accounts for this store.' });
        return;
    }
    res.json({
        success: true,
        storeNumber: normalizeStoreKey(store),
        accounts: listManagedStoreAccounts(store),
    });
});

app.delete('/api/account/managed-accounts', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    const store = String(req.body?.store || req.query?.store || '').trim();
    const username = String(req.body?.username || req.query?.username || '').trim();
    if (!store || !assertStoreAccess(req, res, store)) return;
    const result = deleteManagedStoreAccount(user, store, username);
    if (!result.ok) {
        res.status(400).json({ success: false, error: result.error });
        return;
    }
    deleteMmxCredentialsForUser(result.username);
    deleteLifeLenzCredentialsForUser(result.username);
    res.json({ success: true, storeNumber: normalizeStoreKey(store), username: result.username });
});

app.patch('/api/account/managed-accounts', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    const store = String(req.body?.store || '').trim();
    const username = String(req.body?.username || '').trim();
    if (!store || !assertStoreAccess(req, res, store)) return;
    const patch = {};
    if (req.body?.accountLevel != null) patch.accountLevel = req.body.accountLevel;
    if (req.body?.stores != null) patch.stores = req.body.stores;
    const result = updateManagedStoreAccount(user, store, username, patch);
    if (!result.ok) {
        res.status(400).json({ success: false, error: result.error });
        return;
    }
    res.json({ success: true, ...result, storeNumber: normalizeStoreKey(store) });
});

app.get('/api/account/login-history', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    const store = String(req.query.store || '').trim();
    if (!store || !assertStoreAccess(req, res, store)) return;
    const result = listLoginHistoryForStore(user, store, {
        username: req.query.username,
        limit: req.query.limit,
    });
    if (!result.ok) {
        res.status(403).json({ success: false, error: result.error });
        return;
    }
    res.json({ success: true, ...result });
});

app.get('/api/admin/forecast/status', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserAccessAdminMenu(user)) {
        res.status(403).json({ success: false, error: 'Admin menu access required.' });
        return;
    }
    const storeNumbers = getEffectiveStoresForUser(user).filter((s) => !isTestStore(s));
    const payload = buildStatusForStores(storeNumbers);
    const history = buildHistoryCoverageForStores(storeNumbers);
    const weekStart = payload.targetWeeks?.[0] || getTargetForecastWeekStarts()[0];
    const forecastUpdates = buildForecastUpdatesForStores(storeNumbers, weekStart);
    const updatesSummary = {};
    for (const store of storeNumbers) {
        updatesSummary[String(store)] = summarizeForecastUpdates(forecastUpdates[String(store)]);
    }
    const autoSubmit = buildAutoSubmitStatus();
    res.json({
        success: true,
        ...payload,
        history,
        forecastUpdates,
        updatesSummary,
        autoSubmit,
        canManageAutoSubmit: canUserEditGlobalBuildTo(user),
    });
});

app.get('/api/admin/forecast/auto-submit', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserAccessAdminMenu(user)) {
        res.status(403).json({ success: false, error: 'Admin menu access required.' });
        return;
    }
    res.json({
        success: true,
        ...buildAutoSubmitStatus(),
        canManage: canUserEditGlobalBuildTo(user),
    });
});

app.put('/api/admin/forecast/auto-submit', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserAccessAdminMenu(user)) {
        res.status(403).json({ success: false, error: 'Admin menu access required.' });
        return;
    }
    if (!canUserEditGlobalBuildTo(user)) {
        res.status(403).json({ success: false, error: 'Area Manager access or above required.' });
        return;
    }
    try {
        const enabled = !(req.body?.enabled === false || req.body?.enabled === 0 || req.body?.enabled === '0');
        const doc = writeAutoSubmitSettings({ enabled }, user.username);
        res.json({ success: true, ...buildAutoSubmitStatus(), settings: doc });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message || 'Could not save auto-submit setting.' });
    }
});

app.get('/api/admin/forecast/history-grid', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserAccessAdminMenu(user)) {
        res.status(403).json({ success: false, error: 'Admin menu access required.' });
        return;
    }
    const store = String(req.query.store || '').trim();
    if (!store || !assertStoreAccess(req, res, store)) return;
    const weekdayRaw = req.query.weekday;
    const weekday = weekdayRaw === undefined || weekdayRaw === '' ? undefined : Number(weekdayRaw);
    if (weekdayRaw !== undefined && weekdayRaw !== '' && (!Number.isFinite(weekday) || weekday < 0 || weekday > 6)) {
        res.status(400).json({ success: false, error: 'weekday must be 0–6 (Sun–Sat).' });
        return;
    }
    const maxWeeks = Number(req.query.weeks) || 5;
    const includeForecast = req.query.includeForecast !== '0';
    try {
        const grid = buildHistoryHourGrid(store, { weekday, maxWeeks });
        let forecastWeek = null;
        if (includeForecast) {
            try {
                const preview = previewForecastForStore(store);
                forecastWeek = {
                    targetWeeks: preview.targetWeeks,
                    grid: preview.grid,
                };
            } catch (err) {
                forecastWeek = { error: err.message || 'Could not build forecast preview.' };
            }
        }
        res.json({
            success: true,
            grid,
            forecastWeek,
            dateBounds: historyDateBounds(readStoreHistory(store).timeZone),
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message || 'Could not build history grid.' });
    }
});

app.get('/api/admin/forecast/history/day', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserAccessAdminMenu(user)) {
        res.status(403).json({ success: false, error: 'Admin menu access required.' });
        return;
    }
    const store = String(req.query.store || '').trim();
    const date = String(req.query.date || '').trim();
    if (!store || !assertStoreAccess(req, res, store)) return;
    try {
        const entry = buildHistoryDayEntry(store, date || undefined);
        res.json({ success: true, entry });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message || 'Could not load history day.' });
    }
});

app.post('/api/admin/forecast/history', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserAccessAdminMenu(user)) {
        res.status(403).json({ success: false, error: 'Admin menu access required.' });
        return;
    }
    const store = String(req.body?.store || req.body?.storeNumber || '').trim();
    const date = String(req.body?.date || '').trim();
    if (!store || !assertStoreAccess(req, res, store)) return;
    if (!date) {
        res.status(400).json({ success: false, error: 'date is required (YYYY-MM-DD).' });
        return;
    }
    try {
        const row = upsertManualHistoryDay(store, date, req.body || {}, {
            force: req.body?.force === true,
            source: 'manual-ui',
        });
        const readiness = buildHistoryCoverageForStores([store]).stores[store];
        res.json({ success: true, day: row, readiness });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message || 'Could not save history day.' });
    }
});

app.delete('/api/admin/forecast/history', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserAccessAdminMenu(user)) {
        res.status(403).json({ success: false, error: 'Admin menu access required.' });
        return;
    }
    const store = String(req.query?.store || req.body?.store || '').trim();
    const date = String(req.query?.date || req.body?.date || '').trim();
    if (!store || !assertStoreAccess(req, res, store)) return;
    if (!date) {
        res.status(400).json({ success: false, error: 'date is required.' });
        return;
    }
    try {
        const force = req.query?.force === '1' || req.body?.force === true;
        const result = deleteHistoryDay(store, date, { force });
        const readiness = buildHistoryCoverageForStores([store]).stores[store];
        res.json({ success: true, ...result, readiness });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message || 'Could not delete history day.' });
    }
});

app.get('/api/admin/forecast/adjustments', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserAccessAdminMenu(user)) {
        res.status(403).json({ success: false, error: 'Admin menu access required.' });
        return;
    }
    const store = String(req.query.store || '').trim();
    const weekStart = String(req.query.weekStart || getTargetForecastWeekStarts()[0] || '').trim();
    if (!store || !assertStoreAccess(req, res, store)) return;
    res.json({ success: true, adjustments: readAdjustments(store, weekStart) });
});

app.put('/api/admin/forecast/adjustments', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserAccessAdminMenu(user)) {
        res.status(403).json({ success: false, error: 'Admin menu access required.' });
        return;
    }
    const store = String(req.body?.store || req.body?.storeNumber || '').trim();
    const weekStart = String(req.body?.weekStart || getTargetForecastWeekStarts()[0] || '').trim();
    if (!store || !assertStoreAccess(req, res, store)) return;
    try {
        const doc = writeAdjustments(store, weekStart, req.body?.rules || [], user.username);
        const preview = previewForecastForStore(store);
        res.json({
            success: true,
            adjustments: doc,
            preview: {
                storeNumber: preview.storeNumber,
                baseWeekTotal: preview.baseWeekTotal,
                adjustedWeekTotal: preview.adjustedWeekTotal,
                adjustmentDelta: preview.adjustmentDelta,
                grid: preview.grid,
                baseGrid: preview.baseGrid,
            },
        });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message || 'Could not save adjustments.' });
    }
});

app.delete('/api/admin/forecast/adjustments', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserAccessAdminMenu(user)) {
        res.status(403).json({ success: false, error: 'Admin menu access required.' });
        return;
    }
    const store = String(req.query?.store || req.body?.store || '').trim();
    const weekStart = String(req.query?.weekStart || req.body?.weekStart || getTargetForecastWeekStarts()[0] || '').trim();
    if (!store || !assertStoreAccess(req, res, store)) return;
    try {
        const result = deleteAdjustments(store, weekStart);
        const preview = previewForecastForStore(store);
        res.json({
            success: true,
            ...result,
            preview: {
                storeNumber: preview.storeNumber,
                baseWeekTotal: preview.baseWeekTotal,
                adjustedWeekTotal: preview.adjustedWeekTotal,
                adjustmentDelta: preview.adjustmentDelta,
                grid: preview.grid,
            },
        });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message || 'Could not clear adjustments.' });
    }
});

app.post('/api/admin/forecast/preview', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserAccessAdminMenu(user)) {
        res.status(403).json({ success: false, error: 'Admin menu access required.' });
        return;
    }
    const allowed = new Set((getEffectiveStoresForUser(user) || []).map(String));
    const requested = Array.isArray(req.body?.storeNumbers) ? req.body.storeNumbers.map(String) : [];
    const storeNumbers = requested.filter((s) => allowed.has(String(s)) && !isTestStore(s));
    if (!storeNumbers.length) {
        res.status(400).json({ success: false, error: 'No valid stores selected.' });
        return;
    }
    const previews = previewForecastForStores(storeNumbers);
    const ok = previews.filter((row) => row.ok);
    if (!ok.length) {
        res.status(400).json({
            success: false,
            error: previews[0]?.error || 'Could not build forecast preview.',
            previews,
        });
        return;
    }
    res.json({
        success: true,
        targetWeeks: ok[0]?.targetWeeks || getTargetForecastWeekStarts(),
        previews,
    });
});

app.get('/api/admin/forecast/lifelenz/status', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserAccessAdminMenu(user)) {
        res.status(403).json({ success: false, error: 'Admin menu access required.' });
        return;
    }
    const status = getLifeLenzCredentialsStatus(user.username);
    res.json({ success: true, ...status });
});

app.post('/api/admin/forecast/lifelenz/verify', async (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserAccessAdminMenu(user)) {
        res.status(403).json({ success: false, error: 'Admin menu access required.' });
        return;
    }
    const email = String(req.body?.email || '').trim();
    const password = String(req.body?.password || '');
    const save = req.body?.save === true;
    if (!email || !password) {
        res.status(400).json({ success: false, error: 'LifeLenz email and password are required.' });
        return;
    }
    try {
        const verifyResult = await verifyLifeLenzLogin(email, password, { headless: true, skipSlowMo: true });
        if (!verifyResult.ok) {
            res.status(401).json({ success: false, error: verifyResult.error || 'LifeLenz login failed.' });
            return;
        }
        let saved = null;
        if (save) {
            saved = saveUserLifeLenzSecrets(user.username, email, password);
            if (!saved.ok) {
                res.status(500).json({ success: false, error: saved.error || 'Could not save LifeLenz credentials.' });
                return;
            }
        }
        res.json({
            success: true,
            stores: verifyResult.stores,
            saved: Boolean(save && saved?.ok),
            updatedAt: saved?.updatedAt || null,
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message || 'LifeLenz verification failed.' });
    }
});

app.delete('/api/admin/forecast/lifelenz/credentials', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserAccessAdminMenu(user)) {
        res.status(403).json({ success: false, error: 'Admin menu access required.' });
        return;
    }
    const result = deleteLifeLenzCredentialsForUser(user.username);
    if (!result.ok) {
        res.status(400).json({ success: false, error: result.error });
        return;
    }
    res.json({ success: true, removed: result.removed });
});

app.post('/api/admin/forecast/run', async (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserAccessAdminMenu(user)) {
        res.status(403).json({ success: false, error: 'Admin menu access required.' });
        return;
    }
    const allowed = new Set((getEffectiveStoresForUser(user) || []).map(String));
    const requested = Array.isArray(req.body?.storeNumbers) ? req.body.storeNumbers.map(String) : [];
    const storeNumbers = requested.filter((s) => allowed.has(String(s)) && !isTestStore(s));
    if (!storeNumbers.length) {
        res.status(400).json({ success: false, error: 'No valid stores selected.' });
        return;
    }

    const streamProgress = req.body?.streamProgress === true;
    const writeSse = (event, data) => {
        if (!streamProgress) return;
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    if (streamProgress) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();
        writeSse('started', { storeNumbers, targetWeeks: getTargetForecastWeekStarts() });
    }

    try {
        await runWithPriority(PRIORITY.ADMIN, {
            type: 'admin-forecast',
            label: 'forecast tool',
            run: async () => {
                const headed =
                    req.body?.headed === true ||
                    /^(0|false|no|off)$/i.test(String(process.env.FORECAST_SCRAPER_HEADLESS ?? '').trim());
                const lifelenzHeaded =
                    req.body?.lifelenzHeaded === true ||
                    /^(0|false|no|off)$/i.test(String(process.env.LIFELENZ_SCRAPER_HEADLESS ?? '').trim());
                const headless = headed ? false : true;

                const oneTimeEmail = String(req.body?.lifelenzCredentials?.email || '').trim();
                const oneTimePassword = String(req.body?.lifelenzCredentials?.password || '');
                const lifelenzByStore = {};
                for (const sn of storeNumbers) {
                    const cands = listCredentialCandidates(sn, 'lifelenz');
                    if (cands[0]?.email && cands[0]?.password) {
                        lifelenzByStore[sn] = { email: cands[0].email, password: cands[0].password };
                    }
                }
                const lifelenzCredentials =
                    Object.keys(lifelenzByStore).length > 0
                        ? { byStore: lifelenzByStore }
                        : oneTimeEmail && oneTimePassword
                          ? { email: oneTimeEmail, password: oneTimePassword }
                          : null;

                writeSse('platform-started', { platform: 'mmx', storeNumbers });
                if (lifelenzCredentials) {
                    writeSse('platform-started', { platform: 'lifelenz', storeNumbers });
                }

                const combined = await runCombinedForecastForStores(storeNumbers, {
                    completedBy: user.username,
                    headless,
                    lifelenzCredentials,
                    keepBrowserOpen: headed && req.body?.keepBrowserOpen === true,
                    onProgress: (payload) => writeSse('progress', payload),
                });

                const mmxResults = combined.mmxResults || [];
                const lifelenzResults = combined.lifelenzResults || [];
                const allMmxFailed = mmxResults.length && mmxResults.every((row) => !row.ok);
                const allFailed =
                    allMmxFailed &&
                    (!lifelenzCredentials || (lifelenzResults.length && lifelenzResults.every((row) => !row.ok)));

                const payload = {
                    success: !allFailed,
                    mmx: mmxResults,
                    lifelenz: lifelenzResults,
                    lifelenzSkipped: combined.lifelenzSkipped === true,
                    manualSaved: combined.manualSaved || [],
                    results: mmxResults,
                    targetWeeks: combined.targetWeeks || getTargetForecastWeekStarts(),
                    error: allFailed
                        ? mmxResults.find((row) => !row.ok)?.error || 'Forecast run failed for all stores.'
                        : undefined,
                };
                if (streamProgress) {
                    writeSse('complete', payload);
                    res.end();
                    return;
                }
                if (allFailed) {
                    res.status(502).json(payload);
                    return;
                }
                res.json(payload);
            },
        });
    } catch (err) {
        const payload = { success: false, error: err.message || 'Forecast run failed.' };
        if (streamProgress) {
            writeSse('error', payload);
            res.end();
            return;
        }
        res.status(500).json(payload);
    }
});

app.get('/api/admin/mmx-queue', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserAccessAdminMenu(user)) {
        res.status(403).json({ success: false, error: 'Admin menu access required.' });
        return;
    }
    const snapshot = getQueueSnapshot();
    res.json({
        success: true,
        priorities: { MIC: PRIORITY.MIC, ADMIN: PRIORITY.ADMIN, SCRAPE: PRIORITY.SCRAPE },
        ...snapshot,
    });
});

app.get('/api/admin/forecast/manual/:storeNumber', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserAccessAdminMenu(user)) {
        res.status(403).json({ success: false, error: 'Admin menu access required.' });
        return;
    }
    const store = String(req.params.storeNumber || '').trim();
    if (!store || !assertStoreAccess(req, res, store)) return;
    const weekStart = String(req.query.weekStart || getTargetForecastWeekStarts()[0] || '').trim();
    const pack = readManualEntryPack(weekStart, store);
    if (!pack) {
        res.status(404).json({ success: false, error: 'No manual entry pack found for this store and week.' });
        return;
    }
    res.json({
        success: true,
        pack,
        plainText: buildManualEntryPlainText(pack),
    });
});

app.get('/api/admin/build-to/catalog', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserAccessAdminMenu(user)) {
        res.status(403).json({ success: false, error: 'Admin menu access required.' });
        return;
    }
    try {
        const store = String(req.query.store || '').trim();
        const area = String(req.query.area || '').trim();
        const scope = String(req.query.scope || '').trim().toLowerCase();

        if (store) {
            if (!assertStoreAccess(req, res, store)) return;
            res.json({
                success: true,
                ...buildAdminBuildToCatalog({ storeNumber: store, level: 'store' }),
            });
            return;
        }
        if (area || scope === 'area') {
            const areaName = area || String(req.query.areaName || '').trim();
            if (!areaName) {
                res.status(400).json({ success: false, error: 'Area is required.' });
                return;
            }
            const allowedAreas = new Set((getAccessibleAreasForUser(user) || []).map(String));
            if (!canUserEditGlobalBuildTo(user) && !allowedAreas.has(areaName)) {
                res.status(403).json({ success: false, error: 'Area is outside your scope.' });
                return;
            }
            res.json({
                success: true,
                ...buildAdminBuildToCatalog({ areaName, level: 'area' }),
            });
            return;
        }
        if (!canUserEditGlobalBuildTo(user)) {
            res.status(403).json({ success: false, error: 'Area access or above is required for global build-to.' });
            return;
        }
        res.json({ success: true, ...buildAdminBuildToCatalog({ level: 'global' }) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message || 'Could not load build-to catalog.' });
    }
});

app.get('/api/admin/build-to/overrides', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserAccessAdminMenu(user)) {
        res.status(403).json({ success: false, error: 'Admin menu access required.' });
        return;
    }
    const doc = readOverridesDoc();
    const filtered = filterOverridesForActor(
        doc,
        getEffectiveStoresForUser(user),
        canUserEditGlobalBuildTo(user),
        getAccessibleAreasForUser(user)
    );
    res.json({ success: true, overrides: filtered });
});

app.put('/api/admin/build-to/overrides', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserAccessAdminMenu(user)) {
        res.status(403).json({ success: false, error: 'Admin menu access required.' });
        return;
    }
    const allowedStores = new Set((getEffectiveStoresForUser(user) || []).map(String));
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const patch = { stores: {} };

    if (body.settings && canUserEditGlobalBuildTo(user)) {
        patch.settings = body.settings;
    } else if (body.settings && !canUserEditGlobalBuildTo(user)) {
        res.status(403).json({ success: false, error: 'Area access or above is required for global build-to settings.' });
        return;
    }

    if (body.global && canUserEditGlobalBuildTo(user)) {
        patch.global = body.global;
    } else if (body.global && !canUserEditGlobalBuildTo(user)) {
        res.status(403).json({ success: false, error: 'Area access or above is required for global build-to changes.' });
        return;
    }

    if (body.areas && typeof body.areas === 'object') {
        const allowedAreas = new Set((getAccessibleAreasForUser(user) || []).map(String));
        for (const [areaName, areaPatch] of Object.entries(body.areas)) {
            const area = String(areaName || '').trim();
            if (!area) continue;
            if (!canUserEditGlobalBuildTo(user) && !allowedAreas.has(area)) {
                res.status(403).json({ success: false, error: `Area ${areaName} is outside your scope.` });
                return;
            }
            patch.areas = patch.areas || {};
            patch.areas[area] = areaPatch;
        }
    }

    if (body.stores && typeof body.stores === 'object') {
        for (const [storeNumber, storePatch] of Object.entries(body.stores)) {
            const store = normalizeStoreKey(storeNumber);
            if (!store || !allowedStores.has(String(store))) {
                res.status(403).json({ success: false, error: `Store ${storeNumber} is outside your scope.` });
                return;
            }
            patch.stores[store] = storePatch;
        }
    }

    const overrides = patchOverrides(patch);
    appendAccountAudit({
        action: 'update-build-to-overrides',
        updatedBy: user.username,
        patch,
    });
    res.json({ success: true, overrides: filterOverridesForActor(
        overrides,
        getEffectiveStoresForUser(user),
        canUserEditGlobalBuildTo(user)
    ) });
});

function assertStoreLoginAccess(req, res, storeNumber) {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserManageStoreLogins(user)) {
        res.status(403).json({ success: false, error: 'You do not have permission to manage store logins.' });
        return false;
    }
    return assertStoreAccess(req, res, storeNumber);
}

function verifyPortalLogin(service, creds) {
    const svc = String(service || '').trim().toLowerCase();
    if (svc === 'mmx') {
        const username = String(creds?.username || '').trim();
        const password = String(creds?.password || '');
        if (!username || !password) {
            return Promise.resolve({ ok: false, error: 'Username and password are required.' });
        }
        return verifyMacromatixLogin(username, password);
    }
    if (svc === 'lifelenz') {
        const email = String(creds?.email || creds?.username || '').trim();
        const password = String(creds?.password || '');
        if (!email || !password) {
            return Promise.resolve({ ok: false, error: 'Email and password are required.' });
        }
        return verifyLifeLenzLogin(email, password, { headless: true, skipSlowMo: true });
    }
    const username = String(creds?.username || creds?.email || '').trim();
    const password = String(creds?.password || '');
    if (!username || !password) {
        return Promise.resolve({ ok: false, error: 'Login and password are required.' });
    }
    return Promise.resolve({ ok: true, stub: true });
}

app.get('/api/admin/store-logins', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserManageStoreLogins(user)) {
        res.status(403).json({ success: false, error: 'You do not have permission to manage store logins.' });
        return;
    }
    const stores = filterStoresForUser(user, getStoreList()).map((row) => {
        const summary = getStoreCredentialsSummary(row.storeNumber);
        const services = {};
        for (const svc of VALID_SERVICES) {
            const status = summary.services[svc];
            services[svc] = {
                configured: status.configured,
                primary: status.primary,
                fallbackCount: status.fallbacks.length,
            };
        }
        return {
            storeNumber: row.storeNumber,
            storeName: row.storeName || '',
            services,
        };
    });
    res.json({ success: true, stores, services: VALID_SERVICES });
});

app.get('/api/admin/store-logins/:storeNumber', (req, res) => {
    const store = String(req.params.storeNumber || '').trim();
    if (!store || !assertStoreLoginAccess(req, res, store)) return;
    res.json({ success: true, ...getStoreCredentialsSummary(store) });
});

app.post('/api/admin/store-logins/:storeNumber/:service/verify', async (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    const store = String(req.params.storeNumber || '').trim();
    const service = String(req.params.service || '').trim().toLowerCase();
    if (!store || !assertStoreLoginAccess(req, res, store)) return;
    if (!isValidService(service)) {
        res.status(400).json({ success: false, error: 'Invalid service.' });
        return;
    }
    const save = req.body?.save === true;
    const asFallback = req.body?.asFallback === true;
    const label = String(req.body?.label || (asFallback ? 'Fallback' : 'Primary')).trim();
    const firstMmxPrimarySave =
        save && !asFallback && service === 'mmx' && !storeHasServiceCredentials(store, service);
    const verifyResult = await verifyPortalLogin(service, req.body || {});
    if (!verifyResult.ok) {
        res.status(401).json({ success: false, error: verifyResult.error || 'Login verification failed.' });
        return;
    }
    let saved = null;
    if (save) {
        try {
            saved = asFallback
                ? addFallback(store, service, req.body, user.username, label)
                : savePrimary(store, service, req.body, user.username, label);
        } catch (err) {
            res.status(500).json({
                success: false,
                error: err?.message || 'Could not save credentials.',
            });
            return;
        }
        if (!saved.ok) {
            res.status(500).json({ success: false, error: saved.error || 'Could not save credentials.' });
            return;
        }
        if (firstMmxPrimarySave) {
            queueStoreLoginBootstrapScrape(store);
        }
    }
    res.json({
        success: true,
        verified: true,
        stub: Boolean(verifyResult.stub),
        saved: Boolean(save && saved?.ok),
        bootstrapScrapeStarted: Boolean(firstMmxPrimarySave && saved?.ok),
        summary: getStoreCredentialsSummary(store).services[service],
        updatedAt: saved?.updatedAt || null,
        updatedBy: saved?.updatedBy || user.username,
    });
});

app.put('/api/admin/store-logins/:storeNumber/:service/primary', async (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    const store = String(req.params.storeNumber || '').trim();
    const service = String(req.params.service || '').trim().toLowerCase();
    if (!store || !assertStoreLoginAccess(req, res, store)) return;
    if (!isValidService(service)) {
        res.status(400).json({ success: false, error: 'Invalid service.' });
        return;
    }
    const verifyFirst = req.body?.verify !== false;
    if (verifyFirst) {
        const verifyResult = await verifyPortalLogin(service, req.body || {});
        if (!verifyResult.ok) {
            res.status(401).json({ success: false, error: verifyResult.error || 'Login verification failed.' });
            return;
        }
    }
    const label = String(req.body?.label || 'Primary').trim();
    const saved = savePrimary(store, service, req.body, user.username, label);
    if (!saved.ok) {
        res.status(400).json({ success: false, error: saved.error });
        return;
    }
    res.json({
        success: true,
        summary: getStoreCredentialsSummary(store).services[service],
        updatedAt: saved.updatedAt,
        updatedBy: saved.updatedBy,
    });
});

app.post('/api/admin/store-logins/:storeNumber/:service/fallbacks', async (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    const store = String(req.params.storeNumber || '').trim();
    const service = String(req.params.service || '').trim().toLowerCase();
    if (!store || !assertStoreLoginAccess(req, res, store)) return;
    if (!isValidService(service)) {
        res.status(400).json({ success: false, error: 'Invalid service.' });
        return;
    }
    const verifyFirst = req.body?.verify !== false;
    if (verifyFirst) {
        const verifyResult = await verifyPortalLogin(service, req.body || {});
        if (!verifyResult.ok) {
            res.status(401).json({ success: false, error: verifyResult.error || 'Login verification failed.' });
            return;
        }
    }
    const label = String(req.body?.label || 'Fallback').trim();
    const saved = addFallback(store, service, req.body, user.username, label);
    if (!saved.ok) {
        res.status(400).json({ success: false, error: saved.error });
        return;
    }
    res.json({
        success: true,
        id: saved.id,
        summary: getStoreCredentialsSummary(store).services[service],
        updatedAt: saved.updatedAt,
        updatedBy: saved.updatedBy,
    });
});

app.delete('/api/admin/store-logins/:storeNumber/:service/fallbacks/:fallbackId', (req, res) => {
    const store = String(req.params.storeNumber || '').trim();
    const service = String(req.params.service || '').trim().toLowerCase();
    const fallbackId = String(req.params.fallbackId || '').trim();
    if (!store || !assertStoreLoginAccess(req, res, store)) return;
    if (!isValidService(service)) {
        res.status(400).json({ success: false, error: 'Invalid service.' });
        return;
    }
    const result = removeFallback(store, service, fallbackId);
    if (!result.ok) {
        res.status(400).json({ success: false, error: result.error });
        return;
    }
    res.json({ success: true, summary: getStoreCredentialsSummary(store).services[service] });
});

app.delete('/api/admin/store-logins/:storeNumber/:service', (req, res) => {
    const store = String(req.params.storeNumber || '').trim();
    const service = String(req.params.service || '').trim().toLowerCase();
    if (!store || !assertStoreLoginAccess(req, res, store)) return;
    if (!isValidService(service)) {
        res.status(400).json({ success: false, error: 'Invalid service.' });
        return;
    }
    const result = clearServiceCredentials(store, service);
    if (!result.ok) {
        res.status(400).json({ success: false, error: result.error });
        return;
    }
    res.json({ success: true, summary: getStoreCredentialsSummary(store).services[service] });
});

app.get('/api/admin/smg-nsf/settings', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserManageSmgNsfSettings(user)) {
        res.status(403).json({ success: false, error: 'Area access or above is required for SMG/NSF settings.' });
        return;
    }
    res.json({
        success: true,
        smg: getSmgPeriodConfig(),
        nsf: getNsfRoundConfig(),
        defaultNsfRounds: defaultRoundsForYear(new Date().getFullYear()),
    });
});

app.put('/api/admin/smg-nsf/smg', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserManageSmgNsfSettings(user)) {
        res.status(403).json({ success: false, error: 'Area access or above is required for SMG/NSF settings.' });
        return;
    }
    const result = saveSmgPeriodConfig(req.body || {}, user.username);
    if (!result.ok) {
        res.status(400).json({ success: false, error: result.error });
        return;
    }
    res.json({ success: true, smg: result.config });
});

app.put('/api/admin/smg-nsf/nsf', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!canUserManageSmgNsfSettings(user)) {
        res.status(403).json({ success: false, error: 'Area access or above is required for SMG/NSF settings.' });
        return;
    }
    const result = saveNsfRoundConfig(req.body || {}, user.username);
    if (!result.ok) {
        res.status(400).json({ success: false, error: result.error });
        return;
    }
    res.json({ success: true, nsf: result.config });
});

app.get('/api/account/create-options', (req, res) => {
    const actor = resolveCreateAccountActor(req);
    if (!actor) {
        res.status(403).json({ success: false, error: 'Sign in to create accounts first.' });
        return;
    }
    res.json({ success: true, ...getCreateAccountOptions(actor) });
});

app.post('/api/account/create', async (req, res) => {
    const actor = resolveCreateAccountActor(req);
    const parent = resolveCreateAccountParent(req);
    if (!actor || !parent) {
        res.status(403).json({
            success: false,
            error: 'Sign in on the Create Account page first.',
        });
        return;
    }

    const username = String(req.body?.username || '').trim();
    const useTemporaryPassword = Boolean(req.body?.useTemporaryPassword);
    let password = String(req.body?.password || '');
    let confirmPassword = String(req.body?.confirmPassword || '');
    const firstName = String(req.body?.firstName || '').trim();
    const lastName = String(req.body?.lastName || '').trim();
    const accountLevel = String(req.body?.accountLevel || '').trim();
    const storeNumber = String(req.body?.storeNumber || '').trim();
    const market = String(req.body?.market || '').trim();
    const area = String(req.body?.area || '').trim();
    const displayName =
        String(req.body?.displayName || '').trim() ||
        [firstName, lastName].filter(Boolean).join(' ').trim() ||
        firstName ||
        username;
    const mmxUsername = String(req.body?.mmxUsername || '').trim();
    const mmxPassword = String(req.body?.mmxPassword || '');

    if (useTemporaryPassword) {
        password = generateTemporaryPassword(accountLevel);
        confirmPassword = password;
    } else if (password !== confirmPassword) {
        res.status(400).json({ success: false, error: 'Passwords do not match.' });
        return;
    }

    const scopeCheck = validateCreateAccountPayload(actor, {
        accountLevel,
        storeNumber,
        market,
        area,
    });
    if (!scopeCheck.ok) {
        res.status(400).json({ success: false, error: scopeCheck.error });
        return;
    }

    const needsMmx = requiresMmxForAccountLevel(scopeCheck.accountLevel);
    if (needsMmx && !useTemporaryPassword) {
        if (!firstName || !lastName) {
            res.status(400).json({ success: false, error: 'First name and last name are required.' });
            return;
        }
    }

    const result = appendDashboardUser({
        username,
        password,
        displayName,
        accountLevel: scopeCheck.accountLevel,
        accessScope: scopeCheck.accessScope,
        createdBy: parent.parentUsername,
        addCbAlias: parent.addCbAlias && scopeCheck.accessScope?.type === 'store',
        passwordIsTemporary: useTemporaryPassword,
    });
    if (!result.ok) {
        res.status(400).json({ success: false, error: result.error });
        return;
    }

    if (!req.dashboardUser) {
        clearAccountGateCookie(res);
    }
    res.json({
        success: true,
        username: result.username,
        cbUsername: result.cbUsername,
        accountLevel: result.accountLevel,
        temporaryPassword: useTemporaryPassword ? password : undefined,
        message: useTemporaryPassword
            ? 'Account created. Share the temporary password; the user must set a new password on first sign-in.'
            : 'Account created.',
    });
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
    if (isCombinedStockCountSlug(vendorSlug)) {
        const store = stockCountStoreFromQuery(req);
        if (!store) {
            res.status(400).json({ success: false, error: 'Store is required.' });
            return;
        }
        const catalog = buildCombinedStockCountCatalog(pendingVendorLabelsForStockCount(req, store), store);
        if (!catalog.items.length) {
            res.status(404).json({
                success: false,
                error: 'No vendors need a stock count today.',
            });
            return;
        }
        res.json({ success: true, catalog, vendorSlugs: catalog.vendorSlugs });
        return;
    }
    const fullCatalog = /^(1|true|yes)$/i.test(String(req.query.full || req.query.match || ''));
    const store = stockCountStoreFromQuery(req);
    const catalog = getVendorCatalog(vendorSlug, {
        ...(fullCatalog ? {} : { forStockCount: true }),
        storeNumber: store || undefined,
    });
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
        if (isCombinedStockCountSlug(vendorSlug)) {
            res.status(400).json({
                success: false,
                error: 'Combined count uses per-vendor drafts - load vendor=combined catalog only.',
            });
            return;
        }
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
        const merge = Boolean(req.body?.merge);
        const draft = await saveDraftLocation(store, vendorSlug, location, items, undefined, { merge });
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

app.get('/api/stock-count/mmx-user-login', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    const store = stockCountStoreFromQuery(req);
    if (!store || !assertStoreAccess(req, res, store)) return;
    if (!stockCountUsesPersonalMmx(user)) {
        res.json({ success: true, required: false, configured: true });
        return;
    }
    const dashUser = String(user.username || '').trim();
    const creds = readMmxCredentialsForUser(dashUser);
    res.json({
        success: true,
        required: true,
        configured: hasMmxCredentialsForUser(dashUser),
        maskedUsername: creds ? maskMmxLoginForStatus(creds.username) : '',
    });
});

app.post('/api/stock-count/mmx-user-login', async (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!isRealDashboardUser(user)) {
        res.status(403).json({ success: false, error: 'Sign in with your crew account.' });
        return;
    }
    if (!stockCountUsesPersonalMmx(user)) {
        res.status(400).json({ success: false, error: 'Store login accounts use the store Macromatix login from Admin.' });
        return;
    }
    const dashUser = String(user.username || '').trim();
    const result = await verifyAndOptionallySaveUserMmxLogin(req, dashUser);
    if (!result.ok) {
        res.status(result.status || 400).json({ success: false, error: result.error });
        return;
    }
    res.json({ success: true, remembered: result.remembered, maskedUsername: maskMmxLoginForStatus(result.mmxUsername) });
});

app.get('/api/stock-count/send-plan', async (req, res) => {
    try {
        const store = stockCountStoreFromQuery(req);
        const vendorSlug = stockCountVendorFromQuery(req);
        if (!store || !assertStoreAccess(req, res, store)) return;
        const plan = await getStockCountSendPlan(store, vendorSlug, {
            pendingVendorLabels: pendingVendorLabelsForStockCount(req, store),
        });
        res.json(plan);
    } catch (error) {
        console.error('API: Error reading stock count send plan:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/stock-count/send-to-mmx', async (req, res) => {
    try {
        const store = stockCountStoreFromQuery(req);
        const vendorSlug = stockCountVendorFromQuery(req);
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertStockCountUserMmxLogin(req, res)) return;

        const pipeline = await getStockCountPipelineStatus(store);
        if (isStockCountPipelineBusy(pipeline.stage)) {
            console.log(
                `[StockCount] Send to MMX already in progress - store ${store} stage ${pipeline.stage}`
            );
            return res.json({
                success: true,
                accepted: true,
                inProgress: true,
                stage: pipeline.stage,
                sessionId: pipeline.sessionId || null,
            });
        }

        const skipKeyItemCount = /^(1|true|yes|on)$/i.test(
            String(req.body?.skipKeyItemCount ?? req.query.skipKeyItemCount ?? '')
        );
        if (skipKeyItemCount) {
            const user = req.dashboardUser || getRequestUser(req);
            if (!canUserEditGlobalBuildTo(user)) {
                return res.status(403).json({
                    success: false,
                    error: 'Area Manager access or above required to skip Key Item Count.',
                });
            }
            console.log(
                `[StockCount] Skip Key Item Count requested by ${user?.username || 'unknown'} - store ${store}`
            );
        }

        console.log(`[StockCount] Send to MMX (prepare) - store ${store} vendor ${vendorSlug}`);
        const mmxOpts = mmxAutomationOptions(req, store, {
            pendingVendorLabels: pendingVendorLabelsForStockCount(req, store),
            skipKeyItemCount,
        });
        res.json({ success: true, accepted: true });

        void prepareStockCountForMmx(store, vendorSlug, mmxOpts).catch(async (error) => {
            console.error('API: Error preparing stock count for MMX:', error);
            await recordStockCountPrepareFailure(store, error);
        });
    } catch (error) {
        console.error('API: Error starting stock count for MMX:', error);
        const status = /No stock count draft|Submit at least one|not found|ready to send|Continue button/i.test(
            error.message
        )
            ? 400
            : 500;
        res.status(status).json({ success: false, error: error.message });
    }
});

app.get('/api/stock-count/pipeline-status', async (req, res) => {
    try {
        const store = stockCountStoreFromQuery(req);
        if (!store || !assertStoreAccess(req, res, store)) return;
        const status = await getStockCountPipelineStatus(store);
        res.json(status);
    } catch (error) {
        console.error('API: Error reading stock count pipeline status:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/stock-count/send-to-mmx/apply', async (req, res) => {
    try {
        const store = stockCountStoreFromQuery(req);
        let sessionId = String(req.body?.sessionId || req.query.sessionId || '').trim();
        const ordersOnly = /^(1|true|yes|on)$/i.test(String(req.body?.ordersOnly ?? req.query.ordersOnly ?? ''));
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertStockCountUserMmxLogin(req, res)) return;

        if (ordersOnly) {
            console.log(`[StockCount] Scheduled orders only - store ${store}`);
            const skipReportDownload = /^(1|true|yes|on)$/i.test(
                String(req.body?.skipReportDownload ?? req.query.skipReportDownload ?? 'false')
            );
            const result = await runScheduledOrdersOnly(
                store,
                mmxAutomationOptions(req, store, { skipReportDownload })
            );
            res.json({ success: true, ...result });
            return;
        }

        if (!sessionId) {
            const pipeline = await getStockCountPipelineStatus(store);
            if (pipeline.inProgress && pipeline.sessionId) {
                sessionId = pipeline.sessionId;
            }
        }
        if (!sessionId) {
            res.status(400).json({ success: false, error: 'sessionId is required.' });
            return;
        }

        console.log(`[StockCount] Apply MMX count - store ${store} session ${sessionId}`);
        const result = await applyStockCountSession(store, sessionId, mmxAutomationOptions(req, store));
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('API: Error applying stock count in MMX:', error);
        const status = /session expired|not found|Apply button|Missing reports|already applied/i.test(error.message)
            ? 400
            : 500;
        res.status(status).json({ success: false, error: error.message });
    }
});

app.post('/api/stock-count/fill-orders', async (req, res) => {
    try {
        const store = stockCountStoreFromQuery(req);
        if (!store || !assertStoreAccess(req, res, store)) return;

        const skipReportDownload = /^(1|true|yes|on)$/i.test(
            String(req.body?.skipReportDownload ?? req.query.skipReportDownload ?? 'false')
        );
        console.log(`[StockCount] Fill scheduled orders - store ${store}`);
        const result = await runScheduledOrdersOnly(
            store,
            mmxAutomationOptions(req, store, { skipReportDownload })
        );
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('API: Error filling scheduled orders:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/stock-count/low-stock-summary', async (req, res) => {
    try {
        const store = stockCountStoreFromQuery(req);
        if (!store || !assertStoreAccess(req, res, store)) return;
        const summary = await getLowStockSummary(store);
        res.json({
            success: true,
            storeNumber: String(store),
            lowStockCount: summary.count,
            lowStockItems: summary.items || [],
            lowStockAlerts: summary.alerts || summary.items || [],
            stockLevelsSub: summary.count
                ? `${summary.count} item${summary.count === 1 ? '' : 's'} under ${summary.thresholdDays} days stock`
                : summary.checked
                  ? `No stock shortfalls (under ${summary.thresholdDays} days)`
                  : 'Stock levels not checked today',
            stockLevelsChecked: Boolean(summary.checked),
            stockLevelsCheckedAt: summary.checkedAt || null,
            thresholdDays: summary.thresholdDays,
        });
    } catch (error) {
        console.error('API: Error loading low stock summary:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/stock-count/check-stock-levels', async (req, res) => {
    try {
        const store = stockCountStoreFromQuery(req);
        if (!store || !assertStoreAccess(req, res, store)) return;

        const pipeline = await getStockCountPipelineStatus(store);
        if (isStockCountPipelineBusy(pipeline.stage)) {
            res.status(409).json({
                success: false,
                error: 'Stock count pipeline is running - try again when it finishes.',
                inProgress: true,
                stage: pipeline.stage,
            });
            return;
        }

        if (!assertStockCountUserMmxLogin(req, res)) return;

        console.log(`[StockCount] Check stock levels - store ${store} (async)`);
        res.json({ success: true, accepted: true, storeNumber: String(store) });

        void checkStockLevelsForStore(store, mmxAutomationOptions(req, store, {})).catch(async (error) => {
            console.error('API: Error checking stock levels:', error);
            await recordStockCountCheckFailure(store, error);
        });
    } catch (error) {
        console.error('API: Error starting stock level check:', error);
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
        if (isCombinedStockCountSlug(vendorSlug)) {
            const slugs = vendorSlugsFromPendingLabels(pendingVendorLabelsForStockCount(req, store));
            const submitted = [];
            for (const slug of slugs) {
                try {
                    const summary = await submitStockCount(store, slug);
                    if (summary) submitted.push(summary);
                } catch (error) {
                    if (!/Enter at least one count|No stock count draft/i.test(error.message)) {
                        throw error;
                    }
                }
            }
            if (!submitted.length) {
                res.status(400).json({
                    success: false,
                    error: 'Enter at least one count before saving.',
                });
                return;
            }
            console.log(
                `[StockCount] Combined submit store ${store} - ${submitted.map((s) => s.vendorLabel).join(', ')}`
            );
            res.json({ success: true, submitted, vendorSlugs: slugs, macromatixPending: true });
            return;
        }
        const summary = await submitStockCount(store, vendorSlug);
        if (!summary) {
            res.status(404).json({ success: false, error: 'Vendor catalog not found.' });
            return;
        }
        console.log(
            `[StockCount] Submitted store ${store} vendor ${vendorSlug} - ${summary.items?.length || 0} item(s)`
        );
        res.json({ success: true, ...summary, macromatixPending: true });
    } catch (error) {
        console.error('API: Error submitting stock count:', error);
        const status = /No stock count draft|already sent|Enter at least one count/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
});

app.get('/api/daily-stock-count/catalog', (req, res) => {
    try {
        const store = dailyCountStoreFromQuery(req);
        if (!store || !assertStoreAccess(req, res, store)) return;
        const catalog = buildDailyStockCountCatalog(store);
        if (!catalog) {
            res.status(404).json({
                success: false,
                error: 'No daily count items configured. Add | Daily to vendor catalog lines.',
            });
            return;
        }
        res.json({ success: true, catalog, storeNumber: store });
    } catch (error) {
        console.error('API: Error reading daily stock count catalog:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/daily-stock-count/draft', async (req, res) => {
    try {
        const store = dailyCountStoreFromQuery(req);
        if (!store || !assertStoreAccess(req, res, store)) return;
        const draft = await getDailyCountDraft(store);
        if (!draft) {
            res.status(404).json({ success: false, error: 'Daily count catalog not found.' });
            return;
        }
        res.json(draft);
    } catch (error) {
        console.error('API: Error reading daily stock count draft:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/daily-stock-count/draft', async (req, res) => {
    try {
        const store = dailyCountStoreFromQuery(req);
        if (!store || !assertStoreAccess(req, res, store)) return;
        const locationName = String(req.body?.location || req.query.location || '').trim();
        const itemCounts = req.body?.items || req.body?.counts || {};
        if (!locationName) {
            res.status(400).json({ success: false, error: 'Location is required.' });
            return;
        }
        const draft = await saveDailyCountDraftLocation(store, locationName, itemCounts);
        res.json(draft);
    } catch (error) {
        console.error('API: Error saving daily stock count draft:', error);
        const status = /Unknown location/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
});

app.get('/api/daily-stock-count/mmx-status', async (req, res) => {
    try {
        const store = dailyCountStoreFromQuery(req);
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDailyCountMmxAccess(req, res)) return;
        const mmxOpts = mmxAutomationOptions(req, store);
        const probeTimeoutMs = Number(process.env.DAILY_COUNT_MMX_PROBE_MS || 90000);
        const result = await Promise.race([
            probeOpenCounts(store, mmxOpts),
            new Promise((_, reject) => {
                setTimeout(
                    () => reject(new Error('Macromatix check timed out. Try again in a moment.')),
                    probeTimeoutMs
                );
            }),
        ]);
        res.json(result);
    } catch (error) {
        console.error('API: Error probing daily count MMX status:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/daily-stock-count/start', async (req, res) => {
    try {
        const store = dailyCountStoreFromQuery(req);
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDailyCountMmxAccess(req, res)) return;
        const resolution = String(req.body?.resolution || 'create').trim();
        const openBatchValue = req.body?.openBatchValue ?? null;
        if (!['create', 'overwrite', 'delete'].includes(resolution)) {
            res.status(400).json({ success: false, error: 'Invalid resolution.' });
            return;
        }
        const draft = await setDailyCountStartResolution(store, { resolution, openBatchValue });
        res.json({ success: true, ...draft });
    } catch (error) {
        console.error('API: Error starting daily stock count:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/daily-stock-count/submit', async (req, res) => {
    try {
        const store = dailyCountStoreFromQuery(req);
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDailyCountMmxAccess(req, res)) return;

        const pipeline = await getDailyCountPipelineStatus(store);
        if (isDailyCountPipelineBusy(pipeline.stage)) {
            res.json({
                success: true,
                accepted: true,
                inProgress: true,
                stage: pipeline.stage,
                sessionId: pipeline.sessionId || null,
            });
            return;
        }

        const summary = await getDailyCountSummary(store);
        if (!summary?.hasCounts) {
            res.status(400).json({ success: false, error: 'Enter at least one count before submitting.' });
            return;
        }

        res.json({ success: true, accepted: true });
        const mmxOpts = mmxAutomationOptions(req, store);
        void prepareDailyCountForMmx(store, mmxOpts).catch((error) => {
            console.error('API: Error preparing daily count for MMX:', error);
        });
    } catch (error) {
        console.error('API: Error submitting daily stock count:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/daily-stock-count/pipeline-status', async (req, res) => {
    try {
        const store = dailyCountStoreFromQuery(req);
        if (!store || !assertStoreAccess(req, res, store)) return;
        res.json(await getDailyCountPipelineStatus(store));
    } catch (error) {
        console.error('API: Error reading daily stock count pipeline status:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/daily-stock-count/apply', async (req, res) => {
    try {
        const store = dailyCountStoreFromQuery(req);
        const sessionId = String(req.body?.sessionId || req.query.sessionId || '').trim();
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDailyCountMmxAccess(req, res)) return;
        if (!sessionId) {
            res.status(400).json({ success: false, error: 'sessionId is required.' });
            return;
        }
        const result = await applyDailyCountSessionWork(store, sessionId, mmxAutomationOptions(req, store));
        res.json(result);
    } catch (error) {
        console.error('API: Error applying daily stock count:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/daily-stock-count/recount', async (req, res) => {
    try {
        const store = dailyCountStoreFromQuery(req);
        if (!store || !assertStoreAccess(req, res, store)) return;
        await cancelDailyCountSession(store);
        const draft = await reopenDailyCountDraft(store, undefined, { resumeOpenCountInMmx: true });
        res.json({ success: true, storeNumber: store, draft });
    } catch (error) {
        console.error('API: Error cancelling daily count session:', error);
        res.status(500).json({ success: false, error: error.message });
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
            const user = req.dashboardUser || getRequestUser(req);
            const fullPayload = await getSalesDataCached();
            const slice = await enrichSalesSliceWithStockCount(
                filterSalesSliceForUser(
                    buildTestStoreSalesSlice(fullPayload, { stickyKey: stickyKeyForTestMirror(req, user) }),
                    user
                ),
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
        const user = req.dashboardUser || getRequestUser(req);
        res.json({
            ...(await enrichSalesSliceWithStockCount(
                filterSalesSliceForUser(storeSliceFromPayload(fullPayload, requestedStore), user),
                { testPending }
            )),
            salesScrapeStatus: getSalesScrapeStatus(user),
        });
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

async function handleOverviewApi(req, res) {
    try {
        if (!assertOverviewAccess(req, res)) return;
        const user = req.dashboardUser || getRequestUser(req);
        const scope = getOverviewScope(user);
        const storeQuery = String(req.query.store || '').trim();
        const viewAsStore =
            storeQuery &&
            scope !== 'store' &&
            hasMultiStoreScope(user) &&
            userCanAccessStore(user, storeQuery);

        if (scope === 'store' || viewAsStore) {
            const store = scope === 'store' ? storeQuery || singleStoreForUser(user) : storeQuery;
            if (!store || !assertStoreAccess(req, res, store)) return;
            let storeSlice = {};
            if (isTestStore(store)) {
                const payload = await getSalesDataCached();
                storeSlice = buildTestStoreSalesSlice(payload, { stickyKey: stickyKeyForTestMirror(req, user) });
            } else {
                const payload = await getSalesDataCached();
                storeSlice = storeSliceFromPayload(payload, store) || {};
                await enrichSalesSliceWithStockCount(storeSlice);
            }
            const result = await buildOverviewPayload(user, {
                store,
                storeSlice,
                buildDailyStockCountTileStateAsync,
                buildStockCountTileStateAsync,
                getAuditState,
                isTestStore,
                getAuditSchedule,
                canUserAccessDfsc,
            });
            if (!result.ok) {
                res.status(400).json({ success: false, error: result.error });
                return;
            }
            const { ok, ...payload } = result;
            res.json({ success: true, salesScrapeStatus: getSalesScrapeStatus(user), ...payload });
            return;
        }

        let payload;
        try {
            payload = await getSalesDataCached();
        } catch (error) {
            payload = salesCache || buildCacheShellFromStoreList();
        }
        let stores = getStoreList().map((s) => ({
            storeNumber: s.storeNumber,
            storeName: s.storeName,
            area: areaNameFromStore(s),
            areaKey: normalizeAreaKey(areaNameFromStore(s)),
            timeZone: s.timeZone || process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne',
            openHour: s.openHour,
            closeHour: s.closeHour,
        }));
        stores = filterStoresForUser(user, stores);
        const result = await buildOverviewPayload(user, {
            salesPayload: payload,
            stores,
            loadAuditStateMapForStores,
            getAuditSchedule,
            getSalesUpdatedAt,
        });
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        const { ok, ...body } = result;
        res.json({
            success: true,
            salesScrapeStatus: getSalesScrapeStatus(user),
            ...body,
        });
    } catch (error) {
        console.error('API: Error loading overview:', error);
        res.status(500).json({ success: false, error: error.message });
    }
}

app.get('/api/overview', handleOverviewApi);

// MIC overview - store manager dashboard tiles (alias for /api/overview).
app.get('/api/mic', handleOverviewApi);

app.post('/api/mic/daily-item-multiplier', (req, res) => {
    try {
        const user = req.dashboardUser || getRequestUser(req);
        const itemLabel = String(req.body?.itemLabel || '').trim();
        const store = String(req.body?.store || req.query?.store || '').trim();
        const stores = req.body?.stores;
        const scopeAll = req.body?.allStores === true || stores === '*';

        const marketMultiStore =
            hasMultiStoreScope(user) && (scopeAll || (Array.isArray(stores) && stores.length));
        if ((isSuperAdminUser(user) || marketMultiStore) && (scopeAll || (Array.isArray(stores) && stores.length))) {
            const effectiveStores = scopeAll ? '*' : stores;
            const result = addDailyItemMultiplier({
                itemLabel,
                stores: isSuperAdminUser(user) && scopeAll ? '*' : effectiveStores,
                setBy: user?.username || '',
            });
            if (!result.ok) {
                res.status(400).json({ success: false, error: result.error });
                return;
            }
            res.json({ success: true, rule: result.rule });
            return;
        }

        if (!store || !assertStoreAccess(req, res, store)) return;
        if (req.body?.clear === true || /^nothing$/i.test(itemLabel)) {
            const result = clearStoreDailyMultipliers(store);
            if (!result.ok) {
                res.status(400).json({ success: false, error: result.error });
                return;
            }
            res.json({ success: true, cleared: true });
            return;
        }
        const result = setDailyItemMultiplier(store, itemLabel, {
            setBy: user?.username || '',
            replace: true,
        });
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, rule: result.rule });
    } catch (error) {
        console.error('API: Error setting MIC multiplier:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/mic/daily-item-multiplier/:id', (req, res) => {
    try {
        const user = req.dashboardUser || getRequestUser(req);
        if (!isAdminUser(user)) {
            res.status(403).json({ success: false, error: 'Admin only.' });
            return;
        }
        const result = removeDailyItemMultiplier(req.params.id);
        if (!result.ok) {
            res.status(404).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/dfsc/context', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const ctx = dfscRequestUserContext(req);
        res.json({
            success: true,
            ...getDfscContext(store, {
                username: ctx.username,
                conductorFullName: ctx.conductorFullName,
                accountLevel: ctx.accountLevel,
                canAccessDfsc: ctx.canAccessDfsc,
                canCompleteAudits: ctx.canCompleteAudits,
                canStartAudits: ctx.canStartAudits,
                isAdmin: ctx.isAdmin,
            }),
            conductorFullName: ctx.conductorFullName,
            currentUsername: ctx.username,
            canAccessDfsc: true,
        });
    } catch (error) {
        console.error('API: Error loading DFSC context:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/dfsc/open', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const ctx = dfscRequestUserContext(req);
        res.json({
            success: true,
            openAudits: listDfscOpenAudits(store, { access: ctx.access }),
        });
    } catch (error) {
        console.error('API: Error listing open DFSC audits:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/dfsc/history', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const limit = Number(req.query.limit) || 50;
        res.json({ success: true, history: listDfscInspectionHistory(store, { limit }) });
    } catch (error) {
        console.error('API: Error loading DFSC inspection history:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/dfsc/session', (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        const sessionId = String(req.body?.sessionId || req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const ctx = dfscRequestUserContext(req);
        const result = deleteDfscOpenAudit(store, sessionId, ctx.access);
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({
            success: true,
            deletedId: result.deletedId,
            openAudits: listDfscOpenAudits(store, { access: ctx.access }),
        });
    } catch (error) {
        console.error('API: Error deleting open DFSC audit:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/dfsc/start', (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        if (!assertCanStartAudit(req, res)) return;
        const ctx = dfscRequestUserContext(req);
        const result = createDfscSession(store, {
            name: req.body?.name,
            shift: req.body?.shift,
            startSignatureDataUrl: req.body?.startSignatureDataUrl,
            forceNew: Boolean(req.body?.forceNew),
            clientMeta: req.body?.clientMeta,
            createdByUsername: ctx.username,
        });
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, session: result.session, resumed: result.resumed });
    } catch (error) {
        console.error('API: Error starting DFSC:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/dfsc/session', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        const sessionId = String(req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const session = getDfscSessionById(store, sessionId, req.query.dateKey);
        if (!assertDfscSessionAccess(req, res, session)) return;
        const ctx = dfscRequestUserContext(req);
        const canReopen =
            session.status === 'completed' &&
            (ctx.isAdmin || dfscUserOwnsSession(session, ctx.username, ctx.conductorFullName));
        res.json({ success: true, session, canReopen });
    } catch (error) {
        console.error('API: Error loading DFSC session:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/dfsc/report.pdf', async (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        const sessionId = String(req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const session = getDfscSessionById(store, sessionId, req.query.dateKey);
        if (!session) {
            res.status(404).json({ success: false, error: 'Session not found.' });
            return;
        }
        if (session.status !== 'completed') {
            res.status(400).json({ success: false, error: 'PDF is only available for completed inspections.' });
            return;
        }
        const pdfBuffer = await buildDfscReportPdf(session);
        const filename = buildReportFilename(session);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(pdfBuffer);
    } catch (error) {
        console.error('API: Error generating DFSC PDF:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/dfsc/core-report.pdf', async (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const { buffer, filename } = await buildCoreReportPdf(store);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buffer);
    } catch (error) {
        console.error('API: Error generating DFSC CORE report:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/dfsc/reopen', (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        const sessionId = String(req.body?.sessionId || req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const session = getDfscSessionById(store, sessionId, req.body?.dateKey || req.query.dateKey);
        if (!assertDfscSessionAccess(req, res, session, { reopen: true })) return;
        const ctx = dfscRequestUserContext(req);
        const result = reopenDfscSession(store, sessionId, req.body?.dateKey || req.query.dateKey, ctx.access);
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, session: result.session, nonCompliant: result.nonCompliant });
    } catch (error) {
        console.error('API: Error reopening DFSC session:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/dfsc/session', (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        const sessionId = String(req.body?.sessionId || req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const existing = getDfscSessionById(store, sessionId, req.body?.dateKey);
        if (!assertDfscSessionAccess(req, res, existing)) return;
        const ctx = dfscRequestUserContext(req);
        const result = updateDfscSession(
            store,
            sessionId,
            {
                answers: req.body?.answers,
                sectionSkips: req.body?.sectionSkips,
                actions: req.body?.actions,
                notes: req.body?.notes,
                signOff: req.body?.signOff,
                dateKey: req.body?.dateKey,
                clientMeta: req.body?.clientMeta,
            },
            ctx.access
        );
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, session: result.session, nonCompliant: result.nonCompliant });
    } catch (error) {
        console.error('API: Error saving DFSC session:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/dfsc/session/validate-section', (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        const sessionId = String(req.body?.sessionId || req.query.sessionId || '').trim();
        const sectionId = String(req.body?.sectionId || '').trim();
        if (!store || !sessionId || !sectionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const existing = getDfscSessionById(store, sessionId, req.body?.dateKey);
        if (!assertDfscSessionAccess(req, res, existing)) return;
        const ctx = dfscRequestUserContext(req);
        const result = validateSessionSection(store, sessionId, sectionId, ctx.access);
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true });
    } catch (error) {
        console.error('API: Error validating DFSC section:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/dfsc/submit', (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        const sessionId = String(req.body?.sessionId || req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        if (!assertCanCompleteAudit(req, res)) return;
        const existing = getDfscSessionById(store, sessionId, req.body?.dateKey);
        if (!assertDfscSessionAccess(req, res, existing)) return;
        const ctx = dfscRequestUserContext(req);
        const result = submitDfscSession(store, sessionId, req.body?.signOff || {}, ctx.access);
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, session: result.session });
    } catch (error) {
        console.error('API: Error submitting DFSC:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/pest-walk/context', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const ctx = dfscRequestUserContext(req);
        res.json({
            success: true,
            ...getPestWalkContext(store, {
                username: ctx.username,
                conductorFullName: ctx.conductorFullName,
                accountLevel: ctx.accountLevel,
                canAccessDfsc: ctx.canAccessDfsc,
                canCompleteAudits: ctx.canCompleteAudits,
                canStartAudits: ctx.canStartAudits,
                isAdmin: ctx.isAdmin,
            }),
            canAccessPestWalk: true,
        });
    } catch (error) {
        console.error('API: Error loading pest walk context:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/pest-walk/open', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const ctx = dfscRequestUserContext(req);
        res.json({
            success: true,
            openAudits: listPestWalkOpenAudits(store, { access: ctx.access }),
        });
    } catch (error) {
        console.error('API: Error listing open pest walk audits:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/pest-walk/history', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        const limit = Number(req.query.limit) || 50;
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        res.json({ success: true, history: listPestWalkInspectionHistory(store, { limit }) });
    } catch (error) {
        console.error('API: Error loading pest walk history:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/pest-walk/session', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        const sessionId = String(req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const ctx = dfscRequestUserContext(req);
        const result = deletePestWalkOpenAudit(store, sessionId, ctx.access);
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({
            success: true,
            deletedId: result.deletedId,
            openAudits: listPestWalkOpenAudits(store, { access: ctx.access }),
        });
    } catch (error) {
        console.error('API: Error deleting open pest walk audit:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/pest-walk/start', (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        if (!assertCanStartAudit(req, res)) return;
        const ctx = dfscRequestUserContext(req);
        const result = createPestWalkSession(store, {
            name: req.body?.name,
            startSignatureDataUrl: req.body?.startSignatureDataUrl,
            forceNew: Boolean(req.body?.forceNew),
            clientMeta: req.body?.clientMeta,
            createdByUsername: ctx.username,
        });
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, session: result.session, resumed: result.resumed });
    } catch (error) {
        console.error('API: Error starting pest walk:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/pest-walk/session', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        const sessionId = String(req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const session = getPestWalkSessionById(store, sessionId, req.query.periodKey);
        if (!assertPestWalkSessionAccess(req, res, session)) return;
        const ctx = dfscRequestUserContext(req);
        const canReopen =
            session.status === 'completed' &&
            (ctx.isAdmin || pestWalkUserOwnsSession(session, ctx.username, ctx.conductorFullName));
        res.json({ success: true, session, canReopen });
    } catch (error) {
        console.error('API: Error loading pest walk session:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/pest-walk/report.pdf', async (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        const sessionId = String(req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const session = getPestWalkSessionById(store, sessionId, req.query.periodKey);
        if (!session || session.status !== 'completed') {
            res.status(404).json({ success: false, error: 'Completed audit not found.' });
            return;
        }
        const pdfBuffer = await buildPestWalkReportPdf(session);
        const filename = buildPestWalkReportFilename(session);
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(pdfBuffer);
    } catch (error) {
        console.error('API: Error generating pest walk PDF:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/pest-walk/reopen', (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        const sessionId = String(req.body?.sessionId || req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const session = getPestWalkSessionById(store, sessionId, req.body?.periodKey || req.query.periodKey);
        if (!assertPestWalkSessionAccess(req, res, session, { reopen: true })) return;
        const ctx = dfscRequestUserContext(req);
        const result = reopenPestWalkSession(store, sessionId, req.body?.periodKey || req.query.periodKey, ctx.access);
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, session: result.session, nonCompliant: result.nonCompliant });
    } catch (error) {
        console.error('API: Error reopening pest walk:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/pest-walk/session', (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        const sessionId = String(req.body?.sessionId || req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const existing = getPestWalkSessionById(store, sessionId, req.body?.periodKey);
        if (!assertPestWalkSessionAccess(req, res, existing)) return;
        const ctx = dfscRequestUserContext(req);
        const result = updatePestWalkSession(
            store,
            sessionId,
            {
                periodKey: req.body?.periodKey,
                answers: req.body?.answers,
                actions: req.body?.actions,
                notes: req.body?.notes,
                signOff: req.body?.signOff,
                clientMeta: req.body?.clientMeta,
            },
            ctx.access
        );
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, session: result.session, nonCompliant: result.nonCompliant, score: result.score });
    } catch (error) {
        console.error('API: Error saving pest walk session:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/pest-walk/session/validate-section', (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        const sessionId = String(req.body?.sessionId || req.query.sessionId || '').trim();
        const sectionId = String(req.body?.sectionId || '').trim();
        if (!store || !sessionId || !sectionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const existing = getPestWalkSessionById(store, sessionId, req.body?.periodKey);
        if (!assertPestWalkSessionAccess(req, res, existing)) return;
        const ctx = dfscRequestUserContext(req);
        const result = validatePestWalkSection(store, sessionId, sectionId, ctx.access);
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true });
    } catch (error) {
        console.error('API: Error validating pest walk section:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/pest-walk/submit', async (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        const sessionId = String(req.body?.sessionId || req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        if (!assertCanCompleteAudit(req, res)) return;
        const existing = getPestWalkSessionById(store, sessionId, req.body?.periodKey);
        if (!assertPestWalkSessionAccess(req, res, existing)) return;
        const ctx = dfscRequestUserContext(req);
        const result = submitPestWalkSession(store, sessionId, req.body?.signOff || {}, ctx.access);
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        await dismissAuditLabelForStore(store, result.auditLabel || PEST_WALK_AUDIT_LABEL);
        res.json({ success: true, session: result.session });
    } catch (error) {
        console.error('API: Error submitting pest walk:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/rgm-cleaning/context', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const ctx = dfscRequestUserContext(req);
        res.json({
            success: true,
            ...getRgmCleaningContext(store, {
                username: ctx.username,
                conductorFullName: ctx.conductorFullName,
                accountLevel: ctx.accountLevel,
                canAccessDfsc: ctx.canAccessDfsc,
                canCompleteAudits: ctx.canCompleteAudits,
                canStartAudits: ctx.canStartAudits,
                isAdmin: ctx.isAdmin,
            }),
            canAccessRgmCleaning: true,
        });
    } catch (error) {
        console.error('API: Error loading RGM cleaning context:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/rgm-cleaning/open', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const ctx = dfscRequestUserContext(req);
        res.json({
            success: true,
            openAudits: listRgmCleaningOpenAudits(store, { access: ctx.access }),
        });
    } catch (error) {
        console.error('API: Error listing open RGM cleaning audits:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/rgm-cleaning/history', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        const limit = Number(req.query.limit) || 50;
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        res.json({ success: true, history: listRgmCleaningInspectionHistory(store, { limit }) });
    } catch (error) {
        console.error('API: Error loading RGM cleaning history:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/rgm-cleaning/session', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        const sessionId = String(req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const ctx = dfscRequestUserContext(req);
        const result = deleteRgmCleaningOpenAudit(store, sessionId, ctx.access);
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({
            success: true,
            deletedId: result.deletedId,
            openAudits: listRgmCleaningOpenAudits(store, { access: ctx.access }),
        });
    } catch (error) {
        console.error('API: Error deleting open RGM cleaning audit:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/rgm-cleaning/start', (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        if (!assertCanStartAudit(req, res)) return;
        const ctx = dfscRequestUserContext(req);
        const result = createRgmCleaningSession(store, {
            name: req.body?.name,
            startSignatureDataUrl: req.body?.startSignatureDataUrl,
            forceNew: Boolean(req.body?.forceNew),
            clientMeta: req.body?.clientMeta,
            createdByUsername: ctx.username,
        });
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, session: result.session, resumed: result.resumed });
    } catch (error) {
        console.error('API: Error starting RGM cleaning:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/rgm-cleaning/session', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        const sessionId = String(req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const session = getRgmCleaningSessionById(store, sessionId, req.query.periodKey);
        if (!assertRgmCleaningSessionAccess(req, res, session)) return;
        const ctx = dfscRequestUserContext(req);
        const canReopen =
            session.status === 'completed' &&
            (ctx.isAdmin || rgmCleaningUserOwnsSession(session, ctx.username, ctx.conductorFullName));
        res.json({ success: true, session, canReopen });
    } catch (error) {
        console.error('API: Error loading RGM cleaning session:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/rgm-cleaning/report.pdf', async (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        const sessionId = String(req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const session = getRgmCleaningSessionById(store, sessionId, req.query.periodKey);
        if (!session || session.status !== 'completed') {
            res.status(404).json({ success: false, error: 'Completed audit not found.' });
            return;
        }
        const pdfBuffer = await buildRgmCleaningReportPdf(session);
        const filename = buildRgmCleaningReportFilename(session);
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(pdfBuffer);
    } catch (error) {
        console.error('API: Error generating RGM cleaning PDF:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/rgm-cleaning/reopen', (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        const sessionId = String(req.body?.sessionId || req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const session = getRgmCleaningSessionById(store, sessionId, req.body?.periodKey || req.query.periodKey);
        if (!assertRgmCleaningSessionAccess(req, res, session, { reopen: true })) return;
        const ctx = dfscRequestUserContext(req);
        const result = reopenRgmCleaningSession(store, sessionId, req.body?.periodKey || req.query.periodKey, ctx.access);
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, session: result.session, nonCompliant: result.nonCompliant });
    } catch (error) {
        console.error('API: Error reopening RGM cleaning:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/rgm-cleaning/session', (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        const sessionId = String(req.body?.sessionId || req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const existing = getRgmCleaningSessionById(store, sessionId, req.body?.periodKey);
        if (!assertRgmCleaningSessionAccess(req, res, existing)) return;
        const ctx = dfscRequestUserContext(req);
        const result = updateRgmCleaningSession(
            store,
            sessionId,
            {
                periodKey: req.body?.periodKey,
                answers: req.body?.answers,
                actions: req.body?.actions,
                notes: req.body?.notes,
                photos: req.body?.photos,
                squareOnePhotoReviews: req.body?.squareOnePhotoReviews,
                signOff: req.body?.signOff,
                clientMeta: req.body?.clientMeta,
            },
            ctx.access
        );
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, session: result.session, nonCompliant: result.nonCompliant, score: result.score });
    } catch (error) {
        console.error('API: Error saving RGM cleaning session:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/rgm-cleaning/session/validate-section', (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        const sessionId = String(req.body?.sessionId || req.query.sessionId || '').trim();
        const sectionId = String(req.body?.sectionId || '').trim();
        if (!store || !sessionId || !sectionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const existing = getRgmCleaningSessionById(store, sessionId, req.body?.periodKey);
        if (!assertRgmCleaningSessionAccess(req, res, existing)) return;
        const ctx = dfscRequestUserContext(req);
        const result = validateRgmCleaningSection(store, sessionId, sectionId, ctx.access);
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true });
    } catch (error) {
        console.error('API: Error validating RGM cleaning section:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/rgm-cleaning/submit', async (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        const sessionId = String(req.body?.sessionId || req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        if (!assertCanCompleteAudit(req, res)) return;
        const existing = getRgmCleaningSessionById(store, sessionId, req.body?.periodKey);
        if (!assertRgmCleaningSessionAccess(req, res, existing)) return;
        const ctx = dfscRequestUserContext(req);
        const result = submitRgmCleaningSession(store, sessionId, req.body?.signOff || {}, ctx.access);
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        await dismissAuditLabelForStore(store, result.auditLabel || RGM_CLEANING_AUDIT_LABEL);
        res.json({ success: true, session: result.session });
    } catch (error) {
        console.error('API: Error submitting RGM cleaning:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/psi/context', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const ctx = dfscRequestUserContext(req);
        res.json({
            success: true,
            ...getPsiContext(store, {
                username: ctx.username,
                conductorFullName: ctx.conductorFullName,
                accountLevel: ctx.accountLevel,
                canAccessDfsc: ctx.canAccessDfsc,
                canCompleteAudits: ctx.canCompleteAudits,
                canStartAudits: ctx.canStartAudits,
                isAdmin: ctx.isAdmin,
            }),
            canAccessPsi: true,
        });
    } catch (error) {
        console.error('API: Error loading PSI context:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/psi/open', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const ctx = dfscRequestUserContext(req);
        res.json({
            success: true,
            openAudits: listPsiOpenAudits(store, { access: ctx.access }),
        });
    } catch (error) {
        console.error('API: Error listing open PSI audits:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/psi/history', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        const limit = Number(req.query.limit) || 50;
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        res.json({ success: true, history: listPsiInspectionHistory(store, { limit }) });
    } catch (error) {
        console.error('API: Error loading PSI history:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/psi/session', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        const sessionId = String(req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const ctx = dfscRequestUserContext(req);
        const result = deletePsiOpenAudit(store, sessionId, ctx.access);
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({
            success: true,
            deletedId: result.deletedId,
            openAudits: listPsiOpenAudits(store, { access: ctx.access }),
        });
    } catch (error) {
        console.error('API: Error deleting open PSI audit:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/psi/start', (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        if (!assertCanStartAudit(req, res)) return;
        const ctx = dfscRequestUserContext(req);
        const result = createPsiSession(store, {
            name: req.body?.name,
            startSignatureDataUrl: req.body?.startSignatureDataUrl,
            forceNew: Boolean(req.body?.forceNew),
            clientMeta: req.body?.clientMeta,
            createdByUsername: ctx.username,
        });
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, session: result.session, resumed: result.resumed });
    } catch (error) {
        console.error('API: Error starting PSI:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/psi/session', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        const sessionId = String(req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const session = getPsiSessionById(store, sessionId, req.query.periodKey);
        if (!assertPsiSessionAccess(req, res, session)) return;
        const ctx = dfscRequestUserContext(req);
        const canReopen =
            session.status === 'completed' &&
            (ctx.isAdmin || psiUserOwnsSession(session, ctx.username, ctx.conductorFullName));
        res.json({ success: true, session, canReopen });
    } catch (error) {
        console.error('API: Error loading PSI session:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/psi/report.pdf', async (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        const sessionId = String(req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const session = getPsiSessionById(store, sessionId, req.query.periodKey);
        if (!session || session.status !== 'completed') {
            res.status(404).json({ success: false, error: 'Completed inspection not found.' });
            return;
        }
        const pdfBuffer = await buildPsiReportPdf(session);
        const filename = buildPsiReportFilename(session);
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(pdfBuffer);
    } catch (error) {
        console.error('API: Error generating PSI PDF:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/psi/reopen', (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        const sessionId = String(req.body?.sessionId || req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const session = getPsiSessionById(store, sessionId, req.body?.periodKey || req.query.periodKey);
        if (!assertPsiSessionAccess(req, res, session, { reopen: true })) return;
        const ctx = dfscRequestUserContext(req);
        const result = reopenPsiSession(store, sessionId, req.body?.periodKey || req.query.periodKey, ctx.access);
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, session: result.session, nonCompliant: result.nonCompliant });
    } catch (error) {
        console.error('API: Error reopening PSI:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/psi/session', (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        const sessionId = String(req.body?.sessionId || req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const existing = getPsiSessionById(store, sessionId, req.body?.periodKey);
        if (!assertPsiSessionAccess(req, res, existing)) return;
        const ctx = dfscRequestUserContext(req);
        const result = updatePsiSession(
            store,
            sessionId,
            {
                periodKey: req.body?.periodKey,
                answers: req.body?.answers,
                notes: req.body?.notes,
                signOff: req.body?.signOff,
                clientMeta: req.body?.clientMeta,
            },
            ctx.access
        );
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, session: result.session, nonCompliant: result.nonCompliant, score: result.score });
    } catch (error) {
        console.error('API: Error saving PSI session:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/psi/session/validate-section', (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        const sessionId = String(req.body?.sessionId || req.query.sessionId || '').trim();
        const sectionId = String(req.body?.sectionId || '').trim();
        if (!store || !sessionId || !sectionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const existing = getPsiSessionById(store, sessionId, req.body?.periodKey);
        if (!assertPsiSessionAccess(req, res, existing)) return;
        const ctx = dfscRequestUserContext(req);
        const result = validatePsiSection(store, sessionId, sectionId, ctx.access);
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true });
    } catch (error) {
        console.error('API: Error validating PSI section:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/psi/submit', async (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        const sessionId = String(req.body?.sessionId || req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        if (!assertCanCompleteAudit(req, res)) return;
        const existing = getPsiSessionById(store, sessionId, req.body?.periodKey);
        if (!assertPsiSessionAccess(req, res, existing)) return;
        const ctx = dfscRequestUserContext(req);
        const result = submitPsiSession(store, sessionId, req.body?.signOff || {}, ctx.access);
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        await dismissAuditLabelForStore(store, result.auditLabel || PSI_AUDIT_LABEL);
        res.json({ success: true, session: result.session });
    } catch (error) {
        console.error('API: Error submitting PSI:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/square-one/context', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const ctx = dfscRequestUserContext(req);
        res.json({
            success: true,
            ...getSquareOneContext(store, {
                username: ctx.username,
                conductorFullName: ctx.conductorFullName,
                accountLevel: ctx.accountLevel,
                canAccessDfsc: ctx.canAccessDfsc,
                canCompleteAudits: ctx.canCompleteAudits,
                canStartAudits: ctx.canStartAudits,
                isAdmin: ctx.isAdmin,
                areaId: req.query.areaId,
            }),
        });
    } catch (error) {
        console.error('API: Error loading Square One context:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/square-one/open', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const ctx = dfscRequestUserContext(req);
        res.json({ success: true, openAudits: listSquareOneOpenAudits(store, { access: ctx.access }) });
    } catch (error) {
        console.error('API: Error listing open Square One audits:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/square-one/history', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        const limit = Number(req.query.limit) || 50;
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        res.json({ success: true, history: listSquareOneInspectionHistory(store, { limit }) });
    } catch (error) {
        console.error('API: Error loading Square One history:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/square-one/session', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        const sessionId = String(req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const ctx = dfscRequestUserContext(req);
        const result = deleteSquareOneOpenAudit(store, sessionId, ctx.access);
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({
            success: true,
            deletedId: result.deletedId,
            openAudits: listSquareOneOpenAudits(store, { access: ctx.access }),
        });
    } catch (error) {
        console.error('API: Error deleting open Square One audit:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/square-one/start', (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        if (!assertCanStartAudit(req, res)) return;
        const ctx = dfscRequestUserContext(req);
        const result = createSquareOneSession(store, {
            areaId: req.body?.areaId,
            name: req.body?.name,
            startSignatureDataUrl: req.body?.startSignatureDataUrl,
            forceNew: Boolean(req.body?.forceNew),
            clientMeta: req.body?.clientMeta,
            createdByUsername: ctx.username,
        });
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, session: result.session, resumed: result.resumed });
    } catch (error) {
        console.error('API: Error starting Square One:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/square-one/session', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        const sessionId = String(req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const session = getSquareOneSessionById(store, sessionId, req.query.periodKey);
        if (!assertSquareOneSessionAccess(req, res, session)) return;
        res.json({ success: true, session });
    } catch (error) {
        console.error('API: Error loading Square One session:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/square-one/report.pdf', async (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        const sessionId = String(req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const session = getSquareOneSessionById(store, sessionId, req.query.periodKey);
        if (!session || session.status !== 'completed') {
            res.status(404).json({ success: false, error: 'Completed audit not found.' });
            return;
        }
        const pdf = await buildSquareOneReportPdf(session);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${buildSquareOneReportFilename(session)}"`);
        res.send(pdf);
    } catch (error) {
        console.error('API: Error building Square One PDF:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/square-one/reopen', (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        const sessionId = String(req.body?.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const existing = getSquareOneSessionById(store, sessionId, req.body?.periodKey);
        if (!assertSquareOneSessionAccess(req, res, existing, { reopen: true })) return;
        const ctx = dfscRequestUserContext(req);
        const result = reopenSquareOneSession(store, sessionId, req.body?.periodKey, ctx.access);
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, session: result.session });
    } catch (error) {
        console.error('API: Error reopening Square One:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/square-one/session', (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        const sessionId = String(req.body?.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const existing = getSquareOneSessionById(store, sessionId, req.body?.periodKey);
        if (!assertSquareOneSessionAccess(req, res, existing)) return;
        const ctx = dfscRequestUserContext(req);
        const result = updateSquareOneSession(
            store,
            sessionId,
            {
                periodKey: req.body?.periodKey,
                answers: req.body?.answers,
                notes: req.body?.notes,
                photos: req.body?.photos,
                signOff: req.body?.signOff,
                clientMeta: req.body?.clientMeta,
            },
            ctx.access
        );
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, session: result.session, nonCompliant: result.nonCompliant, score: result.score });
    } catch (error) {
        console.error('API: Error saving Square One session:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/square-one/session/validate-section', (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        const sessionId = String(req.body?.sessionId || '').trim();
        const sectionId = String(req.body?.sectionId || '').trim();
        if (!store || !sessionId || !sectionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const existing = getSquareOneSessionById(store, sessionId, req.body?.periodKey);
        if (!assertSquareOneSessionAccess(req, res, existing)) return;
        const ctx = dfscRequestUserContext(req);
        const result = validateSquareOneSection(store, sessionId, sectionId, ctx.access);
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true });
    } catch (error) {
        console.error('API: Error validating Square One section:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/square-one/submit', async (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        const sessionId = String(req.body?.sessionId || req.query.sessionId || '').trim();
        if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        if (!assertCanCompleteAudit(req, res)) return;
        const existing = getSquareOneSessionById(store, sessionId, req.body?.periodKey);
        if (!assertSquareOneSessionAccess(req, res, existing)) return;
        const ctx = dfscRequestUserContext(req);
        const result = submitSquareOneSession(store, sessionId, req.body?.signOff || {}, ctx.access);
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        await dismissAuditLabelForStore(store, result.auditLabel || SQUARE_ONE_AUDIT_LABEL);
        res.json({ success: true, session: result.session });
    } catch (error) {
        console.error('API: Error submitting Square One:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const periodAuditRouteDeps = {
    assertStoreAccess,
    assertDfscAccess,
    assertCanStartAudit,
    assertCoachAuditAccess,
    dfscRequestUserContext,
};

[
    { auditType: 'core-ops', storeModule: coreOpsStore, coachOnly: false },
    { auditType: 'core-food-safety', storeModule: coreFoodSafetyStore, coachOnly: false },
    { auditType: 'visit-coach', storeModule: visitCoachStore, coachOnly: true },
    { auditType: 'visit-customer', storeModule: visitCustomerStore, coachOnly: true },
].forEach(({ auditType, storeModule, coachOnly }) => {
    registerPeriodAuditRoutes(app, {
        auditType,
        coachOnly,
        storeModule,
        assertSessionAccess: makePeriodAuditSessionAccess(storeModule),
        ...periodAuditRouteDeps,
    });
});

app.get('/api/tacaudit/context', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const ctx = dfscRequestUserContext(req);
        res.json({
            success: true,
            ...getTacauditContext(store, {
                username: ctx.username,
                conductorFullName: ctx.conductorFullName,
                canAccessDfsc: ctx.canAccessDfsc,
                isAdmin: ctx.isAdmin,
                canViewAdminSummary: canViewTacauditAdminSummary(ctx.user),
                canAccessCoachAudits: canAccessCoachAudits(ctx.user),
                user: ctx.user,
            }),
        });
    } catch (error) {
        console.error('API: Error loading Tacaudit context:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/tacaudit/admin-summary', async (req, res) => {
    try {
        const user = req.dashboardUser || getRequestUser(req);
        const viewLevel = String(req.query.view || req.query.scope || 'area').trim().toLowerCase();
        const scopeMeta = getTacauditScopeMeta(user);
        const weekStart = String(req.query.week || req.query.weekStart || '').trim();

        if (viewLevel === 'market') {
            const overviewScope = scopeMeta.overviewScope;
            if (overviewScope !== 'market' && overviewScope !== 'super') {
                res.status(403).json({ success: false, error: 'Market compliance view requires market access or above.' });
                return;
            }
            let marketName = String(req.query.market || '').trim();
            if (!marketName) marketName = scopeMeta.accessibleMarkets[0] || '';
            if (!marketName || !scopeMeta.accessibleMarkets.includes(marketName)) {
                res.status(403).json({ success: false, error: 'You do not have access to this market.' });
                return;
            }
            const marketSummary = buildTacauditMarketSummary(marketName, {
                accessibleAreas: scopeMeta.accessibleAreas,
                weekStartYmd: weekStart || undefined,
            });
            if (!marketSummary.ok) {
                res.status(marketSummary.status || 404).json({ success: false, error: marketSummary.error });
                return;
            }
            res.json({
                success: true,
                viewLevel: 'market',
                summary: marketSummary,
                complianceWeeks: [],
                complianceMeta: { isCurrentWeek: true, viewLevel: 'market' },
                ...scopeMeta,
                marketName,
            });
            return;
        }

        const scope = resolveTacauditAreaScope(user, {
            area: req.query.area,
            store: req.query.store,
        });
        if (!scope.ok) {
            res.status(scope.status).json({ success: false, error: scope.error });
            return;
        }
        const resolved = resolveComplianceSummary(scope.areaName, scope.stores, weekStart, {
            includeCoachVisitRows: canAccessCoachAudits(user),
        });
        if (!resolved.ok) {
            res.status(resolved.status).json({
                success: false,
                error: resolved.error,
                complianceWeeks: resolved.complianceWeeks,
                complianceMeta: resolved.complianceMeta,
            });
            return;
        }
        if (resolved.complianceMeta?.isCurrentWeek) {
            clearOverridesForArea(scope.areaName);
        }
        res.json({
            success: true,
            viewLevel: 'area',
            summary: { ...resolved.summary, viewLevel: 'area' },
            complianceWeeks: resolved.complianceWeeks,
            complianceMeta: resolved.complianceMeta,
            ...scopeMeta,
            areaName: scope.areaName,
        });
    } catch (error) {
        console.error('API: Error loading Tacaudit admin summary:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/tacaudit/admin-context', async (req, res) => {
    try {
        const user = req.dashboardUser || getRequestUser(req);
        const scope = resolveTacauditAreaScope(user, {
            area: req.query.area,
            store: req.query.store,
        });
        if (!scope.ok) {
            res.status(scope.status).json({ success: false, error: scope.error });
            return;
        }
        const ctx = getTacauditAdminContext(scope.stores, {
            areaName: scope.areaName,
            accessibleAreas: scope.accessibleAreas,
            canAccessCoachAudits: canAccessCoachAudits(user),
            user,
            ...getTacauditScopeMeta(user),
        });
        res.json({ success: true, ...ctx });
    } catch (error) {
        console.error('API: Error loading Tacaudit admin context:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/tacaudit/splash-state', async (req, res) => {
    try {
        const user = req.dashboardUser || getRequestUser(req);
        const scope = resolveTacauditAreaScope(user, {
            area: req.query.area,
            store: req.query.store,
        });
        if (!scope.ok) {
            res.status(scope.status).json({ success: false, error: scope.error });
            return;
        }
        res.json({ success: true, state: getSplashStateForArea(scope.areaName) });
    } catch (error) {
        console.error('API: Error loading Tacaudit splash state:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/tacaudit/splash-state', async (req, res) => {
    try {
        const user = req.dashboardUser || getRequestUser(req);
        const areaName = String(req.body?.area || req.query.area || '').trim();
        const scope = resolveTacauditAreaScope(user, {
            area: areaName,
            store: req.body?.storeNumber,
        });
        if (!scope.ok) {
            res.status(scope.status).json({ success: false, error: scope.error });
            return;
        }
        const result = setCellOverride(
            scope.areaName,
            req.body?.storeNumber,
            req.body?.rowId,
            req.body?.status
        );
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        const summary = buildTacauditAdminSummary(scope.stores, {
            areaName: scope.areaName,
            includeCoachVisitRows: canAccessCoachAudits(user),
        });
        res.json({ success: true, status: result.status, summary });
    } catch (error) {
        console.error('API: Error saving Tacaudit splash state:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/tacaudit/actions', async (req, res) => {
    try {
        const user = req.dashboardUser || getRequestUser(req);
        const store = String(req.query.store || '').trim();
        const areaName = String(req.query.area || '').trim();

        if (store) {
            if (!assertStoreAccess(req, res, store)) return;
            if (!assertDfscAccess(req, res)) return;
            const actions = listOpenActionsForStores([{ storeNumber: store }]);
            res.json({ success: true, actions });
            return;
        }

        const scope = resolveTacauditAreaScope(user, { area: areaName });
        if (!scope.ok) {
            res.status(scope.status).json({ success: false, error: scope.error });
            return;
        }
        const actions = listOpenActionsForStores(scope.stores);
        res.json({ success: true, actions, areaName: scope.areaName });
    } catch (error) {
        console.error('API: Error loading Tacaudit actions:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/tacaudit/actions', async (req, res) => {
    try {
        const store = String(req.body?.storeNumber || '').trim();
        if (!store || !assertStoreAccess(req, res, store)) return;

        const user = req.dashboardUser || getRequestUser(req);
        const isAdmin = canViewTacauditAdminSummary(user);
        if (!isAdmin && !assertDfscAccess(req, res)) return;

        const ctx = dfscRequestUserContext(req);
        const access = isAdmin ? { ...ctx.access, isAdmin: true, canAccessDfsc: true } : ctx.access;
        const result = submitAction(req.body, access);
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, session: result.session });
    } catch (error) {
        console.error('API: Error submitting Tacaudit action:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/tacaudit/settings', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        res.json({ success: true, settings: getTacauditSettings(store) });
    } catch (error) {
        console.error('API: Error loading Tacaudit settings:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/tacaudit/settings', (req, res) => {
    try {
        const store = String(req.body?.store || req.query.store || '').trim();
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const result = saveTacauditSettings(store, { reportEmail: req.body?.reportEmail });
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, settings: result.settings });
    } catch (error) {
        console.error('API: Error saving Tacaudit settings:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/tacaudit/history', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        const type = String(req.query.type || '').trim();
        if (!store || !type) {
            res.status(400).json({ success: false, error: 'store and type query parameters are required' });
            return;
        }
        if (!assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const result = listTacauditHistory(store, type, { limit: req.query.limit });
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('API: Error loading Tacaudit history:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/tacaudit/admin-history', (req, res) => {
    try {
        const user = req.dashboardUser || getRequestUser(req);
        const type = String(req.query.type || '').trim();
        const scope = resolveTacauditAreaScope(user, {
            area: req.query.area,
            store: req.query.store,
        });
        if (!scope.ok) {
            res.status(scope.status).json({ success: false, error: scope.error });
            return;
        }
        const result = listTacauditAdminHistory(scope.stores, type, { limit: req.query.limit });
        if (!result.ok) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, ...result, areaName: scope.areaName });
    } catch (error) {
        console.error('API: Error loading Tacaudit admin history:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/tacaudit/archive.pdf', (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        const type = String(req.query.type || '').trim();
        const sessionId = String(req.query.sessionId || '').trim();
        if (!store || !type || !sessionId || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const pdfBuffer = getArchivePdf(store, type, sessionId);
        if (!pdfBuffer) {
            res.status(404).json({ success: false, error: 'Archived PDF not found.' });
            return;
        }
        const cfg = getAuditTypeConfig(type);
        const label = cfg?.label || type;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${label}-${sessionId}.pdf"`);
        res.send(pdfBuffer);
    } catch (error) {
        console.error('API: Error serving Tacaudit archive PDF:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/tacaudit/core-report.pdf', async (req, res) => {
    try {
        const store = String(req.query.store || '').trim();
        if (!store || !assertStoreAccess(req, res, store)) return;
        if (!assertDfscAccess(req, res)) return;
        const { buffer, filename } = await buildCoreReportPdf(store);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buffer);
    } catch (error) {
        console.error('API: Error generating Tacaudit CORE report:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/admin/dfsc/status', (req, res) => {
    try {
        const user = req.dashboardUser || getRequestUser(req);
        if (!isRealDashboardUser(user) || getOverviewScope(user) === 'store') {
            res.status(403).json({ success: false, error: 'DFSC rollup is not available for this account.' });
            return;
        }
        const dateKey = String(req.query.date || '').trim() || undefined;
        let stores = getStoreList().map((s) => ({
            storeNumber: s.storeNumber,
            storeName: s.storeName,
            area: areaNameFromStore(s),
            areaKey: normalizeAreaKey(areaNameFromStore(s)),
        }));
        stores = filterStoresForUser(user, stores);
        res.json({ success: true, ...buildAdminDfscStatus(dateKey, stores) });
    } catch (error) {
        console.error('API: Error loading admin DFSC status:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/admin/dfsc/audit/:sessionId', (req, res) => {
    try {
        const user = req.dashboardUser || getRequestUser(req);
        if (!isAdminUser(user)) {
            res.status(403).json({ success: false, error: 'Admin only.' });
            return;
        }
        const session = getDfscAuditById(req.params.sessionId);
        if (!session) {
            res.status(404).json({ success: false, error: 'Audit not found.' });
            return;
        }
        res.json({ success: true, session });
    } catch (error) {
        console.error('API: Error loading DFSC audit:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/admin/overview/status', (req, res) => {
    const user = req.dashboardUser || getRequestUser(req);
    if (!isRealDashboardUser(user)) {
        res.status(403).json({ success: false, error: 'Login required.' });
        return;
    }
    res.json({ success: true, ...getSalesScrapeStatus(user) });
});

app.get('/api/admin/overview', handleOverviewApi);

app.post('/api/webauthn/login/options', async (req, res) => {
    try {
        const options = await createLoginOptions(req.body?.username);
        res.json({ success: true, options });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

app.post('/api/webauthn/login/verify', async (req, res) => {
    try {
        const user = await verifyPasskeyLogin(req.body);
        setSessionCookie(res, user, true, 'admin');
        logAuthLogin(req, user);
        res.json({ success: true, defaultPath: getAdminRedirectPath() });
    } catch (error) {
        res.status(401).json({ success: false, error: error.message });
    }
});

app.post('/api/webauthn/register/options', async (req, res) => {
    try {
        const user = req.dashboardUser || getRequestUser(req);
        if (!isAdminUser(user)) {
            res.status(403).json({ success: false, error: 'Admin only.' });
            return;
        }
        const options = await createRegistrationOptions(user);
        res.json({ success: true, options });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

app.post('/api/webauthn/register/verify', async (req, res) => {
    try {
        const user = req.dashboardUser || getRequestUser(req);
        if (!isAdminUser(user)) {
            res.status(403).json({ success: false, error: 'Admin only.' });
            return;
        }
        await verifyRegistration(user, req.body);
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
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

        // Fallback: no .storelist configured - use whatever the last scrape discovered.
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

function buildStoresCfgWithAreas() {
    return getStoreList().map((s) => ({
        ...s,
        area: areaNameFromStore(s),
        areaKey: normalizeAreaKey(areaNameFromStore(s)),
        timeZone: s.timeZone || process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne',
    }));
}

async function buildAreaDashboardPayload(areaParam, user, salesPayload, auditStateByStore) {
    const adminUser = isAdminUser(user);
    const storesCfg = buildStoresCfgWithAreas();

    let areaStoresCfg = storesCfg.filter((s) => areaParamMatchesStore(areaParam, s));
    let areaMeta = areaStoresCfg.length
        ? { name: areaStoresCfg[0].area, key: areaStoresCfg[0].areaKey }
        : null;

    if (!areaStoresCfg.length) {
        const resolved = resolveAreaFromAdminList(areaParam);
        if (!resolved) {
            return { error: `Unknown area: ${areaParam}`, status: 404 };
        }
        areaMeta = resolved;
        areaStoresCfg = storesCfg.filter((s) => s.area === resolved.name);
    }

    if (!userCanAccessArea(user, areaMeta?.name)) {
        return { forbidden: true };
    }

    const allowedStores = filterStoresForUser(
        user,
        areaStoresCfg.map((s) => ({ storeNumber: s.storeNumber, storeName: s.storeName }))
    ).map((s) => String(s.storeNumber));
    const filteredCfg = areaStoresCfg.filter((s) => allowedStores.includes(String(s.storeNumber)));
    if (!filteredCfg.length) {
        return { forbidden: true };
    }

    const payload = salesPayload || salesCache || buildCacheShellFromStoreList();
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
            sssgPercent: live.sssgPercent != null ? live.sssgPercent : null,
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
        const state = auditStateByStore?.get(String(s.storeNumber)) || (await getAuditState(s.storeNumber));
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

    let storeSales = stores
        .map((s) => ({
            storeNumber: s.storeNumber,
            storeName: s.storeName,
            sssgPercent: s.sssgPercent,
            ...computeStoreSalesToday(s),
        }))
        .sort(
            (a, b) =>
                b.actual - a.actual ||
                String(a.storeNumber).localeCompare(String(b.storeNumber), undefined, { numeric: true })
        );

    if (!storeSales.length && adminUser && areaMeta) {
        storeSales = [
            {
                storeNumber: TEST_STORE_SLUG,
                storeName: TEST_STORE_NAME,
                testStore: true,
                actual: 0,
                forecast: 0,
                trackClass: 'cell-green',
            },
        ];
    }

    const areaSalesTotal = storeSales.reduce((sum, s) => sum + (Number(s.actual) || 0), 0);

    return {
        success: true,
        area: areaMeta.name,
        areaKey: areaMeta.key,
        isAdmin: adminUser,
        areas: adminUser ? ADMIN_ROTATE_AREAS : [areaMeta.name],
        timestamp: payload.timestamp,
        areaSalesTotal: Math.round(areaSalesTotal),
        storeSales,
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
    };
}

async function loadAuditStateMapForStores(storeNumbers) {
    const map = new Map();
    const nums = [...new Set((storeNumbers || []).map((n) => String(n).trim()).filter(Boolean))];
    await Promise.all(
        nums.map(async (num) => {
            map.set(num, await getAuditState(num));
        })
    );
    return map;
}

app.get('/api/admin/area-sales', async (req, res) => {
    try {
        const user = req.dashboardUser || getRequestUser(req);
        const areaParam = String(req.query.area || '').trim();
        if (!areaParam) {
            return res.status(400).json({ success: false, error: 'Missing area query parameter.' });
        }
        if (!isSuperAdminUser(user) && !hasMultiStoreScope(user)) {
            return res.status(403).json({ success: false, error: 'Area access required.' });
        }
        const resolvedArea = resolveAreaFromAdminList(areaParam);
        const areaName = resolvedArea?.name || areaParam;
        if (!userCanAccessArea(user, areaName)) {
            return sendForbidden(req, res);
        }

        let payload;
        try {
            payload = await getSalesDataCached();
        } catch (error) {
            console.warn('[Admin area sales] Falling back to cached/empty sales payload:', error.message);
            payload = salesCache || buildCacheShellFromStoreList();
        }

        const storesCfg = buildStoresCfgWithAreas().filter((s) => areaParamMatchesStore(areaParam, s));
        let areaMeta = storesCfg.length
            ? { name: storesCfg[0].area, key: storesCfg[0].areaKey }
            : null;
        if (!areaMeta) {
            const resolved = resolveAreaFromAdminList(areaParam);
            if (!resolved) {
                return res.status(404).json({ success: false, error: `Unknown area: ${areaParam}` });
            }
            areaMeta = resolved;
        }

        const testPending = wantsTestStockCountPending(req);
        const slices = [];
        for (const cfg of storesCfg) {
            const slice = await enrichSalesSliceWithStockCount(
                filterSalesSliceForUser(storeSliceFromPayload(payload, cfg.storeNumber), user),
                { testPending }
            );
            slices.push({
                ...slice,
                area: cfg.area,
                areaKey: cfg.areaKey,
                timeZone: cfg.timeZone || slice.timeZone,
            });
        }

        res.json({
            success: true,
            area: areaMeta.name,
            areaKey: areaMeta.key,
            areaCode: areaCodeFromValue(areaMeta.name) || areaParam,
            timestamp: payload.timestamp,
            stores: slices,
        });
    } catch (error) {
        console.error('API: Error loading admin area sales:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/area-dashboard/all', async (req, res) => {
    try {
        const user = req.dashboardUser || getRequestUser(req);
        const adminUser = isAdminUser(user);
        if (!adminUser) {
            return res.status(403).json({ success: false, error: 'Admin access required.' });
        }

        let payload;
        try {
            payload = await getSalesDataCached();
        } catch (error) {
            console.warn('[Area Dashboard] Falling back to cached/empty sales payload:', error.message);
            payload = salesCache || buildCacheShellFromStoreList();
        }

        const storesCfg = buildStoresCfgWithAreas();
        const auditStateByStore = await loadAuditStateMapForStores(
            storesCfg.map((s) => s.storeNumber)
        );

        const byArea = {};
        for (const areaName of ADMIN_ROTATE_AREAS) {
            const areaParam = areaCodeFromValue(areaName) || areaName;
            const built = await buildAreaDashboardPayload(areaParam, user, payload, auditStateByStore);
            if (built?.forbidden || built?.error) continue;
            byArea[built.areaKey] = built;
        }

        res.json({
            success: true,
            isAdmin: true,
            areas: ADMIN_ROTATE_AREAS,
            timestamp: payload.timestamp,
            byArea,
        });
    } catch (error) {
        console.error('API: Error loading all area dashboards:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/area-dashboard', async (req, res) => {
    try {
        const areaParam = String(req.query.area || '').trim();
        if (!areaParam) {
            return res.status(400).json({ success: false, error: 'Missing area query parameter.' });
        }
        const user = req.dashboardUser || getRequestUser(req);

        let payload;
        try {
            payload = await getSalesDataCached();
        } catch (error) {
            console.warn('[Area Dashboard] Falling back to cached/empty sales payload:', error.message);
            payload = salesCache || buildCacheShellFromStoreList();
        }

        const built = await buildAreaDashboardPayload(areaParam, user, payload);
        if (built?.forbidden) return sendForbidden(req, res);
        if (built?.error) {
            return res.status(built.status || 404).json({ success: false, error: built.error });
        }
        res.json(built);
    } catch (error) {
        console.error('API: Error loading area dashboard:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.use((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (isApiRequest(req)) {
            res.status(404).json({ success: false, error: 'Not found.' });
            return;
        }
        res.status(404).send('Not found');
        return;
    }
    sendNotFoundPage(req, res);
});

app.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large') {
        res.status(413).json({
            success: false,
            error: 'Request too large. Refresh the page and try again with a smaller signature.',
        });
        return;
    }
    next(err);
});

let salesScrapeSchedulerTimer = null;
function cancelSchedulerHandle(handle) {
    handle?.cancel?.();
}
function primeSalesCacheFromDisk() {
    salesCache = buildCacheShellFromStoreList();
    salesCacheAt = Date.now();
    applyScrapeScheduleToCache(salesCache);
    const retained = (salesCache.stores || []).filter((s) => storeHasMeaningfulData(s)).length;
    if (retained) {
        const when = Date.now();
        for (const store of salesCache.stores || []) {
            if (storeHasMeaningfulData(store)) noteStoreScrapeSuccess(store.storeNumber, when);
        }
        if (!lastSalesScrapeCompletedAt) {
            lastSalesScrapeCompletedAt = salesCache.timestamp || new Date(when).toISOString();
        }
        console.log(`[Dashboard] Restored sales data for ${retained} store(s) from cache/snapshots`);
    }
}

function shouldPrimeSalesCacheOnBoot() {
    applyScrapeScheduleToCache(salesCache);
    if (!anyStoreInActiveScrapeWindow()) return false;
    const retained = (salesCache?.stores || []).filter((s) => storeHasMeaningfulData(s)).length;
    return !retained;
}

function startBackgroundRefresh() {
    salesScrapeSchedulerTimer = startSalesScrapeScheduler({
        runFullScrape: (opts) =>
            runScrapeIntoCache(opts).catch((error) => {
                notifyScrapeFailure(error, 'interval scrape').catch(() => {});
                throw error;
            }),
        shouldPrimeOnBoot: shouldPrimeSalesCacheOnBoot,
        isScrapeInFlight: () => Boolean(salesInFlight),
    });
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
    void resetStalePipelineCheckpointsOnStartup();
    primeSalesCacheFromDisk();
    sweepForecastHistoryOnStartup();
    startBackgroundRefresh();
    try {
        ensureCompletedWeekSnapshotsCaptured();
    } catch (err) {
        console.warn('[TacAudit] Compliance week snapshot check failed:', err.message);
    }
});

// Graceful shutdown so PM2 restarts / systemctl stop release the port cleanly.
let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Dashboard] ${signal} received - closing server…`);
    cancelSchedulerHandle(salesScrapeSchedulerTimer);
    const force = setTimeout(() => {
        console.warn('[Dashboard] Forced exit after shutdown timeout');
        process.exit(0);
    }, 10000);
    force.unref();
    server.close(() => {
        clearTimeout(force);
        console.log('[Dashboard] Server closed - exiting');
        process.exit(0);
    });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A scrape failure must never take the whole dashboard down.
process.on('unhandledRejection', (reason) => {
    console.error('[Dashboard] Unhandled promise rejection:', reason);
});
