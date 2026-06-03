const { TIME_ZONE } = require('./upselling/upsellingConfig');

function zoneHourMinuteSecond(timeZone = TIME_ZONE, d = new Date()) {
    const parts = new Intl.DateTimeFormat('en-AU', {
        timeZone: String(timeZone || TIME_ZONE),
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).formatToParts(d);
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    return { hour: get('hour'), minute: get('minute'), second: get('second') };
}

function sumHourSlice(values, start, end) {
    return values.slice(start, end).reduce((sum, v) => sum + (Number(v) || 0), 0);
}

function getActualCellClass(actual, forecast) {
    const f = Number(forecast) || 0;
    const a = Number(actual) || 0;
    if (f <= 0) return 'cell-green';
    const ratio = (a - f) / f;
    if (ratio >= 0) return 'cell-green';
    if (ratio >= -0.1) return 'cell-orange';
    return 'cell-red';
}

function getPaceClass(actual, forecast, elapsedProgress) {
    const f = Number(forecast) || 0;
    const a = Number(actual) || 0;
    const p = Number(elapsedProgress) || 0;
    if (f <= 0 || p <= 0) return 'cell-green';

    const expectedSales = f * p;
    if (a >= expectedSales) return 'cell-green';

    const shortfall = (expectedSales - a) / expectedSales;
    if (shortfall <= 0.1) return 'cell-orange';
    return 'cell-red';
}

function getCurrentHourProgress(openHour, hourCount) {
    const startHour = Number(openHour) || 10;
    const tradeEndHourExclusive = startHour + hourCount;
    const gridColoursEndHourExclusive = tradeEndHourExclusive + 1;
    const { hour, minute, second } = zoneHourMinuteSecond();

    if (hour < startHour || hour >= gridColoursEndHourExclusive) {
        return { hourIndex: -1, progress: 0 };
    }
    if (hour >= tradeEndHourExclusive) {
        return { hourIndex: hourCount, progress: 1 };
    }
    const hourIndex = hour - startHour;
    const progress = minute / 60 + second / 3600;
    return { hourIndex, progress };
}

function getWallClockPeriodProgress(startHour, endHourExclusive) {
    const { hour, minute, second } = zoneHourMinuteSecond();
    const nowHourFloat = hour + minute / 60 + second / 3600;
    if (nowHourFloat <= startHour) return 0;
    if (nowHourFloat >= endHourExclusive) return 1;
    return (nowHourFloat - startHour) / (endHourExclusive - startHour);
}

function getPeriodExpectedSoFarSlice(forecasts, startIdx, endExclusive, hourProgress) {
    const { hourIndex, progress } = hourProgress;
    let expected = 0;
    for (let i = startIdx; i < endExclusive; i++) {
        const f = Number(forecasts[i]) || 0;
        if (hourIndex < 0) break;
        if (i < hourIndex) expected += f;
        else if (i === hourIndex) {
            expected += f * progress;
            break;
        } else break;
    }
    return expected;
}

function getPeriodActualSoFarSlice(actuals, startIdx, endExclusive, hourProgress) {
    const { hourIndex } = hourProgress;
    if (hourIndex < 0) return 0;
    let actual = 0;
    for (let i = startIdx; i < endExclusive; i++) {
        if (i <= hourIndex) actual += Number(actuals[i]) || 0;
        else break;
    }
    return actual;
}

/**
 * Dashboard-aligned day progress: time fill + outcome (beat forecast) + pace strip.
 */
function computeDaySalesPresentation(options = {}) {
    const actuals = Array.isArray(options.actual) ? options.actual : [];
    const forecasts = Array.isArray(options.forecast) ? options.forecast : [];
    const openHour = Number.isFinite(options.openHour) ? Math.trunc(options.openHour) : 10;
    const closeHour = Number.isFinite(options.closeHour) ? Math.trunc(options.closeHour) : 22;
    const hourCount = Math.max(actuals.length, forecasts.length);

    if (!hourCount) {
        return {
            phase: 'empty',
            timeFillPercent: 0,
            outcomeClass: 'cell-green',
            paceClass: 'cell-green',
        };
    }

    const startIdx = 0;
    const endExclusive = hourCount;
    const hourProgress = getCurrentHourProgress(openHour, hourCount);
    const totalForecast = sumHourSlice(forecasts, startIdx, endExclusive);
    const totalActual = sumHourSlice(actuals, startIdx, endExclusive);
    const { hour, minute, second } = zoneHourMinuteSecond();
    const nowHourFloat = hour + minute / 60 + second / 3600;
    const wallPct = Math.round(getWallClockPeriodProgress(openHour, closeHour) * 1000) / 10;

    if (nowHourFloat < openHour) {
        return {
            phase: 'before',
            timeFillPercent: 0,
            outcomeClass: totalForecast > 0 ? getActualCellClass(totalActual, totalForecast) : 'cell-green',
            paceClass: 'cell-green',
        };
    }

    if (nowHourFloat >= closeHour) {
        const outcomeClass = totalForecast > 0 ? getActualCellClass(totalActual, totalForecast) : 'cell-green';
        let paceClass = 'cell-green';
        if (totalForecast > 0) {
            paceClass = getPaceClass(totalActual, totalForecast, 1);
        }
        return {
            phase: 'after',
            timeFillPercent: 100,
            outcomeClass,
            paceClass,
        };
    }

    let paceClass = 'cell-green';
    if (totalForecast <= 0) {
        paceClass = 'cell-green';
    } else {
        const expectedSoFar = getPeriodExpectedSoFarSlice(forecasts, startIdx, endExclusive, hourProgress);
        const actualSoFar = getPeriodActualSoFarSlice(actuals, startIdx, endExclusive, hourProgress);
        const ep = totalForecast > 0 ? expectedSoFar / totalForecast : 0;
        if (expectedSoFar <= 0) {
            paceClass = 'cell-green';
        } else {
            paceClass = getPaceClass(actualSoFar, totalForecast, ep);
        }
    }

    const outcomeClass = totalForecast > 0 ? getActualCellClass(totalActual, totalForecast) : 'cell-green';

    return {
        phase: 'during',
        timeFillPercent: wallPct,
        outcomeClass,
        paceClass,
    };
}

module.exports = {
    computeDaySalesPresentation,
    getActualCellClass,
    getPaceClass,
};
