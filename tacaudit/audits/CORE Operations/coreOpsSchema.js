const path = require('path');
const { createPeriodAuditSchema } = require('../../src/audit/periodAuditSchema');
const generated = require('./coreOpsQuestions.generated.json');

const schema = createPeriodAuditSchema(generated);

module.exports = schema;
