const fs = require('fs').promises;
const path = require('path');

const ORDERS_READY_POPUP_MS = Number(process.env.ORDERS_READY_POPUP_MS || 600000);

function resolveTimeZone() {
    return process.env.DASHBOARD_TIME_ZONE || process.env.MMX_TIME_ZONE || 'Australia/Melbourne';
}

function todayKeyMelbourne(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: resolveTimeZone(),
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(date);
}

function resolveSignalPath() {
    const env = String(process.env.DASHBOARD_ORDERS_READY_FILE || '').trim();
    if (env) return path.resolve(env);
    return path.join(__dirname, '../../data/orders-ready-for-review.json');
}

function resolveAckPath() {
    const env = String(process.env.DASHBOARD_ORDERS_READY_ACK_FILE || '').trim();
    if (env) return path.resolve(env);
    return path.join(__dirname, '../../data/orders-ready-ack.json');
}

async function readOrdersReadyAck() {
    try {
        const raw = await fs.readFile(resolveAckPath(), 'utf8');
        const data = JSON.parse(raw);
        return {
            date: String(data.date || '').trim(),
            completedAt: String(data.completedAt || '').trim(),
        };
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn('[Dashboard] orders-ready ack read failed:', error.message);
        }
        return { date: '', completedAt: '' };
    }
}

async function markOrdersReadyAcknowledged(completedAt = '') {
    const filePath = resolveAckPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
        filePath,
        JSON.stringify(
            {
                date: todayKeyMelbourne(),
                completedAt: String(completedAt || '').trim(),
                acknowledgedAt: new Date().toISOString(),
            },
            null,
            2
        ),
        'utf8'
    );
}

async function readOrdersReadyForReview(now = Date.now()) {
    const today = todayKeyMelbourne(new Date(now));
    const ack = await readOrdersReadyAck();
    const alreadyShownToday = ack.date === today;

    const filePath = resolveSignalPath();
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        const data = JSON.parse(raw);
        const completedAt = String(data.completedAt || '').trim();
        const completedMs = Date.parse(completedAt);
        if (!completedAt || !Number.isFinite(completedMs)) {
            return { active: false, showPopup: false, alreadyShownToday };
        }

        const expiresMs = completedMs + ORDERS_READY_POPUP_MS;
        if (now >= expiresMs) {
            return { active: false, showPopup: false, completedAt, expired: true, alreadyShownToday };
        }

        const active = true;
        const showPopup = active && !alreadyShownToday;

        return {
            active,
            showPopup,
            alreadyShownToday,
            completedAt,
            expiresAt: new Date(expiresMs).toISOString(),
            remainingMs: expiresMs - now,
            ordersOk: data.ordersOk,
            ordersTotal: data.ordersTotal,
        };
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn('[Dashboard] orders-ready signal read failed:', error.message);
        }
        return { active: false, showPopup: false, alreadyShownToday };
    }
}

module.exports = {
    ORDERS_READY_POPUP_MS,
    resolveSignalPath,
    resolveAckPath,
    todayKeyMelbourne,
    readOrdersReadyAck,
    markOrdersReadyAcknowledged,
    readOrdersReadyForReview,
};
