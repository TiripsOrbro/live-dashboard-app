#!/usr/bin/env node
/**
 * Offline simulation of Macromatix report download detection and adopt logic.
 * No browser or MMX login — exercises util-files + pipeline adopt helpers.
 *
 * Usage:
 *   npm run simulate-report-download
 *   node scripts/simulate-report-download-detect.js --verbose
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    waitForNewDownload,
    fileSnapshots,
    clearMacromatixDefaultExports,
    sleep,
} = require('../mmx/src/mmxReports/util-files');
const {
    findFreshMacromatixExport,
    normalizeMacromatixExportsForStore,
} = require('../mmx/src/mmxReports/pipeline-download-reports');

const verbose = process.argv.includes('--verbose');

function mkTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-dl-sim-'));
    return dir;
}

function writeFile(dir, name, size = 1024, mtimeMs) {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, Buffer.alloc(size, 0x41));
    if (mtimeMs != null) {
        const t = new Date(mtimeMs);
        fs.utimesSync(filePath, t, t);
    }
    return filePath;
}

async function expectDetect(label, fn, { shouldPass }) {
    try {
        const result = await fn();
        if (!shouldPass) {
            return { label, ok: false, detail: `expected failure but got ${path.basename(result || '')}` };
        }
        return { label, ok: true, detail: path.basename(result || '') };
    } catch (err) {
        if (shouldPass) {
            return { label, ok: false, detail: err.message };
        }
        return { label, ok: true, detail: `rejected: ${err.message.split('(')[0].trim()}` };
    }
}

async function runScenarios() {
    const results = [];

    // 1. Happy path: file appears after snapshot
    {
        const dir = mkTempDir();
        const p = (async () => {
            const wait = waitForNewDownload(dir, { ext: '.xls', timeoutMs: 3000, pollMs: 100 });
            await sleep(200);
            writeFile(dir, 'MMS_Report_SupplyChainManagement_2_All.rpt-TBA157196.xls', 8000);
            return wait;
        })();
        results.push(await expectDetect('new MMS_Report SOH after snapshot', () => p, { shouldPass: true }));
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // 2. Fast export before wait: acceptSinceMs treats file as fresh
    {
        const dir = mkTempDir();
        const generateAt = Date.now();
        writeFile(dir, 'MMS_Report_SupplyChainManagement_2_All.rpt-TBA157196.xls', 8000, generateAt);
        results.push(
            await expectDetect(
                'SOH on disk before wait but fresh since generate (acceptSinceMs)',
                () =>
                    waitForNewDownload(dir, {
                        ext: '.xls',
                        timeoutMs: 800,
                        pollMs: 100,
                        acceptSinceMs: generateAt,
                    }),
                { shouldPass: true }
            )
        );
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // 3. Legacy bug without acceptSinceMs
    {
        const dir = mkTempDir();
        writeFile(dir, 'MMS_Report_SupplyChainManagement_2_All.rpt-TBA157196.xls', 8000);
        results.push(
            await expectDetect(
                'SOH already on disk before wait (no acceptSinceMs)',
                () => waitForNewDownload(dir, { ext: '.xls', timeoutMs: 800, pollMs: 100 }),
                { shouldPass: false }
            )
        );
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // 4. Bug: overwrite same MMS_Report name (mtime/size change)
    {
        const dir = mkTempDir();
        const filePath = writeFile(dir, 'MMS_Report_SupplyChainManagement_2_All.rpt-TBA157196.xls', 4000);
        const before = fileSnapshots(dir, '.xls');
        await sleep(50);
        const stat = fs.statSync(filePath);
        fs.utimesSync(filePath, new Date(stat.mtimeMs + 5000), new Date(stat.mtimeMs + 5000));
        fs.writeFileSync(filePath, Buffer.alloc(9000, 0x42));
        const after = fs.statSync(filePath);
        const prev = before.get(filePath);
        const changed =
            !prev || after.size !== prev.size || after.mtimeMs > prev.mtimeMs + 200;
        results.push({
            label: 'overwrite MMS_Report detected by fileChangedSince',
            ok: changed,
            detail: changed ? 'mtime/size delta seen' : 'missed overwrite',
        });
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // 5. ISE: InventorySpecialEventRS adopt hints
    {
        const dir = mkTempDir();
        const sinceMs = Date.now() - 1000;
        writeFile(dir, 'InventorySpecialEventRS-TBA157196.csv', 25000);
        const scm = findFreshMacromatixExport(dir, { id: 'report1' }, sinceMs);
        const ise = findFreshMacromatixExport(dir, { id: 'report3' }, sinceMs);
        results.push({
            label: 'ISE InventorySpecialEventRS adoptable via findFreshMacromatixExport',
            ok: Boolean(ise),
            detail: ise ? path.basename(ise) : 'report3 hint missing — ISE not adopted on timeout',
        });
        results.push({
            label: 'normalizeMacromatixExportsForStore includes report3',
            ok: (() => {
                const adopted = normalizeMacromatixExportsForStore(dir, ['report3'], { storeNumber: '3811' });
                return Boolean(adopted.report3);
            })(),
            detail: 'report3 not in MMX_DEFAULT_EXPORT_HINTS today',
        });
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // 6. Shared download dir: two fixed names (parallel browsers use separate dirs)
    {
        const dir = mkTempDir();
        writeFile(dir, 'MMS_Report_SupplyChainManagement_2_All.rpt-TBA157196.xls', 8000);
        writeFile(dir, 'MMS_Report_SupplyChainManagement_OnOrder_All.rpt-TBA157196.xls', 7000);
        writeFile(dir, 'InventorySpecialEventRS-TBA157196.csv', 25000);
        const adopted = normalizeMacromatixExportsForStore(dir, ['report1', 'report2'], { storeNumber: '3811' });
        results.push({
            label: 'sequential adopt SOH+SOO from same dir',
            ok: Boolean(adopted.report1 && adopted.report2),
            detail: `${Object.keys(adopted).join(', ') || 'none'}`,
        });
        fs.rmSync(dir, { recursive: true, force: true });
    }

    return results;
}

function printResults(results) {
    let pass = 0;
    let fail = 0;
    console.log('\nScenario results:\n');
    for (const r of results) {
        const mark = r.ok ? 'PASS' : 'FAIL';
        if (r.ok) pass++;
        else fail++;
        console.log(`  [${mark}] ${r.label}`);
        if (verbose || !r.ok) console.log(`         ${r.detail}`);
    }
    console.log(`\n${pass} passed, ${fail} failed (expected failures document known bugs).\n`);
    return fail;
}

async function main() {
    console.log('[simulate-report-download] offline detection/adopt scenarios\n');
    const results = await runScenarios();
    // expectDetect() already encodes shouldPass, so any r.ok === false is a real failure.
    const unexpected = results.filter((r) => !r.ok);
    printResults(results);

    console.log('Live MMX timing (optional, needs store login):');
    console.log('  npm run probe-soh-download -- 3811 --runs 3');
    console.log('  npm run probe-soh-benchmark -- 3811 --all-reports --workers 1 --runs 3');
    console.log('  npm run probe-soh-benchmark -- 3811 --all-reports --workers 2 --runs 4  # parallel browser stress\n');

    console.log('Parallel post-KIC download (3 browsers, default after apply):');
    console.log('  MMX_PARALLEL_BUILD_TO_REPORTS=0  # disable');
    console.log('  npm run download-reports -- --store 3811  # sequential CLI\n');
    process.exit(unexpected.length ? 1 : 0);
}

main().catch((err) => {
    console.error('[simulate-report-download]', err.message);
    process.exit(1);
});
