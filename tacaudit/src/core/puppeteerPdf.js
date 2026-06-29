const puppeteer = require('puppeteer');
const { getPuppeteerLaunchOptions } = require('../../../mmx/src/macromatixScraper');

/** Launch headless Chromium for TacAudit PDF generation (uses SCRAPER_EXECUTABLE_PATH on Pi). */
function launchPdfBrowser() {
    return puppeteer.launch(
        getPuppeteerLaunchOptions({ headless: true, skipSlowMo: true })
    );
}

module.exports = { launchPdfBrowser };
