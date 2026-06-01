#!/usr/bin/env node
/** Dry-run scoring on a minimal in-memory grid written to temp xlsx. */
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { processReportFile } = require('../src/services/upselling/upsellingScores');

const storeNumber = process.argv[2] || '3811';
const tmpDir = path.join(__dirname, '../data/upselling', storeNumber, 'samples');
fs.mkdirSync(tmpDir, { recursive: true });
const filePath = path.join(tmpDir, 'sample-upsell.xlsx');

const grid = [
    ['Cashier', 'Churros', 'Boss Burrito Box', 'BOX_MEALS'],
    ['John Smith', 2, 1, 99],
    ['Jane Doe', 0, 3, 50],
    ['Online 1 Cashier', 10, 10, 10],
];

const wb = XLSX.utils.book_new();
const ws = XLSX.utils.aoa_to_sheet(grid);
XLSX.utils.book_append_sheet(wb, ws, 'Upsell');
XLSX.writeFile(wb, filePath);

const { ranked, parsed } = processReportFile(filePath, storeNumber);
console.log('Columns used:', parsed.columnsUsed);
console.log('Ranked:', ranked);
