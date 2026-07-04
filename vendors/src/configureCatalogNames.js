const {
    findCatalogItemByCode,
    updateVendorCatalogItemName,
} = require('./vendorCatalog');
const { upsertDisplayNameEntry } = require('./stockCountDisplayNames');
const { normalizeItemCode } = require('./reportReader');

/**
 * Persist configure-mode catalog/display name edits to git-tracked catalog files.
 * Strips those keys from the override patch so they are not stored in runtime JSON.
 */
function applyConfigureNameFilePatches(patch, options = {}) {
    if (!patch || typeof patch !== 'object') return patch;
    if (!options.canEditCatalogFiles) return patch;

    const out = { ...patch };
    if (!out.areas || typeof out.areas !== 'object') return out;

    out.areas = { ...out.areas };
    for (const [areaName, areaPatch] of Object.entries(out.areas)) {
        if (!areaPatch || typeof areaPatch !== 'object') continue;
        const nextAreaPatch = { ...areaPatch };

        for (const [itemCode, rawRule] of Object.entries(nextAreaPatch)) {
            if (!rawRule || typeof rawRule !== 'object') continue;
            const rule = { ...rawRule };
            const hasCatalogName = Object.prototype.hasOwnProperty.call(rule, 'catalogName');
            const hasDisplayName = Object.prototype.hasOwnProperty.call(rule, 'displayName');
            if (!hasCatalogName && !hasDisplayName) continue;

            const hit = findCatalogItemByCode(itemCode);
            if (!hit) {
                throw new Error(`Item ${itemCode} was not found in any vendor catalog.`);
            }

            let catalogName = hit.item.name || hit.item.description || '';
            if (hasCatalogName) {
                const nextName = String(rule.catalogName || '').trim();
                if (!nextName) {
                    throw new Error(`Catalog name is required for item ${itemCode}.`);
                }
                if (nextName !== catalogName) {
                    updateVendorCatalogItemName(hit.vendorSlug, itemCode, nextName);
                    catalogName = nextName;
                }
                delete rule.catalogName;
            }

            if (hasDisplayName) {
                upsertDisplayNameEntry({
                    itemCode: normalizeItemCode(itemCode),
                    catalogName,
                    displayLabel: rule.displayName,
                });
                delete rule.displayName;
            }

            if (Object.keys(rule).length) nextAreaPatch[itemCode] = rule;
            else delete nextAreaPatch[itemCode];
        }

        if (Object.keys(nextAreaPatch).length) out.areas[areaName] = nextAreaPatch;
        else delete out.areas[areaName];
    }

    return out;
}

module.exports = {
    applyConfigureNameFilePatches,
};
