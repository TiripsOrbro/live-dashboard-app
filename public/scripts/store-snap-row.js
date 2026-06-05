/**
 * Store snapshot rows — name, actual/forecast, SSSG placeholder, on-track status bar.
 */
(function () {
    const TRACK_FILL = {
        'cell-green': 'var(--good)',
        'cell-orange': 'var(--near)',
        'cell-red': 'var(--bad)',
    };

    const TRACK_TEXT = {
        'cell-green': 'var(--good-border)',
        'cell-orange': 'var(--near-border)',
        'cell-red': 'var(--bad-border)',
    };

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function trackClass(store) {
        return (
            store?.progress?.paceClass || store?.trackClass || store?.progress?.outcomeClass || 'cell-green'
        );
    }

    function paceFillPercent(store) {
        const progress = store?.progress;
        if (window.SalesProgress?.paceFillPercentFromProgress) {
            return window.SalesProgress.paceFillPercentFromProgress(progress);
        }
        if (!progress) return 0;
        if (progress.phase === 'after') return 100;
        return Math.max(0, Math.min(100, Number(progress.timeFillPercent) || 0));
    }

    function formatSssg(store) {
        const v = store?.sssgPercent;
        if (v == null || v === '' || Number.isNaN(Number(v))) return '—';
        return `${Number(v)}%`;
    }

    function storeSnapHref(num, options = {}) {
        const base = String(options.storeBasePath || '').replace(/\/$/, '');
        return base ? `${base}/${num}` : `/${num}`;
    }

    function storeSnapSlug(store) {
        if (store?.testStore) return 'teststore';
        return String(store.storeNumber || '').replace(/[^0-9]/g, '');
    }

    function renderStoreSnapRow(store, formatMoney, options = {}) {
        const num = storeSnapSlug(store);
        const name =
            store.testStore
                ? store.storeName || 'Test Store'
                : store.storeName && String(store.storeName).trim() && store.storeName !== num
                  ? store.storeName
                  : num || 'Store';
        const track = trackClass(store);
        const fillPct = paceFillPercent(store);
        const actual = formatMoney(store.actual);
        const forecast = formatMoney(store.forecast);
        const sssg = formatSssg(store);
        const barColor = TRACK_FILL[track] || TRACK_FILL['cell-green'];
        const actualColor = TRACK_TEXT[track] || TRACK_TEXT['cell-green'];

        return `
            <a class="mic-store-snap mic-store-snap--${track}" href="${escapeHtml(storeSnapHref(num, options))}">
                <div class="mic-store-snap-body">
                    <div class="mic-store-snap-top">
                        <span class="mic-store-snap-name">${escapeHtml(name)}</span>
                        <span class="mic-store-snap-actual" style="color: ${actualColor}">${escapeHtml(actual)}</span>
                    </div>
                    <div class="mic-store-snap-bottom">
                        <span class="mic-store-snap-sssg">SSSG% <span class="mic-store-snap-sssg-val">${escapeHtml(sssg)}</span></span>
                        <span class="mic-store-snap-forecast">Forecast ${escapeHtml(forecast)}</span>
                    </div>
                    <div class="mic-store-snap-pace" aria-hidden="true">
                        <div class="mic-store-snap-pace-fill" style="width: ${fillPct}%; background-color: ${barColor};"></div>
                    </div>
                </div>
            </a>`;
    }

    function renderStoreSnapList(
        stores,
        formatMoney,
        emptyMessage = 'No stores in this area yet.',
        options = {}
    ) {
        if (!Array.isArray(stores) || !stores.length) {
            return `<p class="mic-store-lead-empty">${escapeHtml(emptyMessage)}</p>`;
        }
        return stores.map((s) => renderStoreSnapRow(s, formatMoney, options)).join('');
    }

    window.StoreSnapRow = {
        renderStoreSnapList,
        renderStoreSnapRow,
        trackClass,
    };
})();
