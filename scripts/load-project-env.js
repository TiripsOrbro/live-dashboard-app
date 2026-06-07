const path = require('path');
const { loadEnv } = require('../src/loadEnv');

loadEnv({ root: path.join(__dirname, '..') });
