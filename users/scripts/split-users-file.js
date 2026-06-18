#!/usr/bin/env node
/**
 * Split a legacy root `.Users` file into per-role files under users/accounts/{role}/accounts.users
 *
 * Usage: node users/scripts/split-users-file.js [--source path/to/.Users] [--dry-run]
 */
const fs = require('fs');
const path = require('path');

require('../../src/loadEnv').loadEnv();
const paths = require('../../src/paths');
const {
    parseUsersFileBlocks,
    serializeUsersFile,
    normalizeAccountLevel,
    inferAccountLevel,
} = require('../src/core/dashboardUsers');

const LEVEL_TO_ROLE_FOLDER = {
    it: 'admins',
    market: 'admins',
    area: 'area-coaches',
    store: 'stores',
    manager: 'managers',
    mic: 'mics',
    tm: 'tms',
};

const ROLE_FOLDER_ORDER = ['admins', 'area-coaches', 'stores', 'managers', 'mics', 'tms'];

function roleFolderForBlock(block) {
    const level = normalizeAccountLevel(block?.accountLevel) || inferAccountLevel(block || {});
    return LEVEL_TO_ROLE_FOLDER[level] || 'stores';
}

function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const sourceIdx = args.indexOf('--source');
    const sourcePath =
        sourceIdx >= 0 && args[sourceIdx + 1]
            ? path.resolve(args[sourceIdx + 1])
            : path.join(paths.root, '.Users');

    if (!fs.existsSync(sourcePath)) {
        console.error(`Source file not found: ${sourcePath}`);
        process.exit(1);
    }

    const text = fs.readFileSync(sourcePath, 'utf8');
    const blocks = parseUsersFileBlocks(text);
    const byRole = Object.fromEntries(ROLE_FOLDER_ORDER.map((role) => [role, []]));

    for (const block of blocks) {
        byRole[roleFolderForBlock(block)].push(block);
    }

    for (const role of ROLE_FOLDER_ORDER) {
        const outDir = path.join(paths.users.accounts, role);
        const outPath = path.join(outDir, 'accounts.users');
        const content = serializeUsersFile(byRole[role] || []);
        console.log(`${role}: ${byRole[role].length} account(s) -> ${outPath}`);
        if (!dryRun) {
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(outPath, content, 'utf8');
        }
    }

    if (!dryRun) {
        console.log(`Split complete from ${sourcePath}`);
    } else {
        console.log('Dry run - no files written.');
    }
}

main();
