(function (global) {
    const BOOT_STORAGE_KEY = 'dashboardClientBootId';
    const HARD_REFRESH_PARAM = '_';

    (function stripHardRefreshParam() {
        try {
            const url = new URL(global.location.href);
            if (!url.searchParams.has(HARD_REFRESH_PARAM)) return;
            url.searchParams.delete(HARD_REFRESH_PARAM);
            const next = `${url.pathname}${url.search}${url.hash}`;
            global.history.replaceState(null, '', next || url.pathname);
        } catch {
            /* ignore */
        }
    })();

    async function fetchMeta() {
        const res = await fetch('/api/dashboard/meta', { cache: 'no-store', credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not load dashboard version.');
        }
        return data;
    }

    function needsUpdate(meta) {
        if (!meta?.bootId) return false;
        const stored = localStorage.getItem(BOOT_STORAGE_KEY);
        if (!stored) return false;
        return stored !== meta.bootId;
    }

    function markSynced(meta) {
        if (meta?.bootId) {
            localStorage.setItem(BOOT_STORAGE_KEY, meta.bootId);
        }
    }

    async function hardRefresh(meta) {
        let bootId = meta?.bootId;
        if (!bootId) {
            try {
                bootId = (await fetchMeta()).bootId;
            } catch {
                /* continue with cache bust anyway */
            }
        }
        if (bootId) markSynced({ bootId });

        if ('caches' in global) {
            try {
                const keys = await caches.keys();
                await Promise.all(keys.map((key) => caches.delete(key)));
            } catch {
                /* ignore */
            }
        }

        const url = new URL(global.location.href);
        url.searchParams.set(HARD_REFRESH_PARAM, String(Date.now()));
        global.location.replace(url.toString());
    }

    global.DashboardMeta = {
        BOOT_STORAGE_KEY,
        fetchMeta,
        needsUpdate,
        markSynced,
        hardRefresh,
    };
})(window);
