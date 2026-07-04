const fs = require('fs');
const path = require('path');
const { normalizeItemCode } = require('./reportReader');
const {
    getVendorDefinition,
    registerCustomVendor,
    readCatalogFileSections,
    parseCatalogText,
    invalidateVendorRegistry,
} = require('./vendorCatalog');
const { upsertVendorOrderForCatalog } = require('./vendorOrdersConfig');

function itemCodeFromCatalogLine(line, def) {
    try {
        const catalog = parseCatalogText(`${String(line).trim()}\n`, def);
        const item = catalog.items?.[0];
        return item ? normalizeItemCode(item.itemCode) : null;
    } catch {
        return null;
    }
}

function buildCatalogHeader(label, sourceHeaderLines = []) {
    const out = [];
    let hasVendor = false;
    let hasLocationOrder = false;
    for (const line of sourceHeaderLines) {
        if (/^#\s*vendor:/i.test(line)) {
            out.push(`# vendor: ${label}`);
            hasVendor = true;
        } else if (/^#\s*location-order:/i.test(line)) {
            out.push(line);
            hasLocationOrder = true;
        } else if (line.trim().startsWith('#')) {
            out.push(line);
        }
    }
    if (!hasVendor) out.unshift(`# vendor: ${label}`);
    return out;
}

function existingItemCodesForDef(def) {
    const sections = readCatalogFileSections(def);
    const codes = new Set();
    for (const line of sections.itemLines) {
        const code = itemCodeFromCatalogLine(line, def);
        if (code) codes.add(code);
    }
    return codes;
}

function writeCatalogFile(def, headerLines, itemLines) {
    const sections = readCatalogFileSections(def);
    const filePath = sections.filePath;
    if (!filePath) throw new Error(`Catalog file for ${def.label} is not available on this server.`);
    const body = [...headerLines, '', ...itemLines].join('\n').replace(/\n*$/, '\n');
    fs.writeFileSync(filePath, body, 'utf8');
}

/**
 * Copy item lines from one vendor catalog to another.
 * @param {object} options
 * @param {string} options.sourceSlug
 * @param {string} [options.targetSlug]
 * @param {string} [options.targetLabel]
 * @param {'append'|'replace'} options.mode
 * @param {string} [options.mmxOrderLabel]
 */
function copyVendorCatalog(options = {}) {
    const sourceSlug = String(options.sourceSlug || '').trim().toLowerCase();
    const mode = options.mode === 'replace' ? 'replace' : 'append';
    const sourceDef = getVendorDefinition(sourceSlug);
    if (!sourceDef) throw new Error(`Unknown source vendor: ${sourceSlug}`);

    let targetSlug = String(options.targetSlug || '').trim().toLowerCase();
    let targetLabel = String(options.targetLabel || '').trim();
    let targetDef = targetSlug ? getVendorDefinition(targetSlug) : null;

    if (!targetDef) {
        if (!targetLabel && !targetSlug) throw new Error('Target vendor label or slug is required.');
        if (!targetLabel) targetLabel = targetSlug;
        const registered = registerCustomVendor({ label: targetLabel, slug: targetSlug || undefined });
        targetSlug = registered.slug;
        targetDef = getVendorDefinition(targetSlug);
    } else {
        targetLabel = targetDef.label;
        targetSlug = targetDef.slug;
    }
    if (!targetDef) throw new Error('Could not resolve target vendor.');

    const sourceSections = readCatalogFileSections(sourceDef);
    if (!sourceSections.itemLines.length) throw new Error('Source vendor has no items to copy.');

    const targetSections = readCatalogFileSections(targetDef);
    const targetCodes = existingItemCodesForDef(targetDef);
    let copied = 0;
    let skipped = 0;

    if (mode === 'replace' || !targetSections.itemLines.length) {
        const header = buildCatalogHeader(targetDef.label, sourceSections.header);
        writeCatalogFile(targetDef, header, sourceSections.itemLines);
        copied = sourceSections.itemLines.length;
    } else {
        const appendLines = [];
        for (const line of sourceSections.itemLines) {
            const code = itemCodeFromCatalogLine(line, sourceDef);
            if (code && targetCodes.has(code)) {
                skipped += 1;
                continue;
            }
            appendLines.push(line);
            if (code) targetCodes.add(code);
            copied += 1;
        }
        const header =
            targetSections.header.length > 0
                ? targetSections.header
                : buildCatalogHeader(targetDef.label, sourceSections.header);
        writeCatalogFile(targetDef, header, [...targetSections.itemLines, ...appendLines]);
    }

    invalidateVendorRegistry();

    const mmxOrderLabel = String(options.mmxOrderLabel || '').trim();
    if (mmxOrderLabel) {
        upsertVendorOrderForCatalog({
            catalogSlug: targetSlug,
            label: mmxOrderLabel,
            vendorMatch: targetSlug,
        });
    }

    return {
        sourceSlug,
        targetSlug,
        targetLabel: targetDef.label,
        mode: mode === 'replace' || !targetSections.itemLines.length ? 'replace' : 'append',
        copied,
        skipped,
        mmxOrderLabel: mmxOrderLabel || null,
    };
}

module.exports = {
    copyVendorCatalog,
};
