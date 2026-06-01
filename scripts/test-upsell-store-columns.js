#!/usr/bin/env node
/** Verify each qty cell maps to the store header above that column. */
const { loadPointsMap } = require('../src/services/upselling/pointsFile');
const { parseUpsellGrid } = require('../src/services/upselling/upsellReportParser');

const grid = [
    ['Fiscal YPWD', 'Cashier Name', '', '', 'Boss Burrito Box', '', '', '', ''],
    ['', '', '', '', '3806 Dandenong South', '3808 Berwick South', '3811 Chirnside Park', '3901 Midland', '3902 Ellenbrook North', '3903 Canning Vale', '3904 Butler'],
    ['', '', '', '', 'Sales Item Quantity', 'Sales Item Quantity', 'Sales Item Quantity', 'Sales Item Quantity', 'Sales Item Quantity', 'Sales Item Quantity', 'Sales Item Quantity'],
    ['2026-05-25', 'ANAIS HANCOCK', '', '', '1', '', '2', '', '', '', ''],
    ['2026-05-25', 'MACY VENDEL', '', '', '', '', '2', '', '', '', ''],
    ['2026-05-25', 'MAHSA HUSSAINI', '', '', '', '2', '', '', '', '', ''],
];

/** In-column qty (no shift): MACY 3806, MAHSA 3808 — must not enable column shift. */
const mixedGrid = [
    ['Fiscal YPWD', 'Cashier Name', 'Boss Burrito Box', '', '', '', '', '', ''],
    ['', '', '3806 Dandenong South', '3808 Berwick South', '3811 Chirnside Park', '3901 Midland', '3902 Ellenbrook North', '3903 Canning Vale', '3904 Butler'],
    ['', '', 'Sales Item Quantity', 'Sales Item Quantity', 'Sales Item Quantity', 'Sales Item Quantity', 'Sales Item Quantity', 'Sales Item Quantity', 'Sales Item Quantity'],
    ['2026-05-25', 'ANAIS HANCOCK', '1', '', '2', '', '', '', ''],
    ['2026-05-25', 'MACY VENDEL', '2', '', '', '', '', '', ''],
    ['2026-05-25', 'MAHSA HUSSAINI', '', '2', '', '', '', '', ''],
];

const { byLabel } = loadPointsMap();
const parsed = parseUpsellGrid(grid, byLabel);

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

const anais = parsed.cashiers.filter(
    (c) => c.name === 'ANAIS HANCOCK' && c.day === '2026-05-25'
);
const macy = parsed.cashiers.filter((c) => c.name === 'MACY VENDEL' && c.day === '2026-05-25');
const mahsa = parsed.cashiers.filter((c) => c.name === 'MAHSA HUSSAINI' && c.day === '2026-05-25');

assert(
    anais.some((c) => c.store === '3806'),
    `ANAIS should have 3806 (got ${JSON.stringify(anais.map((c) => c.store))})`
);
assert(
    anais.some((c) => c.store === '3811'),
    `ANAIS should have 3811 (got ${JSON.stringify(anais.map((c) => c.store))})`
);
assert(!anais.some((c) => c.store === '3903'), 'ANAIS should not be tagged 3903');

assert(
    macy.length === 1 && macy[0].store === '3811',
    `MACY should only be 3811 (got ${JSON.stringify(macy)})`
);
assert(
    mahsa.length === 1 && mahsa[0].store === '3808',
    `MAHSA should only be 3808 (got ${JSON.stringify(mahsa)})`
);

const mixed = parseUpsellGrid(mixedGrid, byLabel);
const macyMixed = mixed.cashiers.filter((c) => c.name === 'MACY VENDEL' && c.day === '2026-05-25');
const mahsaMixed = mixed.cashiers.filter((c) => c.name === 'MAHSA HUSSAINI' && c.day === '2026-05-25');
assert(
    macyMixed.length === 1 && macyMixed[0].store === '3806',
    `mixed MACY should be 3806 only (got ${JSON.stringify(macyMixed)})`
);
assert(
    mahsaMixed.length === 1 && mahsaMixed[0].store === '3808',
    `mixed MAHSA should be 3808 only (got ${JSON.stringify(mahsaMixed)})`
);
const anaisMixed = mixed.cashiers.filter((c) => c.name === 'ANAIS HANCOCK' && c.day === '2026-05-25');
assert(
    anaisMixed.some((c) => c.store === '3806') && anaisMixed.some((c) => c.store === '3811'),
    `ANAIS mixed grid (got ${JSON.stringify(anaisMixed.map((c) => c.store))})`
);
assert(!anaisMixed.some((c) => c.store === '3903'), 'ANAIS should not bleed into 3903');

console.log('OK — store columns match headers above each qty cell');
console.log(
    'Sample:',
    parsed.cashiers
        .filter((c) => c.day === '2026-05-25')
        .slice(0, 6)
        .map((c) => `${c.store} | ${c.name} | ${JSON.stringify(c.qtyByColumn)}`)
);
