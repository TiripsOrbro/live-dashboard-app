const { DEFAULT_OPEN_HOUR, DEFAULT_CLOSE_HOUR } = require('./storeList');

const TEST_STORE_SLUG = 'teststore';
const TEST_STORE_NAME = 'Test Store';

function isTestStore(store) {
    return String(store || '').trim().toLowerCase() === TEST_STORE_SLUG;
}

/** Normalized store key for APIs, persistence, and auth. Empty when invalid. */
function normalizeStoreKey(store) {
    const raw = String(store || '').trim();
    if (isTestStore(raw)) return TEST_STORE_SLUG;
    const digits = raw.replace(/[^0-9]/g, '');
    return /^\d{3,6}$/.test(digits) ? digits : '';
}

function buildTestStoreSalesSlice() {
    return {
        success: true,
        timestamp: new Date().toISOString(),
        actual: [],
        forecast: [],
        pendingVendors: [],
        storeNumber: TEST_STORE_SLUG,
        storeName: TEST_STORE_NAME,
        openHour: DEFAULT_OPEN_HOUR,
        closeHour: DEFAULT_CLOSE_HOUR,
        availableStores: [],
        storeNotFound: false,
        testStore: true,
    };
}

function testStoreListEntry() {
    return {
        storeNumber: TEST_STORE_SLUG,
        storeName: TEST_STORE_NAME,
        openHour: DEFAULT_OPEN_HOUR,
        closeHour: DEFAULT_CLOSE_HOUR,
        testStore: true,
    };
}

module.exports = {
    TEST_STORE_SLUG,
    TEST_STORE_NAME,
    isTestStore,
    normalizeStoreKey,
    buildTestStoreSalesSlice,
    testStoreListEntry,
};
