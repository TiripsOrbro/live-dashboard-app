/** Retry after ASP.NET navigation destroys Puppeteer execution context. */
async function withPageContextRetry(page, label, fn) {
    const backoffMs = [450, 900, 1600];
    let lastErr;
    for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
        try {
            return await fn();
        } catch (e) {
            lastErr = e;
            const msg = String(e && e.message ? e.message : e);
            const retriable = /Execution context was destroyed|Target closed|Protocol error|most likely because of a navigation/i.test(
                msg
            );
            if (!retriable || attempt === backoffMs.length) {
                throw e;
            }
            console.warn(`[MMX] ${label}: context lost; retry ${attempt + 2}/${backoffMs.length + 1}`);
            await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(backoffMs[attempt]);
        }
    }
    throw lastErr;
}

module.exports = { withPageContextRetry };
