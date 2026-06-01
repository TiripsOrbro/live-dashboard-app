const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT, resolveUpsellSyncStore, TIME_ZONE } = require('./upsellingConfig');

function melbourneTodayIso() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());
}

function dayNameKey(entry) {
    return `${String(entry.day || '').trim()}|${normalizeCashierName(entry.name)}`;
}

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

function isStoreField(value) {
    return /^\d{3,6}$/.test(String(value || '').trim());
}

function resolveSyncStore() {
    return resolveUpsellSyncStore();
}

/** Rows for one store's leaderboard (single-store file has no store column). */
function filterByDayForStoreLeaderboard(byDay, wantStore) {
    const store = String(wantStore || resolveSyncStore() || '').trim();
    const rows = byDay || [];
    if (!store) return rows;
    return rows.filter((r) => {
        const rowStore = String(r.store || store).trim();
        return rowStore === store;
    });
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
    const syncStore = resolveSyncStore();
    const byDay = [];
    const bonusByKey = new Map();
    const bonusNames = new Map();

    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const parts = line.split('|').map((p) => p.trim());
        if (parts.length < 2) continue;

        let store = syncStore;
        let day = '';
        let rowName = '';
        let pointsRaw = '';

        if (isStoreField(parts[0]) && isDayField(parts[1]) && parts.length >= 4) {
            store = parts[0];
            day = parts[1];
            rowName = parts[2];
            pointsRaw = parts[3];
        } else if (isDayField(parts[0]) && parts.length >= 3) {
            day = parts[0];
            rowName = parts[1];
            pointsRaw = parts[2];
        }

        if (day) {
            const points = Number(pointsRaw ?? 0);
            if (!rowName) continue;
            if (syncStore && store && store !== syncStore) continue;
            byDay.push({
                store: syncStore || store,
                day,
                name: rowName,
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
    const syncStore = resolveSyncStore();
    const lines = [
        '# day | name | points',
        '# Per-day scores from MMX sync (overwritten each sync).',
        '# Leaderboard shows each person\'s best single-day score (+ optional bonus below).',
    ];
    if (syncStore) {
        lines.push(`# Store: ${syncStore}`);
    }
    for (const d of byDay) {
        const day = String(d.day || '').trim();
        if (!isDayField(day)) continue;
        lines.push(`${day} | ${d.name} | ${d.points}`);
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

function saveRankedEmployees(_rankedRows, byDay = [], syncStore = '') {
    const { bonusByKey, bonusNames, byDay: existingByDay } = loadEmployees();
    const syncStoreNorm = String(syncStore || resolveSyncStore() || '').trim();
    const defaultDay = melbourneTodayIso();

    const incoming = (byDay || [])
        .map((d) => {
            const day = String(d.day || '').trim() || defaultDay;
            return {
                store: syncStoreNorm,
                day: isDayField(day) ? day : defaultDay,
                name: String(d.name || '').trim(),
                points: Number.isFinite(d.points) ? d.points : 0,
            };
        })
        .filter((d) => d.name && d.points > 0);

    const MIN_FULL_REPLACE = 3;
    let mergedByDay;
    if (
        incoming.length > 0 &&
        incoming.length < MIN_FULL_REPLACE &&
        (existingByDay || []).length >= MIN_FULL_REPLACE
    ) {
        const byKey = new Map();
        for (const row of existingByDay) {
            byKey.set(dayNameKey(row), row);
        }
        for (const row of incoming) {
            byKey.set(dayNameKey(row), row);
        }
        mergedByDay = [...byKey.values()];
        console.warn(
            `[Upselling] Only ${incoming.length} scored row(s) from sync — merged into .Employees (${mergedByDay.length} day rows kept)`
        );
    } else {
        mergedByDay = incoming.length ? incoming : [];
    }

    if (mergedByDay.length || bonusByKey.size || fs.existsSync(EMPLOYEES_PATH)) {
        saveEmployees(mergedByDay, bonusByKey, bonusNames);
    }

    return aggregateRowsFromByDay(mergedByDay, bonusByKey, bonusNames);
}

module.exports = {
    EMPLOYEES_PATH,
    EMPLOYEES_EXAMPLE_PATH,
    normalizeCashierName,
    isDayField,
    filterByDayForStoreLeaderboard,
    aggregateRowsFromByDay,
    parseEmployeesText,
    formatEmployeesText,
    loadEmployees,
    saveEmployees,
    saveRankedEmployees,
};
