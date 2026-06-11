const { listConfiguredVendors, getVendorCatalog } = require('./vendorCatalog');

const DAILY_SLUG = 'daily';

/**
 * Merge daily-tagged items from all vendor catalogs into one location-tabbed list.
 */
function buildDailyStockCountCatalog() {
    const items = [];
    const locationOrder = [];
    const seenLocs = new Set();
    const vendorLabels = [];

    for (const vendor of listConfiguredVendors()) {
        const cat = getVendorCatalog(vendor.slug, { forDailyCount: true });
        if (!cat) continue;
        vendorLabels.push(cat.label);

        for (const loc of cat.locations || []) {
            const name = String(loc || '').trim();
            if (!name || seenLocs.has(name)) continue;
            seenLocs.add(name);
            locationOrder.push(name);
        }

        for (const item of cat.items) {
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

    return {
        slug: DAILY_SLUG,
        label: vendorLabels.length ? `Daily Count (${vendorLabels.join(', ')})` : 'Daily Count',
        locations: locationOrder,
        locationOrder,
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
