const { getStoreList } = require('../../../stores/src/storeList');
const { buildDaySummary, storeDateKey, normalizeStoreKey, listOpenAudits } = require('./dfscStore');

function buildStoreDfscStatus(store, dateKey) {
    const summary = buildDaySummary(store.storeNumber, dateKey);
    return {
        storeNumber: normalizeStoreKey(store.storeNumber),
        storeName: store.storeName,
        area: store.area,
        areaKey: store.areaKey || '',
        amCompleted: summary.amCompleted,
        pmCompleted: summary.pmCompleted,
        amCompletedAt: summary.amCompletedAt,
        pmCompletedAt: summary.pmCompletedAt,
        completedCount: summary.completedCount,
        extraCount: summary.extraCount,
        inProgress: summary.inProgress
            ? {
                  id: summary.inProgress.id,
                  shift: summary.inProgress.shift,
                  conductorName: summary.inProgress.conductor?.name || '',
                  startedAt: summary.inProgress.startedAt,
              }
            : null,
        openAuditCount: listOpenAudits(store.storeNumber).length,
    };
}

function buildAdminDfscStatus(dateKey, stores = null) {
    const list = stores || getStoreList();
    const key = dateKey || storeDateKey(list[0]?.storeNumber || '3806');
    const rows = list.map((store) => buildStoreDfscStatus(store, key));
    const total = rows.length;
    const amDone = rows.filter((r) => r.amCompleted).length;
    const pmDone = rows.filter((r) => r.pmCompleted).length;
    const inProgress = rows.filter((r) => r.inProgress).length;
    const openAudits = rows.reduce((sum, r) => sum + (r.openAuditCount || 0), 0);
    return {
        dateKey: key,
        summary: {
            totalStores: total,
            amCompleted: amDone,
            pmCompleted: pmDone,
            inProgress,
            openAudits,
            amPending: total - amDone,
            pmPending: total - pmDone,
        },
        stores: rows,
    };
}

function formatAdminTileSubtext(status) {
    const { summary } = status;
    if (!summary.totalStores) return 'No stores configured';
    const parts = [];
    parts.push(`AM ${summary.amCompleted}/${summary.totalStores}`);
    parts.push(`PM ${summary.pmCompleted}/${summary.totalStores}`);
    if (summary.inProgress) parts.push(`${summary.inProgress} in progress`);
    return parts.join(' · ');
}

function formatStoreTileSubtext(daySummary, inProgress, openAuditCount = 0) {
    const parts = [];
    parts.push(daySummary.amCompleted ? 'AM done' : 'AM pending');
    parts.push(daySummary.pmCompleted ? 'PM done' : 'PM pending');
    if (openAuditCount > 0) parts.push(`${openAuditCount} open`);
    else if (inProgress) parts.push('In progress');
    return parts.join(' · ');
}

module.exports = {
    buildStoreDfscStatus,
    buildAdminDfscStatus,
    formatAdminTileSubtext,
    formatStoreTileSubtext,
};
