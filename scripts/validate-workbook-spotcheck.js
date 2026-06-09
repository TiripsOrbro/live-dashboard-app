#!/usr/bin/env node
/**
 * Spot-check Cut Fresh calendar + Schweppes fixed BIB pars vs live Pi reports.
 * Run on Pi after a stock count: node scripts/validate-workbook-spotcheck.js 3811
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { calculateBuildToOrders } = require('../src/services/buildToCalculator');
const { loadWorkbookConfig } = require('../src/services/buildToWorkbookEngine');
const { melbourneWeekdayUpper } = require('../src/services/buildToWorkbookModel');

const STORE = process.argv[2] || '3811';

function round2(n) {
    return Math.round(Number(n) * 100) / 100;
}

async function main() {
    const config = loadWorkbookConfig();
    const weekday = melbourneWeekdayUpper();
    const result = await calculateBuildToOrders(STORE, { preferReportOnHand: true });

    console.log(`\n=== Workbook spot-check store ${STORE} (${weekday}) ===\n`);

    const bibCodes = new Set(
        (config.rows || [])
            .filter((r) => r.sheet === 'SCHWEPPES' && r.buildToRule?.type === 'fixed')
            .map((r) => r.mmxCode)
    );
    const cutfreshNames = new Set(['LETTUCE', 'ONION', 'CORIANDER', 'TOMATO']);

    console.log('--- Schweppes fixed BIB / frozen pars ---');
    console.log('Item'.padEnd(28), 'MMX'.padEnd(10), 'Expected', 'App BT', 'OH', 'OO', 'Need');
    for (const row of config.rows.filter((r) => r.sheet === 'SCHWEPPES' && r.buildToRule?.type === 'fixed')) {
        const line = result.lines.find((l) => l.itemCode === row.mmxCode);
        const expected = row.buildToRule.value;
        const appBt = line?.buildTo ?? '—';
        const oh = line?.onHandCartons ?? '—';
        const oo = line?.onOrderCartons ?? '—';
        const need = line?.orderQty ?? '—';
        const ok = line && Math.abs(line.buildTo - expected) < 0.05 ? '✓' : '!';
        console.log(
            ok,
            row.name.padEnd(26),
            String(row.mmxCode).padEnd(10),
            String(expected).padEnd(8),
            String(appBt).padEnd(8),
            String(oh).padEnd(6),
            String(oo).padEnd(6),
            need
        );
    }

    console.log('\n--- Cut Fresh (calendar build-to for today) ---');
    const dayCal = config.cutfreshCalendar?.[weekday] || {};
    console.log('Item'.padEnd(14), 'Calendar', 'App BT', 'Daily', 'OH', 'OO', 'Need');
    for (const row of config.rows.filter(
        (r) => r.sheet === 'CUTFRESH' && cutfreshNames.has(r.name.toUpperCase().trim())
    )) {
        const key = row.name.toUpperCase().trim();
        const expected = dayCal[key] ?? dayCal[key.replace(/\s+$/, '')] ?? '—';
        const line = result.lines.find(
            (l) => l.description?.toUpperCase().trim() === key || l.itemCode === row.mmxCode
        );
        const ok =
            expected !== '—' && line && Math.abs(line.buildTo - expected) < 0.05 ? '✓' : '!';
        console.log(
            ok,
            key.padEnd(12),
            String(expected).padEnd(8),
            String(line?.buildTo ?? '—').padEnd(8),
            String(line?.avgDaily ?? '—').padEnd(6),
            String(line?.onHandCartons ?? '—').padEnd(6),
            String(line?.onOrderCartons ?? '—').padEnd(6),
            line?.orderQty ?? '—'
        );
    }

    if (weekday === 'FRIDAY' || weekday === 'SUNDAY' && Object.keys(dayCal).length === 0) {
        console.log('\nNote: Excel has no Cut Fresh delivery on', weekday, '(build-to may be 0).');
    }

    console.log('\nEngine:', result.engine || 'catalog');
    console.log('Report SOH:', result.reportFiles?.stockOnHand || 'missing');
    console.log('Manual count items:', result.manualCountItems ?? 'n/a');
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
