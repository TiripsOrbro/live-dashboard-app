(function (global) {
    let menuOpen = false;
    let panelBound = false;
    let bindOptions = {};
    let profile = null;

    function escapeAttr(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    }

    function renderTrigger(options = {}) {
        const hidden = options.hidden ? ' hidden' : '';
        const id = options.id ? ` id="${escapeAttr(options.id)}"` : ' id="admin-menu-btn"';
        const className = options.className || 'mic-account-btn admin-menu-trigger';
        return `<button type="button" class="${escapeAttr(className)}"${id}${hidden}>Admin menu</button>`;
    }

    function renderActionsHtml() {
        return `
                <div class="admin-menu-actions mic-settings-actions">
                    <button type="button" class="mic-settings-btn" data-admin-action="view-accounts">Accounts</button>
                    <button type="button" class="mic-settings-btn" data-admin-action="store-logins" hidden>Setup Store Logins</button>
                    <button type="button" class="mic-settings-btn" data-admin-action="smg-nsf" hidden>Setup SMG/NSF</button>
                    <button type="button" class="mic-settings-btn" data-admin-action="forecast">Forecast tool</button>
                    <button type="button" class="mic-settings-btn" data-admin-action="build-to">Build to adjustments</button>
                    <button type="button" class="mic-settings-btn" data-admin-action="feature-requests" hidden>Feature requests</button>
                </div>`;
    }

    function renderPanel() {
        return `
        <div id="admin-menu-picker" class="mic-item-picker admin-menu-picker" hidden>
            <div class="mic-item-picker-panel admin-menu-panel">
                <h2>Admin menu</h2>
                ${renderActionsHtml()}
                <div class="admin-menu-footer">
                    <button type="button" class="mic-settings-btn" id="admin-menu-close">Close</button>
                </div>
            </div>
        </div>`;
    }

    function ensurePanel() {
        let picker = document.getElementById('admin-menu-picker');
        if (picker) return picker;
        const host = document.createElement('div');
        host.innerHTML = renderPanel();
        picker = host.firstElementChild;
        document.body.appendChild(picker);
        return picker;
    }

    function closeMenu() {
        const picker = document.getElementById('admin-menu-picker');
        if (!picker) return;
        picker.classList.add('is-closing');
        window.setTimeout(() => {
            picker.hidden = true;
            picker.classList.remove('is-closing');
            menuOpen = false;
        }, 350);
    }

    function openMenu() {
        const picker = ensurePanel();
        if (!panelBound) bindPanel(picker);
        picker.hidden = false;
        picker.classList.remove('is-closing');
        menuOpen = true;
    }

    function viewAccountsOptions() {
        if (typeof bindOptions.getViewAccountsOptions === 'function') {
            return bindOptions.getViewAccountsOptions();
        }
        return bindOptions.viewAccountsOptions || {};
    }

    function applyActionVisibility(root, data) {
        if (!root || !data) return;
        const storeLoginsBtn = root.querySelector('[data-admin-action="store-logins"]');
        if (storeLoginsBtn) storeLoginsBtn.hidden = !data.canManageStoreLogins;
        const smgNsfBtn = root.querySelector('[data-admin-action="smg-nsf"]');
        if (smgNsfBtn) smgNsfBtn.hidden = !data.canManageSmgNsfSettings;
        root.querySelectorAll(
            '[data-admin-action="view-accounts"], [data-admin-action="forecast"], [data-admin-action="build-to"]'
        ).forEach((btn) => {
            btn.hidden = !data.canAccessAdminMenu;
        });
        const featureRequestsBtn = root.querySelector('[data-admin-action="feature-requests"]');
        if (featureRequestsBtn) featureRequestsBtn.hidden = !data.isSuperAdmin;
    }

    function bindActionButtons(root, options = {}) {
        if (!root || root.dataset.adminActionsBound) return;
        root.dataset.adminActionsBound = '1';
        if (options.getViewAccountsOptions) {
            bindOptions.getViewAccountsOptions = options.getViewAccountsOptions;
        }
        const onBeforeAction = options.onBeforeAction || closeMenu;
        root.querySelector('[data-admin-action="view-accounts"]')?.addEventListener('click', () => {
            onBeforeAction();
            global.AdminAccounts?.open?.(viewAccountsOptions());
        });
        root.querySelector('[data-admin-action="forecast"]')?.addEventListener('click', () => {
            onBeforeAction();
            global.AdminForecast?.open?.(viewAccountsOptions());
        });
        root.querySelector('[data-admin-action="build-to"]')?.addEventListener('click', () => {
            onBeforeAction();
            global.AdminBuildTo?.open?.(viewAccountsOptions());
        });
        root.querySelector('[data-admin-action="store-logins"]')?.addEventListener('click', () => {
            onBeforeAction();
            global.AdminStoreLogins?.open?.();
        });
        root.querySelector('[data-admin-action="smg-nsf"]')?.addEventListener('click', () => {
            onBeforeAction();
            global.AdminSmgNsf?.open?.();
        });
        root.querySelector('[data-admin-action="feature-requests"]')?.addEventListener('click', () => {
            onBeforeAction();
            window.location.href = '/requests';
        });
    }

    function bindPanel(picker) {
        panelBound = true;
        picker.addEventListener('click', (event) => {
            if (event.target === picker) closeMenu();
        });
        picker.querySelector('#admin-menu-close')?.addEventListener('click', closeMenu);
        bindActionButtons(picker.querySelector('.admin-menu-actions'), { onBeforeAction: closeMenu });
    }

    async function fetchProfile() {
        if (profile) return profile;
        const res = await fetch('/api/me', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error('Could not load profile.');
        profile = data;
        return data;
    }

    function bind(options = {}) {
        bindOptions = { ...bindOptions, ...options };
        document.querySelectorAll('.admin-menu-trigger').forEach((btn) => {
            if (btn.dataset.adminMenuBound) return;
            btn.dataset.adminMenuBound = '1';
            btn.addEventListener('click', () => openMenu());
        });
        if (bindOptions.resolveVisibility !== false) {
            void fetchProfile()
                .then((data) => {
                    document.querySelectorAll('.admin-menu-trigger').forEach((btn) => {
                        if (data.canAccessAdminMenu || data.canManageStoreLogins) btn.hidden = false;
                    });
                    const adminTab = document.getElementById('mic-settings-admin-tab');
                    if (adminTab && (data.canAccessAdminMenu || data.canManageStoreLogins)) {
                        adminTab.hidden = false;
                    }
                    const settingsAdminPanel = document.querySelector('[data-settings-panel="admin"]');
                    if (settingsAdminPanel) applyActionVisibility(settingsAdminPanel, data);
                    const adminMenuPicker = document.getElementById('admin-menu-picker');
                    if (adminMenuPicker) applyActionVisibility(adminMenuPicker, data);
                })
                .catch(() => {});
        }
    }

    function mountHeaderTrigger(host, options = {}) {
        if (!host) return;
        host.innerHTML = renderTrigger({ hidden: options.hidden !== false, id: options.id || 'admin-menu-btn' });
        bind(options);
    }

    global.AdminMenu = {
        renderTrigger,
        renderActionsHtml,
        renderPanel,
        mountHeaderTrigger,
        bind,
        bindActionButtons,
        applyActionVisibility,
        open: openMenu,
        close: closeMenu,
        fetchProfile,
    };
})(window);
