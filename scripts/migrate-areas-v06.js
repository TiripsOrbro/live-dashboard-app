#!/usr/bin/env node
/**
 * Migrate legacy Area 1/2/21/22 labels to QLD-1 / VIC-1 / WA-1 in .storelist and .Users.
 * Dry-run by default; pass --write to apply changes.
 */
const fs = require('fs');
const path = require('path');
const paths = require('../src/paths');
const { inferAreaFromStore, normalizeAreaLabel } = require('../stores/src/areasConfig');

const WRITE = process.argv.includes('--write');
const STORELIST = paths.stores.storelist;
const USERS = path.join(paths.root, '.Users');

const LEGACY_MAP = {
    'Area 1': 'QLD-1',
    'Area 2': 'QLD-1',
    'Area 21': 'VIC-1',
    'Area 22': 'VIC-1',
};

function migrateStorelist(text) {
    const lines = text.split(/\r?\n/);
    let changes = 0;
    const out = lines.map((line) => {
        if (!line.trim() || line.trim().startsWith('#')) return line;
        const parts = line.split('|').map((p) => p.trim());
        if (parts.length < 2) return line;
        const storeNumber = (parts[0] || '').replace(/[^0-9]/g, '');
        const storeName = parts[1] || storeNumber;
        const areaIdx = parts.length >= 5 ? 4 : parts.length >= 4 ? 2 : -1;
        if (areaIdx < 0) return line;
        const current = parts[areaIdx];
        const mapped = LEGACY_MAP[current] || normalizeAreaLabel(current);
        const tz = parts[areaIdx + 1] || '';
        const inferred = inferAreaFromStore(storeNumber, storeName, mapped, tz);
        if (current === inferred) return line;
        changes += 1;
        parts[areaIdx] = inferred;
        return parts.join(' | ');
    });
    return { text: out.join('\n'), changes };
}

function migrateUsers(text) {
    let changes = 0;
    const out = text.split(/\r?\n/).map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        const mapped = LEGACY_MAP[trimmed];
        if (!mapped) return line;
        changes += 1;
        return mapped;
    });
    return { text: out.join('\n'), changes };
}

function run() {
    if (fs.existsSync(STORELIST)) {
        const raw = fs.readFileSync(STORELIST, 'utf8');
        const { text, changes } = migrateStorelist(raw);
        console.log(`[storelist] ${changes} line(s) would change`);
        if (WRITE && changes) fs.writeFileSync(STORELIST, text, 'utf8');
    } else {
        console.log('[storelist] file not found — skipped');
    }

    if (fs.existsSync(USERS)) {
        const raw = fs.readFileSync(USERS, 'utf8');
        const { text, changes } = migrateUsers(raw);
        console.log(`[.Users] ${changes} line(s) would change`);
        if (WRITE && changes) fs.writeFileSync(USERS, text, 'utf8');
    } else {
        console.log('[.Users] file not found — skipped');
    }

    if (!WRITE) console.log('Dry run only. Re-run with --write to apply.');
}

run();
