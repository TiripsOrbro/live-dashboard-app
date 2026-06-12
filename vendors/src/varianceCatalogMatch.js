/**
 * Match MMX confirm-screen variance rows to dashboard catalog / filled count lines.
 * Code aliases (.item-codes) first; closing counts only when code/name already agree.
 */
const { allLookupKeys, loadItemCodes } = require('./itemCodes');
const { normalizeItemCode } = require('./reportReader');

const NAME_STOP_WORDS = new Set([
    'tb',
    'the',
    'and',
    'with',
    'each',
    'cooked',
    'fresh',
    'frozen',
    'pack',
    'pet',
]);

const DRINK_HINT =
    /\b(drink|pepsi|sunkist|solo|7up|mountain\s*dew|bib|bottle|bottles|can|cans|freeze|fcB|red\s*bull|juice|water)\b/i;
const FOOD_HINT =
    /\b(tortilla|meat|chicken|beef|lettuce|cheese|bean|rice|sauce|chip|fries|churro|onion|tomato|guac|sour\s*cream)\b/i;

function normalizeName(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function significantTokens(text) {
    return normalizeName(text)
        .split(/\s+/)
        .filter((t) => t.length >= 2 && !NAME_STOP_WORDS.has(t));
}

function productFormHints(name) {
    const n = normalizeName(name);
    const sizes = [...n.matchAll(/\b(\d+(?:\.\d+)?)\s*(ml|l|litre|liter|inch|in)\b/g)].map((m) => `${m[1]}${m[2]}`);
    return {
        bib: /\bbib\b/.test(n),
        can: /\bcan\b/.test(n),
        bottle: /\bbottle\b/.test(n) || /\bpet\b/.test(n),
        freeze: /\bfreeze\b/.test(n) || /\bfcb\b/.test(n),
        sizes,
    };
}

function formFactorCompatible(varianceName, catalogName) {
    const v = productFormHints(varianceName);
    const i = productFormHints(catalogName);
    if (v.sizes.length && i.sizes.length) {
        const overlap = v.sizes.some((s) => i.sizes.includes(s));
        if (!overlap) return false;
    }
    if (v.bib && (i.bottle || i.can || i.freeze) && !i.bib) return false;
    if (v.bottle && i.bib && !i.bottle) return false;
    if (v.can && i.bib && !i.can) return false;
    if (v.freeze && !i.freeze && (i.bib || i.bottle || i.can)) return false;
    return true;
}

function categoriesCompatible(varianceName, catalogName) {
    const v = normalizeName(varianceName);
    const i = normalizeName(catalogName);
    const vDrink = DRINK_HINT.test(v);
    const iDrink = DRINK_HINT.test(i);
    const vFood = FOOD_HINT.test(v);
    const iFood = FOOD_HINT.test(i);
    if (vDrink && iFood && !iDrink) return false;
    if (vFood && iDrink && !vFood) return false;
    return true;
}

function lookupKeysForVarianceCode(itemCode) {
    loadItemCodes();
    return allLookupKeys(itemCode);
}

function catalogItemLookupSet(item) {
    const keys = new Set();
    if (!item) return keys;
    if (Array.isArray(item.lookupCodes)) {
        for (const k of item.lookupCodes) {
            const n = normalizeItemCode(k);
            if (n) keys.add(n);
        }
    }
    const direct = normalizeItemCode(item.itemCode);
    if (direct) keys.add(direct);
    return keys;
}

function itemMatchesVarianceCode(item, varianceCode) {
    const keys = lookupKeysForVarianceCode(varianceCode);
    if (!keys.length) return false;
    const itemKeys = catalogItemLookupSet(item);
    return keys.some((k) => itemKeys.has(k));
}

function nameMatchScore(varianceName, catalogName) {
    const v = normalizeName(varianceName);
    const i = normalizeName(catalogName);
    if (!v || !i) return 0;
    if (!categoriesCompatible(v, i)) return 0;
    if (!formFactorCompatible(varianceName, catalogName)) return 0;
    if (v === i) return 100;

    if (v.includes(i) || i.includes(v)) return 85;

    const vTokens = significantTokens(v);
    const iTokens = significantTokens(i);
    if (!vTokens.length || !iTokens.length) return 0;

    let hits = 0;
    for (const vt of vTokens) {
        if (iTokens.some((it) => vt === it || (vt.length >= 4 && it.includes(vt)) || (it.length >= 4 && vt.includes(it)))) {
            hits++;
        }
    }
    const ratio = hits / Math.max(vTokens.length, 1);
    if (ratio >= 0.75) return 70 + Math.round(ratio * 20);
    if (vTokens.length >= 3 && hits >= vTokens.length - 1) return 65;
    return hits >= 2 ? 45 + hits * 5 : 0;
}

function parseClosingNum(raw) {
    if (raw == null || raw === '' || raw === '—' || raw === '-') return null;
    const n = Number(String(raw).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : null;
}

function scoreClosingSlots(variance, countsToSlots) {
    const vSlots = [
        parseClosingNum(variance.closingBox),
        parseClosingNum(variance.closingInner),
        parseClosingNum(variance.closingUnit),
    ];
    const fSlots = countsToSlots || [null, null, null];
    let score = 0;
    let comparisons = 0;
    for (let i = 0; i < 3; i++) {
        const vVal = vSlots[i];
        const fVal = fSlots[i];
        if (vVal == null && fVal == null) continue;
        if (vVal != null && fVal != null) {
            comparisons++;
            if (Math.abs(Number(vVal) - Number(fVal)) < 0.015) score += 40;
            else score -= 25;
        }
    }
    return comparisons ? score : 0;
}

function findByCodeInCatalogs(variance, catalogsBySlug) {
    const hits = [];
    for (const [slug, catalog] of catalogsBySlug) {
        for (const item of catalog.items || []) {
            if (itemMatchesVarianceCode(item, variance.itemCode)) {
                hits.push({ item, slug });
            }
        }
    }
    if (!hits.length) return null;
    if (hits.length === 1) return hits[0];

    let best = null;
    let bestScore = 0;
    for (const hit of hits) {
        const score = nameMatchScore(variance.itemName, hit.item.name);
        if (score > bestScore) {
            bestScore = score;
            best = hit;
        }
    }
    return bestScore >= 35 ? best : hits[0];
}

function findByNameInCatalogs(variance, catalogsBySlug, minScore = 55) {
    let best = null;
    let bestSlug = null;
    let bestScore = 0;
    for (const [slug, catalog] of catalogsBySlug) {
        for (const item of catalog.items || []) {
            const score = nameMatchScore(variance.itemName, item.name);
            if (score > bestScore) {
                bestScore = score;
                best = item;
                bestSlug = slug;
            }
        }
    }
    return bestScore >= minScore ? { item: best, slug: bestSlug } : null;
}

/**
 * @param {object} variance - MMX confirm row
 * @param {Map<string, object>} catalogsBySlug
 * @param {object[]} filledItems - items we typed into KIC (with counts, vendorSlug, key, itemCode, name)
 * @param {function} countsToSlotValues - (catalogItem, counts) => [box, inner, unit] for MMX slots
 */
function resolveVarianceCatalogMatch(variance, catalogsBySlug, filledItems = [], countsToSlotValues = null) {
    if (variance.vendorSlug && variance.catalogKey) {
        const cat = catalogsBySlug.get(variance.vendorSlug);
        const item = cat?.items?.find((i) => i.key === variance.catalogKey);
        if (item && itemMatchesVarianceCode(item, variance.itemCode)) {
            return { item, slug: variance.vendorSlug, method: 'enriched' };
        }
        if (item && nameMatchScore(variance.itemName, item.name) >= 50) {
            return { item, slug: variance.vendorSlug, method: 'enriched-name' };
        }
    }

    const byCode = findByCodeInCatalogs(variance, catalogsBySlug);
    if (byCode) return { ...byCode, method: 'code' };

    const byName = findByNameInCatalogs(variance, catalogsBySlug);
    if (byName) return { ...byName, method: 'name' };

    if (!filledItems.length || typeof countsToSlotValues !== 'function') {
        return null;
    }

    const codeKeys = new Set(lookupKeysForVarianceCode(variance.itemCode));
    let candidates = filledItems;
    if (codeKeys.size) {
        const byCodeFilled = filledItems.filter((f) => {
            const fKeys = catalogItemLookupSet(f);
            return [...codeKeys].some((k) => fKeys.has(k));
        });
        if (byCodeFilled.length === 1) {
            const f = byCodeFilled[0];
            const cat = catalogsBySlug.get(f.vendorSlug);
            const item = cat?.items?.find((i) => i.key === f.key);
            if (item) return { item, slug: f.vendorSlug, method: 'filled-code' };
        }
        if (byCodeFilled.length > 1) candidates = byCodeFilled;
    }

    const nameFiltered = candidates.filter((f) =>
        nameMatchScore(variance.itemName, f.name) >= 50
    );
    if (nameFiltered.length === 1) {
        const f = nameFiltered[0];
        const cat = catalogsBySlug.get(f.vendorSlug);
        const item = cat?.items?.find((i) => i.key === f.key);
        if (item) return { item, slug: f.vendorSlug, method: 'filled-name' };
    }
    if (nameFiltered.length > 1) candidates = nameFiltered;

    let best = null;
    let bestSlug = null;
    let bestScore = 0;
    for (const filled of candidates) {
        const cat = catalogsBySlug.get(filled.vendorSlug);
        const item = cat?.items?.find((i) => i.key === filled.key);
        if (!item) continue;
        let score = scoreClosingSlots(variance, countsToSlotValues(item, filled.counts || {}));
        score += nameMatchScore(variance.itemName, item.name);
        if (itemMatchesVarianceCode(item, variance.itemCode)) score += 80;
        if (score > bestScore) {
            bestScore = score;
            best = item;
            bestSlug = filled.vendorSlug;
        }
    }

    if (bestScore >= 75 && best) {
        return { item: best, slug: bestSlug, method: 'filled-closing' };
    }

    return null;
}

function filledLineKey(filled) {
    return `${filled.vendorSlug || ''}::${filled.key || ''}`;
}

function applyMatchToVariance(variance, match) {
    if (!match?.item) return variance;
    return {
        ...variance,
        vendorSlug: match.slug,
        catalogKey: match.item.key,
        catalogName: match.item.name,
        matchedItemCode: match.item.itemCode || '',
        matchMethod: match.method,
    };
}

/**
 * Assign each variance at most one filled line; prefer code/name before closing-only guesses.
 */
function enrichVariancesWithFilledItems(variances, filledItems, catalogsBySlug, countsToSlotValues) {
    if (!filledItems.length) return variances;

    const out = variances.map((v) => ({ ...v }));
    const usedFilled = new Set();
    const assigned = new Array(out.length).fill(null);

    const tryAssignPass = (filterFn) => {
        for (let i = 0; i < out.length; i++) {
            if (assigned[i]) continue;
            const available = filledItems.filter((f) => !usedFilled.has(filledLineKey(f)));
            const match = resolveVarianceCatalogMatch(
                out[i],
                catalogsBySlug,
                available,
                countsToSlotValues
            );
            if (!match?.item || !filterFn(match)) continue;
            assigned[i] = match;
            const filled = available.find(
                (f) => f.vendorSlug === match.slug && f.key === match.item.key
            );
            if (filled) usedFilled.add(filledLineKey(filled));
        }
    };

    tryAssignPass((m) => m.method === 'code' || m.method === 'filled-code');
    tryAssignPass((m) => m.method === 'name' || m.method === 'filled-name' || m.method === 'enriched-name');
    tryAssignPass((m) => m.method === 'enriched' || m.method === 'enriched-name');
    tryAssignPass((m) => m.method === 'filled-closing');

    return out.map((variance, i) => applyMatchToVariance(variance, assigned[i]));
}

module.exports = {
    normalizeName,
    categoriesCompatible,
    nameMatchScore,
    itemMatchesVarianceCode,
    lookupKeysForVarianceCode,
    findByCodeInCatalogs,
    findByNameInCatalogs,
    resolveVarianceCatalogMatch,
    enrichVariancesWithFilledItems,
};
