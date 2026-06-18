const { buildDailyStockCountCatalog } = require('./dailyStockCountCatalog');
const { getDraft } = require('./dailyStockCountState');
const { getDailyCountPipelineStatus } = require('./dailyStockCountMmxPipeline');

function buildDailyStockCountTileState(storeNumber) {
    const store = String(storeNumber || '').trim();
    const catalog = buildDailyStockCountCatalog(store);
    const href = catalog && store ? `/${store}/daily-stock-count` : null;

    return {
        configured: Boolean(catalog),
        clickable: Boolean(href),
        href,
        message: catalog ? 'Open daily count' : 'No daily items tagged yet',
    };
}

async function enrichDailyStockCountTileState(base, storeNumber) {
    if (!base.configured) return base;

    const draft = await getDraft(storeNumber);
    const pipeline = await getDailyCountPipelineStatus(storeNumber);
    let sub = 'Enter counts by location';

    if (pipeline.stage === 'prepared' && pipeline.redVarianceCount > 0) {
        sub = `${pipeline.redVarianceCount} variance${pipeline.redVarianceCount === 1 ? '' : 's'} to review`;
    } else if (pipeline.inProgress) {
        sub = pipeline.stepLabel || 'Sending to Macromatix…';
    } else if (draft?.mmxSentAt) {
        sub = 'Completed today';
    } else if (draft?.submittedAt) {
        sub = 'Submitted - open to continue';
    }

    return { ...base, sub, draft, pipeline };
}

async function buildDailyStockCountTileStateAsync(storeNumber) {
    const base = buildDailyStockCountTileState(storeNumber);
    return enrichDailyStockCountTileState(base, storeNumber);
}

function buildAreaDailyStockCountTileState(areaStores) {
    const catalog = buildDailyStockCountCatalog(areaStores?.[0]);
    const stores = (areaStores || [])
        .map((cfg) => String(cfg.storeNumber || '').trim())
        .filter(Boolean);
    if (!catalog) {
        return {
            configured: false,
            clickable: false,
            message: 'No daily items tagged yet',
        };
    }
    const first = stores[0] || '';
    return {
        configured: true,
        clickable: Boolean(first),
        href: first ? `/${first}/daily-stock-count` : '/daily-stock-count',
        pickStoreOnPage: stores.length > 1,
        storeNumbers: stores,
        message: 'Open daily count',
        sub:
            stores.length > 1
                ? `${stores.length} stores - select store to count`
                : 'Enter counts by location',
    };
}

async function buildAreaDailyStockCountTileStateAsync(areaStores) {
    const base = buildAreaDailyStockCountTileState(areaStores);
    if (!base.configured || !base.storeNumbers?.length) return base;

    let inProgress = 0;
    let completed = 0;
    let needsReview = 0;
    for (const storeNumber of base.storeNumbers) {
        const draft = await getDraft(storeNumber);
        const pipeline = await getDailyCountPipelineStatus(storeNumber);
        if (pipeline.inProgress) inProgress += 1;
        else if (draft?.mmxSentAt) completed += 1;
        else if (pipeline.stage === 'prepared' && pipeline.redVarianceCount > 0) needsReview += 1;
    }

    let sub = base.sub;
    if (needsReview) {
        sub = `${needsReview} store${needsReview === 1 ? '' : 's'} with variances to review`;
    } else if (inProgress) {
        sub = `${inProgress} store${inProgress === 1 ? '' : 's'} sending to Macromatix`;
    } else if (completed === base.storeNumbers.length) {
        sub = 'Completed today for all stores';
    } else if (completed) {
        sub = `${completed}/${base.storeNumbers.length} stores completed today`;
    }

    return { ...base, sub };
}

module.exports = {
    buildDailyStockCountTileState,
    buildDailyStockCountTileStateAsync,
    enrichDailyStockCountTileState,
    buildAreaDailyStockCountTileState,
    buildAreaDailyStockCountTileStateAsync,
};
