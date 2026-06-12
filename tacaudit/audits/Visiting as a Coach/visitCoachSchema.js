const { createPeriodAuditSchema } = require('../../src/audit/periodAuditSchema');
const generated = require('./visitCoachQuestions.generated.json');

module.exports = createPeriodAuditSchema(generated);
