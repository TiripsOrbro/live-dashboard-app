/**
 * Browser notifications for stock count MMX pipeline (variances / orders ready).
 * Uses the Notification API - not Web Push - so no service worker is required.
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
    const title = `Store ${store} - variances to review`;
    const body = 'There are variances to review before scheduled orders can be placed.';
    notify(title, body, { tag: `stock-count-variances-${store}`, url: stockCountUrl(store, vendorSlug) });
    emitAttention({ kind: 'variances', title, body });
}

function notifyPrepareFailed(store, message) {
    if (wasNotified('prepare-failed')) return;
    markNotified('prepare-failed');
    const body = String(message || 'Stock count could not be sent to Macromatix.').trim();
    notify(`Store ${store} - send failed`, body, {
        tag: `stock-count-prepare-failed-${store}`,
        url: stockCountUrl(store, readWatch()?.vendorSlug),
    });
    emitAttention({ kind: 'error', title: 'Send to Macromatix failed', body });
    clearWatch(store);
}

function notifyApplyFailed(store, message) {
    if (wasNotified('apply-failed')) return;
    markNotified('apply-failed');
    const body = String(message || 'Could not apply the count or place orders.').trim();
    notify(`Store ${store} - orders step failed`, body, {
        tag: `stock-count-apply-failed-${store}`,
        url: stockCountUrl(store, readWatch()?.vendorSlug),
    });
    emitAttention({ kind: 'error', title: 'Orders step failed', body });
}

function notifyReadyForReview(store, vendorSlug, { title, body, kind }) {
    const notifyKey = `review-${kind || 'generic'}`;
    if (wasNotified(notifyKey)) return;
    markNotified(notifyKey);
    const safeTitle = title || `Store ${store} - action needed`;
    const safeBody = body || 'Return to the stock count screen to continue.';
    notify(safeTitle, safeBody, { tag: `stock-count-${notifyKey}-${store}`, url: stockCountUrl(store, vendorSlug) });
    emitAttention({ kind: kind || 'info', title: safeTitle, body: safeBody });
}

function emitAttention(detail) {
    if (!document.hidden) return;
    try {
        window.dispatchEvent(new CustomEvent('stock-count-attention', { detail }));
    } catch {
        /* ignore */
    }
}

    function notifyLowStock(store, alerts) {
        if (wasNotified('low-stock')) return;
        const list = Array.isArray(alerts) ? alerts : [];
        if (!list.length) return;
        markNotified('low-stock');
        const top = list
            .slice(0, 3)
            .map((item) => item.description || item.itemCode)
            .filter(Boolean)
            .join(', ');
        const extra = list.length > 3 ? ` (+${list.length - 3} more)` : '';
        notify(`Store ${store} - low stock`, `${list.length} item${list.length === 1 ? '' : 's'} under warning threshold${top ? `: ${top}${extra}` : ''}.`, {
            tag: `stock-count-low-stock-${store}`,
            url: stockCountUrl(store, readWatch()?.vendorSlug),
        });
    }

    function notifyOrdersReady(store, vendorSlug, options = {}) {
        if (wasNotified('orders')) return;
        markNotified('orders');
        const body = options.partial
            ? 'Scheduled orders were updated in Macromatix, but some lines could not be filled. Review in MMX.'
            : 'Scheduled orders are ready to be reviewed in Macromatix.';
        notify(`Store ${store} - orders ready`, body, {
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
        const varianceCount = Number(status.redVarianceCount) || (status.variances?.length ?? 0);
        if (status.stage === 'prepared' && status.sessionId && varianceCount > 0) {
            notifyVariancesReady(store, watch.vendorSlug);
        } else if (status.stage === 'prepared' && status.sessionId && varianceCount === 0) {
            notifyReadyForReview(store, watch.vendorSlug, {
                kind: 'confirm',
                title: `Store ${store} - ready to confirm`,
                body: 'No red variances. Confirm on the stock count screen to place scheduled orders.',
            });
        }
        if (status.stage === 'prepare-failed' && !status.inProgress) {
            notifyPrepareFailed(store, status.lastError);
        }
        if (status.stage === 'apply-failed' && !status.inProgress) {
            notifyApplyFailed(store, status.lastError);
        }
        const ordersDone =
            status.ordersComplete &&
            !status.inProgress &&
            (status.stage === 'completed' || status.stage === 'idle');
        if (ordersDone) {
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

    function permissionState() {
        if (!('Notification' in window)) return 'unsupported';
        return Notification.permission;
    }

    function isWatching(store) {
        const watch = readWatch();
        return Boolean(watch && String(watch.store) === String(store));
    }

    window.StockCountNotify = {
        requestPermission,
        permissionState,
        isWatching,
        setWatch,
        clearWatch,
        notifyVariancesReady,
        notifyOrdersReady,
        notifyLowStock,
        notifyPrepareFailed,
        notifyApplyFailed,
        notifyReadyForReview,
        emitAttention,
        initPipelineWatcher,
        startPolling,
        stopPolling,
    };
})();
