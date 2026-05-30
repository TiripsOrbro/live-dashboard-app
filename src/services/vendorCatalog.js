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
    return /^n\/a$/i.test(String(label || '').trim());
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

function parseCatalogText(text, def) {
    const vendorDefaultLocations = [];
    const locationOrder = [];
    let vendorName = def.label;
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
            continue;
        }

        const parts = rawLine.split('|').map((p) => p.trim());
        if (!parts.length || !parts[0]) continue;

        const identity = parseItemIdentity(parts);
        if (!identity) continue;

        const { itemCode, name, unitStart } = identity;
        const unitParts = parts.slice(unitStart, unitStart + UNIT_SLOTS);
        const locationParts = parts
            .slice(unitStart + UNIT_SLOTS)
            .map((p) => p.trim())
            .filter((p) => p && !isNaUnit(p));

        const columns = [];
        for (const label of unitParts) {
            if (!label || isNaUnit(label)) continue;
            columns.push({ key: slugifyKey(label), label });
        }
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
            locations: itemLocations,
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
    return catalog;
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
    UNIT_SLOTS,
};
