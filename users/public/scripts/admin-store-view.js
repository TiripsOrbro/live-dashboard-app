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
                    Preview the MIC overview as a single store. Admin menu and settings stay available.
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

    function mountBanner() {
        if (!isActiveOnOverview(meProfile)) return;
        const store = getSelectedStore();
        if (!store) return;
        const page = document.getElementById('mic-page');
        if (!page || document.getElementById('mic-admin-store-view-banner')) return;
        const banner = document.createElement('div');
        banner.id = 'mic-admin-store-view-banner';
        banner.className = 'mic-admin-store-view-banner';
        banner.innerHTML = `
            <span>Viewing as ${escapeHtml(storeLabel(store))}</span>
            <button type="button" class="mic-admin-store-view-banner-exit" id="mic-admin-store-view-exit">Exit store view</button>`;
        page.insertAdjacentElement('afterbegin', banner);
        banner.querySelector('#mic-admin-store-view-exit')?.addEventListener('click', () => {
            applyAndReload({ enabled: false });
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
        mountSettingsBlock(meProfile);
        mountBanner();
    }

    global.AdminStoreView = {
        init,
        afterShellRendered,
        canUse,
        isEnabled,
        getSelectedStore,
        resolveStoreForOverview,
        isActiveOnOverview,
        mountSettingsBlock,
        syncSettingsUi,
        openStorePicker,
        applyAndReload,
    };
})(window);
