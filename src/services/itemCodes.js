const fs = require('fs');
const path = require('path');
const { normalizeItemCode } = require('./reportReader');

const ITEM_CODES_PATH = path.join(__dirname, '..', '..', 'vendors', '.item-codes');
const ITEM_CODES_EXAMPLE = path.join(__dirname, '..', '..', 'vendors', 'examples', '.item-codes.example');

let cache = null;

function parseItemCodesText(text) {
    const byMmx = new Map();
    const orderToMmx = new Map();
    const byName = new Map();

    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const parts = line.split('|').map((p) => p.trim());
        if (parts.length < 2) continue;

        const name = parts[0];
        const mmxCode = normalizeItemCode(parts[1]);
        const orderCode = normalizeItemCode(parts[2] || parts[1]);
        if (!mmxCode) continue;

        if (!byMmx.has(mmxCode)) {
            byMmx.set(mmxCode, { name, mmxCode, orderCodes: new Set() });
        }
        const entry = byMmx.get(mmxCode);
        if (name) entry.name = name;
        entry.orderCodes.add(orderCode);

        orderToMmx.set(orderCode, mmxCode);
        if (name) {
            byName.set(name.toLowerCase(), mmxCode);
        }
    }

    return { byMmx, orderToMmx, byName };
}

function loadItemCodes() {
    if (cache) return cache;
    const file = fs.existsSync(ITEM_CODES_PATH) ? ITEM_CODES_PATH : ITEM_CODES_EXAMPLE;
    if (!fs.existsSync(file)) {
        cache = { byMmx: new Map(), orderToMmx: new Map(), byName: new Map(), loaded: false };
        return cache;
    }
    cache = { ...parseItemCodesText(fs.readFileSync(file, 'utf8')), loaded: true, source: path.basename(file) };
    return cache;
}

/** All report/order lookup keys for an ISE (MMX) item code — MMX code plus any order-form aliases. */
function lookupKeysForMmx(mmxItemCode) {
    const mmx = normalizeItemCode(mmxItemCode);
    if (!mmx) return [];

    const { byMmx } = loadItemCodes();
    const entry = byMmx.get(mmx);
    if (!entry) return [mmx];

    return [mmx, ...[...entry.orderCodes].filter((c) => c !== mmx)];
}

function mmxCodeForOrderCode(orderCode) {
    const key = normalizeItemCode(orderCode);
    if (!key) return null;
    const { orderToMmx, byMmx } = loadItemCodes();
    if (orderToMmx.has(key)) return orderToMmx.get(key);
    if (byMmx.has(key)) return key;
    return null;
}

function clearItemCodesCache() {
    cache = null;
}

module.exports = {
    loadItemCodes,
    lookupKeysForMmx,
    mmxCodeForOrderCode,
    parseItemCodesText,
    clearItemCodesCache,
    ITEM_CODES_PATH,
};
