const {
    melbourneTodayIso,
    getAllActiveMultipliersForDay,
    ROTATE_INTERVAL_MS,
    DEFAULT_ITEM_MULTIPLIER,
    MULTIPLIER_NOTHING_LABEL,
    MIC_VOC_PLACEHOLDER,
} = require('./micStore');
const { loadPointsMapForParsing } = require('../upselling/pointsFile');
const { computeDaySalesPresentation } = require('../salesProgress');
const { buildStockCountTileState } = require('../stockCountTileState');
const { DEFAULT_OPEN_HOUR, DEFAULT_CLOSE_HOUR } = require('../storeList');

/** Same areas as store picker — always rotate through these even with no stores/data. */
const ADMIN_ROTATE_AREAS = ['Area 1', 'Area 2', 'Area 21', 'Area 22'];

function normalizeAreaKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

function ensureAllAreaGroups(areaGroups) {
    const byKey = new Map();
    for (const group of areaGroups || []) {
        const name = String(group.name || '').trim();
        const key = normalizeAreaKey(group.key || group.areaKey || name);
        if (!key) continue;
        byKey.set(key, {
            name: name || group.name,
            key,
            stores: Array.isArray(group.stores) ? group.stores : [],
        });
    }
    return ADMIN_ROTATE_AREAS.map((name) => {
        const key = normalizeAreaKey(name);
        const existing = byKey.get(key);
        return existing || { name, key, stores: [] };
    });
}

function emptyAreaSalesToday() {
    return computeAreaSalesToday([]);
}

function mergeAreaHourly(areaStores) {
    let hours = 0;
    for (const store of areaStores || []) {
        const a = Array.isArray(store.actual) ? store.actual : [];
        const f = Array.isArray(store.forecast) ? store.forecast : [];
        hours = Math.max(hours, a.length, f.length);
    }
    const actual = new Array(hours).fill(0);
    const forecast = new Array(hours).fill(0);
    for (const store of areaStores || []) {
        const a = Array.isArray(store.actual) ? store.actual : [];
        const f = Array.isArray(store.forecast) ? store.forecast : [];
        for (let i = 0; i < hours; i++) {
            actual[i] += Number(a[i]) || 0;
            forecast[i] += Number(f[i]) || 0;
        }
    }
    return { actual, forecast, hours };
}

function computeAreaSalesToday(areaStores) {
    const { actual, forecast, hours } = mergeAreaHourly(areaStores);
    let actualTotal = 0;
    let forecastTotal = 0;
    for (let i = 0; i < hours; i++) {
        actualTotal += Number(actual[i]) || 0;
        forecastTotal += Number(forecast[i]) || 0;
    }
    const progress = computeDaySalesPresentation({
        actual,
        forecast,
        openHour: DEFAULT_OPEN_HOUR,
        closeHour: DEFAULT_CLOSE_HOUR,
    });
    return {
        actual: Math.round(actualTotal),
        forecast: Math.round(forecastTotal),
        hours,
        openHour: DEFAULT_OPEN_HOUR,
        closeHour: DEFAULT_CLOSE_HOUR,
        progress,
    };
}

function buildAreaStockCountTileState(areaStores, liveByNum) {
    let active = false;
    let pendingCount = 0;
    let firstHref = null;
    for (const cfg of areaStores || []) {
        const live = liveByNum.get(String(cfg.storeNumber)) || {};
        const tile = buildStockCountTileState(cfg.storeNumber, live);
        if (!tile.active) continue;
        active = true;
        pendingCount += Number(tile.pendingCount) || 0;
        if (!firstHref && tile.clickable && tile.href) firstHref = tile.href;
    }
    return {
        active,
        clickable: Boolean(firstHref),
        href: firstHref,
        message: active
            ? pendingCount
                ? `${pendingCount} vendor count${pendingCount === 1 ? '' : 's'} due in this area`
                : 'Stock counts due in this area'
            : 'All orders are placed for today in this area',
    };
}

function buildAdminOverviewPayload(salesPayload, areaGroups) {
    const day = melbourneTodayIso();
    const liveByNum = new Map((salesPayload?.stores || []).map((s) => [String(s.storeNumber), s]));

    const areas = ensureAllAreaGroups(areaGroups).map((group) => {
        const configs = group.stores || [];
        const areaStores = configs.map((cfg) => {
            const live = liveByNum.get(String(cfg.storeNumber)) || {};
            return {
                storeNumber: cfg.storeNumber,
                storeName: cfg.storeName,
                actual: Array.isArray(live.actual) ? live.actual : [],
                forecast: Array.isArray(live.forecast) ? live.forecast : [],
            };
        });
        const hasStores = configs.length > 0;
        return {
            name: group.name,
            areaKey: group.key || normalizeAreaKey(group.name),
            salesToday: hasStores ? computeAreaSalesToday(areaStores) : emptyAreaSalesToday(),
            stockCount: buildAreaStockCountTileState(areaStores, liveByNum),
        };
    });

    const vocByArea = areas.map((a) => ({
        name: a.name,
        areaKey: a.areaKey,
        ...MIC_VOC_PLACEHOLDER,
        placeholder: true,
    }));

    const { byLabel } = loadPointsMapForParsing();
    const items = [...byLabel.values()]
        .map((entry) => ({ label: entry.label, basePoints: Number(entry.points) || 0 }))
        .sort((a, b) => a.label.localeCompare(b.label));

    return {
        day,
        areas,
        vocByArea,
        activeMultipliers: getAllActiveMultipliersForDay(day),
        items,
        defaultMultiplier: DEFAULT_ITEM_MULTIPLIER,
        multiplierNothingLabel: MULTIPLIER_NOTHING_LABEL,
        rotateIntervalMs: ROTATE_INTERVAL_MS,
    };
}

module.exports = {
    ADMIN_ROTATE_AREAS,
    buildAdminOverviewPayload,
    computeAreaSalesToday,
    mergeAreaHourly,
    ensureAllAreaGroups,
};
