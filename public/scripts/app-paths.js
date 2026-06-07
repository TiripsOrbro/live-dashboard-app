/**
 * Canonical dashboard URL paths — MIC and Admin namespaces.
 */
(function (global) {
    function areaCodeFromName(name) {
        const m = String(name || '').match(/(\d+)/);
        return m ? `A${Number(m[1])}` : '';
    }

    function micOverview() {
        return '/MIC/Overview';
    }

    function micStore(storeNumber) {
        const slug = String(storeNumber || '').toLowerCase();
        if (slug === 'teststore') return '/MIC/teststore';
        const num = String(storeNumber || '').replace(/[^0-9]/g, '');
        return num ? `/MIC/${num}` : micOverview();
    }

    function adminOverview() {
        return '/Admin/Overview';
    }

    function adminArea(areaCodeOrName) {
        const code = areaCodeFromName(areaCodeOrName) || String(areaCodeOrName || '').trim();
        return code ? `/Admin/${code}` : adminOverview();
    }

    function adminAreaWithStore(areaCodeOrName, storeNumber) {
        const base = adminArea(areaCodeOrName);
        const num = String(storeNumber || '').replace(/[^0-9]/g, '');
        return num ? `${base}?store=${encodeURIComponent(num)}` : base;
    }

    function adminStore(storeNumber) {
        const slug = String(storeNumber || '').toLowerCase();
        if (slug === 'teststore') return '/Admin/teststore';
        const num = String(storeNumber || '').replace(/[^0-9]/g, '');
        return num ? `/Admin/${num}` : adminOverview();
    }

    function areaTotals(areaCodeOrName) {
        const code = areaCodeFromName(areaCodeOrName);
        return code ? `/${code}` : '/A22';
    }

    global.AppPaths = {
        micOverview,
        micStore,
        adminOverview,
        adminArea,
        adminAreaWithStore,
        adminStore,
        areaTotals,
        areaCodeFromName,
    };
})(window);
