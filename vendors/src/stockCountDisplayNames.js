const fs = require('fs');
const path = require('path');
const { normalizeItemCode } = require('./reportReader');

const paths = require('../../src/paths');
const DISPLAY_NAMES_PATH = path.join(paths.vendors.catalogs, '.display-names');
const DISPLAY_NAMES_EXAMPLE = path.join(
    __dirname,
    '..',
    '..',
    'vendors',
    'examples',
    '.display-names.example'
);

let cache = null;

function normalizeNameKey(name) {
    return String(name || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function parseDisplayNamesText(text) {
    const byCode = new Map();
    const byName = new Map();

    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const parts = line.split('|').map((p) => p.trim());
        if (parts.length < 2) continue;

        const catalogRef = parts[0];
        const displayLabel = parts.slice(1).join('|').trim();
        if (!catalogRef || !displayLabel) continue;

        const code = normalizeItemCode(catalogRef);
        if (code && /^\d/.test(code)) {
            byCode.set(code, displayLabel);
            continue;
        }

        const nameKey = normalizeNameKey(catalogRef);
        if (nameKey) byName.set(nameKey, displayLabel);
    }

    return { byCode, byName };
}

function loadDisplayNames() {
    if (cache) return cache;
    const file = fs.existsSync(DISPLAY_NAMES_PATH) ? DISPLAY_NAMES_PATH : DISPLAY_NAMES_EXAMPLE;
    if (!fs.existsSync(file)) {
        cache = { byCode: new Map(), byName: new Map(), loaded: false, source: null };
        return cache;
    }
    cache = {
        ...parseDisplayNamesText(fs.readFileSync(file, 'utf8')),
        loaded: true,
        source: path.basename(file),
    };
    return cache;
}

/**
 * Short label for stock-count UI. Catalog name + itemCode stay unchanged for MMX/saves.
 */
function stockCountDisplayName(itemCode, catalogName) {
    const { byCode, byName } = loadDisplayNames();
    const code = normalizeItemCode(itemCode);
    if (code && byCode.has(code)) return byCode.get(code);

    const nameKey = normalizeNameKey(catalogName);
    if (nameKey && byName.has(nameKey)) return byName.get(nameKey);

    return null;
}

function clearDisplayNamesCache() {
    cache = null;
}

module.exports = {
    loadDisplayNames,
    stockCountDisplayName,
    clearDisplayNamesCache,
    DISPLAY_NAMES_PATH,
    parseDisplayNamesText,
};
