/**
 * Diagnose post-login area picker (default AshOwens).
 * Usage: node scripts/test-area-picker-ashowens.js [username] [password]
 * Env: ASHOWENS_PASSWORD, TEST_BASE_URL
 */
const http = require('http');
const puppeteer = require('puppeteer');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const USERNAME = process.argv[2] || 'AshOwens';
const PASSWORD =
    process.argv[3] ||
    process.env.ASHOWENS_PASSWORD ||
    (USERNAME === 'NicholasAntonello' ? 'changeme-admin-password' : '');

function httpLogin(username, password) {
    const body = JSON.stringify({ username, password, remember: false, mode: 'mic' });
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: 'localhost',
                port: 3000,
                path: '/login',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    resolve({
                        status: res.statusCode,
                        body: data,
                        cookies: res.headers['set-cookie'] || [],
                    });
                });
            }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function browserExecutable() {
    const candidates = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ].filter(Boolean);
    const fs = require('fs');
    return candidates.find((p) => fs.existsSync(p));
}

async function main() {
    if (!PASSWORD) {
        console.error(
            `No password for ${USERNAME}. Pass as 2nd arg or set ASHOWENS_PASSWORD.`
        );
        process.exit(1);
    }

    const login = await httpLogin(USERNAME, PASSWORD);
    console.log('Login:', login.status, login.body);
    if (login.status !== 200) {
        process.exit(1);
    }

    const execPath = browserExecutable();
    if (!execPath) {
        console.error('No Chrome/Edge found for Puppeteer.');
        process.exit(1);
    }

    const browser = await puppeteer.launch({
        headless: true,
        executablePath: execPath,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
        const page = await browser.newPage();
        page.on('console', (msg) => {
            const text = msg.text();
            if (/area|picker|MIC overview|welcome/i.test(text)) {
                console.log('[page]', msg.type(), text);
            }
        });
        page.on('pageerror', (err) => console.error('[pageerror]', err.message));

        const parsedCookies = login.cookies.map((raw) => {
            const [pair, ...attrs] = raw.split(';');
            const [name, value] = pair.split('=');
            const cookie = { name: name.trim(), value: value.trim(), url: BASE };
            for (const attr of attrs) {
                const [k, v] = attr.trim().split('=');
                if (k.toLowerCase() === 'httponly') cookie.httpOnly = true;
                if (k.toLowerCase() === 'secure') cookie.secure = true;
            }
            return cookie;
        });
        await page.setCookie(...parsedCookies);

        await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.evaluate(() => {
            try {
                sessionStorage.removeItem('mic-overview-area');
                sessionStorage.removeItem('admin-view-as-store-enabled');
                sessionStorage.removeItem('admin-view-as-store');
                localStorage.setItem(
                    'dashboard-welcome-shown',
                    new Date().toISOString().slice(0, 10)
                );
            } catch {
                /* ignore */
            }
        });

        await page.goto(`${BASE}/overview`, { waitUntil: 'networkidle2', timeout: 60000 });

        const diag = await page.evaluate(() => {
            const picker = document.getElementById('area-picker-stage');
            const welcome = document.getElementById('welcome-stage');
            const profile = window.__lastMeProfile || null;
            return {
                pathname: location.pathname,
                hasMicAreaPicker: Boolean(window.MicAreaPicker),
                hasMicOverviewMulti: Boolean(window.MicOverviewMulti),
                storedArea: (() => {
                    try {
                        return sessionStorage.getItem('mic-overview-area');
                    } catch {
                        return null;
                    }
                })(),
                pickerPresent: Boolean(picker),
                pickerVisible: picker
                    ? getComputedStyle(picker).opacity !== '0' && !picker.hidden
                    : false,
                pickerText: picker?.textContent?.replace(/\s+/g, ' ').trim() || '',
                pickerReady: picker?.classList.contains('area-picker-stage--ready') || false,
                welcomePresent: Boolean(welcome),
                welcomeHidden: welcome ? welcome.hidden : null,
                bodyClasses: document.body.className,
                shouldShow: window.MicAreaPicker?.shouldShowPicker
                    ? window.MicAreaPicker.shouldShowPicker(window.__testProfile)
                    : null,
                appShell: Boolean(window.__APP_SHELL__),
                inIframe: window !== window.top,
            };
        });

        const me = await page.evaluate(async () => {
            const res = await fetch('/api/me', { credentials: 'include' });
            return res.json();
        });

        const pickerLogic = await page.evaluate((p) => {
            if (!window.MicAreaPicker) return { error: 'MicAreaPicker missing' };
            const areas = window.MicAreaPicker.resolveInitialAreaNames(p, null);
            return {
                shouldShowPicker: window.MicAreaPicker.shouldShowPicker(p),
                resolveInitialAreaNames: areas,
                storedArea: window.MicAreaPicker.getStoredArea(),
            };
        }, me);

        console.log('\n--- Browser state ---');
        console.log(JSON.stringify(diag, null, 2));
        console.log('\n--- Picker logic (/api/me) ---');
        console.log(JSON.stringify(pickerLogic, null, 2));

        await new Promise((r) => setTimeout(r, 2500));

        const afterWait = await page.evaluate(() => {
            const picker = document.getElementById('area-picker-stage');
            return {
                pickerPresent: Boolean(picker),
                pickerText: picker?.textContent?.replace(/\s+/g, ' ').trim() || '',
                bodyClasses: document.body.className,
            };
        });
        console.log('\n--- After 2.5s ---');
        console.log(JSON.stringify(afterWait, null, 2));

        if (!afterWait.pickerPresent && pickerLogic.shouldShowPicker && pickerLogic.resolveInitialAreaNames?.length > 1) {
            console.error('\nFAIL: Picker should show but #area-picker-stage is missing.');
            process.exitCode = 1;
        } else if (afterWait.pickerPresent) {
            console.log('\nOK: Area picker is visible in DOM.');
        } else {
            console.log('\nNOTE: Picker not shown (may be expected if shouldShowPicker is false).');
        }
    } finally {
        await browser.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
