/**
 * Browser-side variance → catalog matching (uses lookupCodes on catalog items from API).
 */
(function varianceCatalogMatchModule(global) {
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

    function normalizeItemCode(code) {
        return String(code || '')
            .trim()
            .toUpperCase()
            .replace(/^0+/, '');
    }

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
        const sizes = [...n.matchAll(/\b(\d+(?:\.\d+)?)\s*(ml|l|litre|liter|inch|in)\b/g)].map(
            (m) => `${m[1]}${m[2]}`
        );
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

    function catalogItemLookupSet(item) {
        const keys = new Set();
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
        const v = normalizeItemCode(varianceCode);
        if (!v) return false;
        return catalogItemLookupSet(item).has(v);
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
            if (
                iTokens.some(
                    (it) =>
                        vt === it ||
                        (vt.length >= 4 && it.includes(vt)) ||
                        (it.length >= 4 && vt.includes(it))
                )
            ) {
                hits++;
            }
        }
        const ratio = hits / Math.max(vTokens.length, 1);
        if (ratio >= 0.75) return 70 + Math.round(ratio * 20);
        if (vTokens.length >= 3 && hits >= vTokens.length - 1) return 65;
        return hits >= 2 ? 45 + hits * 5 : 0;
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

    function resolveVarianceCatalogMatch(variance, catalogsBySlug) {
        if (variance.catalogKey && variance.vendorSlug) {
            const cat = catalogsBySlug.get(variance.vendorSlug);
            const item = cat?.items?.find((i) => i.key === variance.catalogKey);
            if (item && itemMatchesVarianceCode(item, variance.itemCode)) {
                return { item, slug: variance.vendorSlug };
            }
            if (item && nameMatchScore(variance.itemName, item.name) >= 50) {
                return { item, slug: variance.vendorSlug };
            }
        }

        const byCode = findByCodeInCatalogs(variance, catalogsBySlug);
        if (byCode) return byCode;

        return findByNameInCatalogs(variance, catalogsBySlug);
    }

    global.VarianceCatalogMatch = {
        normalizeItemCode,
        nameMatchScore,
        categoriesCompatible,
        itemMatchesVarianceCode,
        findByCodeInCatalogs,
        findByNameInCatalogs,
        resolveVarianceCatalogMatch,
    };
})(typeof window !== 'undefined' ? window : globalThis);
