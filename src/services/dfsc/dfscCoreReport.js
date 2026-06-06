const fs = require('fs');
const puppeteer = require('puppeteer');
const { buildSimplePdf } = require('./dfscReport');
const { buildCoreReportData } = require('./dfscStore');

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatDateKey(dateKey) {
    const parsed = Date.parse(`${dateKey}T12:00:00`);
    if (!Number.isFinite(parsed)) return dateKey || '—';
    return new Date(parsed).toLocaleDateString('en-AU', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    });
}

function formatDateTime(iso) {
    if (!iso) return '—';
    const parsed = Date.parse(iso);
    if (!Number.isFinite(parsed)) return iso;
    return new Date(parsed).toLocaleString('en-AU', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    });
}

function buildCoreReportFilename(data) {
    const parsed = Date.parse(data.generatedAt || '');
    const date = Number.isFinite(parsed) ? new Date(parsed) : new Date();
    const day = date.getDate();
    const month = date.toLocaleString('en-AU', { month: 'short' });
    const year = date.getFullYear();
    const storeSlug = String(data.storeName || data.storeNumber || 'Store')
        .replace(/^TB\s+/i, '')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-');
    return `${day}-${month}-${year}-CORE-DFSC-${storeSlug || 'Store'}.pdf`;
}

function buildCoreReportHtml(data) {
    const dailyRows = (data.dailyCompletion || [])
        .map(
            (row) => `
        <tr>
            <td>${escapeHtml(formatDateKey(row.dateKey))}</td>
            <td class="num">${row.am ? escapeHtml(String(row.am)) : '—'}</td>
            <td class="num">${row.pm ? escapeHtml(String(row.pm)) : '—'}</td>
            <td class="num"><strong>${escapeHtml(String(row.total))}</strong></td>
        </tr>`
        )
        .join('');

    const openAuditsHtml = (data.openAudits || []).length
        ? `<table class="data-table">
            <thead>
                <tr>
                    <th>Date</th>
                    <th>Shift</th>
                    <th>Conducted by</th>
                    <th>Started</th>
                    <th class="num">Open actions</th>
                </tr>
            </thead>
            <tbody>
                ${data.openAudits
                    .map(
                        (row) => `
                <tr>
                    <td>${escapeHtml(formatDateKey(row.dateKey))}</td>
                    <td>${escapeHtml(row.shift || '—')}</td>
                    <td>${escapeHtml(row.conductorName || '—')}</td>
                    <td>${escapeHtml(formatDateTime(row.startedAt))}</td>
                    <td class="num">${escapeHtml(String(row.openActionCount || 0))}</td>
                </tr>`
                    )
                    .join('')}
            </tbody>
        </table>`
        : '<p class="empty">No open (in-progress) DFSC audits.</p>';

    const openActionsHtml = (data.openActions || []).length
        ? `<table class="data-table">
            <thead>
                <tr>
                    <th>Date</th>
                    <th>Shift</th>
                    <th>Conducted by</th>
                    <th>Non-compliant item</th>
                    <th>Action status</th>
                </tr>
            </thead>
            <tbody>
                ${data.openActions
                    .map(
                        (row) => `
                <tr>
                    <td>${escapeHtml(formatDateKey(row.dateKey))}</td>
                    <td>${escapeHtml(row.shift || '—')}</td>
                    <td>${escapeHtml(row.conductorName || '—')}</td>
                    <td>${escapeHtml(row.label || '—')}</td>
                    <td>${row.draftAction ? escapeHtml(row.draftAction) : '<span class="warn">Not submitted</span>'}</td>
                </tr>`
                    )
                    .join('')}
            </tbody>
        </table>`
        : '<p class="empty">No open corrective actions.</p>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>CORE DFSC Report — ${escapeHtml(data.storeName || data.storeNumber)}</title>
<style>
    * { box-sizing: border-box; }
    body {
        font-family: Helvetica, Arial, sans-serif;
        font-size: 10px;
        color: #1f2933;
        margin: 0;
        padding: 0;
        line-height: 1.45;
    }
    .report-header {
        border-bottom: 3px solid #6d28d9;
        padding-bottom: 12px;
        margin-bottom: 18px;
    }
    .report-title {
        margin: 0 0 4px;
        font-size: 18px;
        font-weight: 700;
        color: #5b21b6;
        letter-spacing: 0.02em;
    }
    .report-subtitle {
        margin: 0;
        font-size: 11px;
        color: #4b5563;
    }
    .summary-strip {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-bottom: 18px;
    }
    .summary-pill {
        flex: 1 1 120px;
        border: 1px solid #ddd6fe;
        background: #f5f3ff;
        border-radius: 6px;
        padding: 10px 12px;
    }
    .summary-pill span {
        display: block;
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #6d28d9;
        margin-bottom: 4px;
    }
    .summary-pill strong {
        font-size: 16px;
        color: #1f2933;
    }
    h2 {
        margin: 20px 0 8px;
        font-size: 12px;
        font-weight: 700;
        color: #5b21b6;
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }
    .data-table {
        width: 100%;
        border-collapse: collapse;
        margin-bottom: 8px;
    }
    .data-table th,
    .data-table td {
        border: 1px solid #e5e7eb;
        padding: 6px 8px;
        text-align: left;
        vertical-align: top;
    }
    .data-table th {
        background: #f9fafb;
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #4b5563;
    }
    .data-table tr:nth-child(even) td {
        background: #fcfcfd;
    }
    .num { text-align: center; white-space: nowrap; }
    .empty {
        margin: 0;
        padding: 10px 12px;
        background: #f9fafb;
        border: 1px solid #e5e7eb;
        border-radius: 4px;
        color: #6b7280;
        font-style: italic;
    }
    .warn { color: #c0392b; font-weight: 600; }
    .footer-note {
        margin-top: 24px;
        padding-top: 10px;
        border-top: 1px solid #e5e7eb;
        font-size: 9px;
        color: #9ca3af;
        text-align: center;
    }
</style>
</head>
<body>
    <header class="report-header">
        <h1 class="report-title">DFSC Report for CORE</h1>
        <p class="report-subtitle">
            ${escapeHtml(data.storeName || data.storeNumber)} · Store ${escapeHtml(data.storeNumber)}
            · ${escapeHtml(formatDateKey(data.fromDateKey))} to ${escapeHtml(formatDateKey(data.toDateKey))}
            · Generated ${escapeHtml(formatDateTime(data.generatedAt))}
        </p>
    </header>

    <div class="summary-strip">
        <div class="summary-pill">
            <span>Completed (30 days)</span>
            <strong>${escapeHtml(String(data.totals?.completed ?? 0))}</strong>
        </div>
        <div class="summary-pill">
            <span>Open audits</span>
            <strong>${escapeHtml(String(data.totals?.openAudits ?? 0))}</strong>
        </div>
        <div class="summary-pill">
            <span>Open actions</span>
            <strong>${escapeHtml(String(data.totals?.openActions ?? 0))}</strong>
        </div>
    </div>

    <h2>Daily completions</h2>
    <table class="data-table">
        <thead>
            <tr>
                <th>Date</th>
                <th class="num">AM</th>
                <th class="num">PM</th>
                <th class="num">Total</th>
            </tr>
        </thead>
        <tbody>
            ${dailyRows}
            <tr>
                <td><strong>Period total</strong></td>
                <td class="num"><strong>${escapeHtml(String(data.totals?.amCompleted ?? 0))}</strong></td>
                <td class="num"><strong>${escapeHtml(String(data.totals?.pmCompleted ?? 0))}</strong></td>
                <td class="num"><strong>${escapeHtml(String(data.totals?.completed ?? 0))}</strong></td>
            </tr>
        </tbody>
    </table>

    <h2>Open audits (in progress)</h2>
    ${openAuditsHtml}

    <h2>Open corrective actions</h2>
    ${openActionsHtml}

    <p class="footer-note">Daily Food Safety Checklist · CORE summary report · Retention ${escapeHtml(String(data.periodDays || 30))} days</p>
</body>
</html>`;
}

function resolveChromiumExecutablePath() {
    const fromEnv = String(process.env.SCRAPER_EXECUTABLE_PATH || '').trim();
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
    try {
        const bundled = typeof puppeteer.executablePath === 'function' ? puppeteer.executablePath() : '';
        if (bundled && fs.existsSync(bundled)) return bundled;
    } catch {
        /* bundled chromium not installed */
    }
    const candidates = [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
        '/usr/lib/chromium/chromium',
        '/usr/lib/chromium-browser/chromium-browser',
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
}

function buildCoreReportText(data) {
    const lines = [
        `DFSC Report for CORE — ${data.storeName || data.storeNumber}`,
        `${formatDateKey(data.fromDateKey)} to ${formatDateKey(data.toDateKey)}`,
        '',
        'Daily completions:',
    ];
    for (const row of data.dailyCompletion || []) {
        lines.push(`  ${row.dateKey}: AM ${row.am} · PM ${row.pm} · Total ${row.total}`);
    }
    lines.push('', `Open audits: ${data.totals?.openAudits ?? 0}`, `Open actions: ${data.totals?.openActions ?? 0}`);
    return lines.join('\n');
}

async function buildCoreReportPdf(storeNumber, options = {}) {
    const data = buildCoreReportData(storeNumber, options);
    const html = buildCoreReportHtml(data);
    let browser;
    try {
        const launchOpts = {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        };
        const chromiumPath = resolveChromiumExecutablePath();
        if (chromiumPath) launchOpts.executablePath = chromiumPath;

        browser = await puppeteer.launch(launchOpts);
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '12mm', right: '10mm', bottom: '14mm', left: '10mm' },
        });
        return { buffer: Buffer.from(pdf), data, filename: buildCoreReportFilename(data) };
    } catch (err) {
        console.info('[DFSC] CORE report HTML PDF fallback:', err.message);
        return {
            buffer: buildSimplePdf(buildCoreReportText(data)),
            data,
            filename: buildCoreReportFilename(data),
        };
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

module.exports = {
    buildCoreReportHtml,
    buildCoreReportPdf,
    buildCoreReportFilename,
};
