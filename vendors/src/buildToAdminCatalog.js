const { listConfiguredVendors, getVendorCatalog, catalogItemBuildToRule } = require('./vendorCatalog');
const { buildToOverridesForStore, mergeBuildToRules } = require('./buildToStoreOverrides');
const {
    adminOverridesForStore,
    readOverridesDoc,
    effectiveSkipKeyItemCount,
    effectiveSkipStockCount,
    effectiveIncludeDaily,
} = require('./buildToAdminOverrides');
const { normalizeItemCode } = require('./reportReader');
const {
    DEFAULT_BUILD_TO_DAYS,
    EXTENDED_BUILD_TO_DAYS,
    SALAD_BUILD_TO_DAYS,
    BUILD_TO_13_DAY_ITEM_CODES,
} = require('./buildToCalculator');

function isSaladItem(description) {
    return /\blettuce\b|\btomato\b|\bonion\b|\bcorriander\b|\bcoriander\b|\bpico de gallo\b|\bsalad\b/i.test(
        String(description || '')
    );
}

function defaultDaysForItem(itemCode, description) {
    if (isSaladItem(description)) return SALAD_BUILD_TO_DAYS;
    return BUILD_TO_13_DAY_ITEM_CODES.has(normalizeItemCode(itemCode))
        ? EXTENDED_BUILD_TO_DAYS
        : DEFAULT_BUILD_TO_DAYS;
}

function describeRuleType(rule, description, itemCode, item, skipKeyItemCount) {
    const manual = Boolean(rule?.buildToManual || item?.buildToManual);
    const orderManual = Boolean(rule?.buildToOrderManual || item?.buildToOrderManual);
    if (skipKeyItemCount && !orderManual && !manual) return 'on-hand';
    if (!rule) return 'default';
    if (rule.buildToManual) return 'manual';
    if (rule.buildToOrderManual) return 'order-manual';
    if (rule.buildToFixed != null) return 'fixed';
    if (rule.onHandOnly) return 'on-hand';
    if (rule.buildToDays != null || rule.buildToAdd) return 'days';
    return 'default';
}

function isOnHandBuildToCatalogItem(item) {
    return Boolean(
        item?.skipStockCount &&
        item?.skipKeyItemCount &&
        !item?.buildToManual &&
        !item?.buildToOrderManual &&
        item?.buildToDays != null
    );
}

function effectiveRuleForCatalogItem(item, vendorSlug, storeNumber) {
    const catalogRule = catalogItemBuildToRule(item, vendorSlug);
    const storeMap = buildToOverridesForStore(storeNumber);
    const adminMap = adminOverridesForStore(storeNumber);
    const code = normalizeItemCode(item.itemCode);
    let effective = mergeBuildToRules(catalogRule, storeMap.get(code));
    effective = mergeBuildToRules(effective, adminMap.get(code));

    const description = item.name || item.description || '';
    const skipKeyItemCount = effectiveSkipKeyItemCount(item, storeNumber);
    const skipStockCount = effectiveSkipStockCount(item, storeNumber);
    const ruleType = describeRuleType(effective, description, code, item, skipKeyItemCount);
    const defaultDays = defaultDaysForItem(code, description);
    const doc = readOverridesDoc();
    const storeKey = String(storeNumber || '').trim();
    const storeRule = storeKey ? doc.stores?.[storeKey]?.[code] : null;
    const globalRule = doc.global?.[code] || null;

    return {
        itemCode: code,
        name: item.name || item.description || code,
        vendorSlug,
        ruleType,
        needsCount: !skipStockCount,
        catalogNeedsCount: !Boolean(item.skipStockCount),
        skipKeyItemCount,
        skipStockCount,
        storeSkipStockCountOverride:
            storeRule && typeof storeRule.skipStockCount === 'boolean' ? storeRule.skipStockCount : null,
        globalSkipStockCountOverride:
            globalRule && typeof globalRule.skipStockCount === 'boolean' ? globalRule.skipStockCount : null,
        storeSkipKeyItemCountOverride:
            storeRule && typeof storeRule.skipKeyItemCount === 'boolean' ? storeRule.skipKeyItemCount : null,
        globalSkipKeyItemCountOverride:
            globalRule && typeof globalRule.skipKeyItemCount === 'boolean' ? globalRule.skipKeyItemCount : null,
        includeDaily: effectiveIncludeDaily(item, storeNumber),
        catalogIncludeDaily: Boolean(item.includeDaily),
        storeIncludeDailyOverride:
            storeRule && typeof storeRule.includeDaily === 'boolean' ? storeRule.includeDaily : null,
        globalIncludeDailyOverride:
            globalRule && typeof globalRule.includeDaily === 'boolean' ? globalRule.includeDaily : null,
        buildToDays:
            effective?.buildToDays != null && Number.isFinite(effective.buildToDays)
                ? effective.buildToDays
                : ruleType === 'days' || ruleType === 'default' || ruleType === 'on-hand'
                  ? defaultDays
                  : null,
        buildToAdd: effective?.buildToAdd != null ? effective.buildToAdd : 0,
        buildToFixed: effective?.buildToFixed != null ? effective.buildToFixed : null,
        buildToManual: Boolean(effective?.buildToManual),
        buildToOrderManual: Boolean(effective?.buildToOrderManual),
        onHandOnly: ruleType === 'on-hand',
        catalogRule,
        storeOverride: storeMap.get(code) || null,
        adminOverride: adminMap.get(code) || null,
    };
}

function buildAdminBuildToCatalog(storeNumber) {
    const store = String(storeNumber || '').trim();
    const vendors = [];
    for (const vendor of listConfiguredVendors()) {
        const catalog = getVendorCatalog(vendor.slug);
        if (!catalog?.items?.length) continue;
        const items = [];
        for (const item of catalog.items) {
            const code = String(item.itemCode || '').trim();
            if (!code || (item.skipStockCount && !isOnHandBuildToCatalogItem(item))) continue;
            items.push(effectiveRuleForCatalogItem(item, vendor.slug, store));
        }
        if (items.length) {
            vendors.push({ slug: vendor.slug, label: vendor.label || vendor.slug, items });
        }
    }
    return { storeNumber: store, vendors };
}

function filterOverridesForActor(doc, actorStores, canEditGlobal) {
    const out = { global: {}, stores: {} };
    if (canEditGlobal && doc.global) out.global = { ...doc.global };
    const allowed = new Set((actorStores || []).map(String));
    for (const [store, patch] of Object.entries(doc.stores || {})) {
        if (allowed.has(String(store))) out.stores[store] = { ...patch };
    }
    return out;
}

module.exports = {
    buildAdminBuildToCatalog,
    effectiveRuleForCatalogItem,
    filterOverridesForActor,
    isOnHandBuildToCatalogItem,
    readOverridesDoc,
};
