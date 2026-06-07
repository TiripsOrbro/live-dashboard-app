const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const CHANGELOG_PATH = path.join(PROJECT_ROOT, 'CHANGELOG.md');
const PACKAGE_PATH = path.join(PROJECT_ROOT, 'package.json');

/** Changes on every PM2 / server restart so clients can prompt for a hard refresh. */
const SERVER_BOOT_ID = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
const SERVER_BOOT_AT = new Date().toISOString();

function readDashboardVersion() {
    const fromEnv = String(process.env.DASHBOARD_VERSION || '').trim();
    if (fromEnv) return fromEnv;
    try {
        const changelog = fs.readFileSync(CHANGELOG_PATH, 'utf8');
        const match = changelog.match(/\*\*Current live branch:\*\*\s*`([^`]+)`/);
        if (match) return match[1].trim();
    } catch {
        /* ignore */
    }
    try {
        const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
        if (pkg?.version) return `v${pkg.version}`;
    } catch {
        /* ignore */
    }
    return 'dev';
}

function getDashboardMeta() {
    return {
        version: readDashboardVersion(),
        bootId: SERVER_BOOT_ID,
        bootAt: SERVER_BOOT_AT,
    };
}

function readChangelogMarkdown() {
    try {
        return fs.readFileSync(CHANGELOG_PATH, 'utf8');
    } catch {
        return '# Changelog\n\nNo changelog file found on this server.\n';
    }
}

module.exports = {
    getDashboardMeta,
    readDashboardVersion,
    readChangelogMarkdown,
    SERVER_BOOT_ID,
};
