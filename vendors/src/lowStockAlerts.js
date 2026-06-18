const { normalizeItemCode, reportsReadyForStore } = require('./reportReader');
const { catalogRuleForItem, calculateBuildToOrders, REPORTS_DIR } = require('./buildToCalculator');
const { buildCatalogBuildToIndex } = require('./vendorCatalog');
const { buildToOverridesForStore } = require('./buildToStoreOverrides');
const { adminOverridesForStore, readOverridesDoc } = require('./buildToAdminOverrides');

const DEFAULT_STOCK_WARNING_DAYS = 5;
const SUMMARY_CACHE_MS = Number(process.env.LOW_STOCK_SUMMARY_CACHE_MS || 15 * 60 * 1000);
const summaryCache = new Map();

function defaultStockWarningDays() {
    const doc = readOverridesDoc();
    const raw = doc?.settings?.stockWarningDays;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_STOCK_WARNING_DAYS;
}

function stockWarningDaysForItem(itemCode, storeNumber, catalogRules, storeOverrideMap, adminOverrideMap) {
    const code = normalizeItemCode(itemCode);
    const rule = catalogRuleForItem(code, catalogRules, storeOverrideMap);
    const adminRule = adminOverrideMap?.get(code) || null;
    const merged = adminRule ? { ...rule, ...adminRule } : rule;
    if (merged?.stockWarningDays != null && Number.isFinite(Number(merged.stockWarningDays))) {
        return Number(merged.stockWarningDays);
    }
    return defaultStockWarningDays();
}

function computeLowStockAlerts(lines, options = {}) {
    const storeNumber = String(options.storeNumber || '').trim();
    const catalogRules = options.catalogRules || (storeNumber ? buildCatalogBuildToIndex() : null);
    const storeOverrideMap = storeNumber ? buildToOverridesForStore(storeNumber) : new Map();
    const adminOverrideMap = storeNumber ? adminOverridesForStore(storeNumber) : new Map();
    const defaultThreshold = options.thresholdDays != null ? Number(options.thresholdDays) : null;

    const alerts = [];
    for (const line of lines || []) {
        const avgDaily = Number(line.avgDaily);
        if (!Number.isFinite(avgDaily) || avgDaily <= 0) continue;
        const onHand = Number(line.onHandCartons) || 0;
        const onOrder = Number(line.onOrderCartons) || 0;
        const daysOfStock = (onHand + onOrder) / avgDaily;
        const threshold =
            defaultThreshold != null && Number.isFinite(defaultThreshold)
                ? defaultThreshold
                : stockWarningDaysForItem(
                      line.itemCode || line.iseItemCode,
                      storeNumber,
                      catalogRules,
                      storeOverrideMap,
                      adminOverrideMap
                  );
        if (daysOfStock >= threshold) continue;
        alerts.push({
            itemCode: line.itemCode || line.iseItemCode,
            iseItemCode: line.iseItemCode || line.itemCode,
            description: line.description || '',
            onHandCartons: onHand,
            onOrderCartons: onOrder,
            avgDaily,
            daysOfStock: Math.round(daysOfStock * 100) / 100,
            thresholdDays: threshold,
        });
    }
    alerts.sort((a, b) => a.daysOfStock - b.daysOfStock);
    return alerts;
}

function setLowStockSummaryCache(storeNumber, summary, dateKey = '') {
    const cacheKey = `${String(storeNumber || '').trim()}:${dateKey || ''}`;
    summaryCache.set(cacheKey, { at: Date.now(), summary });
}

function buildLowStockSummaryFromAlerts(alerts, options = {}) {
    const thresholdDays = options.thresholdDays ?? defaultStockWarningDays();
    return {
        count: alerts.length,
        items: alerts.slice(0, 5),
        alerts,
        thresholdDays,
        checked: true,
        checkedAt: options.checkedAt || new Date().toISOString(),
    };
}

async function getLowStockSummary(storeNumber, options = {}) {
    const store = String(storeNumber || '').trim();
    const thresholdDays = defaultStockWarningDays();
    if (!store) {
        return { count: 0, items: [], thresholdDays, checked: false, checkedAt: null };
    }

    const cacheKey = `${store}:${options.dateKey || ''}`;
    if (!options.skipCache) {
        const cached = summaryCache.get(cacheKey);
        if (cached && Date.now() - cached.at < SUMMARY_CACHE_MS) {
            return cached.summary;
        }
    }

    const reportsDir = options.reportsDir || REPORTS_DIR;
    const { ready } = reportsReadyForStore(store, reportsDir);
    if (!ready) {
        const empty = { count: 0, items: [], thresholdDays, checked: false, checkedAt: null };
        if (!options.skipCache) setLowStockSummaryCache(store, empty, options.dateKey);
        return empty;
    }

    try {
        const buildTo = await calculateBuildToOrders(store, {
            reportsDir,
            dateKey: options.dateKey,
            preferReportOnHand: true,
        });
        const alerts = computeLowStockAlerts(buildTo.lines || [], { storeNumber: store });
        const summary = buildLowStockSummaryFromAlerts(alerts, { thresholdDays });
        setLowStockSummaryCache(store, summary, options.dateKey);
        return summary;
    } catch {
        const empty = { count: 0, items: [], thresholdDays, checked: false, checkedAt: null };
        setLowStockSummaryCache(store, empty, options.dateKey);
        return empty;
    }
}

function invalidateLowStockSummaryCache(storeNumber) {
    const prefix = `${String(storeNumber || '').trim()}:`;
    for (const key of summaryCache.keys()) {
        if (key.startsWith(prefix)) summaryCache.delete(key);
    }
}

module.exports = {
    DEFAULT_STOCK_WARNING_DAYS,
    defaultStockWarningDays,
    stockWarningDaysForItem,
    computeLowStockAlerts,
    getLowStockSummary,
    setLowStockSummaryCache,
    buildLowStockSummaryFromAlerts,
    invalidateLowStockSummaryCache,
};
