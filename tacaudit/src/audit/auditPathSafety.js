// Guards user-supplied values (session IDs, period/date keys, audit types)
// before they are used as filesystem path segments, blocking traversal like
// `../../other` sneaking through path.join.
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function safePathSegment(value, label = 'path segment') {
    const segment = String(value ?? '').trim();
    if (!segment || segment.includes('..') || !SAFE_SEGMENT.test(segment)) {
        throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
    }
    return segment;
}

module.exports = { safePathSegment };
