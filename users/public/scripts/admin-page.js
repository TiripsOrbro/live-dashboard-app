(function (global) {
    const SECTIONS = [
        {
            id: 'accounts-create',
            label: 'Create account',
            visible: (p) => p.canAccessAdminMenu,
            mount: (host, opts) => global.AdminAccounts?.mountCreate?.(host, opts),
            unmount: () => global.AdminAccounts?.unmount?.(),
        },
        {
            id: 'accounts-existing',
            label: 'Existing accounts',
            visible: (p) => p.canAccessAdminMenu,
            mount: (host, opts) => global.AdminAccounts?.mountExisting?.(host, opts),
            unmount: () => global.AdminAccounts?.unmount?.(),
        },
        {
            id: 'store-logins',
            label: 'Store logins',
            visible: (p) => p.canManageStoreLogins,
            mount: (host, opts) => global.AdminStoreLogins?.mount?.(host, opts),
            unmount: () => global.AdminStoreLogins?.unmount?.(),
        },
        {
            id: 'smg-nsf',
            label: 'Setup SMG/NSF',
            visible: (p) => p.canManageSmgNsfSettings,
            mount: (host) => global.AdminSmgNsf?.mount?.(host),
            unmount: () => global.AdminSmgNsf?.unmount?.(),
        },
        {
            id: 'forecast',
            label: 'Forecast tool',
            visible: (p) => p.canAccessAdminMenu,
            mount: (host, opts) => global.AdminForecast?.mount?.(host, opts),
            unmount: () => global.AdminForecast?.unmount?.(),
        },
        {
            id: 'build-to',
            label: 'Build to adjustments',
            visible: (p) => p.canAccessAdminMenu,
            mount: (host, opts) => global.AdminBuildTo?.mount?.(host, opts),
            unmount: () => global.AdminBuildTo?.unmount?.(),
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
    let mountedSection = '';

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

    function unmountCurrent() {
        if (!mountedSection) return;
        const section = SECTIONS.find((row) => row.id === mountedSection);
        section?.unmount?.();
        mountedSection = '';
    }

    async function showSection(sectionId) {
        const data = await fetchProfile();
        const allowed = visibleSections(data);
        const section = allowed.find((row) => row.id === sectionId) || allowed[0];
        if (!section) {
            document.getElementById('admin-settings-content').innerHTML =
                '<p class="admin-settings-empty">You do not have access to any admin settings.</p>';
            return;
        }

        if (section.external) {
            global.location.href = section.external;
            return;
        }

        activeSection = section.id;
        if (global.location.hash !== `#${section.id}`) {
            global.history.replaceState(null, '', `#${section.id}`);
        }
        setActiveNav(section.id);

        const host = document.getElementById('admin-settings-content');
        if (!host) return;

        if (mountedSection && mountedSection !== section.id) {
            unmountCurrent();
        }

        host.innerHTML = '<p class="admin-settings-loading">Loading…</p>';

        try {
            unmountCurrent();
            host.innerHTML = '';
            await section.mount(host, mountOptions());
            mountedSection = section.id;
        } catch (error) {
            host.innerHTML = `<p class="admin-modal-error" role="alert">${escapeAttr(error.message || 'Could not load section.')}</p>`;
        }
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
            const requested = sectionFromLocation();
            await showSection(requested);
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
