/**
 * Canonical dashboard URL paths — MIC and Admin namespaces.
 */
(function (global) {
    function areaCodeFromName(name) {
        const m = String(name || '').match(/(\d+)/);
        return m ? `A${Number(m[1])}` : '';
    }

    function micOverview() {
        return '/overview';
    }

    function overview() {
        return '/overview';
    }

    function micStore(storeNumber) {
        const slug = String(storeNumber || '').toLowerCase();
        if (slug === 'teststore') return '/MIC/teststore';
        const num = String(storeNumber || '').replace(/[^0-9]/g, '');
        return num ? `/MIC/${num}` : micOverview();
    }

    function adminOverview() {
        return '/overview';
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

    function tacaudit(storeNumber) {
        const slug = String(storeNumber || '').toLowerCase();
        if (slug === 'teststore') return '/teststore/tacaudit';
        const num = String(storeNumber || '').replace(/[^0-9]/g, '');
        return num ? `/${num}/tacaudit` : micOverview();
    }

    const TACAUDIT_ROW_BY_AUDIT_LABEL = {
        'Pest Walk': 'pest-walk',
        'RGM Cleaning Checklist': 'rgm-cleaning',
        'Period Safety Inspection': 'psi',
        'Dining Room': 'square-one:dining-room',
        Restrooms: 'square-one:restrooms',
        'Production Line': 'square-one:production-line',
        'Walls, Floors, Drains, Shelves...': 'square-one:boh-walls-floors',
        External: 'square-one:external',
        'Bins, Bin Room, Office...': 'square-one:bins-bin-room',
        'Drink Station': 'square-one:drink-stations',
        'Prep and Washup': 'square-one:prep-washup',
    };

    function tacauditRowForAuditLabel(label, areaId) {
        if (areaId) return `square-one:${String(areaId).trim()}`;
        return TACAUDIT_ROW_BY_AUDIT_LABEL[String(label || '').trim()] || '';
    }

    function tacauditAdminSummary(options = {}) {
        const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
        const url = new URL('/tacaudit/summary', global.location?.origin || 'http://localhost');
        const area = String(opts.area || '').trim();
        if (area) url.searchParams.set('area', area);
        const row = String(opts.row || '').trim();
        if (row) url.searchParams.set('row', row);
        return `${url.pathname}${url.search}`;
    }

    global.AppPaths = {
        overview,
        micOverview,
        micStore,
        adminOverview,
        adminArea,
        adminAreaWithStore,
        adminStore,
        areaTotals,
        areaCodeFromName,
        tacaudit,
        tacauditAdminSummary,
        tacauditRowForAuditLabel,
    };
})(window);
