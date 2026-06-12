const { createPeriodAuditSchema } = require('../../src/audit/periodAuditSchema');
const generated = require('./visitCustomerQuestions.generated.json');

module.exports = createPeriodAuditSchema(generated);
