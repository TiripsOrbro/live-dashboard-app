/**
 * Excel build-to workbook formulas — mirrors New - Build To spreadsheet logic.
 * NEED = 0 when days holding > 10 (unless skipDaysHoldingCap); else max(0, buildTo − onHand − onOrder).
 */

const { normalizeItemCode, onOrderToCartons } = require('./reportReader');
const { allLookupKeys } = require('./itemCodes');

const BUILD_TO_DAYS = 10;
const DAYS_HOLDING_CAP = 10;

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function round4(n) {
    return Math.round(Number(n) * 10000) / 10000;
}

/** Excel XLOOKUP wildmatch: description contains label (case-insensitive). */
function lookupSohRawQty(onHandReport, sohLabel, mmxCode) {
    if (!onHandReport?.size) return 0;

    const label = String(sohLabel || '').trim().toLowerCase();
    if (label) {
        for (const row of onHandReport.values()) {
            const desc = String(row.description || '').toLowerCase();
            if (desc.includes(label)) {
                return num(row.onHandQty ?? row.quantity ?? row.qty);
            }
        }
    }

    for (const key of allLookupKeys(mmxCode)) {
        const row = onHandReport.get(normalizeItemCode(key));
        if (row) return num(row.onHandQty ?? row.quantity ?? row.qty);
    }
    return 0;
}

function sumOnOrderByMmx(onOrderReport, mmxCode, iseUnit, isePack) {
    if (!onOrderReport?.size || !mmxCode) return 0;
    let total = 0;
    for (const key of allLookupKeys(mmxCode)) {
        const hit = onOrderReport.get(normalizeItemCode(key));
        if (hit) {
            total += onOrderToCartons(hit, iseUnit, isePack, key);
        }
    }
    return total;
}

function melbourneWeekdayUpper(date = new Date()) {
    const days = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
    try {
        const fmt = new Intl.DateTimeFormat('en-AU', {
            timeZone: 'Australia/Melbourne',
            weekday: 'long',
        });
        return fmt.format(date).toUpperCase();
    } catch {
        return days[date.getDay()];
    }
}

function cutfreshBuildTo(row, calendar, weekday) {
    const day = String(weekday || '').toUpperCase();
    const itemKey = String(row.name || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, ' ');
    const dayMap = calendar?.[day];
    if (!dayMap) return 0;
    if (dayMap[itemKey] != null) return num(dayMap[itemKey]);
    for (const [k, v] of Object.entries(dayMap)) {
        if (itemKey.includes(k) || k.includes(itemKey)) return num(v);
    }
    return 0;
}

/**
 * @param {object} row — workbook JSON row
 * @param {object} params — { daily, rawOnHandQty, onHandOverride, onOrderCartons, weekday, cutfreshCalendar }
 */
function computeWorkbookLine(row, params = {}) {
    const rule = row.buildToRule || { type: 'days10' };
    const perPack = num(row.perPack) > 0 ? num(row.perPack) : 1;
    let daily = params.daily != null ? num(params.daily) : num(row.dailyManual);

    let onHand = params.onHandOverride != null ? num(params.onHandOverride) : null;
    let onOrder = num(params.onOrderCartons);
    let buildTo = 0;
    let need = 0;
    let daysHolding = 0;
    let orderQty = 0;

    if (rule.type === 'cutfresh') {
        buildTo = cutfreshBuildTo(row, params.cutfreshCalendar, params.weekday);
        if (onHand == null) {
            const raw = params.rawOnHandQty != null ? num(params.rawOnHandQty) : 0;
            onHand = daily > 0 ? raw / perPack : raw / perPack;
        }
        daysHolding = daily > 0 ? onHand / daily : 0;
        const rawNeed = Math.max(0, buildTo - onHand - onOrder);
        need = row.name?.toUpperCase().includes('LETTUCE') ? Math.ceil(rawNeed) : rawNeed;
        orderQty = need;
        return { daily, onHand, onOrder, buildTo, daysHolding, need, orderQty, ruleType: rule.type };
    }

    if (rule.type === 'pack10') {
        const inner = num(rule.innerPerCarton) > 0 ? num(rule.innerPerCarton) : 10;
        const ooFactor = num(rule.onOrderCartonFactor) > 0 ? num(rule.onOrderCartonFactor) : inner;

        if (onHand == null) {
            const raw = params.rawOnHandQty != null ? num(params.rawOnHandQty) : 0;
            onHand = raw / perPack;
        }

        buildTo = daily * BUILD_TO_DAYS * inner;
        daysHolding = daily > 0 ? onHand / (daily * inner) : 0;

        const ooInPackUnits = onOrder * ooFactor;
        const rawNeed = Math.max(0, buildTo - onHand - ooInPackUnits);
        need = rawNeed / inner;
        orderQty = need;
        return { daily, onHand, onOrder, buildTo, daysHolding, need, orderQty, ruleType: rule.type };
    }

    if (onHand == null) {
        const raw = params.rawOnHandQty != null ? num(params.rawOnHandQty) : 0;
        onHand = raw / perPack;
    }

    if (rule.type === 'fixed') {
        buildTo = num(rule.value);
    } else if (rule.type === 'days10add2') {
        buildTo = daily * BUILD_TO_DAYS + num(rule.add);
    } else {
        buildTo = daily * BUILD_TO_DAYS;
    }

    daysHolding = daily > 0 ? onHand / daily : 0;

    if (!rule.skipDaysHoldingCap && daysHolding > DAYS_HOLDING_CAP) {
        need = 0;
    } else {
        need = Math.max(0, buildTo - onHand - onOrder);
    }
    orderQty = need;

    return { daily, onHand, onOrder, buildTo, daysHolding, need, orderQty, ruleType: rule.type };
}

module.exports = {
    BUILD_TO_DAYS,
    DAYS_HOLDING_CAP,
    lookupSohRawQty,
    sumOnOrderByMmx,
    melbourneWeekdayUpper,
    cutfreshBuildTo,
    computeWorkbookLine,
    round4,
    num,
};
