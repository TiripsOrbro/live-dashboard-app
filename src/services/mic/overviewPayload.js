const { buildMicPayload } = require('./micStore');
const { getSettings: getTacauditSettings } = require('../tacaudit/tacauditStore');
const { buildAdminOverviewPayload, ensureAllAreaGroups } = require('./adminOverview');
const { buildWeeklyAuditsTileState, buildSquareOneTiles } = require('../weeklyAuditsTileState');
const { normalizeAreaLabel } = require('../marketsConfig');
const {
    getOverviewScope,
    getAccessibleAreasForUser,
    getUserAccessScope,
    singleStoreForUser,
} = require('../dashboardUsers');

function normalizeAreaKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

function filterAreaGroupsForUser(areaGroups, user) {
    const allowed = new Set(getAccessibleAreasForUser(user).map(normalizeAreaLabel));
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

    return {
        ok: true,
        overviewScope: 'store',
        accessibleAreas: getAccessibleAreasForUser(user),
        accessibleMarkets: getUserAccessScope(user).markets,
        ...buildMicPayload(store, storeSlice, { canAccessDfsc: canUserAccessDfsc(user) }),
        dailyStockCount: await buildDailyStockCountTileStateAsync(store),
        weeklyAudits,
        squareOneTiles,
        reportEmail: tacauditSettings.reportEmail || '',
    };
}

async function buildMultiStoreOverviewPayload(user, deps) {
    const overviewScope = getOverviewScope(user);
    const { salesPayload, stores, loadAuditStateMapForStores, getAuditSchedule, getSalesUpdatedAt } = deps;

    const areaGroups = filterAreaGroupsForUser(buildAreaGroupsFromStoreRows(stores), user);
    const auditsSchedule = getAuditSchedule();
    const auditStateByStore = await loadAuditStateMapForStores(stores.map((s) => s.storeNumber));

    const adminPayload = await buildAdminOverviewPayload(salesPayload, areaGroups, {
        auditStateByStore,
        requiredAudits: auditsSchedule.auditListItems,
        ensureAllAreaGroups: (groups) => filterAreaGroupsForUser(groups, user),
    });

    return {
        ok: true,
        overviewScope,
        accessibleAreas: getAccessibleAreasForUser(user),
        accessibleMarkets: getUserAccessScope(user).markets,
        salesUpdatedAt: getSalesUpdatedAt(),
        ...adminPayload,
    };
}

async function buildOverviewPayload(user, deps) {
    const scope = getOverviewScope(user);
    if (scope === 'store') {
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
