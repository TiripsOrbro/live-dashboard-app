const { downscaleSessionImages } = require('./imageDownscale');
const { saveArchivePdf } = require('./tacauditArchive');
const { sendAuditReportEmail } = require('./tacauditEmail');
const { getAuditTypeConfig, summarizeSessionMeta } = require('./auditRegistry');

function afterAuditSubmit({ storeNumber, auditType, session }) {
    const cfg = getAuditTypeConfig(auditType);
    if (!cfg || cfg.placeholder || typeof cfg.buildPdf !== 'function') return;

    void (async () => {
        try {
            const pdfBuffer = await cfg.buildPdf(session);
            await sendAuditReportEmail({
                storeNumber,
                auditType,
                session,
                pdfBuffer,
                buildFilename: cfg.buildFilename,
                buildText: cfg.buildText,
            });

            const downscaled = await downscaleSessionImages(session);
            const archivePdf = await cfg.buildPdf(downscaled);
            saveArchivePdf({
                storeNumber,
                auditType,
                sessionId: session.id,
                completedAt: session.completedAt,
                meta: summarizeSessionMeta(session, auditType),
                pdfBuffer: archivePdf,
            });
        } catch (err) {
            console.info(`[Tacaudit] post-submit failed (${auditType}):`, err.message);
        }
    })();
}

module.exports = {
    afterAuditSubmit,
};
