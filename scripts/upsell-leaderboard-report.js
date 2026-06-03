#!/usr/bin/env node
/**
 * Print cashier points by day from {store}_leaderboard.json.
 *
 *   node scripts/upsell-leaderboard-report.js 3811
 *   node scripts/upsell-leaderboard-report.js --all-stores
 */
const { loadScores, aggregateLeaderboard } = require('../src/services/upselling/leaderboardStore');
const {
    resolveEnabledStores,
    isUpsellingMmxSyncStore,
} = require('../src/services/upselling/upsellingConfig');

function effectivePts(row) {
    if (row.excluded) return null;
    if (Number.isFinite(row.override)) return row.override;
    return Number(row.points) || 0;
}

function printStore(store) {
    const { rows, lastSyncAt } = loadScores(store);
    console.log(`\n=== Store ${store} ===`);
    console.log(`Last sync: ${lastSyncAt || '(unknown)'}`);

    const dayRows = rows
        .filter((r) => effectivePts(r) > 0)
        .sort(
            (a, b) =>
                a.day.localeCompare(b.day) ||
                effectivePts(b) - effectivePts(a) ||
                a.name.localeCompare(b.name)
        );

    if (!dayRows.length) {
        console.log('(no scored rows — run upsell sync or rescore first)');
        return;
    }

    let currentDay = '';
    for (const row of dayRows) {
        if (row.day !== currentDay) {
            currentDay = row.day;
            console.log(`\n${currentDay}`);
        }
        const pts = effectivePts(row);
        const mmx = Number(row.points) || 0;
        const note =
            Number.isFinite(row.override) && row.override !== mmx
                ? `  (MMX ${mmx}, override ${row.override})`
                : row.note
                  ? `  (${row.note})`
                  : '';
        console.log(`  ${row.name.padEnd(26)} ${String(pts).padStart(4)} pts${note}`);
    }

    const { rows: weekTop, weekStart, weekEnd } = aggregateLeaderboard(store, { period: 'week' });
    console.log(`\nWeek total ${weekStart} – ${weekEnd} (podium ranking):`);
    weekTop.slice(0, 7).forEach((r, i) => {
        console.log(`  ${i + 1}. ${r.name} — ${r.total} pts`);
    });
}

function main() {
    const args = process.argv.slice(2).filter((a) => a !== '--');
    const allStores = args.includes('--all-stores');
    const stores = allStores
        ? resolveEnabledStores().filter(isUpsellingMmxSyncStore)
        : args.filter((a) => !a.startsWith('--'));

    if (!stores.length) {
        console.error('Usage: node scripts/upsell-leaderboard-report.js <storeNumber>');
        console.error('       node scripts/upsell-leaderboard-report.js --all-stores');
        process.exit(1);
    }

    for (const store of stores) {
        printStore(store);
    }
    console.log('');
}

main();
