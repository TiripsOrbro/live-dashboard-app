const path = require('path');
const { createPeriodAuditStore } = require('../../src/audit/periodAuditStore');
const schema = require('./visitCoachSchema');
const paths = require('../../../src/paths');

module.exports = createPeriodAuditStore({
    auditType: 'visit-coach',
    dataDir: path.join(paths.tacaudit.data, 'visit-coach'),
    schema,
});
