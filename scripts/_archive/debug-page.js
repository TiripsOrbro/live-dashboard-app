const fs = require('fs');
const puppeteer = require('puppeteer');

const CANDIDATES = [
    process.env.SCRAPER_EXECUTABLE_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const executablePath = CANDIDATES.find((p) => fs.existsSync(p));

(async () => {
    let browser;
    try {
        browser = await puppeteer.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        page.on('pageerror', (err) => console.log('[pageerror]', err.message));
        const targetUrl = process.argv[2] || 'http://localhost:3000/3811';
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise((r) => setTimeout(r, 3500));
        console.log('--- target:', targetUrl);
        const metrics = await page.evaluate(() => {
            const dash = document.querySelector('.dashboard');
            const grid = document.querySelector('.dashboard-grid');
            const cs = getComputedStyle(document.documentElement);
            return {
                scale: cs.getPropertyValue('--dashboard-scale').trim(),
                bodyH: document.body.scrollHeight,
                dashRect: dash ? { w: Math.round(dash.getBoundingClientRect().width), h: Math.round(dash.getBoundingClientRect().height) } : null,
                gridRect: grid ? { w: Math.round(grid.getBoundingClientRect().width), h: Math.round(grid.getBoundingClientRect().height) } : null,
                gridCols: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : null,
            };
        });
        console.log('--- metrics:', JSON.stringify(metrics));
        const probe = await page.evaluate(() => {
            const el = document.createElement('div');
            el.style.width = 'calc(190px * var(--dashboard-scale))';
            el.style.position = 'absolute';
            document.body.appendChild(el);
            const w = el.getBoundingClientRect().width;
            el.remove();
            const grid = document.querySelector('.dashboard-grid');
            return { labelProbeW: w, gridTemplateColumns: grid ? getComputedStyle(grid).gridTemplateColumns : null };
        });
        console.log('--- probe:', JSON.stringify(probe));
        const fills = await page.evaluate(() => {
            const read = (el) => {
                if (!el) return null;
                const fill = el.querySelector('.grid-cell-live-main-fill');
                const solid = /cell-(green|orange|red)/.test(el.className) && !fill;
                return fill ? `fill ${fill.style.width}` : solid ? 'SOLID-FULL' : 'empty';
            };
            const cells = [...document.querySelectorAll('.meal-period-cell')];
            const liveHour = document.querySelector('.grid-cell--live-hour');
            return {
                lunch: read(cells[0]),
                dinner: read(cells[1]),
                currentHour: liveHour ? `fill ${liveHour.querySelector('.grid-cell-live-main-fill')?.style.width}` : '(none/solid)',
            };
        });
        console.log('--- fills:', JSON.stringify(fills));
        await page.screenshot({ path: 'scripts/dashboard-shot.png', fullPage: false });
        console.log('--- screenshot saved to scripts/dashboard-shot.png');
    } catch (e) {
        console.error('debug error:', e.message);
    } finally {
        if (browser) await browser.close();
    }
})();
