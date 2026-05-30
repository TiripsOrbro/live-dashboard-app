const { getStoreConfig } = require('./storeList');
const { getVendorCatalog } = require('./vendorCatalog');
const {
    getDraft,
    submitStockCount,
    markMmxSent,
    getMmxSentVendorSlugs,
    getSubmittedVendorSlugs,
    melbourneDateKey,
} = require('./stockCountState');
const { openMacromatixBrowser, closeBrowserQuietly, selectStoreOnPage } = require('./macromatixScraper');
const { enterVendorStockCount } = require('./mmxReports/mmx-stock-count');
const { downloadReportsForStores } = require('./mmxReportDownloader');
const { buildOrderLinesByVendorId } = require('./buildToOrderLines');
const { runVendorOrderEntry } = require('./mmxReports/pipeline-enter-vendor-orders');
const log = require('./mmxReports/util-logging');
const runLockByStore = new Map();

function storeSelectorLabel(store) {
    const num = String(store.storeNumber || '').trim();
    const name = String(store.storeName || '').trim();
    if (num && name) return `${num} ${name}`;
    return name || num;
}

async function withStoreLock(storeNumber, fn) {
    const key = String(storeNumber);
    const prev = runLockByStore.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    runLockByStore.set(key, prev.then(() => gate));
    await prev;
    try {
        return await fn();
    } finally {
        release();
        if (runLockByStore.get(key) === gate) runLockByStore.delete(key);
    }
}

async function shouldRunOrderPipeline(storeNumber, dateKey) {
    const submitted = await getSubmittedVendorSlugs(storeNumber, dateKey);
    if (!submitted.length) return false;
    const sent = await getMmxSentVendorSlugs(storeNumber, dateKey);
    return submitted.every((slug) => sent.includes(slug));
}

/**
 * Send one vendor's stock counts to Macromatix Key Item Count.
 * When all vendors for the store are sent for the day, download reports and enter scheduled orders.
 */
async function sendStockCountToMmx(storeNumber, vendorSlug, options = {}) {
    return withStoreLock(storeNumber, async () => {
        const dateKey = options.dateKey || melbourneDateKey();
        const catalog = getVendorCatalog(vendorSlug);
        if (!catalog) throw new Error(`Vendor catalog not found: ${vendorSlug}`);

        const draft = await getDraft(storeNumber, vendorSlug, dateKey);
        if (!draft?.locations || !Object.keys(draft.locations).length) {
            throw new Error('No stock count draft to send.');
        }

        const storeCfg = getStoreConfig(storeNumber) || { storeNumber, storeName: storeNumber };
        const storeLabel = storeSelectorLabel(storeCfg);

        let browser;
        let page;
        let stockCountResult;
        let orderPipelineResult = null;

        try {
            ({ browser, page } = await openMacromatixBrowser(options));

            const selectStore = async (p, num) => {
                const picked = await selectStoreOnPage(p, num);
                if (!picked) throw new Error(`Could not select store ${num} in Macromatix`);
                log.info(`Store selected: ${picked}`);
            };

            stockCountResult = await enterVendorStockCount(page, {
                storeNumber,
                catalog,
                draftLocations: draft.locations,
                navTimeoutMs: Number(process.env.MMX_NAV_TIMEOUT_MS || 45000),
                selectStore,
            });

            await submitStockCount(storeNumber, vendorSlug, dateKey);
            await markMmxSent(storeNumber, vendorSlug, dateKey);

            const runOrders = await shouldRunOrderPipeline(storeNumber, dateKey);

            if (runOrders) {
                log.info(`All vendor counts sent for store ${storeNumber} — running report download + order entry`);

                await downloadReportsForStores({
                    storeNumber,
                    page,
                    browser,
                });

                const { byVendorId, vendorOrdersCfg, buildTo } = await buildOrderLinesByVendorId(storeNumber, {
                    dateKey,
                });

                const settings = {
                    navTimeoutMs: Number(process.env.MMX_NAV_TIMEOUT_MS || 45000),
                    vendorOrders: vendorOrdersCfg,
                    storeNumber,
                    storeName: storeLabel,
                    storeContext: {
                        storeNumber,
                        storeName: storeLabel,
                        selectStore: async (p) => selectStore(p, storeNumber),
                    },
                    orderLinesByVendorId: byVendorId,
                };

                orderPipelineResult = await runVendorOrderEntry(page, settings, { continueOnError: true });
                orderPipelineResult.buildToSummary = {
                    orderLineCount: buildTo.orderLines.length,
                    totalCartons: buildTo.orderLines.reduce((s, l) => s + l.orderQty, 0),
                };
            }

            return {
                success: true,
                storeNumber: String(storeNumber),
                vendorSlug,
                dateKey,
                submittedAt: new Date().toISOString(),
                stockCount: stockCountResult,
                ordersRan: Boolean(orderPipelineResult),
                orders: orderPipelineResult,
            };
        } finally {
            if (!options.page) {
                await closeBrowserQuietly(browser, 'stock count MMX');
            }
        }
    });
}

module.exports = {
    sendStockCountToMmx,
    shouldRunOrderPipeline,
};
