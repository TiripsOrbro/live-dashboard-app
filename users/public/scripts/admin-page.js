(function (global) {
    const ADMIN_SECTIONS = [
        {
            id: 'accounts-create',
            label: 'Create account',
            group: 'admin',
            visible: (p) => p.canAccessAdminMenu,
            mount: (host, opts) => global.AdminAccounts?.mountCreate?.(host, opts),
            activate: () => global.AdminAccounts?.setInlineHost?.(sectionPanels.get('accounts-create')?.host, 'create'),
        },
        {
            id: 'accounts-existing',
            label: 'Store accounts',
            group: 'admin',
            visible: (p) => p.canAccessAdminMenu,
            mount: (host, opts) => global.AdminAccounts?.mountExisting?.(host, opts),
            activate: () => global.AdminAccounts?.setInlineHost?.(sectionPanels.get('accounts-existing')?.host, 'existing'),
        },
        {
            id: 'store-logins',
            label: 'Store logins',
            group: 'admin',
            visible: (p) => p.canManageStoreLogins,
            mount: (host, opts) => global.AdminStoreLogins?.mount?.(host, opts),
            activate: () => global.AdminStoreLogins?.setInlineHost?.(sectionPanels.get('store-logins')?.host),
        },
        {
            id: 'smg-nsf',
            label: 'Setup SMG/NSF',
            group: 'admin',
            visible: () => false,
            mount: (host) => global.AdminSmgNsf?.mount?.(host),
            activate: () => global.AdminSmgNsf?.setInlineHost?.(sectionPanels.get('smg-nsf')?.host),
        },
        {
            id: 'forecast',
            label: 'Forecast tool',
            group: 'admin',
            visible: (p) => p.canAccessAdminMenu,
            mount: (host, opts) => global.AdminForecast?.mount?.(host, opts),
            activate: () => global.AdminForecast?.setInlineHost?.(sectionPanels.get('forecast')?.host),
        },
        {
            id: 'build-to',
            label: 'Build to adjustments',
            group: 'admin',
            visible: (p) => p.canAccessAdminMenu,
            mount: (host, opts) => global.AdminBuildTo?.mount?.(host, opts),
            activate: () => global.AdminBuildTo?.setInlineHost?.(sectionPanels.get('build-to')?.host),
        },
        {
            id: 'feature-requests',
            label: 'Feature requests',
            group: 'admin',
            visible: (p) => p.isSuperAdmin,
            mount: (host, opts) => global.FeatureRequestsView?.mount?.(host, opts),
            activate: () => {},
        },
    ];

    const USER_SECTIONS = [
        {
            id: 'account',
            label: 'Account',
            group: 'user',
            visible: () => true,
            mount: (host, opts) => global.MicSettings?.mountPageSection?.('account', host, opts),
            activate: () => {},
        },
        {
            id: 'preferences',
            label: 'Preferences',
            group: 'user',
            visible: () => true,
            mount: (host, opts) => global.MicSettings?.mountPageSection?.('preferences', host, opts),
            activate: () => global.AdminStoreView?.mountSettingsBlock?.(profile),
        },
        {
            id: 'store',
            label: 'Store',
            group: 'user',
            visible: (_p, opts) => Boolean(opts?.storeNumber),
            mount: (host, opts) => global.MicSettings?.mountPageSection?.('store', host, opts),
            activate: () => {},
        },
        {
            id: 'general',
            label: 'General',
            group: 'user',
            visible: () => true,
            mount: (host, opts) => global.MicSettings?.mountPageSection?.('general', host, opts),
            activate: () => {},
        },
    ];

    const SECTIONS = [...ADMIN_SECTIONS, ...USER_SECTIONS];

    let profile = null;
    let activeSection = '';
    /** @type {Map<string, { host: HTMLElement, mounted: boolean }>} */
    const sectionPanels = new Map();
    let preloadPromise = null;

    function escapeAttr(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    }

    async function fetchProfile() {
        if (profile) return profile;
        const res = await fetch('/api/me', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error('Could not load profile.');
        profile = data;
        return data;
    }

    function visibleSections(data, opts = mountOptions()) {
        return SECTIONS.filter((section) => {
            if (section.external) return section.visible(data, opts);
            return section.visible(data, opts);
        });
    }

    function defaultSectionId(data, opts = mountOptions()) {
        const adminSections = ADMIN_SECTIONS.filter((section) => section.visible(data, opts));
        if (adminSections.length) return adminSections[0].id;
        return 'account';
    }

    function sectionFromLocation() {
        const hash = String(global.location.hash || '').replace(/^#/, '').trim().toLowerCase();
        if (hash === 'accounts') {
            const params = new URLSearchParams(global.location.search);
            if (/^(1|true|yes)$/i.test(String(params.get('focusCreate') || ''))) {
                return 'accounts-create';
            }
            return 'accounts-existing';
        }
        if (hash) return hash;
        const params = new URLSearchParams(global.location.search);
        return String(params.get('section') || '').trim().toLowerCase();
    }

    function mountOptions() {
        const params = new URLSearchParams(global.location.search);
        const storeNumber = String(params.get('store') || '').trim();
        const focusCreate = /^(1|true|yes)$/i.test(String(params.get('focusCreate') || ''));
        return { storeNumber, focusCreate };
    }

    function setActiveNav(sectionId) {
        document.querySelectorAll('.admin-settings-nav-item').forEach((btn) => {
            const isActive = btn.dataset.section === sectionId;
            btn.classList.toggle('is-active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
    }

    function ensurePageShell() {
        if (document.getElementById('admin-settings-content')) return;
        const root = document.getElementById('app') || document.body;
        document.body.classList.add('admin-settings-page');
        root.innerHTML = `
            <div id="nav-back-host"></div>
            <div class="admin-settings-shell">
                <header class="admin-settings-header">
                    <h1 class="admin-settings-title">Settings</h1>
                    <nav id="admin-settings-nav" class="admin-settings-nav-wrap" role="tablist" aria-label="Settings sections"></nav>
                </header>
                <main class="admin-settings-main">
                    <div id="admin-settings-content" class="admin-settings-content" role="main"></div>
                </main>
            </div>`;
    }

    function contentHost() {
        return document.getElementById('admin-settings-content');
    }

    async function ensureSectionMounted(section) {
        if (section.external || sectionPanels.get(section.id)?.mounted) return;

        const host = contentHost();
        if (!host) return;

        let panel = sectionPanels.get(section.id)?.host;
        if (!panel) {
            panel = document.createElement('div');
            panel.className = 'admin-settings-section-panel';
            if (section.group === 'user') panel.classList.add('admin-settings-user-panel');
            panel.dataset.adminSection = section.id;
            panel.hidden = true;
            host.appendChild(panel);
            sectionPanels.set(section.id, { host: panel, mounted: false });
        }

        try {
            await section.mount(panel, mountOptions());
            sectionPanels.set(section.id, { host: panel, mounted: true });
        } catch (error) {
            panel.innerHTML = `<p class="admin-modal-error" role="alert">${escapeAttr(error.message || 'Could not load section.')}</p>`;
            sectionPanels.set(section.id, { host: panel, mounted: false });
        }
    }

    async function preloadSections(sections) {
        const internal = sections.filter((section) => !section.external);
        const accountSections = internal.filter((section) => section.id.startsWith('accounts-'));
        const otherSections = internal.filter((section) => !section.id.startsWith('accounts-'));

        for (const section of accountSections) {
            await ensureSectionMounted(section);
        }
        await Promise.all(otherSections.map((section) => ensureSectionMounted(section)));
    }

    function preloadAllSections(data) {
        const opts = mountOptions();
        if (!preloadPromise) {
            preloadPromise = preloadSections(visibleSections(data, opts));
        }
        return preloadPromise;
    }

    function revealSection(sectionId) {
        for (const [id, row] of sectionPanels) {
            row.host.hidden = id !== sectionId;
        }
        const section = SECTIONS.find((row) => row.id === sectionId);
        section?.activate?.();
    }

    async function showSection(sectionId) {
        const data = await fetchProfile();
        const opts = mountOptions();
        const allowed = visibleSections(data, opts);
        const section = allowed.find((row) => row.id === sectionId) || allowed[0];
        if (!section) {
            const host = contentHost();
            if (host) {
                host.innerHTML = '<p class="admin-settings-empty">You do not have access to any settings.</p>';
            }
            return;
        }

        if (section.external) {
            global.location.href = section.external;
            return;
        }

        await preloadAllSections(data);

        if (!sectionPanels.get(section.id)?.mounted) {
            await ensureSectionMounted(section);
        }

        activeSection = section.id;
        if (global.location.hash !== `#${section.id}`) {
            global.history.replaceState(null, '', `#${section.id}`);
        }
        setActiveNav(section.id);
        revealSection(section.id);
    }

    function renderNavRow(sections) {
        if (!sections.length) return '';
        return `
            <div class="admin-accounts-scope-row-wrap admin-settings-nav-row">
                <div class="admin-accounts-scope-row admin-accounts-scope-row--equal admin-settings-section-tabs" role="presentation" style="--scope-cols: ${sections.length}">
                    ${sections
                        .map(
                            (section) =>
                                `<button type="button" class="admin-accounts-scope-chip admin-settings-nav-item admin-settings-tab" role="tab" data-section="${escapeAttr(section.id)}" aria-selected="false">${escapeAttr(section.label)}</button>`
                        )
                        .join('')}
                </div>
            </div>`;
    }

    function renderNav(data) {
        const nav = document.getElementById('admin-settings-nav');
        if (!nav) return;
        const opts = mountOptions();
        const items = visibleSections(data, opts);
        const adminItems = items.filter((section) => section.group === 'admin');
        const userItems = items.filter((section) => section.group === 'user');
        nav.innerHTML = renderNavRow(adminItems) + renderNavRow(userItems);
        nav.querySelectorAll('[data-section]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.getAttribute('data-section') || '';
                if (id === activeSection) return;
                void showSection(id);
            });
        });
    }

    function mountBackButton() {
        const host = document.getElementById('nav-back-host');
        if (!host || !global.DashboardNavBack?.mountBackButton) return;
        global.DashboardNavBack.mountBackButton(host, {
            fallback: global.AppPaths?.micOverview?.() || '/overview',
            fade: true,
            label: 'Back',
        });
    }

    async function init() {
        ensurePageShell();
        mountBackButton();
        global.__APP_SHELL__ = Boolean(global.__APP_SHELL__);
        try {
            const data = await fetchProfile();
            global.MicSettings?.setStoreContext?.({
                storeNumber: mountOptions().storeNumber,
            });
            await global.MicSettings?.initPreferences?.();

            renderNav(data);

            const host = contentHost();
            if (host) {
                host.innerHTML = '<p class="admin-settings-loading">Loading settings…</p>';
            }

            const requested = sectionFromLocation() || defaultSectionId(data);
            await preloadAllSections(data);
            host?.querySelector('.admin-settings-loading')?.remove();

            await showSection(requested);
        } catch {
            global.location.href = '/login';
        }

        global.addEventListener('hashchange', () => {
            const next = sectionFromLocation();
            if (next && next !== activeSection) void showSection(next);
        });
    }

    if (!global.__APP_SHELL__) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => void init());
        } else {
            void init();
        }
    }

    global.AdminSettingsView = {
        async mount() {
            preloadPromise = null;
            sectionPanels.clear();
            activeSection = '';
            profile = null;
            await init();
        },
        unmount() {
            const root = document.getElementById('app');
            if (root) root.innerHTML = '';
            document.body.classList.remove('admin-settings-page');
            preloadPromise = null;
            sectionPanels.clear();
            activeSection = '';
            profile = null;
        },
    };

    global.AdminSettingsPage = {
        defaultSectionId,
        showSection,
    };
})(window);
