#!/usr/bin/env node
/**
 * Probe dashboard login -> welcome -> reveal timing (headless).
 * Usage: node scripts/probe-dashboard-login-timing.js
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const puppeteer = require('puppeteer');

function resolveExecutable() {
    if (process.env.SCRAPER_EXECUTABLE_PATH && fs.existsSync(process.env.SCRAPER_EXECUTABLE_PATH)) {
        return process.env.SCRAPER_EXECUTABLE_PATH;
    }
    if (process.platform === 'win32') {
        const candidates = [
            'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
            'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
            'C:/Program Files/Google/Chrome/Application/chrome.exe',
            'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        ];
        return candidates.find((p) => fs.existsSync(p));
    }
    return undefined;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const MILESTONE_EVAL = () => {
    const body = document.body;
    const welcomeStage = document.getElementById('welcome-stage');
    const iframe = document.getElementById('dashboard-preload');

    let dashDoc = document;
    try {
        const iframeDoc = iframe?.contentDocument;
        if (iframeDoc?.body) dashDoc = iframeDoc;
    } catch {
        /* ignore */
    }

    const welcomeVisible = Boolean(welcomeStage?.classList.contains('welcome-stage--visible'));

    const dashboardReveal = Boolean(
        body.classList.contains('login-body--dashboard-reveal') ||
            (iframe &&
                !iframe.hasAttribute('hidden') &&
                iframe.classList.contains('dashboard-preload--active'))
    );

    const welcomeHiddenAfterWelcome = Boolean(
        dashboardReveal ||
            (welcomeVisible === false &&
                welcomeStage &&
                welcomeStage.hidden === true &&
                !welcomeStage.classList.contains('welcome-stage--visible'))
    );

    const grid = dashDoc.querySelector('.dashboard-grid');
    const gridReady = Boolean(
        grid &&
            !grid.querySelector('.dashboard-grid-loading') &&
            !dashDoc.querySelector('.grid-error')
    );

    const lastUpdatedEl = dashDoc.getElementById('last-updated');
    const lastText = (lastUpdatedEl?.textContent || '').trim();
    const salesUpdated = lastText.length > 0;

    const salesStatusEl = dashDoc.getElementById('sales-status');
    let salesStatus = null;
    if (salesStatusEl && !salesStatusEl.hidden) {
        const t = (salesStatusEl.textContent || '').trim();
        salesStatus = t || null;
    }

    return {
        t: Date.now(),
        welcomeVisible,
        welcomeHiddenAfterWelcome,
        dashboardReveal,
        gridReady,
        salesUpdated,
        salesStatus,
        lastUpdatedText: lastText || null,
        iframeSrc: iframe?.src || null,
        dashPath: (() => {
            try {
                return dashDoc.location?.pathname || null;
            } catch {
                return null;
            }
        })(),
    };
};

function trackNetwork(page, network) {
    const requestStarts = new Map();
    page.on('request', (req) => {
        const url = req.url();
        const method = req.method();
        let pathname = '';
        try {
            pathname = new URL(url).pathname;
        } catch {
            return;
        }
        const trackSales = pathname.includes('/api/sales');
        const trackLogin = method === 'POST' && pathname === '/login';
        if (trackSales || trackLogin) {
            requestStarts.set(req, { url, method, start: Date.now() });
        }
    });
    page.on('response', (res) => {
        const req = res.request();
        const meta = requestStarts.get(req);
        if (!meta) return;
        requestStarts.delete(req);
        network.push({
            url: meta.url,
            method: meta.method,
            status: res.status(),
            durationMs: Date.now() - meta.start,
        });
    });
}

async function readMilestones(page) {
    const main = await page.evaluate(MILESTONE_EVAL);
    for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        try {
            const inFrame = await frame.evaluate(MILESTONE_EVAL);
            if (inFrame.gridReady && !main.gridReady) main.gridReady = true;
            if (inFrame.salesUpdated && !main.salesUpdated) {
                main.salesUpdated = true;
                main.lastUpdatedText = inFrame.lastUpdatedText;
            }
            if (inFrame.salesStatus != null && main.salesStatus == null) {
                main.salesStatus = inFrame.salesStatus;
            }
            if (inFrame.dashPath && !main.dashPath) main.dashPath = inFrame.dashPath;
        } catch {
            /* ignore detached frames */
        }
    }
    return main;
}

async function main() {
    const username = process.env.TempDashboardU;
    const password = process.env.TempDashboardP;
    if (!username || !password) {
        console.error(JSON.stringify({ error: 'Missing TempDashboardU or TempDashboardP in .env' }));
        process.exit(1);
    }

    const executablePath = resolveExecutable();
    const browser = await puppeteer.launch({
        headless: true,
        executablePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    const network = [];
    trackNetwork(page, network);

    const errors = [];
    const milestones = {};
    let loginSubmit = null;
    let salesStatusCaptured = null;
    let endSnap = null;

    try {
        await page.goto('http://localhost:3000/login', {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });

        await page.waitForSelector('#login-form', { timeout: 15000 });

        await page.evaluate(() => {
            try {
                localStorage.removeItem('dashboard-welcome-shown');
            } catch {
                /* ignore */
            }
        });

        await page.type('#login-username', username, { delay: 0 });
        await page.type('#login-password', password, { delay: 0 });

        loginSubmit = await page.evaluate(() => Date.now());

        await Promise.all([
            page.click('#login-submit'),
            page
                .waitForFunction(
                    () =>
                        document.getElementById('welcome-stage')?.classList.contains('welcome-stage--visible') ||
                        document.body.classList.contains('login-body--dashboard-reveal'),
                    { timeout: 60000 }
                )
                .catch(() => {}),
        ]);

        const deadline = loginSubmit + 60000;
        while (Date.now() < deadline) {
            const snap = await readMilestones(page);
            const rel = (key) => {
                if (milestones[key] != null) return;
                milestones[key] = snap.t;
            };

            if (snap.welcomeVisible) rel('welcomeVisible');
            if (
                milestones.welcomeVisible != null &&
                (snap.welcomeHiddenAfterWelcome || snap.dashboardReveal)
            ) {
                rel('welcomeHidden');
            }
            if (snap.dashboardReveal) rel('dashboardReveal');
            if (snap.gridReady) rel('gridReady');
            if (snap.salesUpdated) rel('salesUpdated');
            if (snap.salesStatus != null && salesStatusCaptured == null) {
                salesStatusCaptured = snap.salesStatus;
            }

            const allDone =
                milestones.welcomeVisible != null &&
                milestones.welcomeHidden != null &&
                milestones.dashboardReveal != null &&
                milestones.gridReady != null &&
                milestones.salesUpdated != null;

            if (allDone) break;
            await sleep(100);
        }

        milestones.loginSubmit = loginSubmit;
        endSnap = await readMilestones(page);
        if (salesStatusCaptured != null) {
            milestones.salesStatusText = salesStatusCaptured;
        } else if (endSnap.salesStatus != null) {
            milestones.salesStatusText = debug.salesStatus;
        }
    } catch (err) {
        errors.push(String(err && err.stack ? err.stack : err));
    } finally {
        await browser.close();
    }

    const keys = [
        'loginSubmit',
        'welcomeVisible',
        'welcomeHidden',
        'dashboardReveal',
        'gridReady',
        'salesUpdated',
    ];
    const deltas = {};
    const base = milestones.loginSubmit;
    for (const key of keys) {
        if (milestones[key] != null && base != null) {
            deltas[`${key}Ms`] = milestones[key] - base;
        } else {
            deltas[`${key}Ms`] = null;
        }
    }
    const pairwise = {};
    for (let i = 1; i < keys.length; i++) {
        const a = keys[i - 1];
        const b = keys[i];
        if (milestones[a] != null && milestones[b] != null) {
            pairwise[`${a}_to_${b}`] = milestones[b] - milestones[a];
        }
    }

    const summary = {
        ok: errors.length === 0 && milestones.loginSubmit != null,
        executablePath: executablePath || 'puppeteer-bundled',
        milestones,
        deltasFromLoginSubmit: deltas,
        deltasBetweenMilestones: pairwise,
        salesStatus: milestones.salesStatusText ?? null,
        network,
        loginIframePath: endSnap?.dashPath ?? null,
        errors,
    };

    console.log(JSON.stringify(summary, null, 2));
    if (errors.length) process.exit(1);
}

main().catch((e) => {
    console.error(JSON.stringify({ fatal: String(e && e.stack ? e.stack : e) }));
    process.exit(1);
});
