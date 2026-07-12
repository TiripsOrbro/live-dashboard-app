/**
 * PM2 - Live Sales Dashboard (Express + Macromatix scraper).
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup   # follow the printed command so it survives reboot
 *
 * Logs:  pm2 logs dashboard
 *
 * Memory caps come from .env (see .env.example / .env.server16gb.example):
 *   PM2_DASHBOARD_MAX_MEMORY
 *   PM2_REPORT_SCHEDULER_MAX_MEMORY
 *   PM2_FORECAST_SCHEDULER_MAX_MEMORY
 */
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;

function loadEnvFile(name) {
    const p = path.join(ROOT, name);
    if (!fs.existsSync(p)) return {};
    const out = {};
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
        ) {
            val = val.slice(1, -1);
        }
        out[key] = val;
    }
    return out;
}

// PM2 loads the same single `.env` as the app (Pi / Windows server / dev).
const env = {
    ...loadEnvFile('.env'),
    NODE_ENV: 'production',
};

module.exports = {
    apps: [
        {
            name: 'dashboard',
            cwd: ROOT,
            script: 'src/app.js',
            interpreter: 'node',
            autorestart: true,
            max_restarts: 100,
            min_uptime: '20s',
            restart_delay: 5000,
            // Leaked Chromium can grow over days; recycle before the host runs out.
            // Pi 4 (4GB): default 900M. Windows 16gb profile: 4G via .env.
            max_memory_restart: env.PM2_DASHBOARD_MAX_MEMORY || '900M',
            kill_timeout: 15000,
            env,
        },
        {
            name: 'report-download-scheduler',
            cwd: ROOT,
            script: 'scripts/run-report-download-scheduler.js',
            interpreter: 'node',
            autorestart: true,
            max_restarts: 50,
            min_uptime: '30s',
            restart_delay: 10000,
            max_memory_restart: env.PM2_REPORT_SCHEDULER_MAX_MEMORY || '400M',
            kill_timeout: 120000,
            env: {
                ...env,
                REPORT_DOWNLOAD_SCHEDULE_ENABLED: env.REPORT_DOWNLOAD_SCHEDULE_ENABLED || '1',
            },
        },
        {
            name: 'forecast-scheduler',
            cwd: ROOT,
            script: 'scripts/run-forecast-scheduler.js',
            interpreter: 'node',
            autorestart: true,
            max_restarts: 50,
            min_uptime: '30s',
            restart_delay: 10000,
            max_memory_restart: env.PM2_FORECAST_SCHEDULER_MAX_MEMORY || '500M',
            kill_timeout: 180000,
            env: {
                ...env,
                FORECAST_SCHEDULE_ENABLED: env.FORECAST_SCHEDULE_ENABLED || '1',
            },
        },
        {
            // Lightweight watcher — recycles the other apps once each morning before daily reports.
            name: 'morning-restart',
            cwd: ROOT,
            script: 'scripts/run-morning-restart.js',
            interpreter: 'node',
            autorestart: true,
            max_restarts: 50,
            min_uptime: '10s',
            restart_delay: 5000,
            max_memory_restart: env.PM2_MORNING_RESTART_MAX_MEMORY || '150M',
            kill_timeout: 10000,
            env: {
                ...env,
                MORNING_RESTART_ENABLED: env.MORNING_RESTART_ENABLED || '1',
            },
        },
    ],
};
