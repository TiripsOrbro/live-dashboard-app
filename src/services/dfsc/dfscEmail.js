const { buildDfscReportText, buildDfscReportPdf, buildReportFilename } = require('./dfscReport');

const DFSC_EMAIL_FROM = 'from@example.com';
const DFSC_EMAIL_TO = 'to@example.com';

async function sendDfscReportEmail(session) {
    try {
        let nodemailer;
        try {
            nodemailer = require('nodemailer');
        } catch {
            return;
        }

        const reportText = buildDfscReportText(session);
        const pdfBuffer = await buildDfscReportPdf(session);
        const storeLabel = session.storeName || session.storeNumber || 'Store';
        const subject = `DFSC Report — ${storeLabel} — ${session.dateKey || ''} ${session.shift || ''}`.trim();

        const host = String(process.env.DASHBOARD_SMTP_HOST || 'smtp.example.com').trim();
        const port = Number(process.env.DASHBOARD_SMTP_PORT || 587);
        const user = String(process.env.DASHBOARD_SMTP_USER || '').trim();
        const pass = String(process.env.DASHBOARD_SMTP_PASS || '').trim();

        const transporter = nodemailer.createTransport({
            host,
            port,
            secure: port === 465,
            auth: user ? { user, pass } : undefined,
            tls: { rejectUnauthorized: false },
        });

        await transporter.sendMail({
            from: DFSC_EMAIL_FROM,
            to: DFSC_EMAIL_TO,
            subject,
            text: reportText,
            attachments: [
                {
                    filename: buildReportFilename(session),
                    content: pdfBuffer,
                    contentType: 'application/pdf',
                },
            ],
        });
    } catch (err) {
        console.info('[DFSC] Report email not sent:', err.message);
    }
}

module.exports = {
    DFSC_EMAIL_FROM,
    DFSC_EMAIL_TO,
    sendDfscReportEmail,
};
