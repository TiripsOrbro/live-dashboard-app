const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TIME_ZONE } = require('../../../../../dashboard/src/upselling/upsellingConfig');
const { loadPointsMap, normalizeLabel } = require('../../../../../dashboard/src/upselling/pointsFile');
const { getCachedSssgLy } = require('../../../../../mmx/src/macromatixScraper');
const { computeStoreWtdSssgPercent, getStoreDateKey } = require('../../../../../dashboard/src/sssg/sssgWeeklyLedger');
const { buildStockCountTileState } = require('../../../../../vendors/src/stockCountTileState');
const { buildDailyStockCountTileState } = require('../../../../../vendors/src/dailyStockCountTileState');
const { buildDaySummary, storeDateKey: dfscStoreDateKey, listOpenAudits } = require('../../../../../tacaudit/audits/Daily Food Safety Check/dfscStore');
const { formatStoreTileSubtext } = require('../../../../../tacaudit/audits/Daily Food Safety Check/dfscAdmin');
const { loadScores, soldCountForItemLabel } = require('../../../../../dashboard/src/upselling/leaderboardStore');
const { trimHourlyToTradingWindow, computeDaySalesPresentation } = require('../../../../../dashboard/src/salesProgress');
const { DEFAULT_OPEN_HOUR, DEFAULT_CLOSE_HOUR, getStoreConfig } = require('../../../../../stores/src/storeList');

const paths = require('../../../../../src/paths');
const MIC_DATA_DIR = path.join(paths.stores.data, 'mic');
const ADMIN_DAILY_FILE = path.join(MIC_DATA_DIR, '_admin_daily.json');
const DEFAULT_ITEM_MULTIPLIER = 3;
const ROTATE_INTERVAL_MS = 8000;
/** Shown on MIC when no daily item multiplier is configured for today. */
const MULTIPLIER_NOTHING_LABEL = 'Nothing Yet...';
/** Shown on MIC until live VOC data is wired up. */
const MIC_VOC_PLACEHOLDER = { count: 'TBD', osatPercent: null, accuracyPercent: null };

function melbourneTodayIso() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());
}

function dailyFilePath(storeNumber) {
    return path.join(MIC_DATA_DIR, `${String(storeNumber || '').trim()}_daily.json`);
}

function readJson(filePath, fallback) {
    if (!fs.existsSync(filePath)) return fallback;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function newMultiplierId() {
    return crypto.randomBytes(8).toString('hex');
}

function normalizeStoresList(stores) {
    if (!stores) return [];
    if (stores === '*' || (Array.isArray(stores) && stores.includes('*'))) return ['*'];
    return [...new Set((Array.isArray(stores) ? stores : [stores]).map(String).filter(Boolean))];
}

function ruleAppliesToStore(rule, storeNumber) {
    const stores = normalizeStoresList(rule.stores);
    if (stores.includes('*')) return true;
    return stores.includes(String(storeNumber || '').trim());
}

function migrateLegacyDaily(raw, storeNumber, day) {
    if (!raw?.itemLabel || String(raw.day || '') !== day) return null;
    return {
        id: newMultiplierId(),
        itemLabel: String(raw.itemLabel).trim(),
        multiplier: Number(raw.multiplier) || DEFAULT_ITEM_MULTIPLIER,
        basePoints: Number(raw.basePoints) || 0,
        stores: [String(storeNumber)],
        setBy: raw.setBy || null,
        setAt: raw.setAt || new Date().toISOString(),
    };
}

function readDailyFile(filePath, storeNumber, day) {
    const raw = readJson(filePath, null);
    if (!raw) return { day, multipliers: [] };
    const fiscalDay = String(raw.day || day).trim();
    let multipliers = Array.isArray(raw.multipliers) ? raw.multipliers : [];
    if (!multipliers.length && raw.itemLabel && fiscalDay === day) {
        const legacy = migrateLegacyDaily(raw, storeNumber, day);
        if (legacy) multipliers = [legacy];
    }
    return {
        day: fiscalDay,
        multipliers: multipliers.filter((m) => m?.itemLabel && fiscalDay === day),
    };
}

function writeDailyFile(filePath, day, multipliers) {
    writeJson(filePath, { day, multipliers });
}

function listUpsellItems(storeNumber) {
    const { byLabel } = loadPointsMap(storeNumber);
    return [...byLabel.values()]
        .map((entry) => ({
            label: entry.label,
            basePoints: Number(entry.points) || 0,
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

function getAdminDailyMultipliers(day = melbourneTodayIso()) {
    const fiscalDay = String(day || melbourneTodayIso()).trim();
    const { multipliers } = readDailyFile(ADMIN_DAILY_FILE, '', fiscalDay);
    return multipliers.map((m) => ({
        ...m,
        stores: normalizeStoresList(m.stores),
    }));
}

function getStoreDailyMultipliers(storeNumber, day = melbourneTodayIso()) {
    const store = String(storeNumber || '').trim();
    const fiscalDay = String(day || melbourneTodayIso()).trim();
    const { multipliers } = readDailyFile(dailyFilePath(store), store, fiscalDay);
    return multipliers.map((m) => ({
        ...m,
        stores: normalizeStoresList(m.stores).length ? normalizeStoresList(m.stores) : [store],
    }));
}

function getDailyItemMultipliers(storeNumber, day = melbourneTodayIso()) {
    const store = String(storeNumber || '').trim();
    const fiscalDay = String(day || melbourneTodayIso()).trim();
    const combined = [];
    for (const rule of getAdminDailyMultipliers(fiscalDay)) {
        if (ruleAppliesToStore(rule, store)) combined.push(rule);
    }
    for (const rule of getStoreDailyMultipliers(store, fiscalDay)) {
        if (ruleAppliesToStore(rule, store)) combined.push(rule);
    }
    return combined;
}

/** First matching rule (legacy API). */
function getDailyItemMultiplier(storeNumber, day = melbourneTodayIso()) {
    const rules = getDailyItemMultipliers(storeNumber, day);
    return rules.length ? rules[0] : null;
}

function resolveItemMatch(itemLabel, storeNumber) {
    const label = String(itemLabel || '').trim();
    const items = listUpsellItems(storeNumber || '3811');
    const match = items.find((item) => normalizeLabel(item.label) === normalizeLabel(label));
    return match || null;
}

function addDailyItemMultiplier(options = {}) {
    const label = String(options.itemLabel || '').trim();
    const day = String(options.day || melbourneTodayIso()).trim();
    const stores = normalizeStoresList(options.stores);
    const setBy = String(options.setBy || '').trim();
    const multiplier = Number(options.multiplier) || DEFAULT_ITEM_MULTIPLIER;

    if (!label) return { ok: false, error: 'Item is required.' };
    if (!stores.length) return { ok: false, error: 'Select at least one store or all stores.' };

    const refStore = stores.includes('*') ? '3811' : stores[0];
    const match = resolveItemMatch(label, refStore);
    if (!match) return { ok: false, error: 'Item not found in upsell points map.' };

    const rule = {
        id: newMultiplierId(),
        itemLabel: match.label,
        multiplier,
        basePoints: match.basePoints,
        stores,
        setBy: setBy || null,
        setAt: new Date().toISOString(),
    };

    const isAdminScope = stores.includes('*') || stores.length > 1;
    if (isAdminScope) {
        const { multipliers } = readDailyFile(ADMIN_DAILY_FILE, '', day);
        multipliers.push(rule);
        writeDailyFile(ADMIN_DAILY_FILE, day, multipliers);
    } else {
        const store = stores[0];
        const { multipliers } = readDailyFile(dailyFilePath(store), store, day);
        multipliers.push({ ...rule, stores: [store] });
        writeDailyFile(dailyFilePath(store), day, multipliers);
    }

    return { ok: true, rule };
}

function removeDailyItemMultiplier(id, options = {}) {
    const ruleId = String(id || '').trim();
    const day = String(options.day || melbourneTodayIso()).trim();
    if (!ruleId) return { ok: false, error: 'Missing multiplier id.' };

    let removed = false;
    for (const filePath of [ADMIN_DAILY_FILE]) {
        const { multipliers } = readDailyFile(filePath, '', day);
        const next = multipliers.filter((m) => String(m.id) !== ruleId);
        if (next.length !== multipliers.length) {
            writeDailyFile(filePath, day, next);
            removed = true;
        }
    }
    if (!removed && fs.existsSync(MIC_DATA_DIR)) {
        for (const name of fs.readdirSync(MIC_DATA_DIR)) {
            if (!name.endsWith('_daily.json') || name === '_admin_daily.json') continue;
            const filePath = path.join(MIC_DATA_DIR, name);
            const store = name.replace(/_daily\.json$/, '');
            const { multipliers } = readDailyFile(filePath, store, day);
            const next = multipliers.filter((m) => String(m.id) !== ruleId);
            if (next.length !== multipliers.length) {
                writeDailyFile(filePath, day, next);
                removed = true;
            }
        }
    }
    return removed ? { ok: true } : { ok: false, error: 'Multiplier not found.' };
}

function getAllActiveMultipliersForDay(day = melbourneTodayIso()) {
    const fiscalDay = String(day || melbourneTodayIso()).trim();
    const byId = new Map();
    for (const rule of getAdminDailyMultipliers(fiscalDay)) {
        byId.set(rule.id, rule);
    }
    if (fs.existsSync(MIC_DATA_DIR)) {
        for (const name of fs.readdirSync(MIC_DATA_DIR)) {
            if (!name.endsWith('_daily.json') || name === '_admin_daily.json') continue;
            const store = name.replace(/_daily\.json$/, '');
            for (const rule of getStoreDailyMultipliers(store, fiscalDay)) {
                byId.set(rule.id, rule);
            }
        }
    }
    return [...byId.values()];
}

function boostedPointsForColumn(colName, qtyNum, byLabel, micRules = []) {
    let pts = pointsForColumnFromMap(byLabel, colName);
    if (pts == null) return null;
    const colKey = normalizeLabel(colName);
    let best = pts;
    for (const rule of micRules) {
        if (normalizeLabel(rule.itemLabel) !== colKey) continue;
        const base = Number.isFinite(Number(rule.basePoints)) ? Number(rule.basePoints) : pts;
        const mult = Number(rule.multiplier) || DEFAULT_ITEM_MULTIPLIER;
        best = Math.max(best, base * mult);
    }
    return best;
}

function pointsForColumnFromMap(byLabel, colName) {
    const { pointsForColumn } = require('../../../../../dashboard/src/upselling/pointsFile');
    return pointsForColumn(byLabel, colName);
}

function resolveStoreTimeZone(store = {}) {
    const explicit = String(store.timeZone || '').trim();
    if (explicit) return explicit;
    const cfg = getStoreConfig(store.storeNumber);
    return cfg?.timeZone || TIME_ZONE;
}

function buildStoreForSssgWtd(storeNumber, storeSlice = {}) {
    const store = String(storeNumber || '').trim();
    const cfg = getStoreConfig(store) || {};
    return {
        storeNumber: store,
        storeName: cfg.storeName || storeSlice.storeName,
        openHour: storeSlice.openHour ?? cfg.openHour,
        closeHour: storeSlice.closeHour ?? cfg.closeHour,
        timeZone: resolveStoreTimeZone({ ...cfg, ...storeSlice, storeNumber: store }),
        actual: Array.isArray(storeSlice.actual) ? storeSlice.actual : [],
        forecast: Array.isArray(storeSlice.forecast) ? storeSlice.forecast : [],
    };
}

function computeMicSssgWtd(storeNumber, storeSlice = {}) {
    const storeForWtd = buildStoreForSssgWtd(storeNumber, storeSlice);
    const day = getStoreDateKey(storeForWtd);
    const slots = getCachedSssgLy(storeForWtd.storeNumber, day);
    return computeStoreWtdSssgPercent(storeForWtd, slots);
}

function computeSalesToday(storeSlice = {}) {
    const openHour = Number.isFinite(storeSlice.openHour) ? storeSlice.openHour : DEFAULT_OPEN_HOUR;
    const closeHour = Number.isFinite(storeSlice.closeHour) ? storeSlice.closeHour : DEFAULT_CLOSE_HOUR;
    const trimmed = trimHourlyToTradingWindow(storeSlice.actual, storeSlice.forecast, openHour, closeHour);
    const { actual: actualHourly, forecast: forecastHourly } = trimmed;
    const hours = Math.max(actualHourly.length, forecastHourly.length);
    let actualTotal = 0;
    let forecastTotal = 0;
    for (let i = 0; i < hours; i++) {
        actualTotal += Number(actualHourly[i]) || 0;
        forecastTotal += Number(forecastHourly[i]) || 0;
    }
    const cfg = getStoreConfig(storeSlice.storeNumber);
    const timeZone =
        String(storeSlice.timeZone || '').trim() || cfg?.timeZone || TIME_ZONE;
    const progress = computeDaySalesPresentation({
        actual: actualHourly,
        forecast: forecastHourly,
        openHour,
        closeHour,
        timeZone,
    });
    return {
        actual: Math.round(actualTotal),
        forecast: Math.round(forecastTotal),
        hours,
        openHour,
        closeHour,
        timeZone,
        actualHourly,
        forecastHourly,
        progress,
        sssgPercent: storeSlice.sssgPercent != null ? storeSlice.sssgPercent : null,
    };
}

function buildMicPayload(storeNumber, storeSlice = {}, options = {}) {
    const store = String(storeNumber || '').trim();
    const canAccessDfsc = options.canAccessDfsc !== false;
    const day = melbourneTodayIso();
    const dailyItemMultipliers = getDailyItemMultipliers(store, day);
    const cfg = getStoreConfig(store) || {};
    const salesToday = computeSalesToday(storeSlice);
    const sssgWtdPercent = computeMicSssgWtd(store, storeSlice);
    const itemQtyByDay = loadScores(store).itemQtyByDay || {};
    const multipliersWithSold = dailyItemMultipliers.map((rule) => ({
        ...rule,
        soldCount: soldCountForItemLabel(itemQtyByDay, day, rule.itemLabel),
    }));
    const dfscDateKey = dfscStoreDateKey(store);
    const dfscDay = buildDaySummary(store, dfscDateKey);
    const openAuditCount = listOpenAudits(store).length;
    const dfscSubtext = formatStoreTileSubtext(
        {
            amCompleted: dfscDay.amCompleted,
            pmCompleted: dfscDay.pmCompleted,
        },
        dfscDay.inProgress,
        openAuditCount
    );
    return {
        storeNumber: store,
        storeName: String(cfg.storeName || storeSlice.storeName || store).trim(),
        day,
        salesToday: {
            ...salesToday,
            sssgWtdPercent,
            rawActual: Array.isArray(storeSlice.actual) ? storeSlice.actual : [],
            rawForecast: Array.isArray(storeSlice.forecast) ? storeSlice.forecast : [],
        },
        voc: {
            ...MIC_VOC_PLACEHOLDER,
            placeholder: true,
        },
        dailyItemMultiplier: multipliersWithSold[0] || null,
        dailyItemMultipliers: multipliersWithSold,
        items: listUpsellItems(store),
        defaultMultiplier: DEFAULT_ITEM_MULTIPLIER,
        multiplierNothingLabel: MULTIPLIER_NOTHING_LABEL,
        stockCount: buildStockCountTileState(store, storeSlice),
        dailyStockCount: buildDailyStockCountTileState(store),
        dfsc: canAccessDfsc
            ? {
                  href: `/${store}/dfsc`,
                  subtext: dfscSubtext,
                  amCompleted: dfscDay.amCompleted,
                  pmCompleted: dfscDay.pmCompleted,
                  inProgress: Boolean(dfscDay.inProgress),
                  openAuditCount,
              }
            : null,
    };
}

function setDailyItemMultiplier(storeNumber, itemLabel, options = {}) {
    const store = String(storeNumber || '').trim();
    const day = String(options.day || melbourneTodayIso()).trim();
    if (options.replace) {
        for (const rule of getStoreDailyMultipliers(store, day)) {
            removeDailyItemMultiplier(rule.id, { day });
        }
    } else {
        const existing = getStoreDailyMultipliers(store, day);
        if (existing.length) {
            return { ok: false, error: 'A multiplier is already set. Add another via add multiplier.', existing: existing[0] };
        }
    }
    return addDailyItemMultiplier({
        itemLabel,
        stores: [store],
        multiplier: options.multiplier,
        setBy: options.setBy,
        day,
    });
}

function clearStoreDailyMultipliers(storeNumber, day = melbourneTodayIso()) {
    const store = String(storeNumber || '').trim();
    const fiscalDay = String(day || melbourneTodayIso()).trim();
    if (!store) return { ok: false, error: 'Store is required.' };
    writeDailyFile(dailyFilePath(store), fiscalDay, []);
    return { ok: true };
}

module.exports = {
    MIC_DATA_DIR,
    ADMIN_DAILY_FILE,
    DEFAULT_ITEM_MULTIPLIER,
    MULTIPLIER_NOTHING_LABEL,
    MIC_VOC_PLACEHOLDER,
    ROTATE_INTERVAL_MS,
    melbourneTodayIso,
    listUpsellItems,
    getDailyItemMultiplier,
    getDailyItemMultipliers,
    getAllActiveMultipliersForDay,
    addDailyItemMultiplier,
    removeDailyItemMultiplier,
    setDailyItemMultiplier,
    clearStoreDailyMultipliers,
    computeSalesToday,
    buildMicPayload,
    computeMicSssgWtd,
    buildStoreForSssgWtd,
    resolveStoreTimeZone,
    normalizeStoresList,
    ruleAppliesToStore,
};
