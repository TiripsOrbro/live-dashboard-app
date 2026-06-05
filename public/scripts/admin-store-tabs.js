/**
 * Admin store dashboard — area selector + store switcher at /admin/{storeNumber}.
 * Desktop: tabs spread evenly. Mobile: picker button + menu.
 * Tabs are limited to the active store's area (test store is separate).
 */
(function (global) {
    const MOBILE_MAX = 768;
    const ADMIN_AREAS = ['Area 1', 'Area 2', 'Area 21', 'Area 22'];

    function isAdminStorePath() {
        return /^\/admin\/(teststore|\d{3,6})\/?$/i.test(global.location.pathname);
    }

    function storeFromPath() {
        const m = global.location.pathname.match(/^\/admin\/(teststore|\d{3,6})\/?$/i);
        return m ? String(m[1]).toLowerCase() : '';
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function normalizeAreaKey(value) {
        return String(value || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');
    }

    function storeTabId(store) {
        if (!store) return '';
        return store.testStore ? 'teststore' : String(store.storeNumber || '').replace(/[^0-9]/g, '');
    }

    function areaKeyForStore(store) {
        if (!store) return '';
        if (store.testStore) return 'test-store';
        return store.areaKey || normalizeAreaKey(store.area || '');
    }

    function activeAreaKey(stores, activeStore) {
        const active = String(activeStore || storeFromPath()).toLowerCase();
        if (active === 'teststore') return 'test-store';
        const entry = stores.find((s) => storeTabId(s) === active);
        return entry ? areaKeyForStore(entry) : '';
    }

    function storesInArea(stores, areaName) {
        const key = normalizeAreaKey(areaName);
        return sortStores(
            (stores || []).filter((s) => !s.testStore && areaKeyForStore(s) === key)
        );
    }

    function firstStoreHrefForArea(stores, areaName) {
        const inArea = storesInArea(stores, areaName);
        if (inArea.length) return tabHref(storeTabId(inArea[0]));
        return '/admin/teststore';
    }

    function filterStoresForActiveArea(stores, activeStore) {
        const list = Array.isArray(stores) ? stores.filter((s) => s && (s.storeNumber || s.testStore)) : [];
        const active = String(activeStore || '').toLowerCase();

        if (active === 'teststore') {
            return list.filter((s) => s.testStore);
        }

        const activeEntry = list.find((s) => storeTabId(s) === active);
        if (!activeEntry) {
            return list.filter((s) => !s.testStore);
        }

        const areaKey = areaKeyForStore(activeEntry);
        return list.filter((s) => {
            if (s.testStore) return false;
            return areaKeyForStore(s) === areaKey;
        });
    }

    function sortStores(stores) {
        return [...stores].sort((a, b) =>
            String(a.storeNumber).localeCompare(String(b.storeNumber), undefined, { numeric: true })
        );
    }

    function tabHref(storeNumber) {
        const num = String(storeNumber || '').trim();
        return num ? `/admin/${encodeURIComponent(num)}` : '/admin/overview';
    }

    function tabLabel(store) {
        if (store.testStore) return 'Test';
        return String(store.storeNumber || '').replace(/[^0-9]/g, '');
    }

    function mobileTabLabel(store) {
        if (!store) return 'Store';
        if (store.testStore) return store.storeName || 'Test Store';
        const num = tabLabel(store);
        const name = String(store.storeName || '').trim();
        if (name && name !== num) return name;
        return num || 'Store';
    }

    function activePickerLabel(stores, activeStore) {
        const active = String(activeStore || '').toLowerCase();
        const current = stores.find((s) => storeTabId(s) === active);
        if (!current) return 'Select store';
        return mobileTabLabel(current);
    }

    function renderAreaTabs(stores, activeStore) {
        const currentKey = activeAreaKey(stores, activeStore);
        const parts = [];
        ADMIN_AREAS.forEach((name, idx) => {
            const key = normalizeAreaKey(name);
            const isActive = key === currentKey;
            const href = firstStoreHrefForArea(stores, name);
            if (isActive) {
                parts.push(
                    `<span class="admin-area-tab is-active" role="tab" aria-selected="true">${escapeHtml(name)}</span>`
                );
            } else {
                parts.push(
                    `<a class="admin-area-tab" role="tab" href="${escapeHtml(href)}" data-area-name="${escapeHtml(name)}">${escapeHtml(name)}</a>`
                );
            }
            if (idx < ADMIN_AREAS.length - 1) {
                parts.push('<span class="admin-area-tab-pipe" aria-hidden="true">|</span>');
            }
        });
        return parts.join('');
    }

    function renderTabLink(store, activeStore) {
        const num = storeTabId(store);
        if (!num) return '';
        const active = String(activeStore || '').toLowerCase();
        const isActive = num === active;
        const label = tabLabel(store);
        return `<a class="admin-store-tabs__tab${isActive ? ' is-active' : ''}" href="${tabHref(num)}"${
            isActive ? ' aria-current="page"' : ''
        } role="tab"><span class="admin-store-tabs__num">${escapeHtml(label)}</span></a>`;
    }

    function renderMenuLink(store, activeStore) {
        const num = storeTabId(store);
        if (!num) return '';
        const active = String(activeStore || '').toLowerCase();
        const isActive = num === active;
        const label = mobileTabLabel(store);
        return `<a class="admin-store-tabs__menu-item${isActive ? ' is-active' : ''}" href="${tabHref(num)}"${
            isActive ? ' aria-current="page"' : ''
        } role="option">${escapeHtml(label)}</a>`;
    }

    function renderTabs(stores, activeStore) {
        const filtered = sortStores(filterStoresForActiveArea(stores, activeStore));
        const active = activeStore || storeFromPath();
        const items = filtered.map((s) => renderTabLink(s, active)).join('');
        const menuItems = filtered.map((s) => renderMenuLink(s, active)).join('');
        const pickerLabel = escapeHtml(activePickerLabel(filtered, active));

        return `
            <div class="admin-store-chrome">
                <nav class="admin-area-tabs admin-store-area-tabs" role="tablist" aria-label="Select area">
                    ${renderAreaTabs(stores, active)}
                </nav>
                <nav class="admin-store-tabs" aria-label="Switch store">
                    <div class="admin-store-tabs__scroll" role="tablist">${items}</div>
                    <div class="admin-store-tabs__mobile">
                        <button
                            type="button"
                            class="admin-store-tabs__picker-btn"
                            aria-expanded="false"
                            aria-haspopup="listbox"
                            aria-controls="admin-store-tabs-menu"
                        >
                            <span class="admin-store-tabs__picker-label">${pickerLabel}</span>
                        </button>
                        <div
                            id="admin-store-tabs-menu"
                            class="admin-store-tabs__menu"
                            role="listbox"
                            hidden
                        >${menuItems}</div>
                    </div>
                </nav>
            </div>`;
    }

    function positionMobileMenu(btn, menu) {
        const rect = btn.getBoundingClientRect();
        const isMobile = window.matchMedia(`(max-width: ${MOBILE_MAX}px)`).matches;
        menu.style.position = 'fixed';
        menu.style.top = `${Math.round(rect.bottom + 6)}px`;
        menu.style.right = 'auto';
        if (isMobile) {
            const menuWidth = Math.min(320, Math.max(240, global.innerWidth - 32));
            menu.style.left = `${Math.round((global.innerWidth - menuWidth) / 2)}px`;
            menu.style.width = `${menuWidth}px`;
        } else {
            menu.style.left = `${Math.round(rect.left)}px`;
            menu.style.width = `${Math.round(rect.width)}px`;
        }
    }

    function clearMobileMenuPosition(menu) {
        menu.style.position = '';
        menu.style.top = '';
        menu.style.left = '';
        menu.style.width = '';
        menu.style.right = '';
    }

    function closeMobileMenu(bar) {
        const btn = bar.querySelector('.admin-store-tabs__picker-btn');
        const menu = bar.querySelector('.admin-store-tabs__menu');
        const nav = bar.querySelector('.admin-store-tabs');
        if (!btn || !menu) return;
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        nav?.classList.remove('admin-store-tabs--menu-open');
        clearMobileMenuPosition(menu);
    }

    function openMobileMenu(bar) {
        const btn = bar.querySelector('.admin-store-tabs__picker-btn');
        const menu = bar.querySelector('.admin-store-tabs__menu');
        const nav = bar.querySelector('.admin-store-tabs');
        if (!btn || !menu) return;
        positionMobileMenu(btn, menu);
        menu.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        nav?.classList.add('admin-store-tabs--menu-open');
    }

    function bindMobilePicker(bar) {
        if (bar.dataset.mobilePickerBound) return;
        bar.dataset.mobilePickerBound = '1';

        let ignoreOutsideClose = false;

        bar.addEventListener('click', (e) => {
            const btn = e.target.closest('.admin-store-tabs__picker-btn');
            if (!btn || !bar.contains(btn)) return;
            e.preventDefault();
            e.stopPropagation();
            const menu = bar.querySelector('.admin-store-tabs__menu');
            if (!menu) return;
            const willOpen = menu.hidden;
            if (willOpen) {
                openMobileMenu(bar);
                ignoreOutsideClose = true;
                window.setTimeout(() => {
                    ignoreOutsideClose = false;
                }, 300);
            } else {
                closeMobileMenu(bar);
            }
        });

        bar.addEventListener('click', (e) => {
            if (e.target.closest('.admin-store-tabs__menu-item')) closeMobileMenu(bar);
        });

        document.addEventListener('click', (e) => {
            if (ignoreOutsideClose) return;
            if (!bar.contains(e.target)) closeMobileMenu(bar);
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeMobileMenu(bar);
        });

        window.addEventListener(
            'resize',
            () => {
                const menu = bar.querySelector('.admin-store-tabs__menu');
                const btn = bar.querySelector('.admin-store-tabs__picker-btn');
                if (!menu || menu.hidden || !btn) return;
                positionMobileMenu(btn, menu);
            },
            { passive: true }
        );
    }

    async function mountAdminStoreTabs(activeStore) {
        if (!isAdminStorePath()) return;
        const dashboard = document.querySelector('.dashboard');
        if (!dashboard) return;

        let bar = document.getElementById('admin-store-tabs');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'admin-store-tabs';
            const backHost = document.getElementById('admin-store-nav-back');
            if (backHost?.nextSibling) {
                dashboard.insertBefore(bar, backHost.nextSibling);
            } else {
                dashboard.prepend(bar);
            }
        }

        bar.innerHTML = '<div class="admin-store-tabs__loading">Loading stores…</div>';

        try {
            const res = await fetch('/api/stores', { credentials: 'same-origin' });
            const data = await res.json();
            const stores = Array.isArray(data.stores) ? data.stores : [];
            const current = activeStore || storeFromPath();
            bar.innerHTML = renderTabs(stores, current);
            bindMobilePicker(bar);
            bar.querySelector('.admin-store-tabs__tab.is-active')?.scrollIntoView({
                inline: 'center',
                block: 'nearest',
                behavior: 'smooth',
            });
        } catch {
            bar.innerHTML = renderTabs([], activeStore || storeFromPath());
            bindMobilePicker(bar);
        }
    }

    global.AdminStoreTabs = {
        isAdminStorePath,
        storeFromPath,
        filterStoresForActiveArea,
        mount: mountAdminStoreTabs,
        mobileMaxWidth: MOBILE_MAX,
        adminAreas: ADMIN_AREAS,
    };
})(window);
