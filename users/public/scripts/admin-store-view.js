/**
 * Admin "view dashboard as store user" - session preference + settings UI.
 */
(function (global) {
    const ENABLED_KEY = 'admin-view-as-store-enabled';
    const STORE_KEY = 'admin-view-as-store';

    let meProfile = null;
    let wired = false;

    function canUse(profile) {
        const p = profile || meProfile;
        if (!p) return false;
        const scope = p.overviewScope;
        return scope === 'super' || scope === 'market' || scope === 'area';
    }

    function isEnabled() {
        try {
            return sessionStorage.getItem(ENABLED_KEY) === '1';
        } catch {
            return false;
        }
    }

    function getSelectedStore() {
        try {
            return String(sessionStorage.getItem(STORE_KEY) || '').trim();
        } catch {
            return '';
        }
    }

    function setEnabled(enabled) {
        try {
            if (enabled) sessionStorage.setItem(ENABLED_KEY, '1');
            else sessionStorage.removeItem(ENABLED_KEY);
        } catch {
            /* ignore */
        }
        syncSettingsUi();
        global.dispatchEvent(new CustomEvent('admin-store-view-change'));
    }

    function setStore(storeNumber) {
        const store = String(storeNumber || '').trim();
        try {
            if (store) sessionStorage.setItem(STORE_KEY, store);
            else sessionStorage.removeItem(STORE_KEY);
        } catch {
            /* ignore */
        }
        syncSettingsUi();
        global.dispatchEvent(new CustomEvent('admin-store-view-change'));
    }

    function resolveStoreForOverview(profile) {
        if (!canUse(profile)) return '';
        if (!isEnabled()) return '';
        const store = getSelectedStore();
        if (!store) return '';
        const allowed = new Set((profile?.effectiveStores || []).map(String));
        if (allowed.size && !allowed.has(String(store))) return '';
        return store;
    }

    function isActiveOnOverview(profile) {
        return Boolean(resolveStoreForOverview(profile));
    }

    function storeLabel(storeNumber) {
        const num = String(storeNumber || '').trim();
        return num ? `Store ${num}` : 'No store selected';
    }

    function applyAndReload({ enabled, storeNumber } = {}) {
        if (enabled !== undefined) setEnabled(Boolean(enabled));
        if (storeNumber !== undefined) setStore(storeNumber);
        global.location.reload();
    }

    function openStorePicker({ enableOnSelect = false } = {}) {
        global.AdminScopePicker?.open({
            title: 'Select store',
            hint: 'Choose market, area, and store to preview the store-level dashboard.',
            preferredStore: getSelectedStore(),
            onSelect: (store) => {
                if (enableOnSelect) {
                    setEnabled(true);
                    setStore(store);
                    global.location.reload();
                    return;
                }
                setStore(store);
                if (isEnabled()) {
                    global.location.reload();
                    return;
                }
                syncSettingsUi();
            },
        });
    }

    function renderSettingsBlock() {
        return `
            <div class="mic-settings-pref-block mic-admin-store-view" id="mic-admin-store-view-block">
                <div class="mic-settings-toggle-row">
                    <span class="mic-settings-toggle-label" id="mic-admin-store-view-label">View as store user</span>
                    <label class="mic-toggle-switch">
                        <input type="checkbox" id="mic-admin-store-view-toggle" role="switch" aria-labelledby="mic-admin-store-view-label" />
                        <span class="mic-toggle-slider" aria-hidden="true"></span>
                    </label>
                </div>
                <p class="mic-settings-pref-hint" id="mic-admin-store-view-hint">
                    Use the store selector in the page header, or the toggle below, to preview the MIC overview as a single store.
                </p>
                <p class="mic-admin-store-view-current" id="mic-admin-store-view-current"></p>
                <button type="button" class="mic-settings-btn" id="mic-admin-store-view-pick">Select store</button>
            </div>`;
    }

    function mountSettingsBlock(profile) {
        meProfile = profile || meProfile;
        if (!canUse(meProfile)) return;
        const panel = document.querySelector('[data-settings-panel="preferences"]');
        if (!panel || document.getElementById('mic-admin-store-view-block')) return;
        panel.insertAdjacentHTML('afterbegin', renderSettingsBlock());
        wireSettingsControls();
        syncSettingsUi();
    }

    function syncSettingsUi() {
        syncHeaderSelector();
        const block = document.getElementById('mic-admin-store-view-block');
        if (!block || block.hidden) return;
        const toggle = document.getElementById('mic-admin-store-view-toggle');
        const current = document.getElementById('mic-admin-store-view-current');
        const store = getSelectedStore();
        if (toggle) toggle.checked = isEnabled();
        if (current) {
            current.textContent = store ? `Selected: ${storeLabel(store)}` : 'No store selected yet.';
            current.classList.toggle('mic-admin-store-view-current--empty', !store);
        }
    }

    function formatStoreOptionLabel(row) {
        const num = String(row?.storeNumber || '').trim();
        const name = String(row?.storeName || '').trim();
        if (!num) return '';
        return name && name !== num ? `${num} — ${name}` : num;
    }

    async function loadStoreOptions() {
        const allowed = new Set((meProfile?.effectiveStores || []).map(String));
        try {
            const tree = await global.AdminScopePicker?.loadScopeTree?.();
            if (tree) {
                const flat = [];
                const seen = new Set();
                for (const rows of Object.values(tree.storesByArea || {})) {
                    for (const row of rows || []) {
                        const num = String(row.storeNumber || '').trim();
                        if (!num || seen.has(num)) continue;
                        if (allowed.size && !allowed.has(num)) continue;
                        seen.add(num);
                        flat.push({
                            storeNumber: num,
                            label: formatStoreOptionLabel(row),
                        });
                    }
                }
                flat.sort((a, b) =>
                    a.storeNumber.localeCompare(b.storeNumber, undefined, { numeric: true })
                );
                if (flat.length) return flat;
            }
        } catch {
            /* ignore */
        }
        return [...allowed]
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            .map((num) => ({ storeNumber: num, label: storeLabel(num) }));
    }

    function syncHeaderSelector(selectEl) {
        const select = selectEl || document.getElementById('mic-header-store-select');
        if (!select) return;
        const activeStore = isEnabled() ? getSelectedStore() : '';
        const hasOption = activeStore && [...select.options].some((opt) => opt.value === activeStore);
        select.value = hasOption ? activeStore : '';
        document.body.classList.toggle('mic-store-view-active', Boolean(activeStore));
    }

    function onHeaderStoreSelectChange(event) {
        const value = String(event.target?.value || '').trim();
        if (!value) {
            applyAndReload({ enabled: false, storeNumber: '' });
            return;
        }
        applyAndReload({ enabled: true, storeNumber: value });
    }

    function wireHeaderSelector(select) {
        if (!select || select.dataset.storeSelectWired) return;
        select.dataset.storeSelectWired = '1';
        select.addEventListener('change', onHeaderStoreSelectChange);
    }

    async function populateHeaderSelector(select) {
        if (!select) return;
        const currentValue = isEnabled() ? getSelectedStore() : '';
        select.innerHTML = '<option value="">Default — all stores</option>';
        const stores = await loadStoreOptions();
        for (const store of stores) {
            const opt = document.createElement('option');
            opt.value = store.storeNumber;
            opt.textContent = store.label || store.storeNumber;
            select.appendChild(opt);
        }
        syncHeaderSelector(select);
        if (currentValue && select.value !== currentValue) {
            const missing = document.createElement('option');
            missing.value = currentValue;
            missing.textContent = storeLabel(currentValue);
            select.appendChild(missing);
            select.value = currentValue;
        }
    }

    function mountHeaderSelector() {
        if (!canUse(meProfile)) return;
        const actions = document.querySelector('.mic-header--admin .mic-header-actions');
        if (!actions) return;

        let wrap = document.getElementById('mic-header-store-select-wrap');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = 'mic-header-store-select-wrap';
            wrap.className = 'mic-header-store-select-wrap';
            wrap.innerHTML = `
                <label class="mic-header-store-select-label" for="mic-header-store-select">Store</label>
                <select
                    id="mic-header-store-select"
                    class="mic-header-store-select"
                    aria-label="Select store or default admin view"
                >
                    <option value="">Default — all stores</option>
                </select>`;
            actions.insertBefore(wrap, actions.firstChild);
        }

        const select = wrap.querySelector('#mic-header-store-select');
        wireHeaderSelector(select);
        void populateHeaderSelector(select);
    }

    function wireSettingsControls() {
        if (wired) return;
        const toggle = document.getElementById('mic-admin-store-view-toggle');
        const pickBtn = document.getElementById('mic-admin-store-view-pick');
        if (!toggle && !pickBtn) return;
        wired = true;

        toggle?.addEventListener('change', () => {
            const wantOn = toggle.checked;
            const store = getSelectedStore();
            if (wantOn && !store) {
                toggle.checked = false;
                openStorePicker({ enableOnSelect: true });
                return;
            }
            applyAndReload({ enabled: wantOn });
        });

        pickBtn?.addEventListener('click', () => {
            openStorePicker({ enableOnSelect: false });
        });
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    async function init(profile) {
        meProfile = profile || meProfile;
    }

    function afterShellRendered(profile) {
        meProfile = profile || meProfile;
        if (!canUse(meProfile)) return;
        mountHeaderSelector();
        mountSettingsBlock(meProfile);
    }

    global.AdminStoreView = {
        init,
        afterShellRendered,
        canUse,
        isEnabled,
        getSelectedStore,
        resolveStoreForOverview,
        isActiveOnOverview,
        mountHeaderSelector,
        mountSettingsBlock,
        syncSettingsUi,
        openStorePicker,
        applyAndReload,
    };
})(window);
