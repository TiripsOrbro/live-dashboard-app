const path = require('path');
const { createPeriodAuditStore } = require('../../src/audit/periodAuditStore');
const schema = require('./coreOpsSchema');
const paths = require('../../../src/paths');

const store = createPeriodAuditStore({
    auditType: 'core-ops',
    dataDir: path.join(paths.tacaudit.data, 'core-ops'),
    schema,
});

module.exports = store;
