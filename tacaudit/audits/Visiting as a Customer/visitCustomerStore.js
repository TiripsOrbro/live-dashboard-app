const path = require('path');
const { createPeriodAuditStore } = require('../../src/audit/periodAuditStore');
const schema = require('./visitCustomerSchema');
const paths = require('../../../src/paths');

module.exports = createPeriodAuditStore({
    auditType: 'visit-customer',
    dataDir: path.join(paths.tacaudit.data, 'visit-customer'),
    schema,
});
