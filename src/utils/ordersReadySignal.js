const fs = require('fs').promises;
const path = require('path');

const ORDERS_READY_POPUP_MS = Number(process.env.ORDERS_READY_POPUP_MS || 600000);

function resolveSignalPath() {
    const env = String(process.env.DASHBOARD_ORDERS_READY_FILE || '').trim();
    if (env) return path.resolve(env);
    return path.join(__dirname, '../../data/orders-ready-for-review.json');
}

async function readOrdersReadyForReview(now = Date.now()) {
    const filePath = resolveSignalPath();
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        const data = JSON.parse(raw);
        const completedAt = String(data.completedAt || '').trim();
        const completedMs = Date.parse(completedAt);
        if (!completedAt || !Number.isFinite(completedMs)) return { active: false };

        const expiresMs = completedMs + ORDERS_READY_POPUP_MS;
        if (now >= expiresMs) return { active: false, completedAt, expired: true };

        return {
            active: true,
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
        return { active: false };
    }
}

module.exports = {
    ORDERS_READY_POPUP_MS,
    resolveSignalPath,
    readOrdersReadyForReview,
};
