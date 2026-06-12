const { trimHourlyToTradingWindow, zoneHourMinuteSecond } = require('../salesProgress');

/**
 * Sum Last Year sales from store open up to `now`, using 15-minute slots with
 * linear interpolation within the current partial slot.
 */
function computeLastYearSalesSoFar(slots, openHour, closeHour, timeZone, now = new Date()) {
    if (!Array.isArray(slots) || !slots.length) return 0;

    const { hour, minute, second } = zoneHourMinuteSecond(timeZone, now);
    const nowMinutes = hour * 60 + minute + second / 60;
    const openMinutes = Math.trunc(openHour) * 60;
    const closeMinutes = Math.trunc(closeHour) * 60;

    if (nowMinutes <= openMinutes) return 0;

    let total = 0;
    for (const slot of slots) {
        if (slot.endMinutes <= openMinutes) continue;
        if (slot.startMinutes >= closeMinutes) continue;
        if (slot.startMinutes >= nowMinutes) break;

        const value = Number(slot.value) || 0;
        if (nowMinutes >= slot.endMinutes) {
            total += value;
        } else {
            const slotDuration = slot.endMinutes - slot.startMinutes;
            if (slotDuration <= 0) continue;
            const elapsed = Math.max(0, nowMinutes - slot.startMinutes);
            total += value * (elapsed / slotDuration);
        }
    }

    return total;
}

/**
 * Sum actual sales from store open up to `now` using hourly Labour Scheduler data.
 * The Labour Scheduler's current-hour cell already contains only the sales taken
 * so far in that hour, so it is added in full — interpolating it again would
 * double-discount the current hour and understate SSSG.
 */
function computeActualSalesSoFar(actual, forecast, openHour, closeHour, timeZone, now = new Date()) {
    const trimmed = trimHourlyToTradingWindow(actual, forecast, openHour, closeHour);
    const actuals = trimmed.actual;
    if (!actuals.length) return 0;

    const { hour, minute, second } = zoneHourMinuteSecond(timeZone, now);
    const nowHourFloat = hour + minute / 60 + second / 3600;
    const open = Math.trunc(openHour);
    const close = Math.trunc(closeHour);

    if (nowHourFloat < open) return 0;

    if (nowHourFloat >= close) {
        return actuals.reduce((sum, v) => sum + (Number(v) || 0), 0);
    }

    let total = 0;
    for (let i = 0; i < actuals.length; i++) {
        const slotHour = open + i;
        if (slotHour > hour) break;
        total += Number(actuals[i]) || 0;
    }

    return total;
}

/**
 * Sum full trading-day actual sales (no partial-hour interpolation).
 */
function computeFullDayActualTotal(actual, forecast, openHour, closeHour) {
    const trimmed = trimHourlyToTradingWindow(actual, forecast, openHour, closeHour);
    return trimmed.actual.reduce((sum, v) => sum + (Number(v) || 0), 0);
}

/**
 * Sum full trading-day Last Year sales from quarter-hour slots (no interpolation).
 */
function computeFullDayLyTotal(slots, openHour, closeHour) {
    if (!Array.isArray(slots) || !slots.length) return 0;
    const openMinutes = Math.trunc(openHour) * 60;
    const closeMinutes = Math.trunc(closeHour) * 60;
    let total = 0;
    for (const slot of slots) {
        if (slot.endMinutes <= openMinutes) continue;
        if (slot.startMinutes >= closeMinutes) continue;
        total += Number(slot.value) || 0;
    }
    return total;
}

/** SSSG % from dollar totals. */
function computeSssgPercentFromTotals(actualTotal, lyTotal) {
    const ly = Number(lyTotal) || 0;
    const actual = Number(actualTotal) || 0;
    if (ly <= 0) return null;
    return Math.round(((actual - ly) / ly) * 1000) / 10;
}

/**
 * SSSG % = ((actualSoFar - salesLySoFar) / salesLySoFar) * 100
 */
function computeSssgPercent(options = {}) {
    const {
        slots,
        actual,
        forecast,
        openHour,
        closeHour,
        timeZone,
        now = new Date(),
    } = options;

    const ly = computeLastYearSalesSoFar(slots, openHour, closeHour, timeZone, now);
    if (ly <= 0) return null;

    const actualSoFar = computeActualSalesSoFar(actual, forecast, openHour, closeHour, timeZone, now);
    const pct = ((actualSoFar - ly) / ly) * 100;
    return Math.round(pct * 10) / 10;
}

module.exports = {
    computeLastYearSalesSoFar,
    computeActualSalesSoFar,
    computeFullDayActualTotal,
    computeFullDayLyTotal,
    computeSssgPercentFromTotals,
    computeSssgPercent,
};
