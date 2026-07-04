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
function applyConfigureScopePatch(scopePatch, options = {}) {
    if (!scopePatch || typeof scopePatch !== 'object') return scopePatch;
    const nextScopePatch = { ...scopePatch };

    for (const [itemCode, rawRule] of Object.entries(nextScopePatch)) {
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

        if (Object.keys(rule).length) nextScopePatch[itemCode] = rule;
        else delete nextScopePatch[itemCode];
    }

    return nextScopePatch;
}

function applyConfigureNameFilePatches(patch, options = {}) {
    if (!patch || typeof patch !== 'object') return patch;
    if (!options.canEditCatalogFiles) return patch;

    const out = { ...patch };

    if (out.global && typeof out.global === 'object') {
        out.global = applyConfigureScopePatch(out.global, options);
        if (!Object.keys(out.global).length) delete out.global;
    }

    if (out.areas && typeof out.areas === 'object') {
        out.areas = { ...out.areas };
        for (const [areaName, areaPatch] of Object.entries(out.areas)) {
            if (!areaPatch || typeof areaPatch !== 'object') continue;
            const nextAreaPatch = applyConfigureScopePatch(areaPatch, options);
            if (Object.keys(nextAreaPatch).length) out.areas[areaName] = nextAreaPatch;
            else delete out.areas[areaName];
        }
        if (!Object.keys(out.areas).length) delete out.areas;
    }

    return out;
}

module.exports = {
    applyConfigureNameFilePatches,
};
