const fs = require('fs');
const path = require('path');
const {
    upsellingRootDir,
    leaderboardFilePath,
    TIME_ZONE,
} = require('./upsellingConfig');

const LEADERBOARD_RETENTION_DAYS = Math.max(
    1,
    Number(process.env.UPSELL_LEADERBOARD_RETENTION_DAYS || 7) || 7
);

function melbourneTodayIso() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());
}

function melbourneDaysAgoIso(daysAgo) {
    const d = new Date();
    d.setDate(d.getDate() - Math.max(0, Number(daysAgo) || 0));
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(d);
}

function melbourneWeekdayIndex(date = new Date()) {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short' }).format(
        date
    );
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[wd] ?? 0;
}

/** Monday (inclusive) of the current Melbourne calendar week. */
function melbourneWeekStartIso(date = new Date()) {
    const daysFromMonday = (melbourneWeekdayIndex(date) + 6) % 7;
    const d = new Date(date);
    d.setDate(d.getDate() - daysFromMonday);
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(d);
}

function addDaysToIso(iso, days) {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    if (!y || !m || !d) return '';
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + Number(days) || 0);
    const y2 = dt.getFullYear();
    const m2 = String(dt.getMonth() + 1).padStart(2, '0');
    const d2 = String(dt.getDate()).padStart(2, '0');
    return `${y2}-${m2}-${d2}`;
}

/** Sunday (inclusive) of the current Melbourne calendar week. */
function melbourneWeekEndIso(date = new Date()) {
    return addDaysToIso(melbourneWeekStartIso(date), 6);
}

function isDayInMelbourneWeek(dayIso, date = new Date()) {
    const day = String(dayIso || '').trim();
    if (!isDayField(day)) return false;
    const start = melbourneWeekStartIso(date);
    const end = melbourneWeekEndIso(date);
    return day >= start && day <= end;
}

/** Keep the most recent N calendar days (Melbourne); drop older rows on each merge. */
function pruneRowsToRetentionDays(rows, keepDays = LEADERBOARD_RETENTION_DAYS) {
    const span = Math.max(1, keepDays);
    const cutoff = melbourneDaysAgoIso(span - 1);
    const pruned = rows.filter((row) => isDayField(row.day) && row.day >= cutoff);
    const dropped = rows.length - pruned.length;
    if (dropped > 0) {
        console.log(
            `[Leaderboard] Pruned ${dropped} row(s) older than ${span} days (before ${cutoff})`
        );
    }
    return pruned;
}

function normalizeCashierName(name) {
    return String(name || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function isDayField(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

function readJsonFile(filePath, fallback) {
    if (!fs.existsSync(filePath)) return fallback;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        console.warn(`[Leaderboard] Invalid JSON in ${filePath}:`, error.message);
        return fallback;
    }
}

function writeJsonFile(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function rowKey(row) {
    return `${row.day}|${normalizeCashierName(row.name)}`;
}

function effectivePoints(row) {
    if (row?.excluded) return 0;
    if (Number.isFinite(row?.override)) return row.override;
    return Number(row?.points) || 0;
}

function normalizeDayShiftEmployeeMultiplier(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const employees = (Array.isArray(raw.employees) ? raw.employees : [])
        .map((name) => String(name || '').trim())
        .filter(Boolean);
    if (!employees.length) return null;
    const multiplier = Number(raw.multiplier);
    return {
        multiplier: Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1.5,
        employees,
    };
}

function employeeMatchesDayShift(name, dayShiftConfig) {
    if (!dayShiftConfig?.employees?.length) return false;
    const key = normalizeCashierName(name);
    return dayShiftConfig.employees.some((employee) => normalizeCashierName(employee) === key);
}

function scoredPoints(row, dayShiftConfig) {
    const base = effectivePoints(row);
    if (!base) return { base: 0, total: 0, multiplier: null };
    if (!employeeMatchesDayShift(row.name, dayShiftConfig)) {
        return { base, total: base, multiplier: null };
    }
    const multiplier = Number(dayShiftConfig.multiplier) || 1.5;
    return { base, total: Math.round(base * multiplier), multiplier };
}

function normalizeScoreRow(row = {}, preserve = null) {
    const day = String(row.day || preserve?.day || '').trim();
    const name = String(row.name || preserve?.name || '').trim();
    const points = Number(row.points ?? preserve?.points);
    if (!name || !isDayField(day) || !Number.isFinite(points) || points <= 0) return null;

    const out = { day, name, points };
    const override =
        row.override != null && row.override !== ''
            ? Number(row.override)
            : preserve?.override != null
              ? preserve.override
              : undefined;
    if (Number.isFinite(override)) out.override = override;

    const excluded = row.excluded ?? preserve?.excluded;
    if (excluded) out.excluded = true;

    const note = String(row.note || preserve?.note || '').trim();
    if (note) out.note = note;

    return out;
}

function serializeScoreRow(row) {
    const out = { day: row.day, name: row.name, points: row.points };
    if (Number.isFinite(row.override)) out.override = row.override;
    if (row.excluded) out.excluded = true;
    if (row.note) out.note = row.note;
    return out;
}

function legacyScoresPath(storeNumber) {
    return path.join(upsellingRootDir(), String(storeNumber), 'leaderboard-scores.json');
}

function legacyOverridesPath(storeNumber) {
    return path.join(upsellingRootDir(), String(storeNumber), 'leaderboard-overrides.json');
}

function applyLegacyOverrides(rows, overridesRaw) {
    const employees = overridesRaw?.employees;
    if (!employees || typeof employees !== 'object') return rows;

    const byKey = new Map(rows.map((row) => [rowKey(row), { ...row }]));

    for (const [key, entry] of Object.entries(employees)) {
        const aliases = new Set([normalizeCashierName(key)]);
        if (entry.displayName) aliases.add(normalizeCashierName(entry.displayName));
        for (const alias of entry.aliases || []) {
            aliases.add(normalizeCashierName(alias));
        }

        for (const row of byKey.values()) {
            if (!aliases.has(normalizeCashierName(row.name))) continue;
            if (entry.excluded) row.excluded = true;
            for (const [day, override] of Object.entries(entry.dayOverrides || {})) {
                if (!isDayField(day)) continue;
                const matchKey = `${day}|${normalizeCashierName(row.name)}`;
                const existing = byKey.get(matchKey);
                if (!existing) continue;
                const pts = Number(override?.points ?? override);
                if (Number.isFinite(pts)) existing.override = pts;
                const note = String(override?.note || '').trim();
                if (note) existing.note = note;
            }
        }

        if (Number.isFinite(Number(entry.bonusPoints)) && Number(entry.bonusPoints) > 0) {
            let best = null;
            for (const row of byKey.values()) {
                if (!aliases.has(normalizeCashierName(row.name))) continue;
                const pts = effectivePoints(row);
                if (!best || pts > best.pts) best = { row, pts };
            }
            if (best?.row) {
                best.row.override = (Number.isFinite(best.row.override) ? best.row.override : best.row.points) + Number(entry.bonusPoints);
            }
        }
    }

    return [...byKey.values()];
}

function migrateLegacyStore(storeNumber) {
    const store = String(storeNumber || '').trim();
    const target = leaderboardFilePath(store);
    if (fs.existsSync(target)) return false;

    const legacyScores = legacyScoresPath(store);
    if (!fs.existsSync(legacyScores)) return false;

    const raw = readJsonFile(legacyScores, { rows: [] });
    let rows = (Array.isArray(raw.rows) ? raw.rows : [])
        .map((row) => normalizeScoreRow(row))
        .filter(Boolean);

    const legacyOverrides = legacyOverridesPath(store);
    if (fs.existsSync(legacyOverrides)) {
        rows = applyLegacyOverrides(rows, readJsonFile(legacyOverrides, {}));
    }

    writeJsonFile(target, {
        storeNumber: store,
        lastSyncAt: raw.lastSyncAt || new Date().toISOString(),
        rows: rows.map(serializeScoreRow),
    });
    console.log(`[Leaderboard] Migrated legacy data → ${path.basename(target)}`);
    return true;
}

function migrateSharedLayout() {
    const root = upsellingRootDir();
    fs.mkdirSync(root, { recursive: true });

    const regional = path.join(root, '_regional');
    if (fs.existsSync(regional)) {
        for (const name of fs.readdirSync(regional)) {
            const src = path.join(regional, name);
            if (!fs.statSync(src).isFile()) continue;
            const dest = path.join(root, name);
            if (!fs.existsSync(dest)) {
                fs.copyFileSync(src, dest);
            }
        }
    }

    const unassignedDir = path.join(root, 'Unassigned Store');
    const reviewSrc = path.join(unassignedDir, 'review-queue.json');
    const reviewDest = path.join(root, 'unassigned-review.json');
    if (fs.existsSync(reviewSrc) && !fs.existsSync(reviewDest)) {
        fs.copyFileSync(reviewSrc, reviewDest);
    }

    try {
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const name = entry.name;
            if (/^\d{4}$/.test(name) || name === 'teststore') {
                migrateLegacyStore(name);
            }
        }
    } catch (_) {
        /* ignore */
    }

    cleanupLegacyFolders();
}

function cleanupLegacyFolders() {
    const root = upsellingRootDir();

    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        if (!/^\d{4}$/.test(name) && name !== 'teststore') continue;
        const migrated = fs.existsSync(leaderboardFilePath(name));
        if (!migrated) continue;
        const legacyDir = path.join(root, name);
        try {
            fs.rmSync(legacyDir, { recursive: true, force: true });
            console.log(`[Leaderboard] Removed legacy folder ${name}/`);
        } catch (err) {
            console.warn(`[Leaderboard] Could not remove legacy folder ${name}/:`, err.message);
        }
    }

    const regional = path.join(root, '_regional');
    if (fs.existsSync(regional)) {
        try {
            fs.rmSync(regional, { recursive: true, force: true });
            console.log('[Leaderboard] Removed legacy folder _regional/');
        } catch (err) {
            console.warn('[Leaderboard] Could not remove legacy folder _regional/:', err.message);
        }
    }

    const unassignedDir = path.join(root, 'Unassigned Store');
    if (fs.existsSync(unassignedDir)) {
        try {
            fs.rmSync(unassignedDir, { recursive: true, force: true });
            console.log('[Leaderboard] Removed legacy folder Unassigned Store/');
        } catch (err) {
            console.warn('[Leaderboard] Could not remove Unassigned Store/:', err.message);
        }
    }
}

let layoutMigrated = false;
function ensureLayoutMigrated() {
    if (layoutMigrated) return;
    layoutMigrated = true;
    migrateSharedLayout();
}

function scoresPath(storeNumber) {
    ensureLayoutMigrated();
    migrateLegacyStore(storeNumber);
    return leaderboardFilePath(storeNumber);
}

function loadScores(storeNumber) {
    const store = String(storeNumber || '').trim();
    const file = scoresPath(store);
    const raw = readJsonFile(file, { storeNumber: store, lastSyncAt: null, rows: [] });
    const rows = (Array.isArray(raw.rows) ? raw.rows : [])
        .map((row) => normalizeScoreRow(row))
        .filter(Boolean)
        .sort(
            (a, b) =>
                a.day.localeCompare(b.day) ||
                b.points - a.points ||
                a.name.localeCompare(b.name)
        );
    return {
        storeNumber: store,
        lastSyncAt: raw.lastSyncAt || null,
        dayShiftEmployeeMultiplier: normalizeDayShiftEmployeeMultiplier(raw.dayShiftEmployeeMultiplier),
        rows,
        source: fs.existsSync(file) ? path.basename(file) : null,
    };
}

function saveScores(storeNumber, rows = [], meta = {}) {
    const store = String(storeNumber || '').trim();
    const file = scoresPath(store);
    const existing = readJsonFile(file, {});
    const normalized = rows.map((row) => normalizeScoreRow(row)).filter(Boolean);
    normalized.sort(
        (a, b) =>
            a.day.localeCompare(b.day) ||
            b.points - a.points ||
            a.name.localeCompare(b.name)
    );
    const payload = {
        storeNumber: store,
        lastSyncAt: meta.lastSyncAt || new Date().toISOString(),
        rows: normalized.map(serializeScoreRow),
    };
    const dayShift =
        meta.dayShiftEmployeeMultiplier !== undefined
            ? normalizeDayShiftEmployeeMultiplier(meta.dayShiftEmployeeMultiplier)
            : normalizeDayShiftEmployeeMultiplier(existing.dayShiftEmployeeMultiplier);
    if (dayShift) payload.dayShiftEmployeeMultiplier = dayShift;
    writeJsonFile(file, payload);
    return normalized;
}

function resolveLeaderboardDayFilter(options = {}) {
    if (options.day === 'today') return melbourneTodayIso();
    const explicit = String(options.day || '').trim();
    return isDayField(explicit) ? explicit : null;
}

function resolveLeaderboardPeriod(options = {}) {
    const period = String(options.period || '').trim().toLowerCase();
    if (period === 'week') return 'week';
    const day = String(options.day || '').trim().toLowerCase();
    if (day === 'week' || day === 'thisweek') return 'week';
    return '';
}

/** Rank cashiers. Default: best single day in retention. `{ period: 'week' }` sums Mon–Sun for the podium. */
function aggregateLeaderboard(storeNumber, options = {}) {
    const dayFilter = resolveLeaderboardDayFilter(options);
    const weekMode = resolveLeaderboardPeriod(options) === 'week';
    const { rows, dayShiftEmployeeMultiplier } = loadScores(storeNumber);
    const bestByName = new Map();
    const weekTotalsByName = new Map();
    const effectiveByDay = [];

    for (const row of rows) {
        if (weekMode) {
            if (!isDayInMelbourneWeek(row.day)) continue;
        } else if (dayFilter && row.day !== dayFilter) continue;
        if (row.excluded) continue;
        const { base, total, multiplier } = scoredPoints(row, dayShiftEmployeeMultiplier);
        if (!total) continue;

        effectiveByDay.push({
            day: row.day,
            name: row.name,
            points: total,
            mmxPoints: row.points,
            basePoints: base,
            override: row.override,
            dayShiftMultiplier: multiplier,
            sourceName: row.name,
        });

        const key = normalizeCashierName(row.name);
        if (weekMode) {
            const prev = weekTotalsByName.get(key);
            const bestDay =
                !prev || total > prev.bestDayPoints
                    ? row.day
                    : prev.bestDay;
            const bestDayPoints = Math.max(prev?.bestDayPoints || 0, total);
            weekTotalsByName.set(key, {
                name: row.name,
                points: (prev?.points || 0) + total,
                basePoints: (prev?.basePoints || 0) + base,
                mmxPoints: (prev?.mmxPoints || 0) + (Number(row.points) || 0),
                dayShiftMultiplier: multiplier || prev?.dayShiftMultiplier || null,
                bestDay,
                bestDayPoints,
            });
            continue;
        }

        const prev = bestByName.get(key);
        if (
            !prev ||
            total > prev.points ||
            (total === prev.points && String(row.day) > String(prev.day))
        ) {
            bestByName.set(key, {
                points: total,
                basePoints: base,
                mmxPoints: row.points,
                dayShiftMultiplier: multiplier,
                day: row.day,
                name: row.name,
            });
        }
    }

    const aggregateSource = weekMode ? weekTotalsByName : bestByName;
    const rankedRows = [...aggregateSource.values()]
        .map((best) => ({
            name: best.name,
            mmxPoints: best.mmxPoints,
            bestDay: best.bestDay || best.day,
            bonusPoints: Math.max(0, best.points - best.basePoints),
            dayShiftMultiplier: best.dayShiftMultiplier,
            total: best.points,
        }))
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

    effectiveByDay.sort(
        (a, b) =>
            a.day.localeCompare(b.day) ||
            b.points - a.points ||
            a.name.localeCompare(b.name)
    );

    return {
        rows: rankedRows,
        byDay: effectiveByDay,
        period: weekMode ? 'week' : dayFilter ? 'day' : 'bestDay',
        weekStart: weekMode ? melbourneWeekStartIso() : null,
        weekEnd: weekMode ? melbourneWeekEndIso() : null,
    };
}

function mergeSyncScores(storeNumber, byDay = [], options = {}) {
    const store = String(storeNumber || '').trim();
    const existing = loadScores(store);
    const defaultDay = melbourneTodayIso();

    const incoming = (byDay || [])
        .map((row) => {
            const day = String(row.day || '').trim() || defaultDay;
            return normalizeScoreRow({
                day: isDayField(day) ? day : defaultDay,
                name: row.name,
                points: row.points,
            });
        })
        .filter(Boolean);

    const replaceDays = new Set(
        (options.replaceDays?.length ? options.replaceDays : incoming.map((r) => r.day)).filter(
            isDayField
        )
    );

    const existingByKey = new Map(existing.rows.map((row) => [rowKey(row), row]));
    const byKey = new Map();

    for (const row of existing.rows) {
        if (replaceDays.has(row.day)) continue;
        byKey.set(rowKey(row), row);
    }

    for (const row of incoming) {
        const key = rowKey(row);
        const prev = existingByKey.get(key);
        byKey.set(
            key,
            normalizeScoreRow(row, prev) || {
                ...row,
                override: prev?.override,
                excluded: prev?.excluded,
                note: prev?.note,
            }
        );
    }

    let mergedRows = [...byKey.values()].filter(Boolean);
    mergedRows = pruneRowsToRetentionDays(mergedRows);

    if (replaceDays.size || incoming.length) {
        const refreshed = replaceDays.size ? [...replaceDays].join(', ') : 'all incoming days';
        console.log(
            `[Leaderboard] Merged ${incoming.length} day row(s) into ${store}_leaderboard.json (${mergedRows.length} total; refreshed ${refreshed})`
        );
    }

    if (mergedRows.length || fs.existsSync(scoresPath(store))) {
        saveScores(store, mergedRows, { lastSyncAt: new Date().toISOString() });
    }

    return aggregateLeaderboard(store);
}

module.exports = {
    normalizeCashierName,
    isDayField,
    melbourneTodayIso,
    melbourneWeekStartIso,
    melbourneWeekEndIso,
    isDayInMelbourneWeek,
    scoresPath,
    leaderboardFilePath,
    loadScores,
    saveScores,
    aggregateLeaderboard,
    resolveLeaderboardDayFilter,
    resolveLeaderboardPeriod,
    mergeSyncScores,
    effectivePoints,
    scoredPoints,
    normalizeDayShiftEmployeeMultiplier,
    employeeMatchesDayShift,
    migrateLegacyStore,
    migrateSharedLayout,
    cleanupLegacyFolders,
};
