const { listConfiguredVendors, getVendorCatalog } = require('./vendorCatalog');
const { effectiveIncludeDaily, effectiveSkipStockCount } = require('./buildToAdminOverrides');

const DAILY_SLUG = 'daily';

/**
 * Merge daily-tagged items from all vendor catalogs into one location-tabbed list.
 */
function buildDailyStockCountCatalog(storeNumber) {
    const store = String(storeNumber || '').trim();
    const items = [];
    const locationOrder = [];
    const seenLocs = new Set();
    const vendorLabels = [];

    for (const vendor of listConfiguredVendors()) {
        const cat = getVendorCatalog(vendor.slug);
        if (!cat?.items?.length) continue;
        vendorLabels.push(cat.label);

        for (const loc of cat.locations || []) {
            const name = String(loc || '').trim();
            if (!name || seenLocs.has(name)) continue;
            seenLocs.add(name);
            locationOrder.push(name);
        }

        for (const item of cat.items) {
            if (effectiveSkipStockCount(item, store)) continue;
            if (!effectiveIncludeDaily(item, store)) continue;
            items.push({
                ...item,
                key: `${vendor.slug}::${item.key}`,
                catalogKey: item.key,
                sourceVendorSlug: vendor.slug,
                vendorLabel: cat.label,
            });
        }
    }

    if (!items.length) return null;

    const locations = locationOrder.length
        ? locationOrder
        : [...new Set(items.flatMap((item) => item.locations || []))];

    return {
        slug: DAILY_SLUG,
        label: vendorLabels.length ? `Daily Count (${vendorLabels.join(', ')})` : 'Daily Count',
        locations,
        locationOrder: locations,
        items,
        vendorSlugs: [...new Set(items.map((i) => i.sourceVendorSlug))],
        vendorLabels,
    };
}

function isDailyStockCountSlug(slug) {
    return String(slug || '')
        .trim()
        .toLowerCase() === DAILY_SLUG;
}

module.exports = {
    DAILY_SLUG,
    buildDailyStockCountCatalog,
    isDailyStockCountSlug,
};
