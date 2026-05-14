const scrapeMacromatix = require('./macromatixScraper');

/**
 * Macromatix hourly forecast and actual sales for the dashboard grid.
 */
async function scrapeData(options = {}) {
    const mm = await scrapeMacromatix(options);

    return {
        success: true,
        message: 'Macromatix',
        actual: mm.actual,
        forecast: mm.forecast,
        timestamp: mm.timestamp,
        pendingVendors: Array.isArray(mm.pendingVendors) ? mm.pendingVendors : [],
    };
}

module.exports = scrapeData;
