const fs = require('fs');
const path = require('path');
const { lookupKeysForMmx, mmxCodeForOrderCode, allLookupKeys } = require('./itemCodes');
const { stockCountDisplayName } = require('./stockCountDisplayNames');
const { normalizeItemCode } = require('./reportReader');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const VENDORS_DIR = path.join(PROJECT_ROOT, 'vendors');
const VENDOR_EXAMPLES_DIR = path.join(VENDORS_DIR, 'examples');

/** Macromatix display label → dotfile slug and filename. */
const VENDOR_DEFINITIONS = [
    { slug: 'americold', label: 'Americold', dotfile: '.Americold', example: '.Americold.example' },
    { slug: 'bega', label: 'Bega', dotfile: '.Bega', example: '.Bega.example' },
    { slug: 'cutfresh', label: 'Cut Fresh', dotfile: '.CutFresh', example: '.CutFresh.example' },
    { slug: 'schweppes', label: 'Schweppes', dotfile: '.Schweppes', example: '.Schweppes.example' },
];

const catalogCache = new Map();

/** Fixed unit columns per item line, before per-item location segments. */
const UNIT_SLOTS = 3;

const UNIT_LABEL_RE =
    /^(boxes|bags|kgs|packs|rolls|bottles|cans|tubs|cartons|each|ea|units?|crates?|n\/a)$/i;

function slugifyKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function isNaUnit(label) {
    return /^n\s*\/\s*a$/i.test(String(label || '').trim());
}

/** Three fixed unit slots matching the vendor file column order (N/a keeps its position). */
function normalizeUnitSlots(item) {
    if (Array.isArray(item.unitSlots) && item.unitSlots.length === UNIT_SLOTS) {
        return item.unitSlots;
    }
    const cols = Array.isArray(item.columns) ? item.columns : [];
    if (cols.length === 2) {
        return [
            { key: cols[0].key, label: cols[0].label, na: false },
            { key: null, label: 'N/a', na: true },
            { key: cols[1].key, label: cols[1].label, na: false },
        ];
    }
    if (cols.length === 1) {
        return [
            { key: null, label: 'N/a', na: true },
            { key: null, label: 'N/a', na: true },
            { key: cols[0].key, label: cols[0].label, na: false },
        ];
    }
    if (cols.length >= UNIT_SLOTS) {
        return cols.slice(0, UNIT_SLOTS).map((col) => ({ key: col.key, label: col.label, na: false }));
    }
    const slots = cols.map((col) => ({ key: col.key, label: col.label, na: false }));
    while (slots.length < UNIT_SLOTS) {
        slots.push({ key: null, label: 'N/a', na: true });
    }
    return slots.slice(0, UNIT_SLOTS);
}

function resolveCatalogPath(def) {
    const live = path.join(VENDORS_DIR, def.dotfile);
    if (fs.existsSync(live)) return live;
    const example = path.join(VENDOR_EXAMPLES_DIR, def.example);
    if (fs.existsSync(example)) return example;
    return null;
}

function looksLikeUnitLabel(value) {
    const label = String(value || '').trim();
    if (!label || isNaUnit(label)) return true;
    return UNIT_LABEL_RE.test(label);
}

function parseLocationListComment(line, key) {
    const m = String(line || '').match(new RegExp(`^#\\s*${key}:\\s*(.+)$`, 'i'));
    if (!m) return null;
    return m[1]
        .split('|')
        .map((p) => p.trim())
        .filter(Boolean);
}

function parseLocationsFromComment(line) {
    return parseLocationListComment(line, 'locations');
}

function parseLocationOrderComment(line) {
    return parseLocationListComment(line, 'location-order');
}

function looksLikeItemCode(value) {
    const s = String(value || '').trim();
    if (/^\d{3,10}$/.test(s)) return true;
    // Alphanumeric supplier codes (e.g. SLETT, DTOM4, 38246A, V366S0398)
    if (/^[A-Za-z0-9]{2,12}$/.test(s) && (/\d/.test(s) || /^[A-Z0-9]+$/.test(s))) return true;
    // Macromatix codes with suffixes e.g. SILA(G)260X260
    if (/^[A-Za-z0-9()[\]/]{2,24}$/.test(s) && /\d/.test(s)) return true;
    return false;
}

/** Leading column: `order=N`, `=N`, `oh:N`, days, or `manual` (see VENDOR-FORMAT.md). */
function parseBuildToPrefix(parts) {
    if (!parts.length) return null;
    const first = String(parts[0] || '').trim();
    if (!first) return null;

    const ohMatch = first.match(/^oh:(\d{1,2})$/i);
    if (ohMatch) {
        const days = Number(ohMatch[1]);
        if (days >= 1 && days <= 31) {
            return {
                buildToManual: false,
                buildToOrderManual: false,
                skipKeyItemCount: true,
                skipStockCount: true,
                buildToDays: days,
                buildToAdd: 0,
                buildToFixed: null,
                rest: parts.slice(1),
            };
        }
    }

    const orderMatch = first.match(/^order=(\d+(?:\.\d+)?)$/i);
    if (orderMatch) {
        const buildToFixed = Number(orderMatch[1]);
        if (Number.isFinite(buildToFixed) && buildToFixed >= 0 && buildToFixed <= 999) {
            return {
                buildToManual: false,
                buildToOrderManual: true,
                skipKeyItemCount: true,
                skipStockCount: false,
                buildToDays: null,
                buildToAdd: 0,
                buildToFixed,
                rest: parts.slice(1),
            };
        }
    }

    const fixedMatch = first.match(/^=(\d+(?:\.\d+)?)$/);
    if (fixedMatch) {
        const buildToFixed = Number(fixedMatch[1]);
        if (Number.isFinite(buildToFixed) && buildToFixed >= 0 && buildToFixed <= 999) {
            return {
                buildToManual: false,
                buildToOrderManual: false,
                skipKeyItemCount: false,
                skipStockCount: false,
                buildToDays: null,
                buildToAdd: 0,
                buildToFixed,
                rest: parts.slice(1),
            };
        }
    }

    if (/^manual$/i.test(first) || /^m$/i.test(first)) {
        return {
            buildToManual: true,
            buildToOrderManual: false,
            skipKeyItemCount: true,
            skipStockCount: false,
            buildToDays: null,
            buildToAdd: 0,
            buildToFixed: null,
            rest: parts.slice(1),
        };
    }

    if (/^ignore$/i.test(first) || /^skip$/i.test(first)) {
        return {
            buildToManual: true,
            buildToOrderManual: false,
            skipKeyItemCount: true,
            skipStockCount: true,
            buildToDays: null,
            buildToAdd: 0,
            buildToFixed: null,
            rest: parts.slice(1),
        };
    }

    const daysPlus = first.match(/^(\d{1,2})\+([\d.]+)$/);
    if (daysPlus) {
        const days = Number(daysPlus[1]);
        const add = Number(daysPlus[2]);
        if (days >= 1 && days <= 31 && Number.isFinite(add) && add >= 0) {
            return {
                buildToManual: false,
                buildToOrderManual: false,
                skipKeyItemCount: false,
                skipStockCount: false,
                buildToDays: days,
                buildToAdd: add,
                buildToFixed: null,
                rest: parts.slice(1),
            };
        }
    }

    if (/^\d{1,2}$/.test(first)) {
        const days = Number(first);
        if (days >= 1 && days <= 31) {
            return {
                buildToManual: false,
                buildToOrderManual: false,
                skipKeyItemCount: false,
                skipStockCount: false,
                buildToDays: days,
                buildToAdd: 0,
                buildToFixed: null,
                rest: parts.slice(1),
            };
        }
    }

    return null;
}

function parseItemIdentity(parts) {
    if (parts.length < 1 + UNIT_SLOTS) return null;

    if (
        parts.length >= 2 + UNIT_SLOTS &&
        looksLikeUnitLabel(parts[2]) &&
        looksLikeItemCode(parts[0])
    ) {
        return { itemCode: parts[0], name: parts[1], unitStart: 2 };
    }
    if (looksLikeUnitLabel(parts[1])) {
        return { itemCode: '', name: parts[0], unitStart: 1 };
    }
    return null;
}

function buildCatalogLocations(items, locationOrder, vendorDefaultLocations) {
    const used = new Set();
    for (const item of items) {
        for (const loc of item.locations) used.add(loc);
    }

    const ordered = [];
    const pushUnique = (loc) => {
        if (!loc || !used.has(loc) || ordered.includes(loc)) return;
        ordered.push(loc);
    };

    for (const loc of locationOrder) pushUnique(loc);
    for (const loc of vendorDefaultLocations) pushUnique(loc);
    const rest = [...used].filter((loc) => !ordered.includes(loc)).sort((a, b) => a.localeCompare(b));
    ordered.push(...rest);

    if (!ordered.length) ordered.push('Default');
    return ordered;
}

function parseVendorFromComment(line) {
    const m = String(line || '').match(/^#\s*vendor:\s*(.+)$/i);
    return m ? m[1].trim() : '';
}

function isItemCode(value) {
    return /^\d{3,10}$/.test(String(value || '').trim());
}

function sectionToMmxOrderClass(sectionName) {
    const s = String(sectionName || '').toLowerCase();
    if (s.includes('dry')) return 'DRY';
    if (s.includes('fridge')) return 'FRG';
    return 'FRZ';
}

/** Optional trailing location token: order:FRG | order:DRY | order:FRZ | no-order */
function parseLocationPartHints(part) {
    const raw = String(part || '').trim();
    const orderClassMatch = raw.match(/^order:(FRG|DRY|FRZ)$/i);
    if (orderClassMatch) {
        return { mmxOrderClass: orderClassMatch[1].toUpperCase(), skipVendorOrder: false, isHint: true };
    }
    if (/^no-order$/i.test(raw)) {
        return { skipVendorOrder: true, isHint: true };
    }
    return { isHint: false };
}

function inferSectionFromComment(line) {
    const raw = String(line || '').replace(/^#\s*/, '').trim();
    if (!raw) return '';
    const cleaned = raw
        .replace(/^[-–—\s]+/, '')
        .replace(/[-–—\s]+$/, '')
        .toLowerCase();
    if (cleaned.includes('dry')) return 'Dry';
    if (cleaned.includes('fridge')) return 'Fridge';
    if (cleaned.includes('freezer')) return 'Freezer';
    return '';
}

function parseCatalogText(text, def) {
    const vendorDefaultLocations = [];
    const locationOrder = [];
    let vendorName = def.label;
    let currentSection = '';
    const items = [];

    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('#')) {
            const locs = parseLocationsFromComment(trimmed);
            if (locs?.length) vendorDefaultLocations.push(...locs);
            const order = parseLocationOrderComment(trimmed);
            if (order?.length) locationOrder.push(...order);
            const vendor = parseVendorFromComment(trimmed);
            if (vendor) vendorName = vendor;
            const inferredSection = inferSectionFromComment(trimmed);
            if (inferredSection) {
                currentSection = inferredSection;
            } else {
                // e.g. "# oh:10 — not on KIC" must not overwrite Dry/Fridge/Freezer
                const sectionMatch = trimmed.match(/^#\s*(.+?)\s*[-—]/);
                if (sectionMatch) {
                    const fromCandidate = inferSectionFromComment(`# ${sectionMatch[1].trim()}`);
                    if (fromCandidate) currentSection = fromCandidate;
                }
            }
            continue;
        }

        const parts = rawLine.split('|').map((p) => p.trim());
        if (!parts.length || !parts[0]) continue;

        let buildToDays = null;
        let buildToManual = false;
        let buildToOrderManual = false;
        let skipKeyItemCount = false;
        let skipStockCount = false;
        let buildToAdd = 0;
        let buildToFixed = null;
        let lineParts = parts;
        const buildToPrefix = parseBuildToPrefix(parts);
        if (buildToPrefix) {
            buildToManual = buildToPrefix.buildToManual;
            buildToOrderManual = Boolean(buildToPrefix.buildToOrderManual);
            skipKeyItemCount = Boolean(buildToPrefix.skipKeyItemCount);
            skipStockCount = Boolean(buildToPrefix.skipStockCount);
            buildToDays = buildToPrefix.buildToDays;
            buildToAdd = buildToPrefix.buildToAdd || 0;
            buildToFixed = buildToPrefix.buildToFixed ?? null;
            lineParts = buildToPrefix.rest;
        }

        const identity = parseItemIdentity(lineParts);
        if (!identity) continue;

        const { itemCode, name, unitStart } = identity;
        const rawUnitParts = lineParts.slice(unitStart, unitStart + UNIT_SLOTS);
        while (rawUnitParts.length < UNIT_SLOTS) rawUnitParts.push('N/a');
        const unitSlots = rawUnitParts.slice(0, UNIT_SLOTS).map((label) => {
            const trimmedLabel = String(label || '').trim();
            if (!trimmedLabel || isNaUnit(trimmedLabel)) {
                return { key: null, label: 'N/a', na: true };
            }
            return { key: slugifyKey(trimmedLabel), label: trimmedLabel, na: false };
        });
        const columns = unitSlots.filter((slot) => !slot.na).map((slot) => ({ key: slot.key, label: slot.label }));
        const locationParts = lineParts
            .slice(unitStart + UNIT_SLOTS)
            .map((p) => p.trim())
            .filter((p) => p && !isNaUnit(p));

        if (!columns.length || !name) continue;

        let innerPerCarton = null;
        const locNames = [];
        let mmxOrderClassOverride = '';
        let skipVendorOrder = false;
        for (const part of locationParts) {
            if (/^\d+(\.\d+)?$/.test(part)) {
                innerPerCarton = Number(part);
                continue;
            }
            const hint = parseLocationPartHints(part);
            if (hint.isHint) {
                if (hint.mmxOrderClass) mmxOrderClassOverride = hint.mmxOrderClass;
                if (hint.skipVendorOrder) skipVendorOrder = true;
                continue;
            }
            locNames.push(part);
        }

        let itemLocations = locNames.length ? [...new Set(locNames)] : [...new Set(vendorDefaultLocations)];
        if (!itemLocations.length) itemLocations = ['Default'];

        items.push({
            key: itemCode || slugifyKey(name),
            itemCode: itemCode || '',
            name,
            columns,
            unitSlots,
            innerPerCarton: innerPerCarton != null && innerPerCarton > 0 ? innerPerCarton : null,
            locations: itemLocations,
            mmxOrderClass: mmxOrderClassOverride || sectionToMmxOrderClass(currentSection),
            skipVendorOrder: Boolean(skipVendorOrder),
            buildToDays: buildToManual || buildToOrderManual || buildToFixed != null ? null : buildToDays,
            buildToManual: Boolean(buildToManual),
            buildToOrderManual: Boolean(buildToOrderManual),
            skipKeyItemCount: Boolean(skipKeyItemCount),
            skipStockCount: Boolean(skipStockCount),
            buildToAdd: buildToManual ? 0 : buildToAdd,
            buildToFixed: buildToManual ? null : buildToFixed,
        });
    }

    const locations = buildCatalogLocations(items, locationOrder, vendorDefaultLocations);

    return {
        slug: def.slug,
        label: vendorName,
        locations,
        locationOrder: [...new Set(locationOrder)],
        items,
    };
}

function readCatalogForDefinition(def) {
    const filePath = resolveCatalogPath(def);
    if (!filePath) return null;
    const mtime = fs.statSync(filePath).mtimeMs;
    const cacheKey = `${def.slug}:${filePath}:${mtime}`;
    if (catalogCache.has(cacheKey)) return catalogCache.get(cacheKey);

    const text = fs.readFileSync(filePath, 'utf8');
    const catalog = parseCatalogText(text, def);
    catalog.source = path.basename(filePath);
    catalogCache.clear();
    catalogCache.set(cacheKey, catalog);
    return catalog;
}

function getVendorDefinition(slug) {
    const normalized = slugifyKey(slug);
    return VENDOR_DEFINITIONS.find((d) => d.slug === normalized) || null;
}

function vendorLabelToSlug(label) {
    const value = String(label || '').trim();
    if (!value) return null;
    for (const def of VENDOR_DEFINITIONS) {
        if (def.label.toLowerCase() === value.toLowerCase()) return def.slug;
    }
    const collapsed = value.replace(/\s+/g, '').toLowerCase();
    for (const def of VENDOR_DEFINITIONS) {
        if (def.slug === collapsed || def.label.replace(/\s+/g, '').toLowerCase() === collapsed) {
            return def.slug;
        }
    }
    return null;
}

function listConfiguredVendors() {
    return VENDOR_DEFINITIONS.map((def) => {
        const catalog = readCatalogForDefinition(def);
        return {
            slug: def.slug,
            label: def.label,
            configured: Boolean(catalog && catalog.items.length),
            locationCount: catalog?.locations?.length || 0,
            itemCount: catalog?.items?.length || 0,
        };
    }).filter((v) => v.configured);
}

function getVendorCatalog(slug, options = {}) {
    const def = getVendorDefinition(slug);
    if (!def) return null;
    const catalog = readCatalogForDefinition(def);
    if (!catalog || !catalog.items.length) return null;

    const normalizeItems = (items) =>
        items.map((item) => {
            const displayName = stockCountDisplayName(item.itemCode, item.name);
            return {
                ...item,
                unitSlots: normalizeUnitSlots(item),
                lookupCodes: allLookupKeys(item.itemCode),
                displayName: displayName || item.name,
            };
        });

    if (options.forStockCount) {
        const countable = catalog.items.filter((item) => !item.skipStockCount);
        if (!countable.length) return null;
        return {
            ...catalog,
            items: normalizeItems(countable),
            locations: buildCatalogLocations(countable, catalog.locationOrder, []),
        };
    }

    return {
        ...catalog,
        items: normalizeItems(catalog.items),
    };
}

/**
 * Build-to rules from vendor catalog files, keyed by normalized item code.
 * @returns {Map<string, { buildToDays: number|null, buildToManual: boolean, vendorSlug: string }>}
 */
function catalogItemBuildToRule(item, vendorSlug) {
    const buildToFixed =
        !item.buildToManual && item.buildToFixed != null && Number.isFinite(item.buildToFixed)
            ? item.buildToFixed
            : null;
    return {
        buildToDays:
            item.buildToManual || item.buildToOrderManual || buildToFixed != null ? null : item.buildToDays,
        buildToManual: Boolean(item.buildToManual),
        buildToOrderManual: Boolean(item.buildToOrderManual),
        buildToFixed,
        buildToAdd: item.buildToManual ? 0 : Number(item.buildToAdd) || 0,
        vendorSlug,
    };
}

function registerCatalogBuildToKeys(byCode, itemCode, rule) {
    const raw = normalizeItemCode(itemCode);
    if (!raw) return;
    const mmx = mmxCodeForOrderCode(raw) || raw;
    const keys = new Set([raw, ...lookupKeysForMmx(mmx)]);
    for (const key of keys) {
        if (key) byCode.set(key, rule);
    }
}

function buildCatalogBuildToIndex() {
    const byCode = new Map();
    for (const def of VENDOR_DEFINITIONS) {
        const catalog = readCatalogForDefinition(def);
        if (!catalog) continue;
        for (const item of catalog.items) {
            const code = String(item.itemCode || '').trim();
            if (!code) continue;
            registerCatalogBuildToKeys(byCode, code, catalogItemBuildToRule(item, def.slug));
        }
    }
    return byCode;
}

function aggregateCounts(catalog, locationCounts) {
    const totals = {};
    for (const item of catalog.items) {
        const row = {
            itemKey: item.key,
            itemCode: item.itemCode || '',
            itemName: item.name,
            columns: {},
        };
        for (const col of item.columns) {
            row.columns[col.key] = 0;
        }
        totals[item.key] = row;
    }

    const locations = locationCounts && typeof locationCounts === 'object' ? locationCounts : {};
    for (const locName of Object.keys(locations)) {
        const itemsAtLoc = locations[locName];
        if (!itemsAtLoc || typeof itemsAtLoc !== 'object') continue;
        for (const [itemKey, counts] of Object.entries(itemsAtLoc)) {
            const row = totals[itemKey];
            if (!row || !counts || typeof counts !== 'object') continue;
            for (const [colKey, raw] of Object.entries(counts)) {
                if (!(colKey in row.columns)) continue;
                const n = Number(raw);
                if (Number.isFinite(n) && n >= 0) row.columns[colKey] += n;
            }
        }
    }

    return catalog.items.map((item) => totals[item.key]).filter(Boolean);
}

module.exports = {
    VENDOR_DEFINITIONS,
    slugifyKey,
    vendorLabelToSlug,
    listConfiguredVendors,
    getVendorCatalog,
    getVendorDefinition,
    aggregateCounts,
    normalizeUnitSlots,
    buildCatalogBuildToIndex,
    parseBuildToPrefix,
    UNIT_SLOTS,
};
