const schema = require('./visitCustomerSchema');
const { buildPeriodAuditReportPdf, buildPeriodAuditReportFilename } = require('../../src/audit/periodAuditReport');

async function buildVisitCustomerReportPdf(session) {
    return buildPeriodAuditReportPdf(session, schema);
}

function buildReportFilename(session) {
    return buildPeriodAuditReportFilename(session, schema);
}

module.exports = { buildVisitCustomerReportPdf, buildReportFilename };
