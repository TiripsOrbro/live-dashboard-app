#!/usr/bin/env node
/** Verify each qty cell maps to the store header above that column. */
const { loadPointsMap, loadPointsMapForParsing } = require('../src/services/upselling/pointsFile');
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

/** Entity per row (no store header row above each item column). */
const entityRowGrid = [
    ['Fiscal YPWD', 'Cashier Name', 'EntityName', 'Boss Burrito Box', 'Cheesy G Taco Box'],
    ['', '', 'Sales Item Quantity', 'Sales Item Quantity', 'Sales Item Quantity'],
    ['2026-06-01', 'LUCY PANETTA', '3811 Chirnside Park', '1', '2'],
    ['2026-06-01', 'MACY VENDEL', '3806 Dandenong South', '3', ''],
    ['2026-06-01', 'MACY VENDEL', '3811 Chirnside Park', '', '1'],
];

const entityParsed = parseUpsellGrid(entityRowGrid, byLabel, { filterStoreNumber: '3811' });
const lucy = entityParsed.cashiers.find((c) => c.name === 'LUCY PANETTA' && c.day === '2026-06-01');
const macy3811 = entityParsed.cashiers.filter(
    (c) => c.name === 'MACY VENDEL' && c.day === '2026-06-01' && c.store === '3811'
);
assert(lucy && lucy.store === '3811' && lucy.qtyByColumn['Boss Burrito Box'] === 1, 'LUCY row store + qty');
assert(
    macy3811.length === 1 && macy3811[0].qtyByColumn['Cheesy G Taco Box'] === 1,
    `MACY at 3811 only (got ${JSON.stringify(macy3811)})`
);
assert(
    !entityParsed.cashiers.some((c) => c.name === 'MACY VENDEL' && c.store === '3806'),
    '3806 MACY row should be filtered out for 3811 sync'
);

/** CSV continuation row: entity in Cashier col when date omitted on second line for same person. */
const continuationGrid = [
    ['Fiscal YPWD', 'Cashier Name', 'Entity by State County Postcode', 'Cheesy G Taco Box', 'Cinnamon Twists'],
    ['', '', 'Sales Item Quantity', 'Sales Item Quantity', 'Sales Item Quantity'],
    ['2026-06-03', 'ZARTASHA AMIN', '3902 Ellenbrook North', '2', '1'],
    ['ZARTASHA AMIN', '3902 Ellenbrook North', '', '3', ''],
];
const contParsed = parseUpsellGrid(continuationGrid, loadPointsMapForParsing().byLabel);
const zartasha = contParsed.cashiers.filter((c) => c.name === 'ZARTASHA AMIN' && c.day === '2026-06-03');
assert(
    zartasha.length >= 1 && zartasha.every((c) => c.store === '3902'),
    `ZARTASHA continuation rows should all be 3902 (got ${JSON.stringify(zartasha)})`
);
assert(!zartasha.some((c) => !c.store), 'ZARTASHA rows must have store set');

const { scoreParsedReport } = require('../src/services/upselling/upsellingScores');
const scored3811 = scoreParsedReport(contParsed, '3811', { syncDay: '2026-06-03' });
assert(
    !scored3811.byDay.some((c) => c.name === 'ZARTASHA AMIN'),
    'ZARTASHA must not score into 3811'
);
const scored3902 = scoreParsedReport(contParsed, '3902', { syncDay: '2026-06-03' });
assert(
    scored3902.byDay.some((c) => c.name === 'ZARTASHA AMIN'),
    'ZARTASHA must score into 3902'
);

/** Orphan continuation row (no prior date) → unassigned, not scored anywhere. */
const orphanGrid = [
    ['Fiscal YPWD', 'Cashier Name', 'Entity by State County Postcode', 'Cheesy G Taco Box', 'Cinnamon Twists'],
    ['', '', 'Sales Item Quantity', 'Sales Item Quantity', 'Sales Item Quantity'],
    ['JANE DOE', '3811 Chirnside Park', '', '2', '1'],
];
const orphanParsed = parseUpsellGrid(orphanGrid, loadPointsMapForParsing().byLabel);
assert(
    orphanParsed.unassigned?.length === 1 && orphanParsed.cashiers.length === 0,
    `orphan row should be unassigned (got ${JSON.stringify(orphanParsed.unassigned)})`
);
assert(
    orphanParsed.unassigned[0].reason.includes('date'),
    'orphan reason should mention missing date'
);

console.log('OK — store columns match headers above each qty cell');
console.log(
    'Sample:',
    parsed.cashiers
        .filter((c) => c.day === '2026-05-25')
        .slice(0, 6)
        .map((c) => `${c.store} | ${c.name} | ${JSON.stringify(c.qtyByColumn)}`)
);
