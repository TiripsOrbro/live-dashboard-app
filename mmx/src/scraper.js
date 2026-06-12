const scrapeMacromatix = require('./macromatixScraper');

/**
 * Macromatix hourly forecast and actual sales for the dashboard grid — one entry per store.
 */
async function scrapeData(options = {}) {
    const mm = await scrapeMacromatix(options);

    return {
        success: true,
        message: 'Macromatix',
        timestamp: mm.timestamp,
        stores: Array.isArray(mm.stores) ? mm.stores : [],
    };
}

module.exports = scrapeData;
