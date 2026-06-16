const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const paths = require('../../src/paths');
const CONFIG_PATH = path.join(paths.nsf.config, 'rounds.json');

function parseYmd(value) {
    const raw = String(value || '').trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        return null;
    }
    return { year, month, day, date, ymd: raw };
}

function defaultRoundsForYear(year) {
    return [
        { id: 'r1', startDate: `${year}-01-01`, endDate: `${year}-04-30` },
        { id: 'r2', startDate: `${year}-05-01`, endDate: `${year}-08-31` },
        { id: 'r3', startDate: `${year}-09-01`, endDate: `${year}-12-31` },
    ];
}

function defaultConfig() {
    const year = new Date().getFullYear();
    return {
        year,
        rounds: defaultRoundsForYear(year),
        updatedBy: '',
        updatedAt: '',
    };
}

function readConfigRaw() {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
        return null;
    }
}

function normalizeRound(row, index) {
    return {
        id: String(row?.id || `r${index + 1}`).trim() || `r${index + 1}`,
        startDate: String(row?.startDate || '').trim(),
        endDate: String(row?.endDate || '').trim(),
    };
}

function normalizeConfig(raw) {
    const base = defaultConfig();
    if (!raw || typeof raw !== 'object') return base;
    const year = Number(raw.year) || base.year;
    const rounds = Array.isArray(raw.rounds) && raw.rounds.length
        ? raw.rounds.map(normalizeRound)
        : defaultRoundsForYear(year);
    return {
        year,
        rounds,
        updatedBy: String(raw.updatedBy || '').trim(),
        updatedAt: String(raw.updatedAt || '').trim(),
    };
}

function validateRounds(year, rounds) {
    if (!Array.isArray(rounds) || !rounds.length) {
        return { ok: false, error: 'At least one NSF round is required.' };
    }
    const parsed = [];
    for (let i = 0; i < rounds.length; i++) {
        const round = normalizeRound(rounds[i], i);
        const start = parseYmd(round.startDate);
        const end = parseYmd(round.endDate);
        if (!start || !end) {
            return { ok: false, error: `Round ${i + 1}: start and end dates must be YYYY-MM-DD.` };
        }
        if (start.year !== year || end.year !== year) {
            return { ok: false, error: `Round ${i + 1}: dates must fall within ${year}.` };
        }
        if (start.date.getTime() > end.date.getTime()) {
            return { ok: false, error: `Round ${i + 1}: start date must be on or before end date.` };
        }
        parsed.push({ ...round, start, end });
    }
    parsed.sort((a, b) => a.start.date.getTime() - b.start.date.getTime());
    for (let i = 1; i < parsed.length; i++) {
        if (parsed[i].start.date.getTime() <= parsed[i - 1].end.date.getTime()) {
            return { ok: false, error: 'NSF rounds must not overlap.' };
        }
    }
    return { ok: true, rounds: parsed.map(({ id, startDate, endDate }) => ({ id, startDate, endDate })) };
}

function getNsfRoundConfig() {
    return normalizeConfig(readConfigRaw());
}

function saveNsfRoundConfig(payload, actor) {
    const year = Number(payload?.year);
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
        return { ok: false, error: 'Valid year is required.' };
    }
    const validation = validateRounds(year, payload?.rounds);
    if (!validation.ok) return validation;
    const now = new Date().toISOString();
    const actorName = String(actor || '').trim() || 'Unknown';
    const config = {
        year,
        rounds: validation.rounds.map((row, index) => ({
            id: row.id || `r${index + 1}`,
            startDate: row.startDate,
            endDate: row.endDate,
        })),
        updatedBy: actorName,
        updatedAt: now,
    };
    try {
        fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
        return { ok: true, config: getNsfRoundConfig() };
    } catch (error) {
        return { ok: false, error: error.message || 'Could not save NSF settings.' };
    }
}

function newRoundId() {
    return `r-${crypto.randomBytes(4).toString('hex')}`;
}

module.exports = {
    getNsfRoundConfig,
    saveNsfRoundConfig,
    defaultRoundsForYear,
    newRoundId,
    CONFIG_PATH,
};
