const schema = require('./coreOpsSchema');
const { buildPeriodAuditReportPdf, buildPeriodAuditReportFilename } = require('../../src/audit/periodAuditReport');

async function buildCoreOpsReportPdf(session) {
    return buildPeriodAuditReportPdf(session, schema);
}

function buildReportFilename(session) {
    return buildPeriodAuditReportFilename(session, schema);
}

module.exports = { buildCoreOpsReportPdf, buildReportFilename };
