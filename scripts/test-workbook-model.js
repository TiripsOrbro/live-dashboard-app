#!/usr/bin/env node
/** Spot-check Excel parity for glove pack math. */
const { computeWorkbookLine } = require('../src/services/buildToWorkbookModel');

const gloveRow = {
    name: 'MEDIUM GLOVES (PACKS)',
    perPack: 1000,
    dailyManual: 0.2,
    buildToRule: { type: 'pack10', innerPerCarton: 10, onOrderCartonFactor: 10 },
};

const r = computeWorkbookLine(gloveRow, {
    daily: 0.2,
    onHandOverride: 18,
    onOrderCartons: 0,
});

console.log('Gloves (18 packs on hand):', r);
if (Math.abs(r.buildTo - 20) > 0.01) throw new Error('buildTo should be 20 packs');
if (Math.abs(r.orderQty - 0.2) > 0.01) throw new Error('orderQty should be 0.2 boxes');
console.log('OK');
