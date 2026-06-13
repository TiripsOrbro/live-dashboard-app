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

    function renderPanel() {
        return `
        <div id="admin-menu-picker" class="mic-item-picker admin-menu-picker" hidden>
            <div class="mic-item-picker-panel admin-menu-panel">
                <h2>Admin menu</h2>
                <div class="admin-menu-actions">
                    <button type="button" class="mic-settings-btn" data-admin-action="view-accounts">View accounts</button>
                    <button type="button" class="mic-settings-btn" data-admin-action="forecast">Forecast tool</button>
                    <button type="button" class="mic-settings-btn" data-admin-action="build-to">Build to adjustments</button>
                </div>
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

    function bindPanel(picker) {
        panelBound = true;
        picker.addEventListener('click', (event) => {
            if (event.target === picker) closeMenu();
        });
        picker.querySelector('#admin-menu-close')?.addEventListener('click', closeMenu);
        picker.querySelector('[data-admin-action="view-accounts"]')?.addEventListener('click', () => {
            closeMenu();
            global.AdminAccounts?.open?.(viewAccountsOptions());
        });
        picker.querySelector('[data-admin-action="forecast"]')?.addEventListener('click', () => {
            closeMenu();
            global.AdminForecast?.open?.(viewAccountsOptions());
        });
        picker.querySelector('[data-admin-action="build-to"]')?.addEventListener('click', () => {
            closeMenu();
            global.AdminBuildTo?.open?.(viewAccountsOptions());
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
            btn.addEventListener('click', () => openMenu());
        });
        if (bindOptions.resolveVisibility !== false) {
            void fetchProfile()
                .then((data) => {
                    document.querySelectorAll('.admin-menu-trigger').forEach((btn) => {
                        if (data.canAccessAdminMenu) btn.hidden = false;
                    });
                    const settingsBtn = document.getElementById('mic-admin-menu-btn');
                    if (settingsBtn && data.canAccessAdminMenu) settingsBtn.hidden = false;
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
        renderPanel,
        mountHeaderTrigger,
        bind,
        open: openMenu,
        close: closeMenu,
        fetchProfile,
    };
})(window);
