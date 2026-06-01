const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./upsellingConfig');

const POINTS_PATH = path.join(PROJECT_ROOT, '.points');
const POINTS_EXAMPLE_PATH = path.join(PROJECT_ROOT, '.points.example');

function normalizeLabel(label) {
    return String(label || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function parsePointsText(text) {
    const byLabel = new Map();
    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const parts = line.split('|').map((p) => p.trim());
        if (parts.length < 2) continue;
        const label = parts[0];
        const pts = Number(parts[1]);
        if (!label || !Number.isFinite(pts)) continue;
        byLabel.set(normalizeLabel(label), { label, points: pts });
    }
    return byLabel;
}

function loadPointsMap() {
    const file = fs.existsSync(POINTS_PATH) ? POINTS_PATH : POINTS_EXAMPLE_PATH;
    if (!fs.existsSync(file)) {
        return { byLabel: new Map(), source: null };
    }
    return { byLabel: parsePointsText(fs.readFileSync(file, 'utf8')), source: path.basename(file) };
}

function pointsForColumn(byLabel, columnName) {
    const key = normalizeLabel(columnName);
    const hit = byLabel.get(key);
    return hit ? hit.points : null;
}

module.exports = {
    POINTS_PATH,
    POINTS_EXAMPLE_PATH,
    normalizeLabel,
    parsePointsText,
    loadPointsMap,
    pointsForColumn,
};
