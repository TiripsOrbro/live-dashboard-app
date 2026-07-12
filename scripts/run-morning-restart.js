#!/usr/bin/env node
/**
 * Morning recycle — restart dashboard + schedulers once per day before daily reports.
 *
 * Why a separate PM2 process: if the dashboard has leaked Chromium / RAM overnight,
 * a tiny watcher can still recycle it. Runs before FIVE_AM_REPORTS_HOUR (default 6 AM
 * when reports are at 7).
 *
 * Env:
 *   MORNING_RESTART_ENABLED=1          (default on)
 *   MORNING_RESTART_HOUR=6             (default: reports hour − 1)
 *   FIVE_AM_REPORTS_HOUR=7
 *   MORNING_RESTART_TARGETS=dashboard,report-download-scheduler,forecast-scheduler
 *   MORNING_RESTART_CHECK_MS=60000
 */
require('../src/loadEnv').loadEnv();

const { spawn } = require('child_process');
const {
    TIME_ZONE,
    melbourneDateKey,
    restartHour,
    reportsHour,
    isMorningRestartEnabled,
    restartTargets,
    shouldMorningRestart,
    markMorningRestartComplete,
} = require('../dashboard/src/morningRestart');

const CHECK_MS = Math.max(
    30_000,
    Number(process.env.MORNING_RESTART_CHECK_MS || 60_000) || 60_000
);

let inFlight = false;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function runPm2(args) {
    return new Promise((resolve, reject) => {
        const child = spawn('pm2', args, {
            shell: true,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => {
            stdout += String(chunk);
        });
        child.stderr?.on('data', (chunk) => {
            stderr += String(chunk);
        });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
                return;
            }
            const err = new Error(`pm2 ${args.join(' ')} exited ${code}`);
            err.stdout = stdout;
            err.stderr = stderr;
            reject(err);
        });
    });
}

async function performMorningRestart() {
    const dateKey = melbourneDateKey();
    const targets = restartTargets();
    console.info(
        `[MorningRestart] ${dateKey} ${TIME_ZONE}: recycling ${targets.join(', ')} before daily reports (hour ${restartHour()} → reports ${reportsHour()})`
    );

    // Mark first so overlapping checks do not double-fire while pm2 runs.
    markMorningRestartComplete(dateKey, {
        targets,
        restartHour: restartHour(),
        reportsHour: reportsHour(),
        status: 'started',
    });

    try {
        await runPm2(['restart', ...targets, '--update-env']);
        markMorningRestartComplete(dateKey, {
            targets,
            restartHour: restartHour(),
            reportsHour: reportsHour(),
            status: 'ok',
        });
        console.info(`[MorningRestart] Restart complete for ${dateKey}`);
    } catch (err) {
        markMorningRestartComplete(dateKey, {
            targets,
            restartHour: restartHour(),
            reportsHour: reportsHour(),
            status: 'error',
            error: err.message || String(err),
            stderr: err.stderr || '',
        });
        console.error('[MorningRestart] pm2 restart failed:', err.message || err);
        if (err.stderr) console.error(err.stderr);
    }
}

async function tick() {
    if (inFlight) return;
    if (!isMorningRestartEnabled()) return;
    if (!shouldMorningRestart()) return;
    inFlight = true;
    try {
        await performMorningRestart();
    } finally {
        inFlight = false;
    }
}

async function main() {
    if (!isMorningRestartEnabled()) {
        console.warn(
            '[MorningRestart] Disabled (MORNING_RESTART_ENABLED=0). Sleeping — set to 1 and restart this process to enable.'
        );
        for (;;) await sleep(60 * 60 * 1000);
    }

    console.info(
        `[MorningRestart] Watching ${TIME_ZONE}: restart at hour ${restartHour()}, daily reports at ${reportsHour()}, check every ${Math.round(CHECK_MS / 1000)}s`
    );

    await tick();
    setInterval(() => void tick(), CHECK_MS);
}

main().catch((err) => {
    console.error('[MorningRestart] Fatal:', err);
    process.exit(1);
});
