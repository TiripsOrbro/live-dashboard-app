const fs = require('fs');
const path = require('path');
const { upsellingRootDir } = require('./upsellingConfig');

const REVIEW_FILE = 'unassigned-review.json';
const REVIEW_LOG = 'unassigned-review-log.jsonl';

function upsellingUnassignedReviewPath() {
    return path.join(upsellingRootDir(), REVIEW_FILE);
}

function normalizeUnassignedRow(row = {}) {
    return {
        rowIndex: row.rowIndex ?? null,
        reason: String(row.reason || 'unknown').trim(),
        day: String(row.day || '').trim(),
        name: String(row.name || '').trim(),
        store: String(row.store || '').trim(),
        storeLabel: String(row.storeLabel || '').trim(),
        raw: row.raw || {},
        qtyByColumn: row.qtyByColumn || {},
    };
}

/**
 * Save rows that could not be assigned to a store (missing date, name, or store).
 * Overwrites unassigned-review.json; appends each batch to unassigned-review-log.jsonl.
 */
function saveUnassignedForReview(rows = [], meta = {}) {
    const normalized = rows.map(normalizeUnassignedRow).filter((row) => row.reason || row.name || row.raw?.date);
    if (!normalized.length) return 0;

    const dir = upsellingRootDir();
    fs.mkdirSync(dir, { recursive: true });

    const at = new Date().toISOString();
    const payload = {
        lastUpdatedAt: at,
        source: meta.source || null,
        exportFile: meta.exportFile || null,
        syncDay: meta.syncDay || null,
        rowCount: normalized.length,
        rows: normalized,
    };

    fs.writeFileSync(upsellingUnassignedReviewPath(), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.appendFileSync(
        path.join(dir, REVIEW_LOG),
        `${JSON.stringify({ at, ...meta, rowCount: normalized.length, rows: normalized })}\n`,
        'utf8'
    );

    console.log(`[Upselling] ${normalized.length} unassigned row(s) → data/upselling/${REVIEW_FILE}`);
    return normalized.length;
}

module.exports = {
    REVIEW_FILE,
    upsellingUnassignedReviewPath,
    saveUnassignedForReview,
};
