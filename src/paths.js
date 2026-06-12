const path = require('path');

const root = process.env.PROJECT_ROOT || path.join(__dirname, '..');

function domain(name) {
    const base = path.join(root, name);
    return {
        root: base,
        src: path.join(base, 'src'),
        public: path.join(base, 'public'),
        data: path.join(base, 'data'),
        config: path.join(base, 'config'),
        scripts: path.join(base, 'scripts'),
    };
}

const dashboard = domain('dashboard');
const vendors = {
    ...domain('vendors'),
    catalogs: process.env.VENDOR_CATALOGS_DIR || path.join(root, 'vendors', 'catalogs'),
    reports: process.env.VENDOR_REPORTS_DIR || path.join(root, 'vendors', 'reports'),
};
const stores = {
    ...domain('stores'),
    storelist: process.env.STORELIST_PATH || path.join(root, 'stores', '.storelist'),
};
const users = {
    ...domain('users'),
    accounts: process.env.USERS_ACCOUNTS_DIR || path.join(root, 'users', 'accounts'),
};
const mmx = domain('mmx');
const tacaudit = domain('tacaudit');
const smg = domain('smg');
const nsf = domain('nsf');

module.exports = {
    root,
    sharedPublic: path.join(root, 'public', 'shared'),
    sharedSrc: path.join(root, 'src', 'shared'),
    legacy: {
        data: path.join(root, 'data'),
        config: path.join(root, 'config'),
        public: path.join(root, 'public'),
        scripts: path.join(root, 'scripts'),
    },
    dashboard,
    vendors,
    stores,
    users,
    mmx,
    tacaudit,
    smg,
    nsf,
};
