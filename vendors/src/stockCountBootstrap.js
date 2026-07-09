const { getVendorCatalog } = require('./vendorCatalog');
const { buildCombinedStockCountCatalog, isCombinedStockCountSlug } = require('./combinedStockCountCatalog');
const { getDraft, getStockCountQueueStatus, melbourneDateKey } = require('./stockCountState');
const { getStockCountPipelineStatus } = require('./stockCountMmxPipeline');

function pipelineNeedsSessionDismiss(pipeline) {
    if (!pipeline) return false;
    if (pipeline.sessionId) return true;
    const stage = String(pipeline.stage || 'idle');
    if (stage === 'prepared') return true;
    if (stage !== 'idle' && stage !== 'completed') return true;
    return false;
}

async function buildStockCountBootstrap(storeNumber, vendorSlug, options = {}) {
    const pendingVendorLabels = options.pendingVendorLabels || [];
    const combined = isCombinedStockCountSlug(vendorSlug);
    const dateKey = melbourneDateKey();

    let catalog = null;
    let vendorSlugs = [];
    let vendorCatalogs = null;
    let vendorDrafts = null;
    let draft = null;

    if (combined) {
        catalog = buildCombinedStockCountCatalog(pendingVendorLabels, storeNumber);
        vendorSlugs = catalog.vendorSlugs || [];
        if (!catalog.items.length) {
            return { success: false, error: 'No vendors need a stock count today.' };
        }
        vendorCatalogs = {};
        vendorDrafts = {};
        await Promise.all(
            vendorSlugs.map(async (slug) => {
                const cat = getVendorCatalog(slug, { forStockCount: true, storeNumber });
                if (cat) vendorCatalogs[slug] = cat;
                const vendorDraft = await getDraft(storeNumber, slug, dateKey);
                if (vendorDraft) vendorDrafts[slug] = vendorDraft;
            })
        );
    } else {
        catalog = getVendorCatalog(vendorSlug, { forStockCount: true, storeNumber });
        if (!catalog) {
            return { success: false, error: 'Vendor catalog not found.' };
        }
        draft = await getDraft(storeNumber, vendorSlug, dateKey);
        if (!draft) {
            return { success: false, error: 'Vendor catalog not found.' };
        }
    }

    const [queueStatus, pipeline] = await Promise.all([
        getStockCountQueueStatus(storeNumber, {
            vendorSlug,
            pendingVendorLabels,
            dateKey,
        }),
        getStockCountPipelineStatus(storeNumber, { light: true }),
    ]);

    return {
        success: true,
        catalog,
        vendorSlugs: combined ? vendorSlugs : undefined,
        vendorCatalogs: combined ? vendorCatalogs : undefined,
        vendorDrafts: combined ? vendorDrafts : undefined,
        draft: combined ? undefined : draft,
        queueStatus,
        pipeline,
        needsSessionDismiss: pipelineNeedsSessionDismiss(pipeline),
    };
}

module.exports = {
    buildStockCountBootstrap,
    pipelineNeedsSessionDismiss,
};
