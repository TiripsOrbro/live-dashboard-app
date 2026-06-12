const puppeteer = require('puppeteer');
const { formatContributionLine } = require('../../src/audit/auditContributions');
const {
    SQUARE_ONE_SECTIONS,
    getVisibleQuestions,
    collectNonCompliant,
    isNotCompliantValue,
    isSquareStandardType,
    scoreSession,
} = require('./squareOneSchema');

const REPORT_SECTIONS = SQUARE_ONE_SECTIONS.filter((s) => s.id !== 'signOff');

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatReportDateTime(iso) {
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

function formatDurationMinutes(session) {
    const started = Date.parse(session.startedAt || '');
    const completed = Date.parse(session.completedAt || '');
    if (!Number.isFinite(started) || !Number.isFinite(completed) || completed <= started) return '—';
    const mins = Math.round((completed - started) / 60000);
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h} hr ${m} min` : `${h} hr`;
}

function buildReportFilename(session) {
    const raw = session.completedAt || session.periodKey || '';
    const parsed = Date.parse(raw.includes('T') ? raw : `${raw}T12:00:00`);
    const date = Number.isFinite(parsed) ? new Date(parsed) : new Date();
    const day = date.getDate();
    const month = date.toLocaleString('en-AU', { month: 'short' });
    const year = date.getFullYear();
    const area = String(session.areaTitle || 'Square-One')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-');
    const storeSlug = String(session.storeName || session.storeNumber || 'Store')
        .replace(/^TB\s+/i, '')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-');
    return `${day}-${month}-${year}-Square-One-${area}-${storeSlug || 'Store'}.pdf`;
}

function formatAnswerValue(question, value) {
    const raw = String(value || '').toLowerCase();
    if (raw === 'complete') return 'Completed to Standard';
    if (raw === 'not_complete') return 'Not Complete';
    if (raw === 'na') return 'N/A';
    return value || '—';
}

function buildSquareOneReportHtml(session) {
    const nc = collectNonCompliant(session);
    const score = session.score ?? scoreSession(session);
    const sectionHtml = REPORT_SECTIONS.map((section) => {
        const questions = getVisibleQuestions(session, section.id);
        const rows = questions
            .filter((q) => q.type !== 'banner')
            .map((question) => {
                const value = session.answers?.[question.id];
                const note = String(session.notes?.[question.id] || '').trim();
                const isNc = isNotCompliantValue(value, question);
                return `
                <tr class="${isNc ? 'row-nc' : ''}">
                    <td>${escapeHtml(question.label)}</td>
                    <td>${escapeHtml(formatAnswerValue(question, value))}</td>
                </tr>
                ${note ? `<tr class="row-note"><td colspan="2"><strong>Note:</strong> ${escapeHtml(note)}</td></tr>` : ''}`;
            })
            .join('');
        return `
            <section>
                <h2>${escapeHtml(section.label)}</h2>
                <table><thead><tr><th>Task</th><th>Response</th></tr></thead><tbody>${rows}</tbody></table>
            </section>`;
    }).join('');

    return `<!DOCTYPE html><html><head><meta charset="utf-8" />
<style>
body { font-family: Arial, sans-serif; font-size: 11px; color: #111; margin: 24px; }
h1 { font-size: 18px; margin: 0 0 4px; }
h2 { font-size: 13px; margin: 18px 0 8px; }
table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
th, td { border: 1px solid #d1d5db; padding: 6px 8px; vertical-align: top; }
th { background: #f3f4f6; text-align: left; }
.row-nc td { background: #fef2f2; }
.row-note td { background: #fafafa; color: #4b5563; }
.meta { margin: 12px 0 18px; }
.signature { max-width: 220px; max-height: 72px; }
</style></head><body>
<h1>Square One — ${escapeHtml(session.areaTitle || '')}</h1>
<p>${escapeHtml(session.storeName || '')} · Store ${escapeHtml(session.storeNumber || '')}</p>
<div class="meta">
<p><strong>Period:</strong> ${escapeHtml(session.periodKey || '—')}</p>
<p><strong>Score:</strong> ${score}% · <strong>Flagged:</strong> ${nc.length}</p>
<p><strong>Conducted by:</strong> ${escapeHtml(session.conductor?.name || '—')}</p>
<p><strong>Signed off by:</strong> ${escapeHtml(session.signOff?.name || '—')}</p>
<p><strong>Completed:</strong> ${escapeHtml(formatReportDateTime(session.completedAt))} · ${escapeHtml(formatDurationMinutes(session))}</p>
</div>
${sectionHtml}
<p><strong>Sign-off signature</strong></p>
${session.signOff?.signatureDataUrl ? `<img class="signature" src="${session.signOff.signatureDataUrl}" alt="" />` : '<p>—</p>'}
</body></html>`;
}

async function buildSquareOneReportPdf(session) {
    const html = buildSquareOneReportHtml(session);
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '12mm', right: '12mm', bottom: '16mm', left: '12mm' },
        });
        return Buffer.from(pdfBuffer);
    } finally {
        await browser.close();
    }
}

module.exports = {
    buildSquareOneReportHtml,
    buildSquareOneReportPdf,
    buildReportFilename,
};
