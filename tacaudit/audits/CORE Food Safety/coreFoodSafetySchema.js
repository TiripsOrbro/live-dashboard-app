const { createPeriodAuditSchema } = require('../../src/audit/periodAuditSchema');
const generated = require('./coreFoodSafetyQuestions.generated.json');

module.exports = createPeriodAuditSchema(generated);
