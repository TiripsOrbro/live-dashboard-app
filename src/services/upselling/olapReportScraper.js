const log = require('../mmxReports/util-logging');
const { loadPointsMap } = require('./pointsFile');
const { resolveUpsellSyncStore } = require('./upsellingConfig');
const { parseUpsellGrid } = require('./upsellReportParser');
const { waitForOlapReportReady, expandOlapCategories } = require('./olapReportExport');

/**
 * Build a 2D grid honoring rowspan/colspan (OLAP tables rely on this).
 */
function tableToGrid(table) {
    const grid = [];
    const occupied = new Set();

    const rows = Array.from(table.querySelectorAll('tr'));
    for (let r = 0; r < rows.length; r++) {
        if (!grid[r]) grid[r] = [];
        let c = 0;
        for (const cell of rows[r].querySelectorAll('th, td')) {
            while (occupied.has(`${r},${c}`)) c++;
            const text = (cell.textContent || '').replace(/\s+/g, ' ').trim();
            const rowspan = Math.max(1, parseInt(cell.getAttribute('rowspan') || '1', 10) || 1);
            const colspan = Math.max(1, parseInt(cell.getAttribute('colspan') || '1', 10) || 1);
            for (let dr = 0; dr < rowspan; dr++) {
                for (let dc = 0; dc < colspan; dc++) {
                    const rr = r + dr;
                    const cc = c + dc;
                    if (!grid[rr]) grid[rr] = [];
                    grid[rr][cc] = dr === 0 && dc === 0 ? text : '';
                    occupied.add(`${rr},${cc}`);
                }
            }
            c += colspan;
        }
    }
    return grid.filter((row) => row.some((cell) => String(cell || '').trim()));
}

function scoreOlapGrid(grid) {
    let hasCashierHeader = false;
    let fiscalHeader = false;
    let dayRows = 0;
    let cashierRows = 0;

    for (const row of grid) {
        for (let i = 0; i < row.length; i++) {
            const cell = String(row[i] || '').trim().toLowerCase();
            if (cell === 'cashier name') hasCashierHeader = true;
            if (cell === 'fiscal ypwd' || cell === 'fiscal ypwd multi-select') fiscalHeader = true;
        }
        const joined = row.join(' ').toLowerCase();
        if (joined.includes('mdx %') || joined.includes('initstars')) return 0;
        if (row.some((c) => /^\d{4}-\d{2}-\d{2}$/.test(String(c || '').trim()))) dayRows++;
        if (row.some((c) => String(c || '').trim() === 'Cashier Name')) continue;
        const nameCell = row.find((c) => {
            const s = String(c || '').trim();
            return s.length > 2 && /^[A-Z][A-Z\s'.-]+$/i.test(s) && !/^\d{4}-\d{2}-\d{2}$/.test(s);
        });
        if (nameCell && !/online\s*\d/i.test(nameCell) && !/^\d{4}\s/.test(nameCell)) cashierRows++;
    }

    if (!hasCashierHeader) return 0;
    return grid.length + dayRows * 5 + cashierRows * 3 + (fiscalHeader ? 50 : 0);
}

/**
 * Read the MdxView HTML grid into a 2D array (same shape as an Excel export).
 */
async function extractOlapGrid(page) {
    return page.evaluate(() => {
        function tableToGrid(table) {
            const grid = [];
            const occupied = new Set();
            const rows = Array.from(table.querySelectorAll('tr'));
            for (let r = 0; r < rows.length; r++) {
                if (!grid[r]) grid[r] = [];
                let c = 0;
                for (const cell of rows[r].querySelectorAll('th, td')) {
                    while (occupied.has(`${r},${c}`)) c++;
                    const text = (cell.textContent || '').replace(/\s+/g, ' ').trim();
                    const rowspan = Math.max(1, parseInt(cell.getAttribute('rowspan') || '1', 10) || 1);
                    const colspan = Math.max(1, parseInt(cell.getAttribute('colspan') || '1', 10) || 1);
                    for (let dr = 0; dr < rowspan; dr++) {
                        for (let dc = 0; dc < colspan; dc++) {
                            const rr = r + dr;
                            const cc = c + dc;
                            if (!grid[rr]) grid[rr] = [];
                            grid[rr][cc] = dr === 0 && dc === 0 ? text : '';
                            occupied.add(`${rr},${cc}`);
                        }
                    }
                    c += colspan;
                }
            }
            return grid.filter((row) => row.some((cell) => String(cell || '').trim()));
        }

        function scoreOlapGrid(grid) {
            let hasCashierHeader = false;
            let fiscalHeader = false;
            let dayRows = 0;
            for (const row of grid) {
                for (const cell of row) {
                    const t = String(cell || '').trim().toLowerCase();
                    if (t === 'cashier name') hasCashierHeader = true;
                    if (t.startsWith('fiscal ypwd')) fiscalHeader = true;
                }
                const joined = row.join(' ').toLowerCase();
                if (joined.includes('mdx %') || joined.includes('initstars')) return 0;
                if (row.some((c) => /^\d{4}-\d{2}-\d{2}$/.test(String(c || '').trim()))) dayRows++;
            }
            if (!hasCashierHeader) return 0;
            return grid.length + dayRows * 5 + (fiscalHeader ? 50 : 0);
        }

        const tables = Array.from(document.querySelectorAll('table'));
        let bestGrid = null;
        let bestScore = 0;

        for (const table of tables) {
            const grid = tableToGrid(table);
            const score = scoreOlapGrid(grid);
            if (score > bestScore) {
                bestGrid = grid;
                bestScore = score;
            }
        }

        return bestGrid;
    });
}

/**
 * Scrape Upsell by Cashier from the Business Intelligence OLAP table (MdxView).
 */
async function scrapeOlapUpsellReport(page, cfg = {}, syncStoreNumber = '') {
    const timeout = Number(cfg.reportReadyTimeoutMs) || 90000;

    log.info('[Upselling] Scraping BI table (MdxView)…');
    const ready = await waitForOlapReportReady(page, timeout);
    if (!ready) {
        log.warn('[Upselling] Table slow to load — scraping anyway');
    }

    await expandOlapCategories(page);
    await page.waitForTimeout(1200);

    const grid = await extractOlapGrid(page);
    if (!grid || grid.length < 2) {
        throw new Error('Could not find Upsell by Cashier data table on the page');
    }

    log.info(`[Upselling] Table rows scraped: ${grid.length}`);
    const syncStore = String(syncStoreNumber || resolveUpsellSyncStore() || '').trim();
    const { byLabel } = loadPointsMap(syncStore);
    const parsed = parseUpsellGrid(grid, byLabel, {
        filterStoreNumber: syncStore,
    });
    parsed.gridSample = grid.slice(0, 25);
    log.info(
        `[Upselling] Cashiers: ${parsed.cashiers.length}, columns: ${parsed.columnsUsed?.length || 0}, mode: ${parsed.scoringMode}, headerRow: ${parsed.headerRowIndex}`
    );
    return parsed;
}

module.exports = {
    tableToGrid,
    extractOlapGrid,
    scrapeOlapUpsellReport,
};

