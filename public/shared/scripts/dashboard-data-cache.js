/**
 * Persists last-known dashboard sales / MIC overview payloads in localStorage
 * so login and navigation can paint immediately while fresh data loads.
 */
(function dashboardDataCacheModule(global) {
    const VERSION = 1;
    const MAX_AGE_MS = 48 * 60 * 60 * 1000;

    function storageKey(kind, store) {
        const s = String(store || 'default').toLowerCase();
        return `dashboard-data-cache:v${VERSION}:${kind}:${s}`;
    }

    function read(kind, store) {
        try {
            const raw = localStorage.getItem(storageKey(kind, store));
            if (!raw) return null;
            const entry = JSON.parse(raw);
            if (!entry?.data || !entry.savedAt) return null;
            if (Date.now() - entry.savedAt > MAX_AGE_MS) {
                localStorage.removeItem(storageKey(kind, store));
                return null;
            }
            return entry;
        } catch {
            return null;
        }
    }

    function write(kind, store, data) {
        if (!data) return;
        try {
            localStorage.setItem(
                storageKey(kind, store),
                JSON.stringify({
                    savedAt: Date.now(),
                    data,
                })
            );
        } catch {
            /* quota or private mode */
        }
    }

    function sumHourly(arr) {
        return Array.isArray(arr) ? arr.reduce((sum, v) => sum + (Number(v) || 0), 0) : 0;
    }

    function hasMeaningfulSalesSlice(slice) {
        if (!slice || slice.success === false) return false;
        return sumHourly(slice.actual) > 0 || sumHourly(slice.forecast) > 0;
    }

    function hasMeaningfulMicOverview(data) {
        if (!data || data.success === false) return false;
        const sales = data.salesToday || {};
        if (Number(sales.actual) > 0 || Number(sales.forecast) > 0) return true;
        if (sumHourly(sales.actualHourly) > 0 || sumHourly(sales.forecastHourly) > 0) return true;
        const resolved = global.MicMiniDashboard?.resolveHourly?.(sales);
        if (resolved) {
            return sumHourly(resolved.actuals) > 0 || sumHourly(resolved.forecasts) > 0;
        }
        return sumHourly(sales.rawActual) > 0 || sumHourly(sales.rawForecast) > 0;
    }

    function staleAgeSeconds(entry) {
        if (!entry?.savedAt) return 0;
        return Math.round((Date.now() - entry.savedAt) / 1000);
    }

    global.DashboardDataCache = {
        readSales: (store) => read('sales', store),
        writeSales: (store, data) => {
            if (hasMeaningfulSalesSlice(data)) write('sales', store, data);
        },
        readOverview: (store) => read('overview', store),
        writeOverview: (store, data) => {
            if (hasMeaningfulMicOverview(data)) write('overview', store, data);
        },
        hasMeaningfulSalesSlice,
        hasMeaningfulMicOverview,
        staleAgeSeconds,
    };
})(typeof window !== 'undefined' ? window : globalThis);
