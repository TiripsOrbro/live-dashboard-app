const schema = require('./visitCoachSchema');
const { buildPeriodAuditReportPdf, buildPeriodAuditReportFilename } = require('../../src/audit/periodAuditReport');

async function buildVisitCoachReportPdf(session) {
    return buildPeriodAuditReportPdf(session, schema);
}

function buildReportFilename(session) {
    return buildPeriodAuditReportFilename(session, schema);
}

module.exports = { buildVisitCoachReportPdf, buildReportFilename };
