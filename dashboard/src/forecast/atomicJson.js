const fs = require('fs');
const path = require('path');

/**
 * Write JSON via temp-file-plus-rename so a crash mid-write can never leave a
 * truncated ledger behind (matches the MMX task queue's write pattern).
 */
function writeJsonAtomic(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
}

module.exports = { writeJsonAtomic };
