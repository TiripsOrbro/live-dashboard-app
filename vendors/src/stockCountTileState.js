const { listConfiguredVendors } = require('./vendorCatalog');

const TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';

function dashboardDateParts(d = new Date()) {
    const parts = new Intl.DateTimeFormat('en-AU', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(d);
    const get = (type) => Number(parts.find((part) => part.type === type)?.value);
    return { year: get('year'), month: get('month'), day: get('day') };
}

function gregorianDaysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
}

function findInstantForMelbourneYmd(year, month, day) {
    const start = Date.UTC(year, month - 1, day - 1, 0, 0, 0);
    const spanMs = 120 * 60 * 60 * 1000;
    const step = 15 * 60 * 1000;
    for (let ms = 0; ms < spanMs; ms += step) {
        const t = new Date(start + ms);
        const p = dashboardDateParts(t);
        if (p.year === year && p.month === month && p.day === day) return t;
    }
    return null;
}

function melbourneWeekdayLong(d) {
    return new Intl.DateTimeFormat('en-AU', { timeZone: TIME_ZONE, weekday: 'long' }).format(d);
}

function isMelbourneMonday(d = new Date()) {
    return melbourneWeekdayLong(d) === 'Monday';
}

function melbourneLastMondayCalendarDay(year, month) {
    const dim = gregorianDaysInMonth(year, month);
    const tLast = findInstantForMelbourneYmd(year, month, dim);
    if (!tLast) return null;
    const w = melbourneWeekdayLong(tLast);
    const iso = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7 }[w];
    if (!iso) return null;
    return dim - ((iso - 1 + 7) % 7);
}

function isMelbourneLastMondayOfMonth(d = new Date()) {
    if (!isMelbourneMonday(d)) return false;
    const { year, month, day } = dashboardDateParts(d);
    const lastMon = melbourneLastMondayCalendarDay(year, month);
    if (lastMon == null) return false;
    return day === lastMon;
}

function matchesLastMondayOnlyVendor(label) {
    const collapsed = String(label).replace(/\s+/g, '').toLowerCase();
    return ['ecolab', 'reward', 'franke', 'staples'].includes(collapsed);
}

function getVisiblePendingVendors(pendingVendors = []) {
    const list = Array.isArray(pendingVendors) ? pendingVendors.map(String) : [];
    const lastMondayMonth = isMelbourneLastMondayOfMonth();
    return list.filter((v) => {
        if (!lastMondayMonth && matchesLastMondayOnlyVendor(v)) return false;
        return true;
    });
}

function vendorHasStockCount(label, stockCountVendors) {
    return stockCountVendors.some((v) => v.label === label);
}

function stockCountPathForVendor(storeNumber, label, stockCountVendors) {
    const entry = stockCountVendors.find((v) => v.label === label);
    if (!entry || !storeNumber) return null;
    return `/${storeNumber}/stock-count/${entry.slug}`;
}

function combinedStockCountPath(storeNumber, pendingVendors, stockCountVendors) {
    const visible = getVisiblePendingVendors(pendingVendors);
    const hasCountable = visible.some((name) => vendorHasStockCount(name, stockCountVendors));
    if (!hasCountable || !storeNumber) return null;
    return `/${storeNumber}/stock-count/combined`;
}

function resolveStockCountTileHref(storeNumber, pendingVendors, stockCountVendors) {
    const combined = combinedStockCountPath(storeNumber, pendingVendors, stockCountVendors);
    if (combined) return combined;
    const visible = getVisiblePendingVendors(pendingVendors);
    for (const name of visible) {
        const path = stockCountPathForVendor(storeNumber, name, stockCountVendors);
        if (path) return path;
    }
    return null;
}

/**
 * Stock Count tile state for MIC (matches dashboard “Orders to place” + combined stock count rules).
 */
function buildStockCountTileState(storeNumber, storeSlice = {}) {
    const store = String(storeNumber || '').trim();
    const pendingVendors = Array.isArray(storeSlice.pendingVendors) ? storeSlice.pendingVendors : [];
    const stockCountVendors = listConfiguredVendors();
    const visible = getVisiblePendingVendors(pendingVendors);
    const monday = isMelbourneMonday();
    const lastMondayMonth = isMelbourneLastMondayOfMonth();
    const hasOrdersToPlace = visible.length > 0 || monday || lastMondayMonth;
    const href = resolveStockCountTileHref(store, pendingVendors, stockCountVendors);

    return {
        hasOrdersToPlace,
        active: hasOrdersToPlace,
        clickable: Boolean(href),
        href,
        pendingCount: visible.length,
        stockCountVendors,
        lowStockCount: 0,
        lowStockItems: [],
        message: hasOrdersToPlace
            ? visible.length
                ? `${visible.length} vendor${visible.length === 1 ? '' : 's'} to count`
                : monday
                  ? 'Monday orders - open stock count'
                  : 'Monthly orders - open stock count'
            : 'All orders are placed for today',
    };
}

function stockLevelsSubFromSummary(summary) {
    const threshold = summary.thresholdDays ?? 5;
    if (summary.count > 0) {
        return `${summary.count} item${summary.count === 1 ? '' : 's'} under ${threshold} days stock`;
    }
    if (summary.checked) {
        return `No stock shortfalls (under ${threshold} days)`;
    }
    return 'Stock levels not checked today';
}

async function enrichStockCountTileState(base, storeNumber) {
    if (!base) return base;
    const store = String(storeNumber || '').trim();
    try {
        const { getLowStockSummary } = require('./lowStockAlerts');
        const summary = await getLowStockSummary(store);
        const stockLevelsSub = stockLevelsSubFromSummary(summary);
        const stockLevelsCheckLabel =
            summary.count > 0 ? 'Check again' : summary.checked ? 'Check again' : 'Check stock levels';
        return {
            ...base,
            lowStockCount: summary.count,
            lowStockItems: summary.alerts || summary.items || [],
            stockLevelsChecked: Boolean(summary.checked),
            stockLevelsCheckedAt: summary.checkedAt || null,
            stockLevelsSub,
            stockLevelsCheckLabel,
            stockLevelsHref: store ? `/${store}/stock-count/levels` : '',
            sub: base.active ? `${base.message} · ${stockLevelsSub}` : stockLevelsSub,
        };
    } catch {
        return {
            ...base,
            stockLevelsSub: 'Stock levels not checked today',
            stockLevelsCheckLabel: 'Check stock levels',
            stockLevelsHref: store ? `/${store}/stock-count/levels` : '',
            stockLevelsChecked: false,
        };
    }
}

async function buildStockCountTileStateAsync(storeNumber, storeSlice = {}) {
    const base = buildStockCountTileState(storeNumber, storeSlice);
    return enrichStockCountTileState(base, storeNumber);
}

module.exports = {
    buildStockCountTileState,
    buildStockCountTileStateAsync,
    enrichStockCountTileState,
    getVisiblePendingVendors,
    combinedStockCountPath,
};
