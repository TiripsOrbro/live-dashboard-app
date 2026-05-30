#!/usr/bin/env node
const { hashPassword } = require('../src/services/dashboardUsers');

const password = process.argv[2];
if (!password) {
    console.error('Usage: node scripts/hash-dashboard-password.js "your-password"');
    process.exit(1);
}

console.log(hashPassword(password));
