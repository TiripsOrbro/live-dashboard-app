const fs = require('fs');
const path = require('path');
const { normalizeStoreKey } = require('../testStore');
const { TACAUDIT_DATA_DIR } = require('./tacauditStore');

const ARCHIVE_RETENTION_DAYS = 45;

function archiveRoot(storeNumber) {
    return path.join(TACAUDIT_DATA_DIR, normalizeStoreKey(storeNumber), 'archive');
}

function archiveIndexPath(storeNumber) {
    return path.join(archiveRoot(storeNumber), 'archive-index.json');
}

function archivePdfPath(storeNumber, auditType, sessionId) {
    return path.join(archiveRoot(storeNumber), auditType, `${sessionId}.pdf`);
}

function readJson(filePath, fallback = null) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function daysAgoIso(days) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString();
}

function pruneArchiveIndex(storeNumber) {
    const store = normalizeStoreKey(storeNumber);
    const indexPath = archiveIndexPath(store);
    const index = readJson(indexPath, { entries: [] });
    const cutoff = daysAgoIso(ARCHIVE_RETENTION_DAYS);
    const kept = [];
    for (const entry of index.entries || []) {
        const completedAt = String(entry.completedAt || '');
        if (completedAt && completedAt < cutoff) {
            const pdfPath = archivePdfPath(store, entry.auditType, entry.id);
            try {
                if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
            } catch {
                /* ignore */
            }
            continue;
        }
        kept.push(entry);
    }
    writeJson(indexPath, { entries: kept });
    return kept;
}

function saveArchivePdf({ storeNumber, auditType, sessionId, completedAt, meta = {}, pdfBuffer }) {
    const store = normalizeStoreKey(storeNumber);
    const pdfPath = archivePdfPath(store, auditType, sessionId);
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
    fs.writeFileSync(pdfPath, pdfBuffer);

    const indexPath = archiveIndexPath(store);
    const index = readJson(indexPath, { entries: [] });
    const entries = Array.isArray(index.entries) ? index.entries : [];
    const nextEntry = {
        id: sessionId,
        auditType,
        completedAt: completedAt || new Date().toISOString(),
        ...meta,
    };
    const without = entries.filter((e) => !(e.id === sessionId && e.auditType === auditType));
    without.unshift(nextEntry);
    writeJson(indexPath, { entries: without });
    pruneArchiveIndex(store);
    return pdfPath;
}

function readArchiveIndex(storeNumber, auditType = null) {
    const store = normalizeStoreKey(storeNumber);
    pruneArchiveIndex(store);
    const entries = readJson(archiveIndexPath(store), { entries: [] }).entries || [];
    if (!auditType) return entries;
    return entries.filter((e) => e.auditType === auditType);
}

function getArchivePdf(storeNumber, auditType, sessionId) {
    const pdfPath = archivePdfPath(storeNumber, auditType, sessionId);
    if (!fs.existsSync(pdfPath)) return null;
    return fs.readFileSync(pdfPath);
}

function mergeHistoryWithArchive(liveHistory, archiveEntries, auditType) {
    const liveIds = new Set((liveHistory || []).map((row) => row.id));
    const merged = [...(liveHistory || [])];
    for (const entry of archiveEntries || []) {
        if (entry.auditType !== auditType) continue;
        if (liveIds.has(entry.id)) continue;
        merged.push({
            id: entry.id,
            auditType,
            archiveOnly: true,
            conductorName: entry.conductorName || '',
            signOffName: entry.signOffName || '',
            completedAt: entry.completedAt,
            durationMinutes: entry.durationMinutes ?? null,
            nonCompliantCount: entry.nonCompliantCount ?? null,
            score: entry.score ?? null,
            dateKey: entry.dateKey || null,
            shift: entry.shift || null,
            periodKey: entry.periodKey || null,
        });
    }
    return merged.sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')));
}

module.exports = {
    ARCHIVE_RETENTION_DAYS,
    archivePdfPath,
    saveArchivePdf,
    readArchiveIndex,
    getArchivePdf,
    mergeHistoryWithArchive,
    pruneArchiveIndex,
};
