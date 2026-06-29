const { getSettings, saveSettings } = require('./tacauditStore');
const { getAuditTypeConfig } = require('./auditRegistry');
const { buildAuditEmailContent } = require('./auditEmailContent');
const { getStoreConfig } = require('../../../stores/src/storeList');
const { listActionsForDigest, ymdInTimeZone } = require('./storeActionsStore');

const AUDIT_TYPE_LABELS = {
    dfsc: 'DFSC',
    'pest-walk': 'Pest Walk',
    'rgm-cleaning': 'RGM Cleaning',
    psi: 'PSI',
    'square-one': 'Square One',
    'core-ops': 'CORE Operations',
    'core-food-safety': 'CORE Food Safety',
    'visit-coach': 'Visiting as a Coach',
    'visit-customer': 'Visiting as a Customer',
};

function emailFromAddress() {
    return (
        String(process.env.TACAUDIT_EMAIL_FROM || '').trim() ||
        String(process.env.DASHBOARD_SMTP_USER || '').trim() ||
        'noreply@example.com'
    );
}

function getAuditLabel(auditType) {
    const cfg = getAuditTypeConfig(auditType);
    return cfg?.label || AUDIT_TYPE_LABELS[auditType] || auditType;
}

function sessionReferenceIso(session) {
    const raw = session?.completedAt || session?.dateKey || session?.periodKey || '';
    if (!raw) return '';
    return raw.includes('T') ? raw : `${raw}T12:00:00`;
}

function formatEmailDate(session) {
    const parsed = Date.parse(sessionReferenceIso(session));
    if (!Number.isFinite(parsed)) return '-';
    const d = new Date(parsed);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
}

function formatEmailTime(iso) {
    const raw = String(iso || '').trim();
    if (!raw) return '-';
    const parsed = Date.parse(raw.includes('T') ? raw : `${raw}T12:00:00`);
    if (!Number.isFinite(parsed)) return '-';
    return new Date(parsed)
        .toLocaleString('en-AU', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
        })
        .replace(/\s?(am|pm)/i, (_, meridiem) => ` ${meridiem.toLowerCase()}`);
}

function formatEmailDuration(session) {
    const started = Date.parse(session?.startedAt || '');
    const completed = Date.parse(session?.completedAt || '');
    if (!Number.isFinite(started) || !Number.isFinite(completed) || completed <= started) return '-';
    const totalSeconds = Math.round((completed - started) / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function buildAuditReportSubject(auditType, session) {
    const label = getAuditLabel(auditType);
    const date = formatEmailDate(session);
    return `${label} ${date}`;
}

function buildAuditReportBody(auditType, session) {
    const date = formatEmailDate(session);
    const time = formatEmailTime(session.completedAt);
    const duration = formatEmailDuration(session);
    return `Attached is the audit from ${date} at ${time}. It took ${duration} to complete.`;
}

/** @deprecated Use buildAuditReportBody */
function buildDefaultReportText({ auditType, session }) {
    return buildAuditReportBody(auditType, session);
}

async function sendAuditReportEmail({ storeNumber, auditType, session, pdfBuffer, buildFilename, buildText }) {
    const settings = getSettings(storeNumber);
    const to = settings.reportEmail;
    if (!to) {
        console.info(`[Tacaudit] Report email skipped for store ${storeNumber}: no reportEmail configured.`);
        return;
    }

    let nodemailer;
    try {
        nodemailer = require('nodemailer');
    } catch {
        console.info('[Tacaudit] nodemailer not available; report email not sent.');
        return;
    }

    const label = getAuditLabel(auditType);
    const subject = buildAuditReportSubject(auditType, session);

    const host = String(process.env.DASHBOARD_SMTP_HOST || '').trim();
    if (!host) {
        console.info('[Tacaudit] DASHBOARD_SMTP_HOST not set; report email not sent.');
        return;
    }

    const port = Number(process.env.DASHBOARD_SMTP_PORT || 587);
    const user = String(process.env.DASHBOARD_SMTP_USER || '').trim();
    const pass = String(process.env.DASHBOARD_SMTP_PASS || '').trim();
    // Validate TLS certs by default; set DASHBOARD_SMTP_ALLOW_SELF_SIGNED=true
    // only for servers with self-signed certificates.
    const allowSelfSigned = /^(1|true|yes|on)$/i.test(
        String(process.env.DASHBOARD_SMTP_ALLOW_SELF_SIGNED ?? '').trim()
    );

    const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: user ? { user, pass } : undefined,
        tls: { rejectUnauthorized: !allowSelfSigned },
    });

    const intro = buildAuditReportBody(auditType, session);
    const emailContent =
        typeof buildText === 'function'
            ? { html: null, text: buildText(session), attachments: [] }
            : buildAuditEmailContent(auditType, session, intro);

    const filename =
        typeof buildFilename === 'function' ? buildFilename(session) : `${label}-report.pdf`;

    const attachments = [
        {
            filename,
            content: pdfBuffer,
            contentType: 'application/pdf',
        },
        ...(emailContent.attachments || []),
    ];

    const mail = {
        from: emailFromAddress(),
        to,
        subject,
        text: emailContent.text,
        attachments,
    };
    if (emailContent.html) {
        mail.html = emailContent.html;
    }

    await transporter.sendMail(mail);
}

function formatYmdDisplay(ymd) {
    const raw = String(ymd || '').trim();
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return raw || '-';
    return `${m[3]}/${m[2]}/${m[1]}`;
}

function buildActionDigestLines(actions) {
    return actions.map((action) => {
        const audit = action.auditLabel || getAuditLabel(action.auditType);
        const due = action.dueDate ? formatYmdDisplay(action.dueDate) : 'No due date';
        const text = String(action.text || '').trim();
        return `• ${audit} — ${action.label || action.questionId} (due ${due})\n  ${text}`;
    });
}

function buildActionsDigestBody({ storeName, overdue, dueSoon, soonDays }) {
    const lines = [`Open corrective actions for ${storeName}`, ''];
    if (overdue.length) {
        lines.push('Overdue', ...buildActionDigestLines(overdue), '');
    }
    if (dueSoon.length) {
        lines.push(`Due within ${soonDays} days`, ...buildActionDigestLines(dueSoon), '');
    }
    return lines.join('\n').trim();
}

function buildActionsDigestHtml({ storeName, overdue, dueSoon, soonDays }) {
    const section = (title, items) => {
        if (!items.length) return '';
        const rows = items
            .map((action) => {
                const audit = action.auditLabel || getAuditLabel(action.auditType);
                const due = action.dueDate ? formatYmdDisplay(action.dueDate) : 'No due date';
                return `<li><strong>${audit}</strong> — ${action.label || action.questionId}<br><span style="color:#6b7280">Due ${due}</span><br>${String(action.text || '').replace(/</g, '&lt;')}</li>`;
            })
            .join('');
        return `<h3 style="margin:16px 0 8px;font-size:16px">${title}</h3><ul style="margin:0;padding-left:20px">${rows}</ul>`;
    };
    return `<div style="font-family:system-ui,sans-serif;color:#111827">
        <p>Open corrective actions for <strong>${storeName}</strong></p>
        ${section('Overdue', overdue)}
        ${section(`Due within ${soonDays} days`, dueSoon)}
    </div>`;
}

async function sendOpenActionsDigestEmail({ storeNumber }) {
    const store = String(storeNumber || '').trim();
    const settings = getSettings(store);
    const to = settings.reportEmail;
    if (!to) {
        return { sent: false, reason: 'no_email' };
    }

    const soonDays = settings.actionsSoonDays || 2;
    const { overdue, dueSoon } = listActionsForDigest(store, { soonDays });
    if (!overdue.length && !dueSoon.length) {
        return { sent: false, reason: 'empty' };
    }

    let nodemailer;
    try {
        nodemailer = require('nodemailer');
    } catch {
        console.info('[Tacaudit] nodemailer not available; actions digest not sent.');
        return { sent: false, reason: 'no_mailer' };
    }

    const host = String(process.env.DASHBOARD_SMTP_HOST || '').trim();
    if (!host) {
        console.info('[Tacaudit] DASHBOARD_SMTP_HOST not set; actions digest not sent.');
        return { sent: false, reason: 'no_smtp' };
    }

    const cfg = getStoreConfig(store) || {};
    const tz = String(cfg.timeZone || 'Australia/Melbourne').trim();
    const todayYmd = ymdInTimeZone(new Date(), tz);
    const subject = `Open actions ${formatYmdDisplay(todayYmd)}`;
    const storeName = String(cfg.storeName || store).trim();

    const port = Number(process.env.DASHBOARD_SMTP_PORT || 587);
    const user = String(process.env.DASHBOARD_SMTP_USER || '').trim();
    const pass = String(process.env.DASHBOARD_SMTP_PASS || '').trim();
    const allowSelfSigned = /^(1|true|yes|on)$/i.test(
        String(process.env.DASHBOARD_SMTP_ALLOW_SELF_SIGNED ?? '').trim()
    );

    const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: user ? { user, pass } : undefined,
        tls: { rejectUnauthorized: !allowSelfSigned },
    });

    const bodyArgs = { storeName, overdue, dueSoon, soonDays };
    await transporter.sendMail({
        from: emailFromAddress(),
        to,
        subject,
        text: buildActionsDigestBody(bodyArgs),
        html: buildActionsDigestHtml(bodyArgs),
    });

    saveSettings(store, { lastActionsDigestDate: todayYmd });
    return { sent: true };
}

module.exports = {
    AUDIT_TYPE_LABELS,
    emailFromAddress,
    buildAuditReportSubject,
    buildAuditReportBody,
    formatEmailDate,
    formatEmailTime,
    formatEmailDuration,
    sendAuditReportEmail,
    sendOpenActionsDigestEmail,
};
