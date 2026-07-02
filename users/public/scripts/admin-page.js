(function (global) {
    const NAV_GROUPS = [
        { id: 'personal', label: 'Personal' },
        { id: 'admin', label: 'Admin' },
        { id: 'support', label: 'Support' },
    ];

    const ADMIN_SECTIONS = [
        {
            id: 'accounts-create',
            label: 'Create account',
            group: 'admin',
            navGroup: 'admin',
            navParent: 'accounts',
            navParentLabel: 'Accounts',
            visible: (p) => p.canAccessAdminMenu,
            mount: (host, opts) => global.AdminAccounts?.mountCreate?.(host, opts),
            activate: () => global.AdminAccounts?.setInlineHost?.(sectionPanels.get('accounts-create')?.host, 'create'),
        },
        {
            id: 'accounts-existing',
            label: 'Existing accounts',
            group: 'admin',
            navGroup: 'admin',
            navParent: 'accounts',
            navParentLabel: 'Accounts',
            visible: (p) => p.canAccessAdminMenu,
            mount: (host, opts) => global.AdminAccounts?.mountExisting?.(host, opts),
            activate: () => global.AdminAccounts?.setInlineHost?.(sectionPanels.get('accounts-existing')?.host, 'existing'),
        },
        {
            id: 'store-logins',
            label: 'Store logins',
            group: 'admin',
            navGroup: 'admin',
            visible: (p) => p.canManageStoreLogins,
            mount: (host, opts) => global.AdminStoreLogins?.mount?.(host, opts),
            activate: () => global.AdminStoreLogins?.setInlineHost?.(sectionPanels.get('store-logins')?.host),
        },
        {
            id: 'smg-nsf',
            label: 'Setup SMG/NSF',
            group: 'admin',
            navGroup: 'admin',
            visible: () => false,
            mount: (host) => global.AdminSmgNsf?.mount?.(host),
            activate: () => global.AdminSmgNsf?.setInlineHost?.(sectionPanels.get('smg-nsf')?.host),
        },
        {
            id: 'forecast',
            label: 'Forecast tool',
            group: 'admin',
            navGroup: 'admin',
            visible: (p) => p.canAccessAdminMenu,
            mount: (host, opts) => global.AdminForecast?.mount?.(host, opts),
            activate: () => global.AdminForecast?.setInlineHost?.(sectionPanels.get('forecast')?.host),
        },
        {
            id: 'build-to',
            label: 'Build to adjustments',
            group: 'admin',
            navGroup: 'admin',
            visible: (p) => p.canAccessAdminMenu,
            mount: (host, opts) => global.AdminBuildTo?.mount?.(host, opts),
            activate: () => global.AdminBuildTo?.setInlineHost?.(sectionPanels.get('build-to')?.host),
        },
        {
            id: 'five-am-reports',
            label: 'Daily reports',
            group: 'admin',
            navGroup: 'admin',
            visible: (p) => p.canAccessAdminMenu,
            mount: (host, opts) => global.AdminFiveAmReports?.mount?.(host, opts),
            activate: () => global.AdminFiveAmReports?.setInlineHost?.(sectionPanels.get('five-am-reports')?.host),
        },
        {
            id: 'report-subscriptions',
            label: 'Report subscriptions',
            group: 'admin',
            navGroup: 'admin',
            visible: (p) => p.canAccessAdminMenu,
            mount: (host, opts) => global.AdminReportSubscriptions?.mount?.(host, opts),
            activate: () =>
                global.AdminReportSubscriptions?.setInlineHost?.(sectionPanels.get('report-subscriptions')?.host),
        },
    ];

    const USER_SECTIONS = [
        {
            id: 'preferences',
            label: 'Preferences',
            group: 'user',
            navGroup: 'personal',
            visible: () => true,
            mount: (host, opts) => global.MicSettings?.mountPageSection?.('preferences', host, opts),
            activate: () => global.AdminStoreView?.mountSettingsBlock?.(profile),
        },
        {
            id: 'general',
            label: 'General',
            group: 'user',
            navGroup: 'personal',
            visible: () => true,
            mount: (host, opts) => global.MicSettings?.mountPageSection?.('general', host, opts),
            activate: () => {},
        },
        {
            id: 'account',
            label: 'Account',
            group: 'user',
            navGroup: 'personal',
            visible: () => false,
            mount: (host, opts) => global.MicSettings?.mountPageSection?.('account', host, opts),
            activate: () => {},
        },
        {
            id: 'store',
            label: 'Store',
            group: 'user',
            navGroup: 'personal',
            visible: () => false,
            mount: (host, opts) => global.MicSettings?.mountPageSection?.('store', host, opts),
            activate: () => {},
        },
        {
            id: 'feature-requests',
            label: 'Feature requests',
            group: 'user',
            navGroup: 'support',
            visible: (p) => p.canViewFeatureRequests,
            mount: (host, opts) => global.FeatureRequestsView?.mount?.(host, opts),
            activate: () => {},
        },
        {
            id: 'bug-reports',
            label: 'Report bug',
            group: 'user',
            navGroup: 'support',
            visible: () => true,
            mount: (host, opts) => global.BugReportsView?.mount?.(host, opts),
            activate: () => {},
        },
    ];

    const SECTIONS = [...ADMIN_SECTIONS, ...USER_SECTIONS];

    let profile = null;
    let activeSection = '';
    /** @type {Map<string, { host: HTMLElement, mounted: boolean }>} */
    const sectionPanels = new Map();
    let preloadPromise = null;
    /** @type {Set<string>} */
    const expandedParents = new Set();
    /** @type {Set<string>} */
    const expandedNavGroups = new Set();
    let drawerEscapeHandler = null;

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
        const visible = visibleSections(data, opts);
        if (visible.some((section) => section.id === 'preferences')) return 'preferences';
        return visible[0]?.id || 'preferences';
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
        if (hash === 'account' || hash === 'store') return 'preferences';
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

    function sectionNavParent(sectionId) {
        return SECTIONS.find((row) => row.id === sectionId)?.navParent || '';
    }

    function sectionNavGroup(sectionId) {
        return SECTIONS.find((row) => row.id === sectionId)?.navGroup || '';
    }

    function buildGroupItems(sections) {
        const result = [];
        const parentBuckets = new Map();
        const insertedParents = new Set();

        for (const section of sections) {
            if (!section.navParent) continue;
            if (!parentBuckets.has(section.navParent)) {
                parentBuckets.set(section.navParent, {
                    id: section.navParent,
                    label: section.navParentLabel || section.navParent,
                    children: [],
                });
            }
            parentBuckets.get(section.navParent).children.push(section);
        }

        for (const section of sections) {
            if (section.navParent) {
                const parentId = section.navParent;
                if (insertedParents.has(parentId)) continue;
                insertedParents.add(parentId);
                const bucket = parentBuckets.get(parentId);
                if (bucket.children.length === 1) {
                    result.push({ type: 'leaf', section: bucket.children[0] });
                } else {
                    result.push({ type: 'parent', ...bucket });
                }
            } else {
                result.push({ type: 'leaf', section });
            }
        }
        return result;
    }

    function buildNavTree(sections) {
        const byNavGroup = Object.fromEntries(NAV_GROUPS.map((group) => [group.id, []]));
        for (const section of sections) {
            const navGroup = section.navGroup || 'personal';
            if (byNavGroup[navGroup]) byNavGroup[navGroup].push(section);
        }
        return NAV_GROUPS.map((group) => ({
            ...group,
            items: buildGroupItems(byNavGroup[group.id] || []),
        })).filter((group) => group.items.length > 0);
    }

    function renderNavLeaf(section, nested = false) {
        const nestedClass = nested ? ' admin-settings-nav-item--nested' : '';
        return `<button type="button" class="admin-settings-nav-item${nestedClass}" role="tab" data-section="${escapeAttr(section.id)}" aria-selected="false">${escapeAttr(section.label)}</button>`;
    }

    function renderNavParent(parent) {
        const isExpanded = expandedParents.has(parent.id);
        const childrenHtml = parent.children.map((section) => renderNavLeaf(section, true)).join('');
        return `
            <div class="admin-settings-nav-parent${isExpanded ? ' is-expanded' : ''}" data-nav-parent="${escapeAttr(parent.id)}">
                <button type="button" class="admin-settings-nav-parent-toggle" aria-expanded="${isExpanded ? 'true' : 'false'}">
                    <span class="admin-settings-nav-parent-label">${escapeAttr(parent.label)}</span>
                    <span class="admin-settings-nav-chevron" aria-hidden="true"></span>
                </button>
                <div class="admin-settings-nav-children" role="group" aria-label="${escapeAttr(parent.label)}">
                    ${childrenHtml}
                </div>
            </div>`;
    }

    function renderNavGroup(group) {
        const isExpanded = expandedNavGroups.has(group.id);
        const itemsHtml = group.items
            .map((item) => (item.type === 'parent' ? renderNavParent(item) : renderNavLeaf(item.section)))
            .join('');
        return `
            <div class="admin-settings-nav-group${isExpanded ? ' is-expanded' : ''}" role="presentation" data-nav-group="${escapeAttr(group.id)}">
                <button type="button" class="admin-settings-nav-group-toggle" aria-expanded="${isExpanded ? 'true' : 'false'}" aria-controls="admin-settings-nav-group-${escapeAttr(group.id)}">
                    <span class="admin-settings-nav-group-label">${escapeAttr(group.label)}</span>
                    <span class="admin-settings-nav-chevron" aria-hidden="true"></span>
                </button>
                <div id="admin-settings-nav-group-${escapeAttr(group.id)}" class="admin-settings-nav-group-items">${itemsHtml}</div>
            </div>`;
    }

    function sidebarEl() {
        return document.getElementById('admin-settings-nav');
    }

    function sidebarWrapEl() {
        return document.querySelector('.admin-settings-sidebar-wrap');
    }

    function navToggleEl() {
        return document.getElementById('admin-settings-nav-toggle');
    }

    function navBackdropEl() {
        return document.getElementById('admin-settings-nav-backdrop');
    }

    function isDrawerMode() {
        return global.matchMedia('(max-width: 820px)').matches;
    }

    function openNavDrawer() {
        const sidebarWrap = sidebarWrapEl();
        const backdrop = navBackdropEl();
        const toggle = navToggleEl();
        if (!sidebarWrap || !isDrawerMode()) return;
        sidebarWrap.classList.add('is-open');
        backdrop?.classList.add('is-visible');
        backdrop?.removeAttribute('hidden');
        toggle?.setAttribute('aria-expanded', 'true');
        document.body.classList.add('admin-settings-nav-drawer-open');
        if (!drawerEscapeHandler) {
            drawerEscapeHandler = (event) => {
                if (event.key === 'Escape') closeNavDrawer();
            };
            document.addEventListener('keydown', drawerEscapeHandler);
        }
    }

    function closeNavDrawer() {
        const sidebarWrap = sidebarWrapEl();
        const backdrop = navBackdropEl();
        const toggle = navToggleEl();
        sidebarWrap?.classList.remove('is-open');
        backdrop?.classList.remove('is-visible');
        backdrop?.setAttribute('hidden', '');
        toggle?.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('admin-settings-nav-drawer-open');
    }

    function wireSidebarFooter() {
        const signOut = document.getElementById('admin-settings-sign-out');
        if (!signOut || signOut.dataset.wired) return;
        signOut.dataset.wired = '1';
        signOut.addEventListener('click', () => {
            global.location.href = '/logout';
        });
    }

    function wireDrawerControls() {
        const toggle = navToggleEl();
        const backdrop = navBackdropEl();
        if (toggle && !toggle.dataset.wired) {
            toggle.dataset.wired = '1';
            toggle.addEventListener('click', () => {
                if (sidebarWrapEl()?.classList.contains('is-open')) closeNavDrawer();
                else openNavDrawer();
            });
        }
        if (backdrop && !backdrop.dataset.wired) {
            backdrop.dataset.wired = '1';
            backdrop.addEventListener('click', closeNavDrawer);
        }
    }

    function setActiveNav(sectionId, { expandForSection = false } = {}) {
        if (expandForSection) {
            const parentId = sectionNavParent(sectionId);
            if (parentId) expandedParents.add(parentId);
            const navGroup = sectionNavGroup(sectionId);
            if (navGroup) expandedNavGroups.add(navGroup);
        }

        document.querySelectorAll('.admin-settings-nav-item').forEach((btn) => {
            const isActive = btn.dataset.section === sectionId;
            btn.classList.toggle('is-active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });

        document.querySelectorAll('.admin-settings-nav-parent').forEach((row) => {
            const pid = row.dataset.navParent || '';
            const hasActiveChild = Boolean(
                row.querySelector(`.admin-settings-nav-item[data-section="${sectionId}"]`)
            );
            const isExpanded = expandedParents.has(pid);
            row.classList.toggle('is-active', hasActiveChild);
            row.classList.toggle('is-expanded', isExpanded);
            const toggle = row.querySelector('.admin-settings-nav-parent-toggle');
            toggle?.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
        });

        document.querySelectorAll('.admin-settings-nav-group').forEach((row) => {
            const gid = row.dataset.navGroup || '';
            const hasActiveItem = Boolean(
                row.querySelector(`.admin-settings-nav-item[data-section="${sectionId}"]`)
            );
            const isExpanded = expandedNavGroups.has(gid);
            row.classList.toggle('is-active', hasActiveItem);
            row.classList.toggle('is-expanded', isExpanded);
            const toggle = row.querySelector('.admin-settings-nav-group-toggle');
            toggle?.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
        });
    }

    function wireNavInteractions(nav) {
        if (!nav || nav.dataset.navWired) return;
        nav.dataset.navWired = '1';

        nav.addEventListener('click', (event) => {
            const groupBtn = event.target.closest('.admin-settings-nav-group-toggle');
            if (groupBtn) {
                event.preventDefault();
                const group = groupBtn.closest('.admin-settings-nav-group');
                const groupId = group?.dataset.navGroup || '';
                if (!groupId) return;
                if (expandedNavGroups.has(groupId)) expandedNavGroups.delete(groupId);
                else expandedNavGroups.add(groupId);
                setActiveNav(activeSection);
                return;
            }

            const parentBtn = event.target.closest('.admin-settings-nav-parent-toggle');
            if (parentBtn) {
                event.preventDefault();
                const parent = parentBtn.closest('.admin-settings-nav-parent');
                const parentId = parent?.dataset.navParent || '';
                if (!parentId) return;
                if (expandedParents.has(parentId)) expandedParents.delete(parentId);
                else expandedParents.add(parentId);
                setActiveNav(activeSection);
                return;
            }

            const sectionBtn = event.target.closest('.admin-settings-nav-item[data-section]');
            if (sectionBtn) {
                const id = sectionBtn.getAttribute('data-section') || '';
                if (id === activeSection) {
                    if (isDrawerMode()) closeNavDrawer();
                    return;
                }
                void showSection(id);
            }
        });
    }

    function ensurePageShell() {
        if (document.getElementById('admin-settings-content')) return;
        const root = document.getElementById('app') || document.body;
        document.body.classList.add('admin-settings-page');
        root.innerHTML = `
            <div class="admin-settings-shell">
                <header class="admin-settings-header">
                    <div id="nav-back-host" class="admin-settings-header__back"></div>
                    <h1 class="admin-settings-title">Settings</h1>
                    <button type="button" id="admin-settings-nav-toggle" class="admin-settings-nav-toggle admin-settings-header__menu" aria-expanded="false" aria-controls="admin-settings-nav">Menu</button>
                </header>
                <div class="admin-settings-body">
                    <div id="admin-settings-nav-backdrop" class="admin-settings-nav-backdrop" hidden aria-hidden="true"></div>
                    <div class="admin-settings-sidebar-wrap">
                        <nav id="admin-settings-nav" class="admin-settings-sidebar" role="navigation" aria-label="Settings sections"></nav>
                        <div class="admin-settings-sidebar-footer">
                            <button type="button" id="admin-settings-sign-out" class="admin-settings-sign-out">Sign out</button>
                        </div>
                    </div>
                    <main class="admin-settings-main">
                        <div id="admin-settings-content" class="admin-settings-content" role="main"></div>
                    </main>
                </div>
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
        setActiveNav(section.id, { expandForSection: true });
        revealSection(section.id);
        if (isDrawerMode()) closeNavDrawer();
    }

    function renderNav(data) {
        const nav = sidebarEl();
        if (!nav) return;
        const opts = mountOptions();
        const items = visibleSections(data, opts);
        const tree = buildNavTree(items);
        nav.innerHTML = tree.map(renderNavGroup).join('');
        wireNavInteractions(nav);
        wireDrawerControls();
        wireSidebarFooter();
    }

    function mountBackButton() {
        const host = document.getElementById('nav-back-host');
        if (!host || !global.DashboardNavBack?.mountBackButton) return;
        global.DashboardNavBack.mountBackButton(host, {
            fallback: global.AppPaths?.micOverview?.() || '/overview',
            fade: true,
            label: 'Back',
            embedded: true,
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
            wireSidebarFooter();

            const host = contentHost();
            if (host) {
                host.innerHTML =
                    '<div class="admin-settings-loading-panel" aria-live="polite"><p class="admin-settings-loading">Loading settings…</p></div>';
            }

            const requested = sectionFromLocation() || defaultSectionId(data);
            await preloadAllSections(data);
            host?.querySelector('.admin-settings-loading-panel')?.remove();

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
            expandedParents.clear();
            expandedNavGroups.clear();
            await init();
        },
        unmount() {
            if (drawerEscapeHandler) {
                document.removeEventListener('keydown', drawerEscapeHandler);
                drawerEscapeHandler = null;
            }
            closeNavDrawer();
            const root = document.getElementById('app');
            if (root) root.innerHTML = '';
            document.body.classList.remove('admin-settings-page', 'admin-settings-nav-drawer-open');
            preloadPromise = null;
            sectionPanels.clear();
            activeSection = '';
            profile = null;
            expandedParents.clear();
            expandedNavGroups.clear();
        },
    };

    global.AdminSettingsPage = {
        defaultSectionId,
        showSection,
    };
})(window);
