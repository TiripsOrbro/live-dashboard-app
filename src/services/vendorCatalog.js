const fs = require('fs');
const path = require('path');

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
    /^(boxes|bags|kgs|packs|bottles|cans|tubs|cartons|each|ea|units?|crates?|n\/a)$/i;

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

/** Leading column: build-to days (1–31) or `manual` / `m` (no auto order qty). */
function parseBuildToPrefix(parts) {
    if (!parts.length) return null;
    const first = String(parts[0] || '').trim();
    if (!first) return null;

    if (/^manual$/i.test(first) || /^m$/i.test(first)) {
        return { buildToManual: true, buildToDays: null, rest: parts.slice(1) };
    }

    if (/^\d{1,2}$/.test(first)) {
        const days = Number(first);
        if (days >= 1 && days <= 31) {
            return { buildToManual: false, buildToDays: days, rest: parts.slice(1) };
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
            const sectionMatch = trimmed.match(/^#\s*(.+?)\s*[-—]/);
            if (sectionMatch) currentSection = sectionMatch[1].trim();
            continue;
        }

        const parts = rawLine.split('|').map((p) => p.trim());
        if (!parts.length || !parts[0]) continue;

        let buildToDays = null;
        let buildToManual = false;
        let lineParts = parts;
        const buildToPrefix = parseBuildToPrefix(parts);
        if (buildToPrefix) {
            buildToManual = buildToPrefix.buildToManual;
            buildToDays = buildToPrefix.buildToDays;
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

        let itemLocations = locationParts.length
            ? [...new Set(locationParts)]
            : [...new Set(vendorDefaultLocations)];
        if (!itemLocations.length) itemLocations = ['Default'];

        items.push({
            key: itemCode || slugifyKey(name),
            itemCode: itemCode || '',
            name,
            columns,
            unitSlots,
            locations: itemLocations,
            mmxOrderClass: sectionToMmxOrderClass(currentSection),
            buildToDays: buildToManual ? null : buildToDays,
            buildToManual: Boolean(buildToManual),
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

function getVendorCatalog(slug) {
    const def = getVendorDefinition(slug);
    if (!def) return null;
    const catalog = readCatalogForDefinition(def);
    if (!catalog || !catalog.items.length) return null;
    return {
        ...catalog,
        items: catalog.items.map((item) => ({
            ...item,
            unitSlots: normalizeUnitSlots(item),
        })),
    };
}

/**
 * Build-to rules from vendor catalog files, keyed by normalized item code.
 * @returns {Map<string, { buildToDays: number|null, buildToManual: boolean, vendorSlug: string }>}
 */
function buildCatalogBuildToIndex() {
    const byCode = new Map();
    for (const def of VENDOR_DEFINITIONS) {
        const catalog = readCatalogForDefinition(def);
        if (!catalog) continue;
        for (const item of catalog.items) {
            const code = String(item.itemCode || '').trim().toUpperCase();
            if (!code) continue;
            byCode.set(code, {
                buildToDays: item.buildToManual ? null : item.buildToDays,
                buildToManual: Boolean(item.buildToManual),
                vendorSlug: def.slug,
            });
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
