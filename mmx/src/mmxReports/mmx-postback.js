/**
 * ASP.NET / Macromatix postback helpers - prefer response + element waits over fixed sleeps.
 */

const DEFAULT_TIMEOUT_MS = Number(process.env.MMX_POSTBACK_TIMEOUT_MS || 15000);

function defaultUrlTest(res) {
    const u = res.url() || '';
    return /macromatix/i.test(u) && res.status() < 500;
}

function stockCountUrlTest(res) {
    const u = res.url() || '';
    return /stockcount|inventorycount/i.test(u) && res.status() < 500;
}

async function waitForAspPostback(page, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const urlTest = options.urlTest ?? defaultUrlTest;

    await Promise.race([
        page.waitForResponse((res) => urlTest(res), { timeout: timeoutMs }).catch(() => null),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => null),
    ]);

    if (options.waitForComplete !== false) {
        await page
            .waitForFunction(() => document.readyState === 'complete', {
                timeout: Math.min(timeoutMs, 10000),
                polling: 50,
            })
            .catch(() => {});
    }

    if (options.elementId) {
        await waitForVisibleElement(page, options.elementId, timeoutMs);
    }

}

async function waitForVisibleElement(page, elementId, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await page
        .waitForFunction(
            (id) => {
                const el = document.getElementById(id);
                return el && el.offsetParent !== null;
            },
            { timeout: timeoutMs, polling: 100 },
            elementId
        )
        .catch(() => {});
}

async function waitForEnabledButton(page, buttonId, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await page
        .waitForFunction(
            (id) => {
                const el = document.getElementById(id);
                return el && !el.disabled && el.offsetParent !== null;
            },
            { timeout: timeoutMs, polling: 100 },
            buttonId
        )
        .catch(() => {});
}

async function clickAndWaitForPostback(page, clickAction, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const urlTest = options.urlTest ?? defaultUrlTest;
    const skipNavigationWait = Boolean(options.skipNavigationWait);

    const waiters = [
        page.waitForResponse((res) => urlTest(res), { timeout: timeoutMs }).catch(() => null),
        clickAction(),
    ];
    if (!skipNavigationWait) {
        waiters.splice(
            1,
            0,
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => null)
        );
    }
    await Promise.all(waiters);

    if (!options.skipPostbackWait) {
        await waitForAspPostback(page, { ...options, timeoutMs, urlTest });
    }
}

async function waitForReportFormatControls(page, timeoutMs = 20000) {
    await page
        .waitForFunction(
            () => {
                for (const sel of document.querySelectorAll('select')) {
                    if (Array.from(sel.options).some((o) => /excel|csv|comma|format/i.test(o.textContent || ''))) {
                        return true;
                    }
                }
                return document.querySelectorAll('input[type="radio"]').length > 0;
            },
            { timeout: timeoutMs, polling: 100 }
        )
        .catch(() => {});
}

async function waitForScmReportList(page, timeoutMs = Number(process.env.MMX_REPORT_LIST_WAIT_MS || 8000)) {
    await page
        .waitForFunction(
            () => {
                for (const sel of document.querySelectorAll('select')) {
                    const label = ((sel.closest('tr, td') || sel).innerText || '').toLowerCase();
                    const hasScm = Array.from(sel.options).some((o) =>
                        /scm|items on hand|items on order/i.test(o.textContent || '')
                    );
                    if (label.includes('report') || hasScm) {
                        if (hasScm) return true;
                    }
                }
                return false;
            },
            { timeout: timeoutMs, polling: 100 }
        )
        .catch(() => {});
}

async function waitForReportSelectionPage(page, timeoutMs = 30000) {
    await page
        .waitForFunction(
            () => {
                for (const sel of document.querySelectorAll('select')) {
                    const label = ((sel.closest('tr, td') || sel).innerText || '').toLowerCase();
                    if (label.includes('group')) return true;
                    if (Array.from(sel.options).some((o) => /supply chain/i.test(o.textContent || ''))) {
                        return true;
                    }
                }
                return false;
            },
            { timeout: timeoutMs, polling: 100 }
        )
        .catch(() => {});
}

module.exports = {
    DEFAULT_TIMEOUT_MS,
    defaultUrlTest,
    stockCountUrlTest,
    waitForAspPostback,
    waitForVisibleElement,
    waitForEnabledButton,
    clickAndWaitForPostback,
    waitForReportFormatControls,
    waitForScmReportList,
    waitForReportSelectionPage,
};
