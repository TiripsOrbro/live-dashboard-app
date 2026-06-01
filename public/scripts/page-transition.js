/**
 * Fade between store picker and store/area dashboards (sessionStorage handoff).
 */
(function pageTransitionModule(global) {
    const KEY = 'dashboard-nav-transition';
    const FROM_STORES = 'from-stores';
    const EXIT_MS = 420;

    function prefersReducedMotion() {
        return global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function markFromStores() {
        try {
            sessionStorage.setItem(KEY, FROM_STORES);
        } catch {
            /* ignore */
        }
    }

    function consumeFromStores() {
        try {
            if (sessionStorage.getItem(KEY) !== FROM_STORES) return false;
            sessionStorage.removeItem(KEY);
            return true;
        } catch {
            return false;
        }
    }

    function navigateTo(url) {
        const dest = String(url || '').trim();
        if (!dest) return;
        if (prefersReducedMotion()) {
            global.location.href = dest;
            return;
        }
        markFromStores();
        document.body.classList.add('page-nav-fade-out');
        global.setTimeout(() => {
            global.location.href = dest;
        }, EXIT_MS);
    }

    function isDashboardLink(anchor) {
        if (!anchor || anchor.target === '_blank') return false;
        const href = anchor.getAttribute('href');
        if (!href || href.startsWith('#')) return false;
        if (anchor.classList.contains('store-tile--empty-area')) return false;
        if (!anchor.classList.contains('store-tile')) return false;
        try {
            const path = new URL(anchor.href, global.location.origin).pathname;
            if (path === '/stores' || path === '/stores.html') return false;
            if (/^\/(teststore|\d{3,6})\/?$/i.test(path)) return true;
            if (/^\/(area\/[^/]+|a\d+)\/?$/i.test(path)) return true;
        } catch {
            return false;
        }
        return false;
    }

    function installStoreLinkFade(root) {
        const el = root || document;
        el.addEventListener('click', (event) => {
            const anchor = event.target.closest('a.store-tile');
            if (!isDashboardLink(anchor)) return;
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            navigateTo(anchor.href);
        });
    }

    function initEnterFade() {
        if (!consumeFromStores()) return;
        document.documentElement.classList.remove('page-nav-enter-pending');
        if (prefersReducedMotion()) return;
        document.body.classList.add('page-nav-fade-in');
        global.requestAnimationFrame(() => {
            global.requestAnimationFrame(() => {
                document.body.classList.add('page-nav-fade-in--visible');
            });
        });
    }

    /** Call from an inline <head> script on dashboard pages to avoid a flash before CSS loads. */
    function markEnterPendingInHtml() {
        try {
            if (sessionStorage.getItem(KEY) === FROM_STORES) {
                document.documentElement.classList.add('page-nav-enter-pending');
            }
        } catch {
            /* ignore */
        }
    }

    global.DashboardPageTransition = {
        KEY,
        FROM_STORES,
        markFromStores,
        consumeFromStores,
        navigateTo,
        installStoreLinkFade,
        initEnterFade,
        markEnterPendingInHtml,
    };
})(window);
