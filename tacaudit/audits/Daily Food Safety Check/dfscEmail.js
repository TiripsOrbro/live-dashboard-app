/** @deprecated Use tacaudit email pipeline via afterAuditSubmit */
const { sendAuditReportEmail } = require('../../src/core/tacauditEmail');
const { buildDfscReportPdf, buildReportFilename } = require('./dfscReport');

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
        });
    } catch (err) {
        console.info('[DFSC] Report email not sent:', err.message);
    }
}

module.exports = {
    sendDfscReportEmail,
};
