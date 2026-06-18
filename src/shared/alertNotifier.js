/**
 * Optional scrape-failure alerts via webhook and/or SMTP email.
 * Configure in `.env` - all vars optional; alerts are rate-limited.
 */
const ALERT_COOLDOWN_MS = Number(process.env.DASHBOARD_ALERT_COOLDOWN_MS || 30 * 60 * 1000);

let lastAlertAt = 0;
let lastAlertMessage = '';

function alertsEnabled() {
    return Boolean(
        String(process.env.DASHBOARD_ALERT_WEBHOOK_URL || '').trim() ||
            (String(process.env.DASHBOARD_ALERT_EMAIL || '').trim() &&
                String(process.env.DASHBOARD_SMTP_HOST || '').trim())
    );
}

function shouldSendAlert(message) {
    if (!alertsEnabled()) return false;
    const now = Date.now();
    if (now - lastAlertAt < ALERT_COOLDOWN_MS && message === lastAlertMessage) return false;
    lastAlertAt = now;
    lastAlertMessage = message;
    return true;
}

async function postWebhook(message) {
    const url = String(process.env.DASHBOARD_ALERT_WEBHOOK_URL || '').trim();
    if (!url) return;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            content: message,
            text: message,
        }),
    });
    if (!res.ok) {
        throw new Error(`Webhook alert failed (${res.status})`);
    }
}

async function sendEmail(message) {
    const to = String(process.env.DASHBOARD_ALERT_EMAIL || '').trim();
    const host = String(process.env.DASHBOARD_SMTP_HOST || '').trim();
    if (!to || !host) return;

    let nodemailer;
    try {
        nodemailer = require('nodemailer');
    } catch {
        console.warn('[Alert] nodemailer not installed - run npm install to enable email alerts');
        return;
    }

    const port = Number(process.env.DASHBOARD_SMTP_PORT || 587);
    const user = String(process.env.DASHBOARD_SMTP_USER || '').trim();
    const pass = String(process.env.DASHBOARD_SMTP_PASS || '').trim();
    const from = String(process.env.DASHBOARD_SMTP_FROM || user || 'dashboard@localhost').trim();

    const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: user ? { user, pass } : undefined,
    });

    await transporter.sendMail({
        from,
        to,
        subject: 'TBA Dashboard - scrape failure',
        text: message,
    });
}

async function notifyScrapeFailure(error, context = 'background refresh') {
    const msg = `[TBA Dashboard] Scrape failed (${context}): ${error?.message || String(error)}`;
    if (!shouldSendAlert(msg)) return;

    console.warn('[Alert] Sending scrape failure notification');
    const tasks = [];
    if (process.env.DASHBOARD_ALERT_WEBHOOK_URL) {
        tasks.push(postWebhook(msg).catch((e) => console.warn('[Alert] Webhook failed:', e.message)));
    }
    if (process.env.DASHBOARD_ALERT_EMAIL && process.env.DASHBOARD_SMTP_HOST) {
        tasks.push(sendEmail(msg).catch((e) => console.warn('[Alert] Email failed:', e.message)));
    }
    await Promise.all(tasks);
}

module.exports = {
    alertsEnabled,
    notifyScrapeFailure,
};
