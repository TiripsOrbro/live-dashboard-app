/** @deprecated Use tacaudit email pipeline via afterAuditSubmit */
const { sendAuditReportEmail } = require('../tacaudit/tacauditEmail');
const { buildDfscReportText, buildDfscReportPdf, buildReportFilename } = require('./dfscReport');

async function sendDfscReportEmail(session) {
    try {
        const pdfBuffer = await buildDfscReportPdf(session);
        const storeNumber = session.storeNumber || '';
        await sendAuditReportEmail({
            storeNumber,
            auditType: 'dfsc',
            session,
            pdfBuffer,
            buildFilename: buildReportFilename,
            buildText: buildDfscReportText,
        });
    } catch (err) {
        console.info('[DFSC] Report email not sent:', err.message);
    }
}

module.exports = {
    sendDfscReportEmail,
};
