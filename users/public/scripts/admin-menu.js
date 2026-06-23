(function (global) {
    const ADMIN_PAGE_PATH = '/Admin/Settings';

    let profile = null;

    function escapeAttr(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    }

    function sectionUrl(section, query = {}) {
        const params = new URLSearchParams();
        Object.entries(query).forEach(([key, value]) => {
            if (value != null && String(value).trim() !== '') params.set(key, String(value));
        });
        const qs = params.toString();
        return `${ADMIN_PAGE_PATH}${qs ? `?${qs}` : ''}#${section}`;
    }

    function goToAdminPage(section, query = {}) {
        global.location.href = sectionUrl(section, query);
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
                    <button type="button" class="mic-settings-btn" data-admin-action="store-logins" hidden>Store logins</button>
                    <button type="button" class="mic-settings-btn" data-admin-action="smg-nsf" hidden>Setup SMG/NSF</button>
                    <button type="button" class="mic-settings-btn" data-admin-action="forecast">Forecast tool</button>
                    <button type="button" class="mic-settings-btn" data-admin-action="build-to">Build to adjustments</button>
                    <button type="button" class="mic-settings-btn" data-admin-action="feature-requests" hidden>Feature requests</button>
                </div>`;
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

    let bindOptions = {};

    function bindActionButtons(root, options = {}) {
        if (!root || root.dataset.adminActionsBound) return;
        root.dataset.adminActionsBound = '1';
        bindOptions = { ...bindOptions, ...options };
        if (options.getViewAccountsOptions) {
            bindOptions.getViewAccountsOptions = options.getViewAccountsOptions;
        }
        const onBeforeAction = options.onBeforeAction || (() => {});

        root.querySelector('[data-admin-action="view-accounts"]')?.addEventListener('click', () => {
            onBeforeAction();
            goToAdminPage('accounts-existing', viewAccountsOptions());
        });
        root.querySelector('[data-admin-action="forecast"]')?.addEventListener('click', () => {
            onBeforeAction();
            goToAdminPage('forecast', viewAccountsOptions());
        });
        root.querySelector('[data-admin-action="build-to"]')?.addEventListener('click', () => {
            onBeforeAction();
            goToAdminPage('build-to', viewAccountsOptions());
        });
        root.querySelector('[data-admin-action="store-logins"]')?.addEventListener('click', () => {
            onBeforeAction();
            goToAdminPage('store-logins');
        });
        root.querySelector('[data-admin-action="smg-nsf"]')?.addEventListener('click', () => {
            onBeforeAction();
            goToAdminPage('smg-nsf');
        });
        root.querySelector('[data-admin-action="feature-requests"]')?.addEventListener('click', () => {
            onBeforeAction();
            global.location.href = '/requests';
        });
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
            btn.addEventListener('click', () => {
                global.location.href = ADMIN_PAGE_PATH;
            });
        });
        if (bindOptions.resolveVisibility !== false) {
            void fetchProfile()
                .then((data) => {
                    document.querySelectorAll('.admin-menu-trigger').forEach((btn) => {
                        if (data.canAccessAdminMenu || data.canManageStoreLogins) btn.hidden = false;
                    });
                    const adminBtn = document.getElementById('mic-settings-admin-btn');
                    if (adminBtn && (data.canAccessAdminMenu || data.canManageStoreLogins)) {
                        adminBtn.hidden = false;
                    }
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
        ADMIN_PAGE_PATH,
        sectionUrl,
        goToAdminPage,
        renderTrigger,
        renderActionsHtml,
        mountHeaderTrigger,
        bind,
        bindActionButtons,
        applyActionVisibility,
        open: () => {
            global.location.href = ADMIN_PAGE_PATH;
        },
        close: () => {},
        fetchProfile,
    };
})(window);
