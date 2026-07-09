#!/usr/bin/env node
/**
 * Apply Americold Dry/Carryover catalog fixes to the live Pi catalog
 * (vendors/catalogs/.Americold). Templates live in vendors/examples/.
 *
 * Dry-run by default; pass --write to apply.
 */
const fs = require('fs');
const path = require('path');
const paths = require('../src/paths');

const WRITE = process.argv.includes('--write');
const EXAMPLE = path.join(paths.vendors.root, 'examples', '.Americold.example');
const LIVE = path.join(paths.vendors.catalogs, '.Americold');

const CARRYOVER_PROTEIN_CODES = new Set(['39520', '39867A', '37909']);

function itemCodeFromLine(line) {
    const m = String(line).match(/^\S+\s*\|\s*([A-Za-z0-9]+)\s*\|/);
    return m ? m[1].toUpperCase() : null;
}

function ensureCarryoverLocation(line) {
    if (!line.trim() || line.trim().startsWith('#')) return line;
    const code = itemCodeFromLine(line);
    if (!code || !CARRYOVER_PROTEIN_CODES.has(code)) return line;
    if (/\|\s*Carryover\b/i.test(line)) return line;
    return line.replace(/\|\s*In Use\b/i, '| Carryover | In Use');
}

function dryCarryoverTailFromExample() {
    const text = fs.readFileSync(EXAMPLE, 'utf8');
    const idx = text.indexOf('# --- Dry');
    if (idx < 0) throw new Error('Example catalog missing Dry section.');
    return text.slice(idx).replace(/\s*$/, '\n');
}

function patchLiveCatalog(raw) {
    const dryIdx = raw.search(/^# --- Dry/m);
    const carryIdx = raw.search(/^# --- Carryover/m);
    const cutIdx = dryIdx >= 0 ? dryIdx : carryIdx;
    const head = cutIdx >= 0 ? raw.slice(0, cutIdx) : raw;
    const headLines = head.split(/\r?\n/).map(ensureCarryoverLocation);
    const tail = dryCarryoverTailFromExample();
    const text = `${headLines.join('\n').replace(/\s*$/, '\n')}\n${tail}`;
    return text;
}

function run() {
    if (!fs.existsSync(EXAMPLE)) {
        console.error(`Example catalog not found: ${EXAMPLE}`);
        process.exit(1);
    }

    if (!fs.existsSync(LIVE)) {
        console.log(`[.Americold] live file missing — would copy from example`);
        const text = fs.readFileSync(EXAMPLE, 'utf8');
        if (WRITE) {
            fs.mkdirSync(path.dirname(LIVE), { recursive: true });
            fs.writeFileSync(LIVE, text, 'utf8');
            console.log(`[.Americold] created ${LIVE}`);
        }
        return;
    }

    const before = fs.readFileSync(LIVE, 'utf8');
    const after = patchLiveCatalog(before);
    const changed = before !== after;

    console.log(`[.Americold] ${changed ? 'would update' : 'already up to date'} ${LIVE}`);
    if (changed) {
        const beforeCarryoverSupplies = (before.match(/^order=.*\|\s*Carryover\b/gim) || []).length;
        const afterCarryoverSupplies = (after.match(/^order=.*\|\s*Carryover\b/gim) || []).length;
        const afterProteinCarryover = (after.match(/^(10|13) \| (39520|39867A|37909).*Carryover/m) || []).length;
        console.log(`  supply lines on Carryover: ${beforeCarryoverSupplies} -> ${afterCarryoverSupplies}`);
        console.log(`  protein lines with Carryover: ${afterProteinCarryover}/3`);
        console.log(`  SCM dry oh: lines: ${(after.match(/^oh:10 \|/gm) || []).length}`);
    }

    if (WRITE && changed) {
        fs.writeFileSync(LIVE, after, 'utf8');
        console.log('[.Americold] patched.');
    } else if (!WRITE) {
        console.log('Dry run only. Re-run with --write to apply.');
    }
}

run();
