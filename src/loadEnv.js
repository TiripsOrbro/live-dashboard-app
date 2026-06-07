const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

/** Load dashboard environment from a single `.env` at the project root (Pi + dev). */
function loadEnv(options = {}) {
    const root = options.root || path.join(__dirname, '..');
    const basePath = path.join(root, '.env');

    if (fs.existsSync(basePath)) {
        dotenv.config({ path: basePath });
        return { mode: 'env', loaded: ['.env'] };
    }
    return { mode: 'none', loaded: [] };
}

module.exports = { loadEnv };
