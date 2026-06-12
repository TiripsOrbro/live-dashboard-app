const schema = require('./coreFoodSafetySchema');
const { buildPeriodAuditReportPdf, buildPeriodAuditReportFilename } = require('../../src/audit/periodAuditReport');

async function buildCoreFoodSafetyReportPdf(session) {
    return buildPeriodAuditReportPdf(session, schema);
}

function buildReportFilename(session) {
    return buildPeriodAuditReportFilename(session, schema);
}

module.exports = { buildCoreFoodSafetyReportPdf, buildReportFilename };
