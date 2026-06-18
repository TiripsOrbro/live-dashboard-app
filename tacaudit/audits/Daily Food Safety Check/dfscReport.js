const fs = require('fs');
const puppeteer = require('puppeteer');
const {
    DFSC_SECTIONS,
    SECTION_SKIP_GROUPS,
    getVisibleQuestions,
    collectNonCompliant,
    isCompliantType,
    isNotCompliantValue,
} = require('./dfscSchema');

const REPORT_SECTIONS = DFSC_SECTIONS.filter((s) => s.id !== 'actions' && s.id !== 'signOff');

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatReportDate(session) {
    const raw = session.completedAt || session.dateKey || '';
    const parsed = Date.parse(raw.includes('T') ? raw : `${raw}T12:00:00`);
    if (!Number.isFinite(parsed)) return raw || '-';
    return new Date(parsed).toLocaleDateString('en-AU', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    });
}

function formatReportDateTime(iso) {
    if (!iso) return '-';
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
    if (!Number.isFinite(started) || !Number.isFinite(completed) || completed <= started) return '-';
    const mins = Math.round((completed - started) / 60000);
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h} hr ${m} min` : `${h} hr`;
}

function buildReportFilename(session) {
    const raw = session.completedAt || session.dateKey || '';
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
    return `${day}-${month}-${year}-TB-${storeSlug || 'Store'}.pdf`;
}

function getReportGroupLabel(question) {
    if (question.group) return question.group;
    if (question.id.startsWith('prodLine1_')) return 'Main Line';
    if (question.id.startsWith('prodLine2_')) return 'Second Line';
    if (question.skipGroup === 'prepFry_freeStandingFridge') return 'Free-standing prep fridge';
    return null;
}

function groupQuestionsForReport(questions) {
    const groups = [];
    let currentLabel = Symbol('unset');
    for (const question of questions) {
        const label = getReportGroupLabel(question);
        if (label !== currentLabel) {
            groups.push({ label, questions: [] });
            currentLabel = label;
        }
        groups[groups.length - 1].questions.push(question);
    }
    return groups;
}

function formatAnswerValue(question, value) {
    if (question.type === 'select' || question.type === 'segmented') {
        let effective = String(value ?? '').trim();
        if (effective === '') effective = String(question.defaultValue ?? '').trim();
        if (effective === '') return '-';
        const choice = (question.choices || []).find((c) => c.value === effective);
        return choice?.label || effective;
    }
    if (value === null || value === undefined || String(value).trim() === '') return '-';
    const raw = String(value).trim();
    if (question.type === 'carryover_temp') {
        if (raw.toLowerCase() === 'no') return 'No carryover';
        return `${raw} °C`;
    }
    if (question.type === 'ppm_band') {
        const choice = (question.choices || []).find((c) => c.value === raw);
        return choice?.label || raw;
    }
    if (isCompliantType(question.type)) {
        if (raw.toLowerCase() === 'compliant') return 'Compliant';
        if (raw.toLowerCase() === 'not_compliant') return 'Not Compliant';
        if (raw.toLowerCase() === 'na') return 'N/A';
    }
    if (question.type === 'yes_no') {
        if (question.choices?.length) {
            const choice = (question.choices || []).find((c) => c.value === raw);
            return choice?.label || raw;
        }
        if (raw.toLowerCase() === 'yes') return 'Yes';
        if (raw.toLowerCase() === 'no') return 'No';
    }
    if (question.type === 'received') {
        if (raw === 'received') return 'Received';
        if (raw === 'not_received') return 'Not Received';
    }
    if (question.type === 'temperature' || question.type === 'temperature_na') {
        if (raw.toLowerCase() === 'na') return 'N/A';
        return `${raw} °C`;
    }
    if (question.type === 'ppm') return `${raw} ppm`;
    if (question.type === 'percent') return `${raw}%`;
    if (question.type === 'date') {
        const parsed = Date.parse(raw.includes('T') ? raw : `${raw}T12:00:00`);
        if (Number.isFinite(parsed)) {
            return new Date(parsed).toLocaleDateString('en-AU', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
            });
        }
        return raw;
    }
    if (question.type === 'datetime') {
        const parsed = Date.parse(raw.includes('T') ? raw : `${raw}T12:00:00`);
        if (Number.isFinite(parsed)) {
            return new Date(parsed).toLocaleString('en-AU', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
            });
        }
        return raw;
    }
    return raw;
}

function answerClass(question, value) {
    if (isCompliantType(question.type)) {
        const v = String(value || '').toLowerCase();
        if (v === 'compliant') return 'answer-ok';
        if (v === 'not_compliant') return 'answer-nc';
    }
    if (isNotCompliantValue(value, question)) return 'answer-nc';
    return '';
}

function skippedGroupsForSection(session, sectionId) {
    return (SECTION_SKIP_GROUPS || []).filter(
        (g) => g.section === sectionId && (session.sectionSkips || []).includes(g.id)
    );
}

function renderQuestionRows(session, questions) {
    return questions
        .map((question) => {
            const value = session.answers?.[question.id];
            const note = String(session.notes?.[question.id] || '').trim();
            const isNc = isNotCompliantValue(value, question);
            const action = isNc
                ? collectNonCompliant(session).find((row) => row.questionId === question.id)
                : null;
            return `
                <tr class="${isNc ? 'row-nc' : ''}">
                    <td class="col-question">${escapeHtml(question.label)}</td>
                    <td class="col-answer ${answerClass(question, value)}">${escapeHtml(formatAnswerValue(question, value))}</td>
                </tr>
                ${
                    note
                        ? `<tr class="row-note"><td colspan="2"><span class="note-label">Note:</span> ${escapeHtml(note)}</td></tr>`
                        : ''
                }
                ${
                    action?.actionText
                        ? `<tr class="row-action"><td colspan="2"><span class="note-label">Action:</span> ${escapeHtml(action.actionText)}</td></tr>`
                        : ''
                }`;
        })
        .join('');
}

function buildDfscReportHtml(session) {
    const nc = collectNonCompliant(session);
    const visibleCount = REPORT_SECTIONS.reduce(
        (sum, section) => sum + getVisibleQuestions(session, section.id).length,
        0
    );
    const ncCount = nc.length;

    const sectionHtml = REPORT_SECTIONS.map((section) => {
        const questions = getVisibleQuestions(session, section.id);
        const skipped = skippedGroupsForSection(session, section.id);
        if (!questions.length && !skipped.length) return '';

        const skippedHtml = skipped
            .map(
                (g) =>
                    `<div class="skip-banner">Section skipped: ${escapeHtml(g.label)}</div>`
            )
            .join('');

        const groups = groupQuestionsForReport(questions);
        const groupsHtml = groups
            .map((group) => {
                const subTitle = group.label
                    ? `<div class="subsection-title">${escapeHtml(group.label)}</div>`
                    : '';
                return `
                    ${subTitle}
                    <table>
                        <thead>
                            <tr>
                                <th>Question</th>
                                <th class="col-answer-head">Response</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${renderQuestionRows(session, group.questions)}
                        </tbody>
                    </table>`;
            })
            .join('');

        const sectionIntro =
            section.id === 'deliveriesTransfers'
                ? `<p class="section-intro">Only complete temps if deliveries from these suppliers, or a chilled/frozen stock transfer, is received today.</p>`
                : '';;

        return `
            <section class="report-section">
                <div class="section-title">${escapeHtml(section.label)}</div>
                ${sectionIntro}
                ${skippedHtml}
                ${groupsHtml}
            </section>`;
    }).join('');

    const actionsHtml =
        nc.length === 0
            ? '<p class="empty-hint">No non-compliant items recorded.</p>'
            : `<ul class="actions-list">
                ${nc
                    .map(
                        (row) => `
                    <li>
                        <div class="action-question">${escapeHtml(row.label)}</div>
                        <div class="action-text">${escapeHtml(row.actionText || '-')}</div>
                    </li>`
                    )
                    .join('')}
               </ul>`;

    const signatureHtml = session.signOff?.signatureDataUrl
        ? `<img class="signature" src="${session.signOff.signatureDataUrl}" alt="Signature" />`
        : '<p class="empty-hint">No signature captured.</p>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>DFSC Report - ${escapeHtml(session.storeName || session.storeNumber)}</title>
<style>
    * { box-sizing: border-box; }
    body {
        font-family: Arial, Helvetica, sans-serif;
        font-size: 10.5px;
        line-height: 1.4;
        color: #1f2933;
        margin: 0;
        padding: 28px 32px 40px;
    }
    .report-header {
        border-bottom: 3px solid #6b21a8;
        padding-bottom: 14px;
        margin-bottom: 18px;
    }
    .report-title {
        font-size: 20px;
        font-weight: 700;
        margin: 0 0 4px;
        color: #111827;
    }
    .report-subtitle {
        font-size: 11px;
        color: #6b7280;
        margin: 0;
    }
    .summary-strip {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 18px;
    }
    .summary-pill {
        background: #f3f4f6;
        border: 1px solid #e5e7eb;
        border-radius: 6px;
        padding: 8px 12px;
        min-width: 120px;
    }
    .summary-pill strong {
        display: block;
        font-size: 16px;
        color: #111827;
    }
    .summary-pill span {
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #6b7280;
    }
    .summary-pill.flagged strong { color: #b91c1c; }
    .meta-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px 28px;
        margin-bottom: 22px;
        font-size: 10.5px;
    }
    .meta-row dt {
        font-weight: 700;
        color: #374151;
        margin: 0;
    }
    .meta-row dd {
        margin: 0 0 6px;
        color: #111827;
    }
    .report-intro {
        page-break-after: always;
    }
    .report-section {
        margin-top: 14px;
    }
    .section-title {
        background: #6b21a8;
        color: #fff;
        padding: 7px 12px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        page-break-after: avoid;
    }
    .section-intro {
        margin: 8px 0 0;
        font-size: 10px;
        font-style: italic;
        color: #6b7280;
    }
    .subsection-title {
        margin: 10px 0 6px;
        font-size: 10.5px;
        font-weight: 700;
        color: #374151;
        text-transform: uppercase;
        letter-spacing: 0.03em;
    }
    .skip-banner {
        margin-top: 8px;
        padding: 7px 10px;
        background: #fffbeb;
        border: 1px solid #fcd34d;
        border-radius: 4px;
        font-size: 10px;
        color: #92400e;
    }
    table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 8px;
        page-break-inside: auto;
    }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    th, td {
        border: 1px solid #d1d5db;
        padding: 6px 8px;
        vertical-align: top;
    }
    th {
        background: #f9fafb;
        text-align: left;
        font-size: 10px;
        font-weight: 700;
        color: #374151;
    }
    .col-question { width: 68%; }
    .col-answer-head, .col-answer { width: 32%; }
    tr.row-nc td { background: #fef2f2; }
    tr.row-note td, tr.row-action td {
        background: #fafafa;
        font-size: 10px;
        border-top: none;
    }
    .note-label {
        font-weight: 700;
        color: #6b7280;
        margin-right: 4px;
    }
    .answer-ok { color: #15803d; font-weight: 600; }
    .answer-nc { color: #b91c1c; font-weight: 700; }
    .actions-list {
        list-style: none;
        padding: 0;
        margin: 10px 0 0;
    }
    .actions-list li {
        border: 1px solid #d1d5db;
        border-left: 4px solid #b91c1c;
        padding: 10px 12px;
        margin-bottom: 8px;
        background: #fff;
    }
    .action-question {
        font-weight: 700;
        margin-bottom: 4px;
    }
    .action-text { white-space: pre-wrap; }
    .signoff-copy {
        margin: 10px 0 14px;
        font-size: 10px;
        color: #374151;
        line-height: 1.5;
    }
    .signature {
        display: block;
        max-width: 260px;
        max-height: 90px;
        border: 1px solid #d1d5db;
        background: #fff;
    }
    .empty-hint {
        color: #6b7280;
        font-style: italic;
        margin: 8px 0 0;
    }
    .footer-note {
        margin-top: 28px;
        padding-top: 10px;
        border-top: 1px solid #e5e7eb;
        font-size: 9px;
        color: #9ca3af;
        text-align: center;
    }
</style>
</head>
<body>
    <div class="report-intro">
    <header class="report-header">
        <h1 class="report-title">Manual Daily Food Safety Checklist</h1>
        <p class="report-subtitle">Daily Food Safety Checklist (DFSC) inspection report</p>
    </header>

    <div class="summary-strip">
        <div class="summary-pill">
            <span>Questions answered</span>
            <strong>${visibleCount}</strong>
        </div>
        <div class="summary-pill flagged">
            <span>Flagged items</span>
            <strong>${ncCount}</strong>
        </div>
        <div class="summary-pill">
            <span>Duration</span>
            <strong>${escapeHtml(formatDurationMinutes(session))}</strong>
        </div>
    </div>

    <dl class="meta-grid">
        <div class="meta-row"><dt>Restaurant name</dt><dd>${escapeHtml(session.storeName || '-')}</dd></div>
        <div class="meta-row"><dt>Store number</dt><dd>${escapeHtml(session.storeNumber || '-')}</dd></div>
        <div class="meta-row"><dt>Date</dt><dd>${escapeHtml(formatReportDate(session))}</dd></div>
        <div class="meta-row"><dt>Shift</dt><dd>${escapeHtml(session.shift || '-')}</dd></div>
        <div class="meta-row"><dt>Conducted by</dt><dd>${escapeHtml(session.conductor?.name || '-')}</dd></div>
        <div class="meta-row"><dt>Signed off by</dt><dd>${escapeHtml(session.signOff?.name || '-')}</dd></div>
        <div class="meta-row"><dt>Started</dt><dd>${escapeHtml(formatReportDateTime(session.startedAt))}</dd></div>
        <div class="meta-row"><dt>Completed</dt><dd>${escapeHtml(formatReportDateTime(session.completedAt))}</dd></div>
    </dl>
    </div>

    ${sectionHtml}

    <section class="report-section">
        <div class="section-title">Actions</div>
        ${actionsHtml}
    </section>

    <section class="report-section">
        <div class="section-title">Sign Off</div>
        <p class="signoff-copy">
            By signing this, you are acknowledging that you have thoroughly completed all sections of the food safety checklist with integrity, confirm that zero food safety breaches are present, and understand that you will be held accountable for any food safety breaches that arise.
        </p>
        <p><strong>Full name of the manager who completed this checklist:</strong> ${escapeHtml(session.signOff?.name || '-')}</p>
        ${signatureHtml}
    </section>

    <p class="footer-note">Generated ${escapeHtml(formatReportDateTime(new Date().toISOString()))}</p>
</body>
</html>`;
}

function buildDfscReportText(session) {
    const lines = [];
    lines.push('MANUAL DAILY FOOD SAFETY CHECKLIST');
    lines.push('='.repeat(48));
    lines.push(`Restaurant name: ${session.storeName || '-'}`);
    lines.push(`Store number: ${session.storeNumber || '-'}`);
    lines.push(`Date: ${formatReportDate(session)}`);
    lines.push(`Shift: ${session.shift || '-'}`);
    lines.push(`Conducted by: ${session.conductor?.name || '-'}`);
    lines.push(`Signed off by: ${session.signOff?.name || '-'}`);
    lines.push(`Started: ${formatReportDateTime(session.startedAt)}`);
    lines.push(`Completed: ${formatReportDateTime(session.completedAt)}`);
    lines.push(`Duration: ${formatDurationMinutes(session)}`);
    lines.push('');

    for (const section of REPORT_SECTIONS) {
        const questions = getVisibleQuestions(session, section.id);
        const skipped = skippedGroupsForSection(session, section.id);
        if (!questions.length && !skipped.length) continue;

        lines.push(section.label.toUpperCase());
        lines.push('-'.repeat(section.label.length));
        for (const skip of skipped) {
            lines.push(`[Skipped: ${skip.label}]`);
        }
        for (const question of questions) {
            const value = session.answers?.[question.id];
            lines.push(`${question.label}`);
            lines.push(`  Response: ${formatAnswerValue(question, value)}`);
            const note = String(session.notes?.[question.id] || '').trim();
            if (note) lines.push(`  Note: ${note}`);
            if (isNotCompliantValue(value, question)) {
                const action = collectNonCompliant(session).find((row) => row.questionId === question.id);
                if (action?.actionText) lines.push(`  Action: ${action.actionText}`);
            }
        }
        lines.push('');
    }

    const nc = collectNonCompliant(session);
    lines.push('ACTIONS');
    lines.push('-'.repeat(7));
    if (!nc.length) {
        lines.push('No non-compliant items recorded.');
    } else {
        for (const row of nc) {
            lines.push(`• ${row.label}`);
            lines.push(`  ${row.actionText || '-'}`);
        }
    }

    return lines.join('\n');
}

function escapePdfText(text) {
    return String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildSimplePdf(text) {
    const lines = String(text).split(/\r?\n/);
    const lineHeight = 12;
    const startY = 770;
    const linesPerPage = 62;
    const pages = [];
    for (let i = 0; i < lines.length; i += linesPerPage) {
        pages.push(lines.slice(i, i + linesPerPage));
    }
    if (!pages.length) pages.push(['']);

    const pageObjects = [];
    const contentObjects = [];
    const kids = [];

    pages.forEach((pageLines, pageIndex) => {
        const pageNum = 3 + pageIndex * 2;
        const contentNum = pageNum + 1;
        kids.push(`${pageNum} 0 R`);

        const streamParts = ['BT /F1 9 Tf'];
        pageLines.forEach((line, i) => {
            const y = startY - i * lineHeight;
            streamParts.push(`1 0 0 1 40 ${y} Tm (${escapePdfText(line.slice(0, 100))}) Tj`);
        });
        streamParts.push('ET');
        const stream = streamParts.join('\n');
        contentObjects.push(
            `${contentNum} 0 obj<< /Length ${Buffer.byteLength(stream, 'utf8')} >> stream\n${stream}\nendstream endobj`
        );
        pageObjects.push(
            `${pageNum} 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNum} 0 R /Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> >> endobj`
        );
    });

    const fontObjNum = 3 + pages.length * 2;
    const fontObj = `${fontObjNum} 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj`;

    const objects = [
        '1 0 obj<< /Type /Catalog /Pages 2 0 R >> endobj',
        `2 0 obj<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >> endobj`,
        ...pageObjects,
        ...contentObjects,
        fontObj,
    ];

    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((obj) => {
        offsets.push(Buffer.byteLength(pdf, 'utf8'));
        pdf += `${obj}\n`;
    });
    const xrefOffset = Buffer.byteLength(pdf, 'utf8');
    pdf += `xref\n0 ${objects.length + 1}\n`;
    pdf += '0000000000 65535 f \n';
    for (let i = 1; i <= objects.length; i++) {
        pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    }
    pdf += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    return Buffer.from(pdf, 'utf8');
}

async function buildDfscReportPdf(session) {
    const html = buildDfscReportHtml(session);
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
        return Buffer.from(pdf);
    } catch (err) {
        console.info('[DFSC] HTML PDF fallback:', err.message);
        return buildSimplePdf(buildDfscReportText(session));
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
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

module.exports = {
    buildReportFilename,
    buildDfscReportHtml,
    buildDfscReportText,
    buildDfscReportPdf,
    buildSimplePdf,
    formatAnswerValue,
    formatReportDate,
};
