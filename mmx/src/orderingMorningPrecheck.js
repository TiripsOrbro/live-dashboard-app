const { getStoreList } = require('../../stores/src/storeList');
const { storeHasServiceCredentials } = require('../../stores/src/storeCredentials');
const { melbourneDateKey } = require('../../vendors/src/stockCountState');
const { resetSalesScrapeAbort } = require('../../dashboard/src/salesScrapeAbort');
const { openMacromatixBrowser, closeBrowserQuietly, probePendingOrdersForStores } = require('./macromatixScraper');
const {
    applyMorningPrecheckResults,
    morningPrecheckCompletedFor,
    markMorningPrecheckCompleted,
} = require('../../vendors/src/orderingDayState');
const { prefetchOrderingReportsForStore } = require('../../vendors/src/orderingReportPrefetch');
const { runWithPriority, PRIORITY } = require('./mmxTaskQueue');
const { resolveOrderDateKey, ymdToPickParts } = require('./scheduledReportDownload');

function resolveMorningPrecheckOrderDateKey(options = {}) {
    if (options.orderDateKey) return options.orderDateKey;
    if (options.orderDate) return resolveOrderDateKey(options.orderDate);
    const { loadVendorOrdersConfig } = require('../../vendors/src/vendorOrdersConfig');
    const cfg = loadVendorOrdersConfig();
    return resolveOrderDateKey(cfg.scheduledOrdersDate || 'tomorrow');
}

function morningPrecheckEnabled() {
    return !/^(0|false|no|off)$/i.test(String(process.env.ORDERING_MORNING_PRECHECK ?? '1').trim());
}

/** Per-store MMX logins need a store number to decrypt; pick any credentialed store to open the browser. */
function pickMorningPrecheckBootstrapStore(stores = []) {
    for (const store of stores) {
        const num = String(store?.storeNumber || '').trim();
        if (num && storeHasServiceCredentials(num, 'mmx')) return num;
    }
    return String(stores[0]?.storeNumber || '').trim();
}

/**
 * Morning ordering precheck: probe every store once, mark no-order stores done for the day,
 * prefetch ISE + on-order for stores that still need to place orders.
 */
async function runMorningOrderingPrecheck(options = {}) {
    if (!morningPrecheckEnabled()) {
        return { skipped: true, reason: 'disabled' };
    }

    const runDateKey = options.runDateKey || melbourneDateKey();
    const orderDateKey = resolveMorningPrecheckOrderDateKey(options);
    const pickYmd = ymdToPickParts(orderDateKey);

    if (!options.force && morningPrecheckCompletedFor(runDateKey)) {
        return { skipped: true, reason: 'already-ran-today', runDateKey, orderDateKey };
    }

    const stores = getStoreList();
    if (!stores.length) {
        throw new Error('No stores in .storelist');
    }

    const bootstrapStore =
        String(options.storeNumber || options.store || '').trim() || pickMorningPrecheckBootstrapStore(stores);
    if (!bootstrapStore || !storeHasServiceCredentials(bootstrapStore, 'mmx')) {
        console.warn(
            '[Ordering] Morning precheck skipped - no Macromatix store logins found. ' +
                'Configure in Admin → Setup Store Logins.'
        );
        return { skipped: true, reason: 'no-mmx-credentials', runDateKey, orderDateKey };
    }

    return runWithPriority(PRIORITY.MIC, {
        type: 'morning-ordering-precheck',
        label: `morning ordering precheck (${orderDateKey})`,
        run: async () => {
            let browser;
            let page;
            try {
                ({ browser, page } = await openMacromatixBrowser({ ...options, storeNumber: bootstrapStore }));
                // Preempt clears the cooperative abort flag for the old sales scrape; reset so our probes run.
                resetSalesScrapeAbort();
                const probe = await probePendingOrdersForStores(page, stores, { pickYmd });
                applyMorningPrecheckResults(runDateKey, probe);

                const withOrders = probe.filter((p) => p.hasOrders && (p.pendingVendors || []).length);
                const prefetchResults = [];

                for (const row of withOrders) {
                    try {
                        const result = await prefetchOrderingReportsForStore(row.storeNumber, {
                            ...options,
                            waitForIdle: true,
                        });
                        prefetchResults.push({ storeNumber: row.storeNumber, ...result });
                    } catch (err) {
                        prefetchResults.push({
                            storeNumber: row.storeNumber,
                            success: false,
                            error: err?.message || String(err),
                        });
                    }
                }

                markMorningPrecheckCompleted(runDateKey);

                const summary = {
                    runDateKey,
                    orderDateKey,
                    probed: probe,
                    storesWithOrders: withOrders.map((p) => ({
                        storeNumber: p.storeNumber,
                        storeName: p.storeName,
                        pendingVendors: p.pendingVendors,
                    })),
                    storesMarkedNoOrders: probe
                        .filter((p) => !p.hasOrders || !(p.pendingVendors || []).length)
                        .map((p) => p.storeNumber),
                    prefetchResults,
                };

                console.log(
                    `[Ordering] Morning precheck ${runDateKey}: ${withOrders.length} store(s) with orders, ` +
                        `${summary.storesMarkedNoOrders.length} marked no orders for the day`
                );

                return summary;
            } finally {
                await closeBrowserQuietly(browser, 'morning ordering precheck');
            }
        },
    });
}

module.exports = {
    morningPrecheckEnabled,
    runMorningOrderingPrecheck,
    resolveMorningPrecheckOrderDateKey,
};
