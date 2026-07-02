#!/usr/bin/env node
/**
 * Read-only: scrape MMX scheduled order grids for item code/name matches.
 *
 * Usage:
 *   node scripts/probe-order-item-codes.js 3811 caramel
 *   node scripts/probe-order-item-codes.js 3811 caramel --vendor americold-frg
 */
const path = require('path');
require('../src/loadEnv').loadEnv();
require('./load-project-env');

const { openMacromatixBrowser, closeBrowserQuietly } = require('../mmx/src/macromatixScraper');
const {
    openScheduledOrders,
    clickCreateForVendorRow,
    returnToScheduledOrders,
} = require('../mmx/src/mmxReports/mmx-scheduled-orders');
const {
    scrapeOrderGridByItemCode,
    waitForOrderItemsGrid,
} = require('../mmx/src/mmxReports/pipeline-enter-vendor-orders');
const vendorOrdersCfg = require('../vendors/config/vendor-orders.json');
const { allLookupKeys } = require('../vendors/src/itemCodes');

function parseArgs(argv) {
    const args = argv.slice(2);
    const storeNumber = args.find((a) => /^\d{4}$/.test(a)) || '3811';
    const nonFlags = args.filter((a) => !a.startsWith('--'));
    const matchText = nonFlags.find((a) => a !== storeNumber) || 'caramel';
    const vendorIdx = args.indexOf('--vendor');
    const vendorId = vendorIdx >= 0 ? String(args[vendorIdx + 1] || '').trim() : '';
    return { storeNumber, matchText, vendorId };
}

async function openOrderDetailTab(page) {
    const currentUrl = page.url();
    const detailUrl = currentUrl.replace(/Action=[^&]+/i, 'Action=ShowDetail');
    if (detailUrl !== currentUrl) {
        await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(2000).catch(() => {});
    }

    const clicked = await page.evaluate(() => {
        const tabs = [...document.querySelectorAll('a, input[type="button"], button, span')];
        for (const el of tabs) {
            const label = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (label !== 'detail') continue;
            const ctx = ((el.closest('table, tr, div') || el.parentElement)?.innerText || '').toLowerCase();
            if (ctx.includes('receive') && ctx.includes('header')) {
                el.click();
                return 'detail-tab';
            }
        }
        return null;
    });
    if (clicked) {
        await page.waitForTimeout(2500).catch(() => {});
        try {
            await waitForOrderItemsGrid(page, 30000);
        } catch (err) {
            console.warn(`[probe-order-item-codes] detail tab wait: ${err.message}`);
        }
    }
    return clicked || (detailUrl !== currentUrl ? 'showdetail-url' : null);
}

async function probeVendor(page, vendor, matchRe, storeNumber) {
    await clickCreateForVendorRow(page, vendor);
    try {
        await waitForOrderItemsGrid(page, Number(process.env.MMX_ORDER_GRID_WAIT_MS || 60000));
    } catch (err) {
        console.warn(`[probe-order-item-codes] grid wait: ${err.message}`);
        const detailTab = await openOrderDetailTab(page);
        if (detailTab) console.warn(`[probe-order-item-codes] opened tab: ${detailTab}`);
        const clickedItems = await page.evaluate(() => {
            for (const a of document.querySelectorAll('a, input[type="button"], button')) {
                const label = (a.textContent || a.value || '').replace(/\s+/g, ' ').trim().toLowerCase();
                if (
                    label === 'items' ||
                    label.includes('order items') ||
                    label.includes('show items') ||
                    label.includes('order lines')
                ) {
                    a.click();
                    return label;
                }
            }
            return null;
        });
        if (clickedItems) {
            console.warn(`[probe-order-item-codes] clicked secondary nav: ${clickedItems}`);
            await page.waitForTimeout(3000).catch(() => {});
            try {
                await waitForOrderItemsGrid(page, 30000);
            } catch (retryErr) {
                console.warn(`[probe-order-item-codes] grid wait after nav: ${retryErr.message}`);
            }
        }
    }
    const grid = await scrapeOrderGridByItemCode(page);
    const pageMeta = await page.evaluate((matchText) => {
        const body = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
        const re = new RegExp(matchText, 'i');
        const lines = body
            .split(/\n/)
            .map((line) => line.trim())
            .filter((line) => re.test(line));
        const links = [...document.querySelectorAll('a')]
            .map((a) => (a.textContent || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .slice(0, 40);
        return {
            url: location.href,
            title: document.title,
            matchingLines: lines.slice(0, 20),
            links,
            hasItemsInOrderText: /items in this order/i.test(body),
            textInputs: document.querySelectorAll('input[type="text"]').length,
        };
    }, matchRe.source);
    const hits = (grid.rows || []).filter((row) =>
        matchRe.test(`${row.itemCode || ''} ${row.itemName || ''}`)
    );
    return {
        vendor: vendor.label,
        vendorId: vendor.id,
        page: pageMeta,
        totalRows: grid.rows?.length || 0,
        tableFound: Boolean(grid.tableFound),
        hits: hits.map((row) => ({
            itemCode: row.itemCode,
            itemName: row.itemName,
            quantity: row.quantity,
        })),
    };
}

async function main() {
    const { storeNumber, matchText, vendorId } = parseArgs(process.argv);
    const matchRe = new RegExp(matchText, 'i');
    const targets = (vendorOrdersCfg.vendors || []).filter((vendor) => {
        if (vendorId) return vendor.id === vendorId;
        return /^americold-/.test(vendor.id);
    });
    if (!targets.length) {
        throw new Error(vendorId ? `Unknown vendor id: ${vendorId}` : 'No Americold vendors configured');
    }

    const { browser, page } = await openMacromatixBrowser({
        storeNumber,
        headless: !process.argv.includes('--headed'),
    });
    const orderForms = [];
    try {
        await openScheduledOrders(
            page,
            vendorOrdersCfg.scheduledOrdersUrl,
            Number(process.env.MMX_NAV_TIMEOUT_MS || 45000),
            vendorOrdersCfg,
            { storeNumber }
        );
        for (let i = 0; i < targets.length; i++) {
            if (i > 0) {
                await returnToScheduledOrders(
                    page,
                    vendorOrdersCfg,
                    Number(process.env.MMX_NAV_TIMEOUT_MS || 45000),
                    { storeNumber }
                );
            }
            orderForms.push(await probeVendor(page, targets[i], matchRe, storeNumber));
        }
    } finally {
        await closeBrowserQuietly(browser, 'probe-order-item-codes');
    }

    console.log(
        JSON.stringify(
            {
                store: storeNumber,
                match: matchText,
                configuredLookupKeys: {
                    '106191': allLookupKeys('106191'),
                    '106251': allLookupKeys('106251'),
                },
                orderForms,
            },
            null,
            2
        )
    );
}

main().catch((err) => {
    console.error('[probe-order-item-codes]', err.message);
    process.exit(1);
});
