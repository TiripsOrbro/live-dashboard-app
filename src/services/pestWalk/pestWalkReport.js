const puppeteer = require('puppeteer');
const { formatContributionLine } = require('../audit/auditContributions');
const {
    PEST_WALK_SECTIONS,
    getVisibleQuestions,
    collectNonCompliant,
    isNotCompliantValue,
    isPestYesType,
    scoreSession,
} = require('./pestWalkSchema');

const REPORT_SECTIONS = PEST_WALK_SECTIONS.filter((s) => s.id !== 'signOff');

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
    const storeSlug = String(session.storeName || session.storeNumber || 'Store')
        .replace(/^TB\s+/i, '')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-');
    return `${day}-${month}-${year}-Pest-Walk-${storeSlug || 'Store'}.pdf`;
}

function formatAnswerValue(question, value) {
    if (value === null || value === undefined || String(value).trim() === '') return '—';
    const raw = String(value).trim();
    if (isPestYesType(question.type)) {
        if (raw.toLowerCase() === 'yes') return 'Yes';
        if (raw.toLowerCase() === 'no') return 'No';
    }
    if (question.type === 'textarea') return raw;
    return raw;
}

function answerClass(question, value) {
    if (isNotCompliantValue(value, question)) return 'answer-nc';
    if (isPestYesType(question.type) && String(value).toLowerCase() === 'yes') return 'answer-ok';
    return '';
}

function renderReportBannerHtml(banner) {
    if (!banner) return '';
    const points = Array.isArray(banner.bannerPoints) ? banner.bannerPoints : [];
    const pointsHtml = points.length
        ? `<ul class="section-banner-points">${points
              .map((point) => `<li>${escapeHtml(point)}</li>`)
              .join('')}</ul>`
        : '';
    return `<div class="section-banner"><strong>${escapeHtml(banner.bannerTitle || '')}</strong>${
        banner.bannerSubtitle ? `<p>${escapeHtml(banner.bannerSubtitle)}</p>` : ''
    }${pointsHtml}</div>`;
}

function groupQuestionsForReport(questions) {
    const groups = [];
    let currentLabel = Symbol('unset');
    for (const question of questions) {
        const label = question.group || null;
        if (label !== currentLabel) {
            groups.push({ label, questions: [] });
            currentLabel = label;
        }
        groups[groups.length - 1].questions.push(question);
    }
    return groups;
}

function renderQuestionRows(session, questions) {
    return questions
        .filter((q) => q.type !== 'banner')
        .map((question) => {
            const value = session.answers?.[question.id];
            const note = String(session.notes?.[question.id] || '').trim();
            const isNc = isNotCompliantValue(value, question);
            const action = isNc
                ? collectNonCompliant(session).find((row) => row.questionId === question.id)
                : null;
            const answerBy = formatContributionLine(session, 'answers', question.id);
            const noteBy = formatContributionLine(session, 'notes', question.id);
            const actionBy = formatContributionLine(session, 'actions', question.id);
            return `
                <tr class="${isNc ? 'row-nc' : ''}">
                    <td class="col-question">${escapeHtml(question.label)}</td>
                    <td class="col-answer ${answerClass(question, value)}">${escapeHtml(formatAnswerValue(question, value))}${answerBy ? `<div class="contrib-meta">${escapeHtml(answerBy)}</div>` : ''}</td>
                </tr>
                ${
                    note
                        ? `<tr class="row-note"><td colspan="2"><span class="note-label">Note:</span> ${escapeHtml(note)}${noteBy ? `<div class="contrib-meta">${escapeHtml(noteBy)}</div>` : ''}</td></tr>`
                        : ''
                }
                ${
                    action?.actionText
                        ? `<tr class="row-action"><td colspan="2"><span class="note-label">Action:</span> ${escapeHtml(action.actionText)}${actionBy ? `<div class="contrib-meta">${escapeHtml(actionBy)}</div>` : ''}</td></tr>`
                        : ''
                }`;
        })
        .join('');
}

function buildPestWalkReportHtml(session) {
    const nc = collectNonCompliant(session);
    const score = session.score || scoreSession(session);

    const sectionHtml = REPORT_SECTIONS.map((section) => {
        const questions = getVisibleQuestions(session, section.id);
        if (!questions.length) return '';

        const groups = groupQuestionsForReport(questions);
        const groupsHtml = groups
            .map((group) => {
                const banner = group.questions.find((q) => q.type === 'banner');
                const bannerHtml = banner ? renderReportBannerHtml(banner) : '';
                const answerQuestions = group.questions.filter((q) => q.type !== 'banner');
                if (!answerQuestions.length && bannerHtml) {
                    return bannerHtml;
                }
                const subTitle = group.label && !banner
                    ? `<div class="subsection-title">${escapeHtml(group.label)}</div>`
                    : '';
                return `
                    ${bannerHtml}
                    ${subTitle}
                    <table>
                        <thead>
                            <tr>
                                <th>Question</th>
                                <th class="col-answer-head">Response</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${renderQuestionRows(session, answerQuestions)}
                        </tbody>
                    </table>`;
            })
            .join('');

        return `
            <section class="report-section">
                <div class="section-title">${escapeHtml(section.label)}</div>
                ${groupsHtml}
            </section>`;
    }).join('');

    const correctiveText = String(session.answers?.corrective_details || '').trim();
    const correctiveHtml = correctiveText
        ? `<p>${escapeHtml(correctiveText)}</p>`
        : '<p class="empty-hint">No corrective actions recorded.</p>';

    const actionsHtml =
        nc.length === 0
            ? '<p class="empty-hint">No flagged items.</p>'
            : `<ul class="actions-list">
                ${nc
                    .map(
                        (row) => `
                    <li>
                        <div class="action-question">${escapeHtml(row.label)}</div>
                        <div class="action-text">${escapeHtml(row.actionText || '—')}</div>
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
<title>Pest Walk — ${escapeHtml(session.storeName || session.storeNumber)}</title>
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
    .meta-row dt { font-weight: 700; color: #374151; margin: 0; }
    .meta-row dd { margin: 0 0 6px; color: #111827; }
    .report-section { margin-top: 14px; }
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
    .section-banner {
        background: #f9fafb;
        border: 1px solid #e5e7eb;
        padding: 10px 12px;
        margin: 10px 0;
        font-size: 10px;
    }
    .section-banner p { margin: 6px 0 0; color: #4b5563; }
    .section-banner-points {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 6px;
        margin: 8px 0 0;
        padding: 0;
        list-style: none;
    }
    .section-banner-points li {
        margin: 0;
        padding: 5px 7px;
        font-size: 9.5px;
        line-height: 1.35;
        color: #374151;
        background: #fff;
        border: 1px solid #e5e7eb;
        border-radius: 3px;
    }
    .subsection-title {
        font-weight: 700;
        font-size: 10.5px;
        margin: 12px 0 6px;
        color: #374151;
    }
    table {
        width: 100%;
        border-collapse: collapse;
        margin-bottom: 10px;
        font-size: 10px;
    }
    th, td {
        border: 1px solid #e5e7eb;
        padding: 6px 8px;
        vertical-align: top;
        text-align: left;
    }
    th { background: #f9fafb; font-weight: 700; }
    .col-answer-head { width: 90px; }
    .answer-ok { color: #1f7a4d; font-weight: 700; }
    .answer-nc { color: #b91c1c; font-weight: 700; }
    .row-nc td { background: #fef2f2; }
    .row-note td, .row-action td { font-size: 9.5px; color: #4b5563; background: #fafafa; }
    .note-label { font-weight: 700; }
    .contrib-meta { font-size: 8px; color: #6b7280; margin-top: 2px; }
    .actions-list { margin: 0; padding-left: 18px; }
    .action-question { font-weight: 700; margin-bottom: 2px; }
    .empty-hint { color: #6b7280; font-style: italic; }
    .signature { max-width: 240px; max-height: 80px; display: block; margin-top: 8px; }
    .footer-note { margin-top: 24px; font-size: 9px; color: #9ca3af; }
</style>
</head>
<body>
    <header class="report-header">
        <h1 class="report-title">Taco Bell Weekly Pest Inspection</h1>
        <p class="report-subtitle">${escapeHtml(session.storeName || '')} · Store ${escapeHtml(session.storeNumber || '')}</p>
    </header>

    <div class="summary-strip">
        <div class="summary-pill">
            <span>Score</span>
            <strong>${score.yesCount} / ${score.total} (${score.percent}%)</strong>
        </div>
        <div class="summary-pill flagged">
            <span>Flagged items</span>
            <strong>${score.flaggedCount}</strong>
        </div>
        <div class="summary-pill">
            <span>Actions</span>
            <strong>${score.actionCount}</strong>
        </div>
    </div>

    <dl class="meta-grid">
        <div class="meta-row"><dt>Period</dt><dd>${escapeHtml(session.periodKey || '—')}</dd></div>
        <div class="meta-row"><dt>Conducted by</dt><dd>${escapeHtml(session.conductor?.name || '—')}</dd></div>
        <div class="meta-row"><dt>Signed off by</dt><dd>${escapeHtml(session.signOff?.name || '—')}</dd></div>
        <div class="meta-row"><dt>Started</dt><dd>${escapeHtml(formatReportDateTime(session.startedAt))}</dd></div>
        <div class="meta-row"><dt>Completed</dt><dd>${escapeHtml(formatReportDateTime(session.completedAt))}</dd></div>
        <div class="meta-row"><dt>Duration</dt><dd>${escapeHtml(formatDurationMinutes(session))}</dd></div>
    </dl>

    ${sectionHtml}

    <section class="report-section">
        <div class="section-title">Corrective Actions</div>
        ${correctiveHtml}
        ${actionsHtml}
    </section>

    <section class="report-section">
        <div class="section-title">Sign Off</div>
        <p><strong>Name and signature of Manager completing the audit:</strong> ${escapeHtml(session.signOff?.name || '—')}</p>
        ${signatureHtml}
    </section>

    <p class="footer-note">Generated ${escapeHtml(formatReportDateTime(new Date().toISOString()))}</p>
</body>
</html>`;
}

async function buildPestWalkReportPdf(session) {
    const html = buildPestWalkReportHtml(session);
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
    buildPestWalkReportHtml,
    buildPestWalkReportPdf,
    buildReportFilename,
};
