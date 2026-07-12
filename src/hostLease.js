/**
 * Desktop Host lease — only one active Host at a time.
 * Stored under users/data/host-lease.json so all clients share the same truth via the live server.
 */

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const LEASE_PATH = path.join(paths.users.data, 'host-lease.json');
const STALE_MS = Math.max(60_000, Number(process.env.HOST_LEASE_STALE_MS || 3 * 60 * 1000));

function ensureDir() {
    fs.mkdirSync(path.dirname(LEASE_PATH), { recursive: true });
}

function readLease() {
    try {
        if (!fs.existsSync(LEASE_PATH)) return null;
        const raw = JSON.parse(fs.readFileSync(LEASE_PATH, 'utf8'));
        if (!raw || typeof raw !== 'object') return null;
        return raw;
    } catch {
        return null;
    }
}

function writeLease(lease) {
    ensureDir();
    fs.writeFileSync(LEASE_PATH, JSON.stringify(lease, null, 2), 'utf8');
    return lease;
}

function isActive(lease, now = Date.now()) {
    if (!lease || !lease.hostId) return false;
    const last = Number(lease.lastSeenAt || lease.claimedAt || 0);
    return now - last < STALE_MS;
}

function publicStatus(now = Date.now()) {
    const lease = readLease();
    if (!isActive(lease, now)) {
        return {
            hasActiveHost: false,
            staleMs: STALE_MS,
            lease: null,
        };
    }
    return {
        hasActiveHost: true,
        staleMs: STALE_MS,
        lease: {
            hostId: lease.hostId,
            displayName: lease.displayName || lease.hostname || 'Another PC',
            hostname: lease.hostname || '',
            platform: lease.platform || '',
            claimedAt: lease.claimedAt,
            lastSeenAt: lease.lastSeenAt,
            message: lease.message || '',
        },
    };
}

function claim({ hostId, displayName, hostname, platform, takeover, message }) {
    const id = String(hostId || '').trim();
    if (!id) {
        return { ok: false, error: 'hostId required' };
    }
    const now = Date.now();
    const current = readLease();
    const active = isActive(current, now);

    if (active && current.hostId !== id && !takeover) {
        return {
            ok: false,
            conflict: true,
            error: 'Another Host is already active',
            status: publicStatus(now),
        };
    }

    const demoted = active && current.hostId !== id
        ? {
              hostId: current.hostId,
              displayName: current.displayName || current.hostname || 'Previous host',
              demotedAt: now,
              demotedBy: displayName || hostname || id,
              message:
                  message ||
                  `${displayName || hostname || 'Another PC'} took over as Host. This PC is now a Client.`,
          }
        : null;

    const lease = writeLease({
        hostId: id,
        displayName: String(displayName || hostname || id).trim(),
        hostname: String(hostname || '').trim(),
        platform: String(platform || '').trim(),
        claimedAt: current && current.hostId === id ? current.claimedAt || now : now,
        lastSeenAt: now,
        message: demoted ? demoted.message : '',
        demotedPrevious: demoted,
    });

    return {
        ok: true,
        takeover: Boolean(demoted),
        lease: publicStatus(now).lease,
        demoted,
    };
}

function heartbeat({ hostId }) {
    const id = String(hostId || '').trim();
    if (!id) return { ok: false, error: 'hostId required' };
    const now = Date.now();
    const current = readLease();
    if (!current || current.hostId !== id) {
        return {
            ok: false,
            demoted: true,
            error: 'This PC is no longer the active Host',
            status: publicStatus(now),
            demotionMessage:
                current?.demotedPrevious?.hostId === id
                    ? current.demotedPrevious.message
                    : current?.message ||
                      'Another PC took over hosting. This PC should switch to Client mode.',
        };
    }
    current.lastSeenAt = now;
    writeLease(current);
    return { ok: true, lease: publicStatus(now).lease };
}

function release({ hostId }) {
    const id = String(hostId || '').trim();
    const current = readLease();
    if (!current) return { ok: true, released: false };
    if (id && current.hostId !== id) {
        return { ok: false, error: 'Only the active Host can release the lease' };
    }
    try {
        fs.unlinkSync(LEASE_PATH);
    } catch {
        writeLease({ hostId: '', lastSeenAt: 0 });
    }
    return { ok: true, released: true };
}

function attach(app, { liveEvents } = {}) {
    app.get('/api/host/status', (_req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, ...publicStatus() });
    });

    app.post('/api/host/claim', (req, res) => {
        const body = req.body || {};
        const result = claim({
            hostId: body.hostId,
            displayName: body.displayName,
            hostname: body.hostname,
            platform: body.platform,
            takeover: Boolean(body.takeover),
            message: body.message,
        });
        if (!result.ok) {
            res.status(result.conflict ? 409 : 400).json({ success: false, ...result });
            return;
        }
        if (result.takeover && liveEvents) {
            liveEvents.bump('host.demoted', {
                demoted: result.demoted,
                newHost: result.lease,
            });
            liveEvents.bump('host.claimed', { lease: result.lease });
        } else if (liveEvents) {
            liveEvents.bump('host.claimed', { lease: result.lease });
        }
        res.json({ success: true, ...result });
    });

    app.post('/api/host/heartbeat', (req, res) => {
        const result = heartbeat({ hostId: req.body?.hostId });
        if (!result.ok && result.demoted && liveEvents) {
            liveEvents.bump('host.demoted', {
                message: result.demotionMessage,
                status: result.status,
            });
        }
        res.status(result.ok ? 200 : 409).json({ success: result.ok, ...result });
    });

    app.post('/api/host/release', (req, res) => {
        const result = release({ hostId: req.body?.hostId });
        if (result.ok && liveEvents) {
            liveEvents.bump('host.released', {});
        }
        res.status(result.ok ? 200 : 403).json({ success: result.ok, ...result });
    });
}

module.exports = {
    LEASE_PATH,
    STALE_MS,
    readLease,
    publicStatus,
    claim,
    heartbeat,
    release,
    attach,
};
