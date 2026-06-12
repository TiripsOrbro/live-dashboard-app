const { getSettings } = require('./tacauditStore');

const AUDIT_TYPE_LABELS = {
    dfsc: 'DFSC',
    'pest-walk': 'Pest Walk',
    'rgm-cleaning': 'RGM Cleaning',
    psi: 'PSI',
    'square-one': 'Square One',
};

function emailFromAddress() {
    return (
        String(process.env.TACAUDIT_EMAIL_FROM || '').trim() ||
        String(process.env.DASHBOARD_SMTP_USER || '').trim() ||
        'noreply@example.com'
    );
}

function buildDefaultReportText({ auditType, session, storeLabel }) {
    const label = AUDIT_TYPE_LABELS[auditType] || auditType;
    const completed = session.completedAt || '';
    return `${label} report for ${storeLabel} — completed ${completed}. See attached PDF.`;
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

    const storeLabel = session.storeName || session.storeNumber || storeNumber || 'Store';
    const label = AUDIT_TYPE_LABELS[auditType] || auditType;
    const subjectParts = [label, storeLabel];
    if (session.dateKey) subjectParts.push(session.dateKey);
    if (session.shift) subjectParts.push(session.shift);
    if (session.periodKey) subjectParts.push(session.periodKey);
    const subject = `${subjectParts.filter(Boolean).join(' — ')}`.trim();

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

    const text =
        typeof buildText === 'function'
            ? buildText(session)
            : buildDefaultReportText({ auditType, session, storeLabel });

    const filename =
        typeof buildFilename === 'function' ? buildFilename(session) : `${label}-report.pdf`;

    await transporter.sendMail({
        from: emailFromAddress(),
        to,
        subject,
        text,
        attachments: [
            {
                filename,
                content: pdfBuffer,
                contentType: 'application/pdf',
            },
        ],
    });
}

module.exports = {
    AUDIT_TYPE_LABELS,
    emailFromAddress,
    sendAuditReportEmail,
};
