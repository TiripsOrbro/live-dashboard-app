#!/usr/bin/env node
/**
 * One-time migration helper for domain-based folder layout.
 * Idempotent: skips moves when the target already exists.
 *
 * Usage: node scripts/migrate-domain-layout.js [--dry-run]
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const MOVES = [
    ['.storelist', 'stores/.storelist'],
    ['.storelist.example', 'stores/.storelist.example'],
    ['Reports', 'vendors/reports'],
    ['data/sales-snapshots', 'dashboard/data/sales-snapshots'],
    ['data/sssg-lastyear', 'dashboard/data/sssg-lastyear'],
    ['data/sssg-weekly', 'dashboard/data/sssg-weekly'],
    ['data/upselling', 'dashboard/data/upselling'],
    ['data/mic', 'stores/data/mic'],
    ['data/mmx-users', 'users/data/mmx-users'],
    ['data/webauthn', 'users/data/webauthn'],
    ['data/account-audit.log', 'users/data/account-audit.log'],
    ['data/stock-count-state.json', 'vendors/data/stock-count-state.json'],
    ['data/daily-stock-count-state.json', 'vendors/data/daily-stock-count-state.json'],
    ['data/mmx-pipeline-checkpoints.json', 'vendors/data/mmx-pipeline-checkpoints.json'],
    ['data/tacaudit', 'tacaudit/data/tacaudit'],
    ['data/dfsc', 'tacaudit/data/dfsc'],
    ['data/pest-walk', 'tacaudit/data/pest-walk'],
    ['data/rgm-cleaning', 'tacaudit/data/rgm-cleaning'],
    ['data/periodic-safety', 'tacaudit/data/periodic-safety'],
    ['data/square-one', 'tacaudit/data/square-one'],
    ['data/audit-state.json', 'tacaudit/data/audit-state.json'],
    ['data/audit-recurrence.json', 'tacaudit/data/audit-recurrence.json'],
    ['data/tacaudit-compliance-history.json', 'tacaudit/data/tacaudit-compliance-history.json'],
    ['data/tacaudit-splash-state.json', 'tacaudit/data/tacaudit-splash-state.json'],
    ['config/markets.json', 'stores/config/markets.json'],
    ['config/upselling.json', 'dashboard/config/upselling.json'],
    ['config/upselling-stores.json', 'dashboard/config/upselling-stores.json'],
    ['config/vendor-orders.json', 'vendors/config/vendor-orders.json'],
    ['config/mmx-stock-count.json', 'mmx/config/mmx-stock-count.json'],
    ['config/reports-pipeline.json', 'mmx/config/reports-pipeline.json'],
];

function movePath(fromRel, toRel, dryRun) {
    const from = path.join(root, fromRel);
    const to = path.join(root, toRel);
    if (!fs.existsSync(from)) {
        console.log(`skip (missing): ${fromRel}`);
        return;
    }
    if (fs.existsSync(to)) {
        console.log(`skip (target exists): ${toRel}`);
        return;
    }
    console.log(`${dryRun ? '[dry-run] ' : ''}${fromRel} -> ${toRel}`);
    if (!dryRun) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
    }
}

function main() {
    const dryRun = process.argv.includes('--dry-run');
    console.log(`Domain layout migration${dryRun ? ' (dry run)' : ''}`);
    for (const [from, to] of MOVES) {
        movePath(from, to, dryRun);
    }
    const usersFile = path.join(root, '.Users');
    if (fs.existsSync(usersFile) && !dryRun) {
        console.log('Splitting .Users into users/accounts/{role}/accounts.users');
        require('child_process').execSync('node users/scripts/split-users-file.js', {
            cwd: root,
            stdio: 'inherit',
        });
    } else if (fs.existsSync(usersFile)) {
        console.log('[dry-run] would split .Users via users/scripts/split-users-file.js');
    }
    console.log('Done.');
}

main();
