const path = require('path');
const { createPeriodAuditStore } = require('../../src/audit/periodAuditStore');
const schema = require('./coreFoodSafetySchema');
const paths = require('../../../src/paths');

module.exports = createPeriodAuditStore({
    auditType: 'core-food-safety',
    dataDir: path.join(paths.tacaudit.data, 'core-food-safety'),
    schema,
});
