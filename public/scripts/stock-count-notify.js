/**
 * Browser notifications for stock count MMX pipeline (variances / orders ready).
 * Uses the Notification API — not Web Push — so no service worker is required.
 */
(function () {
    const WATCH_KEY = 'stockCountPipelineWatch';
    const POLL_MS = 5000;
    let pollTimer = null;

    function readWatch() {
        try {
            const raw = sessionStorage.getItem(WATCH_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }

    function writeWatch(watch) {
        try {
            if (!watch) sessionStorage.removeItem(WATCH_KEY);
            else sessionStorage.setItem(WATCH_KEY, JSON.stringify(watch));
        } catch {
            /* ignore */
        }
    }

    function stockCountUrl(store, vendorSlug) {
        const slug = vendorSlug || 'combined';
        return `${window.location.origin}/${store}/stock-count/${slug}`;
    }

    async function requestPermission() {
        if (!('Notification' in window)) return false;
        if (Notification.permission === 'granted') return true;
        if (Notification.permission === 'denied') return false;
        try {
            const result = await Notification.requestPermission();
            return result === 'granted';
        } catch {
            return false;
        }
    }

    function playSound() {
        try {
            const audio = new Audio('/assets/sounds/notification.mp3');
            audio.volume = 0.85;
            audio.play().catch(() => {});
        } catch {
            /* ignore */
        }
    }

    function notify(title, body, options = {}) {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        const tag = options.tag || 'stock-count';
        const url = options.url || window.location.href;
        try {
            const n = new Notification(title, {
                body,
                tag,
                icon: '/icon.svg',
                data: { url },
            });
            n.onclick = () => {
                try {
                    window.focus();
                } catch {
                    /* ignore */
                }
                n.close();
                if (url && window.location.href !== url) {
                    window.location.href = url;
                }
            };
            playSound();
        } catch {
            /* ignore */
        }
    }

    function setWatch(store, vendorSlug) {
        if (!store) return;
        writeWatch({
            store: String(store),
            vendorSlug: vendorSlug || 'combined',
            startedAt: new Date().toISOString(),
            notified: [],
        });
    }

    function clearWatch(store) {
        const watch = readWatch();
        if (!watch) return;
        if (store && String(watch.store) !== String(store)) return;
        writeWatch(null);
        stopPolling();
    }

    function markNotified(kind) {
        const watch = readWatch();
        if (!watch) return;
        if (!Array.isArray(watch.notified)) watch.notified = [];
        if (!watch.notified.includes(kind)) watch.notified.push(kind);
        writeWatch(watch);
    }

    function wasNotified(kind) {
        const watch = readWatch();
        return Boolean(watch?.notified?.includes(kind));
    }

    function notifyVariancesReady(store, vendorSlug) {
        if (wasNotified('variances')) return;
        markNotified('variances');
        notify(
            `Store ${store} — review variances`,
            'Stock count variances are ready to review in the stock count screen.',
            { tag: `stock-count-variances-${store}`, url: stockCountUrl(store, vendorSlug) }
        );
    }

    function notifyOrdersReady(store, vendorSlug, options = {}) {
        if (wasNotified('orders')) return;
        markNotified('orders');
        const body = options.partial
            ? 'Scheduled orders were updated in Macromatix, but some lines could not be filled. Review in MMX.'
            : 'Scheduled orders are ready to be reviewed in Macromatix.';
        notify(`Store ${store} — orders ready`, body, {
            tag: `stock-count-orders-${store}`,
            url: options.url || `/${store}`,
        });
        clearWatch(store);
    }

    async function fetchPipelineStatus(store) {
        const url = `${window.location.origin}/api/stock-count/pipeline-status?store=${encodeURIComponent(store)}`;
        const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`Pipeline status ${res.status}`);
        return res.json();
    }

    async function pollOnce(store) {
        const watch = readWatch();
        if (!watch || String(watch.store) !== String(store)) {
            stopPolling();
            return;
        }
        const status = await fetchPipelineStatus(store);
        if (status.stage === 'prepared' && status.sessionId) {
            notifyVariancesReady(store, watch.vendorSlug);
        }
        if (status.ordersComplete) {
            notifyOrdersReady(store, watch.vendorSlug, {
                partial: Boolean(status.lastError),
            });
        }
        if (status.stage === 'apply-failed' && !status.inProgress) {
            clearWatch(store);
        }
    }

    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    function startPolling(store) {
        if (!store || pollTimer) return;
        const tick = () => {
            pollOnce(store).catch(() => {});
        };
        tick();
        pollTimer = setInterval(tick, POLL_MS);
    }

    /** Call on dashboard or stock-count page load when a pipeline job may still be running. */
    function initPipelineWatcher(store) {
        if (!store) return;
        const watch = readWatch();
        if (!watch || String(watch.store) !== String(store)) return;
        startPolling(store);
    }

    window.StockCountNotify = {
        requestPermission,
        setWatch,
        clearWatch,
        notifyVariancesReady,
        notifyOrdersReady,
        initPipelineWatcher,
        startPolling,
        stopPolling,
    };
})();
