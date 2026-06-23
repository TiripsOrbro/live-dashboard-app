(function (global) {
    const SECTIONS = [
        {
            id: 'accounts-create',
            label: 'Create account',
            visible: (p) => p.canAccessAdminMenu,
            mount: (host, opts) => global.AdminAccounts?.mountCreate?.(host, opts),
            activate: () => global.AdminAccounts?.setInlineHost?.(sectionPanels.get('accounts-create')?.host, 'create'),
        },
        {
            id: 'accounts-existing',
            label: 'Existing accounts',
            visible: (p) => p.canAccessAdminMenu,
            mount: (host, opts) => global.AdminAccounts?.mountExisting?.(host, opts),
            activate: () => global.AdminAccounts?.setInlineHost?.(sectionPanels.get('accounts-existing')?.host, 'existing'),
        },
        {
            id: 'store-logins',
            label: 'Store logins',
            visible: (p) => p.canManageStoreLogins,
            mount: (host, opts) => global.AdminStoreLogins?.mount?.(host, opts),
            activate: () => global.AdminStoreLogins?.setInlineHost?.(sectionPanels.get('store-logins')?.host),
        },
        {
            id: 'smg-nsf',
            label: 'Setup SMG/NSF',
            visible: (p) => p.canManageSmgNsfSettings,
            mount: (host) => global.AdminSmgNsf?.mount?.(host),
            activate: () => global.AdminSmgNsf?.setInlineHost?.(sectionPanels.get('smg-nsf')?.host),
        },
        {
            id: 'forecast',
            label: 'Forecast tool',
            visible: (p) => p.canAccessAdminMenu,
            mount: (host, opts) => global.AdminForecast?.mount?.(host, opts),
            activate: () => global.AdminForecast?.setInlineHost?.(sectionPanels.get('forecast')?.host),
        },
        {
            id: 'build-to',
            label: 'Build to adjustments',
            visible: (p) => p.canAccessAdminMenu,
            mount: (host, opts) => global.AdminBuildTo?.mount?.(host, opts),
            activate: () => global.AdminBuildTo?.setInlineHost?.(sectionPanels.get('build-to')?.host),
        },
        {
            id: 'feature-requests',
            label: 'Feature requests',
            visible: (p) => p.isSuperAdmin,
            external: '/requests',
        },
    ];

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

    function visibleSections(data) {
        return SECTIONS.filter((section) => section.visible(data));
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
            btn.setAttribute('aria-current', isActive ? 'page' : 'false');
        });
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
        if (!preloadPromise) {
            preloadPromise = preloadSections(visibleSections(data));
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
        const allowed = visibleSections(data);
        const section = allowed.find((row) => row.id === sectionId) || allowed[0];
        if (!section) {
            const host = contentHost();
            if (host) {
                host.innerHTML = '<p class="admin-settings-empty">You do not have access to any admin settings.</p>';
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

    function renderNav(data) {
        const nav = document.getElementById('admin-settings-nav');
        if (!nav) return;
        const items = visibleSections(data);
        nav.innerHTML = items
            .map(
                (section) =>
                    `<button type="button" class="admin-settings-nav-item" data-section="${escapeAttr(section.id)}">${escapeAttr(section.label)}</button>`
            )
            .join('');
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
            label: 'Back to overview',
        });
    }

    async function init() {
        mountBackButton();
        try {
            const data = await fetchProfile();
            if (!data.canAccessAdminMenu && !data.canManageStoreLogins) {
                global.location.href = '/login';
                return;
            }
            renderNav(data);

            const host = contentHost();
            if (host) {
                host.innerHTML = '<p class="admin-settings-loading">Loading admin settings…</p>';
            }

            const requested = sectionFromLocation() || visibleSections(data)[0]?.id;
            await preloadAllSections(data);
            host?.querySelector('.admin-settings-loading')?.remove();

            if (requested) {
                await showSection(requested);
            }
        } catch {
            global.location.href = '/login';
        }

        global.addEventListener('hashchange', () => {
            const next = sectionFromLocation();
            if (next && next !== activeSection) void showSection(next);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void init());
    } else {
        void init();
    }
})(window);
