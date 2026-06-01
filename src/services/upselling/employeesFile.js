const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./upsellingConfig');

const EMPLOYEES_PATH = path.join(PROJECT_ROOT, '.Employees');
const EMPLOYEES_EXAMPLE_PATH = path.join(PROJECT_ROOT, '.Employees.example');

function normalizeCashierName(name) {
    return String(name || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function isDayField(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

function aggregateRowsFromByDay(byDay, bonusByKey = new Map(), bonusNames = new Map()) {
    /** Best single-day score per person (not summed across the competition). */
    const bestByKey = new Map();
    const displayNames = new Map();

    for (const entry of byDay || []) {
        const key = normalizeCashierName(entry.name);
        if (!key) continue;
        const points = Number(entry.points) || 0;
        const prev = bestByKey.get(key);
        if (
            !prev ||
            points > prev.points ||
            (points === prev.points && String(entry.day) > String(prev.day))
        ) {
            bestByKey.set(key, { points, day: entry.day, name: entry.name });
        }
        if (!displayNames.has(key)) displayNames.set(key, entry.name);
    }

    for (const [key, bonus] of bonusByKey.entries()) {
        if (bonus && !displayNames.has(key)) {
            displayNames.set(key, bonusNames.get(key) || key);
        }
    }

    const keys = new Set([...bestByKey.keys(), ...bonusByKey.keys()]);
    const rows = [];
    const byKey = new Map();
    for (const key of keys) {
        const best = bestByKey.get(key);
        const mmxPoints = best?.points || 0;
        const bestDay = best?.day || '';
        const bonusPoints = bonusByKey.get(key) || 0;
        if (!mmxPoints && !bonusPoints) continue;
        const row = {
            name: displayNames.get(key) || best?.name || key,
            mmxPoints,
            bestDay,
            bonusPoints,
            total: mmxPoints + bonusPoints,
        };
        rows.push(row);
        byKey.set(key, row);
    }

    rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    return { rows, byKey };
}

function parseEmployeesText(text) {
    const byDay = [];
    const bonusByKey = new Map();
    const bonusNames = new Map();

    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const parts = line.split('|').map((p) => p.trim());
        if (parts.length < 2) continue;

        if (isDayField(parts[0]) && parts.length >= 3) {
            const day = parts[0];
            const name = parts[1];
            const points = Number(parts[2] ?? 0);
            if (!name) continue;
            byDay.push({
                day,
                name,
                points: Number.isFinite(points) ? points : 0,
            });
            continue;
        }

        if (isDayField(parts[0])) continue;

        const name = parts[0];
        if (!name) continue;
        const key = normalizeCashierName(name);

        if (parts.length === 2) {
            const bonusPoints = Number(parts[1] ?? 0);
            if (!Number.isFinite(bonusPoints)) continue;
            bonusByKey.set(key, bonusPoints);
            bonusNames.set(key, name);
            continue;
        }

        if (parts.length >= 3) {
            const bonusPoints = Number(parts[2] ?? 0);
            if (Number.isFinite(bonusPoints)) {
                bonusByKey.set(key, bonusPoints);
                bonusNames.set(key, name);
            }
        }
    }

    byDay.sort(
        (a, b) =>
            a.day.localeCompare(b.day) ||
            b.points - a.points ||
            a.name.localeCompare(b.name)
    );

    const { rows, byKey } = aggregateRowsFromByDay(byDay, bonusByKey, bonusNames);
    return { rows, byKey, byDay, bonusByKey, bonusNames };
}

function formatEmployeesText(byDay = [], bonusByKey = new Map(), bonusNames = new Map()) {
    const lines = [
        '# day | name | points',
        '# Per-day scores from MMX sync (overwritten each sync).',
        '# Leaderboard shows each person\'s best single-day score (+ optional bonus below).',
    ];
    for (const d of byDay) {
        lines.push(`${d.day} | ${d.name} | ${d.points}`);
    }

    const bonusEntries = [];
    for (const [key, bonus] of bonusByKey.entries()) {
        if (!bonus) continue;
        bonusEntries.push({ name: bonusNames.get(key) || key, bonus });
    }
    bonusEntries.sort((a, b) => a.name.localeCompare(b.name));

    if (bonusEntries.length) {
        lines.push('', '# name | bonusPoints', '# Manual bonus (MIC edits — not from MMX).');
        for (const b of bonusEntries) {
            lines.push(`${b.name} | ${b.bonus}`);
        }
    }

    return `${lines.join('\n')}\n`;
}

function loadEmployees() {
    const file = fs.existsSync(EMPLOYEES_PATH) ? EMPLOYEES_PATH : EMPLOYEES_EXAMPLE_PATH;
    if (!fs.existsSync(file)) {
        return {
            rows: [],
            byKey: new Map(),
            byDay: [],
            bonusByKey: new Map(),
            bonusNames: new Map(),
            source: null,
        };
    }
    const parsed = parseEmployeesText(fs.readFileSync(file, 'utf8'));
    return { ...parsed, source: path.basename(file) };
}

function saveEmployees(byDay = [], bonusByKey = new Map(), bonusNames = new Map()) {
    fs.mkdirSync(path.dirname(EMPLOYEES_PATH), { recursive: true });
    fs.writeFileSync(EMPLOYEES_PATH, formatEmployeesText(byDay, bonusByKey, bonusNames), 'utf8');
}

function saveRankedEmployees(_rankedRows, byDay = []) {
    const { bonusByKey, bonusNames } = loadEmployees();

    const dayRows = (byDay || []).map((d) => ({
        day: String(d.day || '').trim(),
        name: String(d.name || '').trim(),
        points: Number.isFinite(d.points) ? d.points : 0,
    }));

    if (dayRows.length || bonusByKey.size || fs.existsSync(EMPLOYEES_PATH)) {
        saveEmployees(dayRows, bonusByKey, bonusNames);
    }

    return aggregateRowsFromByDay(dayRows, bonusByKey, bonusNames);
}

module.exports = {
    EMPLOYEES_PATH,
    EMPLOYEES_EXAMPLE_PATH,
    normalizeCashierName,
    isDayField,
    aggregateRowsFromByDay,
    parseEmployeesText,
    formatEmployeesText,
    loadEmployees,
    saveEmployees,
    saveRankedEmployees,
};
