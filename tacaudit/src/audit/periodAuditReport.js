const puppeteer = require('puppeteer');

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

function buildReportFilename(session, label) {
    const raw = session.completedAt || session.periodKey || '';
    const parsed = Date.parse(raw.includes('T') ? raw : `${raw}T12:00:00`);
    const date = Number.isFinite(parsed) ? new Date(parsed) : new Date();
    const day = date.getDate();
    const month = date.toLocaleString('en-AU', { month: 'short' });
    const year = date.getFullYear();
    const storeSlug = String(session.storeName || session.storeNumber || 'Store')
        .replace(/^TB\s+/i, '')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-');
    const slug = String(label || 'Audit').replace(/\s+/g, '-');
    return `${day}-${month}-${year}-${slug}-${storeSlug || 'Store'}.pdf`;
}

function renderAnswerHtml(question, value) {
    const raw = value === true || value === 'true' ? 'Yes' : String(value ?? '—');
    const nc = question && typeof question === 'object' ? '' : '';
    return `<span class="answer">${escapeHtml(raw)}</span>`;
}

function buildPeriodAuditReportHtml(session, schema) {
    const sections = schema.getSections().filter((s) => s.id !== 'sign_off');
    const score = session.score || schema.scoreSession(session);
    const rows = [];
    for (const section of sections) {
        rows.push(`<tr class="section"><td colspan="2"><strong>${escapeHtml(section.label)}</strong></td></tr>`);
        const questions = schema.getVisibleQuestions(session, section.id);
        for (const q of questions) {
            const val = session.answers?.[q.id];
            if (q.type === 'banner') continue;
            rows.push(
                `<tr><td class="q">${escapeHtml(q.label)}</td><td>${renderAnswerHtml(q, val)}</td></tr>`
            );
        }
    }
    const ratingLine =
        score?.rating != null
            ? `<p><strong>Result:</strong> ${escapeHtml(score.rating)} (${score.deviationTotal ?? 0} deviation points)</p>`
            : score?.deviationTotal != null
              ? `<p><strong>Deviation points:</strong> ${score.deviationTotal}</p>`
              : '';

    return `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
        body{font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#231e1f;padding:24px}
        h1{font-size:16px;margin:0 0 4px} table{width:100%;border-collapse:collapse;margin-top:12px}
        td{border:1px solid #ccc;padding:6px 8px;vertical-align:top} td.q{width:62%} tr.section td{background:#f3f0f5;font-weight:700}
        .meta{color:#555;margin-bottom:8px}
    </style></head><body>
        <h1>${escapeHtml(schema.AUDIT_LABEL)}</h1>
        <div class="meta">
            <div>Store: ${escapeHtml(session.storeName || session.storeNumber)}</div>
            <div>Period: ${escapeHtml(session.periodKey || '')}</div>
            <div>Conducted by: ${escapeHtml(session.conductor?.name || '')}</div>
            <div>Completed: ${escapeHtml(formatReportDateTime(session.completedAt))}</div>
            ${ratingLine}
        </div>
        <table>${rows.join('')}</table>
        <p style="margin-top:16px">Signed off by: ${escapeHtml(session.signOff?.name || '')}</p>
    </body></html>`;
}

async function buildPeriodAuditReportPdf(session, schema) {
    const html = buildPeriodAuditReportHtml(session, schema);
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' } });
    } finally {
        await browser.close();
    }
}

function buildPeriodAuditReportFilename(session, schema) {
    return buildReportFilename(session, schema.AUDIT_LABEL);
}

module.exports = {
    buildPeriodAuditReportPdf,
    buildPeriodAuditReportFilename,
    buildPeriodAuditReportHtml,
};
