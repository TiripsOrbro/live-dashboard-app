const { buildMicPayload } = require('./micStore');
const { getStoreConfig } = require('../../../../../stores/src/storeList');
const { getSettings: getTacauditSettings } = require('../../../../../tacaudit/src/core/tacauditStore');
const { buildAdminOverviewPayload, ensureAllAreaGroups } = require('./adminOverview');
const { buildWeeklyAuditsTileState, buildSquareOneTiles } = require('../../../../../dashboard/src/weeklyAuditsTileState');
const { normalizeAreaLabel } = require('../../../../../stores/src/marketsConfig');
const {
    getOverviewScope,
    getAccessibleAreasForUser,
    getUserAccessScope,
    singleStoreForUser,
} = require('../../../core/dashboardUsers');

function normalizeAreaKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

function filterAreaGroupsForUser(areaGroups, user) {
    const allowed = new Set((getAccessibleAreasForUser(user) || []).map(normalizeAreaLabel));
    if (!allowed.size) return areaGroups || [];

    const byKey = new Map();
    for (const group of areaGroups || []) {
        const name = normalizeAreaLabel(group.name);
        if (!allowed.has(name)) continue;
        byKey.set(normalizeAreaKey(name), {
            ...group,
            name: group.name || name,
        });
    }

    const ordered = [...allowed];
    return ordered.map((name) => {
        const key = normalizeAreaKey(name);
        return (
            byKey.get(key) || {
                name,
                key,
                stores: [],
            }
        );
    });
}

function buildAreaGroupsFromStoreRows(stores) {
    const groups = new Map();
    for (const store of stores || []) {
        const area = String(store.area || 'Area 22').trim() || 'Area 22';
        if (!groups.has(area)) groups.set(area, []);
        groups.get(area).push(store);
    }
    return [...groups.entries()]
        .map(([name, areaStores]) => ({
            name,
            key: normalizeAreaKey(name),
            stores: areaStores.sort((a, b) =>
                String(a.storeNumber).localeCompare(String(b.storeNumber), undefined, { numeric: true })
            ),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

async function buildStoreOverviewPayload(user, deps) {
    const store = String(deps.store || singleStoreForUser(user) || '').trim();
    if (!store) {
        return { ok: false, error: 'Store is required for store-scoped overview.' };
    }

    const {
        storeSlice,
        buildDailyStockCountTileStateAsync,
        buildStockCountTileStateAsync,
        getAuditState,
        isTestStore,
        getAuditSchedule,
        canUserAccessDfsc,
    } = deps;

    const auditsSchedule = getAuditSchedule();
    const auditState = isTestStore(store) ? { dismissed: [] } : await getAuditState(store);
    const weeklyAudits = buildWeeklyAuditsTileState(store, {
        dismissed: auditState.dismissed,
        requiredAudits: auditsSchedule.auditListItems,
    });
    const squareOneTiles = buildSquareOneTiles(store, { dismissed: auditState.dismissed });

    const tacauditSettings = getTacauditSettings(store);
    const storeCfg = getStoreConfig(store) || {};

    return {
        ok: true,
        overviewScope: 'store',
        areaName: String(storeCfg.area || '').trim(),
        accessibleAreas: getAccessibleAreasForUser(user) || [],
        accessibleMarkets: getUserAccessScope(user).markets || [],
        ...buildMicPayload(store, storeSlice, { canAccessDfsc: canUserAccessDfsc(user) }),
        stockCount: await buildStockCountTileStateAsync(store, storeSlice),
        dailyStockCount: await buildDailyStockCountTileStateAsync(store),
        weeklyAudits,
        squareOneTiles,
        reportEmail: tacauditSettings.reportEmail || '',
    };
}

async function buildMultiStoreOverviewPayload(user, deps) {
    const overviewScope = getOverviewScope(user);
    const { salesPayload, stores, loadAuditStateMapForStores, getAuditSchedule, getSalesUpdatedAt } = deps;
    const storeRows = Array.isArray(stores) ? stores : [];

    const areaGroups = filterAreaGroupsForUser(buildAreaGroupsFromStoreRows(storeRows), user);
    const auditsSchedule = getAuditSchedule();
    const auditStateByStore = await loadAuditStateMapForStores(storeRows.map((s) => s.storeNumber));

    const adminPayload = await buildAdminOverviewPayload(salesPayload, areaGroups, {
        auditStateByStore,
        requiredAudits: auditsSchedule.auditListItems,
        ensureAllAreaGroups: (groups) => filterAreaGroupsForUser(groups, user),
    });

    return {
        ok: true,
        overviewScope,
        accessibleAreas: getAccessibleAreasForUser(user) || [],
        accessibleMarkets: getUserAccessScope(user).markets || [],
        salesUpdatedAt: getSalesUpdatedAt(),
        ...adminPayload,
    };
}

async function buildOverviewPayload(user, deps) {
    const scope = getOverviewScope(user);
    const store = String(deps?.store || '').trim();
    if (scope === 'store' || store) {
        return buildStoreOverviewPayload(user, deps);
    }
    return buildMultiStoreOverviewPayload(user, deps);
}

module.exports = {
    buildOverviewPayload,
    buildStoreOverviewPayload,
    buildMultiStoreOverviewPayload,
    filterAreaGroupsForUser,
    buildAreaGroupsFromStoreRows,
};
