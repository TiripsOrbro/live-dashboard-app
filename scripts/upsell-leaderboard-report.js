#!/usr/bin/env node
/**
 * Print cashier points by day from {store}_leaderboard.json.
 *
 *   node scripts/upsell-leaderboard-report.js 3811
 *   node scripts/upsell-leaderboard-report.js --all-stores
 */
const {
    loadScores,
    aggregateLeaderboard,
    scoredPoints,
} = require('../src/services/upselling/leaderboardStore');
const {
    resolveEnabledStores,
    isUpsellingMmxSyncStore,
} = require('../src/services/upselling/upsellingConfig');

function printStore(store) {
    const { rows, lastSyncAt, dayShiftEmployeeMultiplier } = loadScores(store);
    console.log(`\n=== Store ${store} ===`);
    console.log(`Last sync: ${lastSyncAt || '(unknown)'}`);

    const dayRows = rows
        .map((r) => {
            const { total, multiplier } = scoredPoints(r, dayShiftEmployeeMultiplier);
            return { row: r, total, multiplier };
        })
        .filter((e) => e.total > 0)
        .sort(
            (a, b) =>
                a.row.day.localeCompare(b.row.day) ||
                b.total - a.total ||
                a.row.name.localeCompare(b.row.name)
        );

    if (!dayRows.length) {
        console.log('(no scored rows — run upsell sync or rescore first)');
        return;
    }

    let currentDay = '';
    for (const { row, total, multiplier } of dayRows) {
        if (row.day !== currentDay) {
            currentDay = row.day;
            console.log(`\n${currentDay}`);
        }
        const mmx = Number(row.points) || 0;
        const parts = [];
        if (multiplier) parts.push(`day-shift ×${multiplier}`);
        if (Number.isFinite(row.override) && row.override !== mmx) {
            parts.push(`MMX ${mmx}, override ${row.override}`);
        } else if (row.note) parts.push(row.note);
        const note = parts.length ? `  (${parts.join('; ')})` : '';
        console.log(`  ${row.name.padEnd(26)} ${String(total).padStart(4)} pts${note}`);
    }

    const { rows: weekTop, weekStart, weekEnd } = aggregateLeaderboard(store, { period: 'week' });
    console.log(`\nBest day this week ${weekStart} – ${weekEnd} (podium ranking):`);
    weekTop.slice(0, 7).forEach((r, i) => {
        const day = r.bestDay ? ` on ${r.bestDay}` : '';
        console.log(`  ${i + 1}. ${r.name} — ${r.total} pts${day}`);
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
