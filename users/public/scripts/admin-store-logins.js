(function (global) {
    let backdrop = null;
    let profile = null;
    let activeTab = 'mmx';
    let activeView = 'overview';
    let storeList = [];
    let scopeTree = null;
    let scopeNavigator = null;
    let browseScope = { market: '', area: '', storeNumber: '' };
    let currentStore = '';
    let storeDetail = null;

    const SERVICE_LABELS = {
        mmx: 'MMX',
        lifelenz: 'LifeLenz',
        smg: 'SMG',
        nsf: 'NSF',
    };

    const SERVICES = ['mmx', 'lifelenz', 'smg', 'nsf'];

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function escapeAttr(text) {
        return escapeHtml(text);
    }

    function formatWhen(iso, by) {
        const parts = [];
        if (by) parts.push(escapeHtml(by));
        if (iso) {
            try {
                parts.push(new Date(iso).toLocaleString());
            } catch {
                parts.push(escapeHtml(iso));
            }
        }
        return parts.length ? parts.join(' · ') : '—';
    }

    function loginFieldForService(service) {
        return service === 'lifelenz' ? 'email' : 'username';
    }

    function loginLabelForService(service) {
        return service === 'lifelenz' ? 'Email' : 'Username';
    }

    function normalizeStoreNumber(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        const stripped = raw.replace(/^0+/, '');
        return stripped || raw;
    }

    function storeInList(storeNumber) {
        const num = normalizeStoreNumber(storeNumber);
        if (!num) return false;
        return storeList.some((row) => {
            const listed = String(row.storeNumber);
            return listed === num || normalizeStoreNumber(listed) === num;
        });
    }

    function storeNumberFromList(storeNumber) {
        const num = normalizeStoreNumber(storeNumber);
        const row = storeList.find((entry) => normalizeStoreNumber(entry.storeNumber) === num);
        return row ? String(row.storeNumber) : num;
    }

    function preferredStoreNumber() {
        const candidates = [
            currentStore,
            browseScope.storeNumber,
            storeList.length === 1 ? storeList[0].storeNumber : '',
            scopeTree?.defaults?.storeNumber,
        ];
        const effective = profile?.effectiveStores;
        if (Array.isArray(effective)) {
            if (effective.length === 1) candidates.push(effective[0]);
            if (profile?.skipStorePicker && effective[0]) candidates.push(effective[0]);
        }
        const userMatch = String(profile?.username || '').match(/^CB(\d{3,6})$/i);
        if (userMatch?.[1]) candidates.push(userMatch[1]);
        const pathMatch = global.location?.pathname?.match(/\/(?:MIC|mic)\/(\d+)/i);
        if (pathMatch?.[1]) candidates.push(pathMatch[1]);

        for (const candidate of candidates) {
            const num = String(candidate || '').trim();
            if (storeInList(num)) return storeNumberFromList(num);
        }
        return '';
    }

    function buildFallbackScopeTree(stores) {
        const rows = (stores || []).map((row) => ({
            storeNumber: String(row.storeNumber),
            storeName: String(row.storeName || row.storeNumber),
        }));
        if (!rows.length) return null;
        const bucket = 'Stores';
        return {
            markets: [bucket],
            areasByMarket: { [bucket]: [bucket] },
            storesByArea: { [bucket]: rows },
            defaults: {
                market: bucket,
                area: bucket,
                storeNumber: rows.length === 1 ? rows[0].storeNumber : '',
            },
        };
    }

    function syncScopeNavVisibility() {
        const wrap = ensureBackdrop().querySelector('#admin-store-logins-scope-wrap');
        if (!wrap) return;
        const hidePicker = storeList.length === 1 && Boolean(currentStore);
        wrap.hidden = hidePicker;
    }

    function ensurePreferredStoreSelected() {
        const preferred = preferredStoreNumber();
        if (!preferred) return false;

        if (scopeTree) {
            browseScope = global.AdminScopePicker.resolveBrowseScope(scopeTree, browseScope, preferred);
        }
        if (!browseScope.storeNumber) {
            browseScope = { market: '', area: '', storeNumber: preferred };
        }

        currentStore = storeNumberFromList(browseScope.storeNumber || preferred);
        browseScope.storeNumber = currentStore;
        scopeNavigator?.setScope?.(browseScope);
        syncScopeNavVisibility();
        return true;
    }

    function ensureBackdrop() {
        if (backdrop) return backdrop;
        backdrop = document.createElement('div');
        backdrop.className = 'admin-modal-backdrop';
        backdrop.hidden = true;
        backdrop.innerHTML = `
            <div class="admin-modal admin-modal--wide admin-modal--store-logins" role="dialog" aria-modal="true">
                <h2>Setup Store Logins</h2>
                <div class="admin-tabs admin-tabs--full admin-store-logins-view-tabs" id="admin-store-logins-view-tabs">
                    <button type="button" class="admin-tab is-active" data-view="overview">Overview</button>
                    <button type="button" class="admin-tab" data-view="edit">Edit store</button>
                </div>
                <div id="admin-store-logins-scope-wrap" class="admin-store-logins-scope-wrap">
                    <div id="admin-store-logins-scope-nav" class="admin-store-logins-scope-nav"></div>
                    <p id="admin-store-logins-scope-summary" class="admin-store-logins-scope-summary"></p>
                </div>
                <div id="admin-store-logins-overview" class="admin-store-logins-overview"></div>
                <div id="admin-store-logins-edit" class="admin-store-logins-edit" hidden>
                    <div class="admin-tabs admin-tabs--full" id="admin-store-logins-tabs">
                        ${SERVICES.map(
                            (svc) =>
                                `<button type="button" class="admin-tab${svc === 'mmx' ? ' is-active' : ''}" data-tab="${svc}">${SERVICE_LABELS[svc]}</button>`
                        ).join('')}
                    </div>
                    <div id="admin-store-logins-body"></div>
                </div>
                <p id="admin-store-logins-error" class="admin-modal-error" role="alert"></p>
                <div class="admin-modal-actions">
                    <button type="button" id="admin-store-logins-close">Close</button>
                </div>
            </div>`;
        document.body.appendChild(backdrop);
        backdrop.addEventListener('click', (event) => {
            if (event.target === backdrop) close();
        });
        backdrop.querySelector('#admin-store-logins-close')?.addEventListener('click', close);
        backdrop.querySelectorAll('#admin-store-logins-view-tabs [data-view]').forEach((btn) => {
            btn.addEventListener('click', () => {
                activeView = btn.dataset.view;
                applyViewUi();
                void refresh();
            });
        });
        backdrop.querySelectorAll('#admin-store-logins-tabs [data-tab]').forEach((btn) => {
            btn.addEventListener('click', () => {
                activeTab = btn.dataset.tab;
                applyTabUi();
                renderEditPanel();
            });
        });
        return backdrop;
    }

    function close() {
        if (backdrop) backdrop.hidden = true;
    }

    function setError(message) {
        const el = ensureBackdrop().querySelector('#admin-store-logins-error');
        if (!el) return;
        if (message) {
            el.textContent = message;
            el.hidden = false;
        } else {
            el.textContent = '';
            el.hidden = true;
        }
    }

    function applyViewUi() {
        const root = ensureBackdrop();
        root.querySelectorAll('#admin-store-logins-view-tabs [data-view]').forEach((btn) => {
            btn.classList.toggle('is-active', btn.dataset.view === activeView);
        });
        root.querySelector('#admin-store-logins-overview').hidden = activeView !== 'overview';
        root.querySelector('#admin-store-logins-edit').hidden = activeView !== 'edit';
    }

    function applyTabUi() {
        const root = ensureBackdrop();
        root.querySelectorAll('#admin-store-logins-tabs [data-tab]').forEach((tab) => {
            tab.classList.toggle('is-active', tab.dataset.tab === activeTab);
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

    async function loadScopeTree() {
        try {
            const raw = await global.AdminScopePicker.loadScopeTree();
            scopeTree = global.AdminScopePicker.filterScopeTreeForStores(raw, storeList);
        } catch {
            scopeTree = buildFallbackScopeTree(storeList);
        }
        if (!scopeTree) {
            scopeTree = buildFallbackScopeTree(storeList);
        }
        return scopeTree;
    }

    async function loadStores() {
        const res = await fetch('/api/admin/store-logins', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not load store logins.');
        storeList = data.stores || [];
        return storeList;
    }

    function filteredStores() {
        return global.AdminScopePicker.storesMatchingScope(storeList, scopeTree, browseScope);
    }

    function updateScopeSummary() {
        const el = ensureBackdrop().querySelector('#admin-store-logins-scope-summary');
        if (!el) return;
        const rows = filteredStores();
        const parts = [];
        if (browseScope.market) parts.push(browseScope.market);
        if (browseScope.area) parts.push(browseScope.area);
        if (browseScope.storeNumber) parts.push(`Store ${browseScope.storeNumber}`);
        const scopeLabel = parts.length ? parts.join(' · ') : 'All stores';
        el.textContent =
            activeView === 'edit'
                ? `${scopeLabel}${browseScope.storeNumber ? '' : ' — pick a store to edit logins'}`
                : `${scopeLabel} — showing ${rows.length} store${rows.length === 1 ? '' : 's'}`;
    }

    function syncCurrentStoreFromScope() {
        if (ensurePreferredStoreSelected()) return true;

        const store = String(browseScope.storeNumber || '').trim();
        if (store && storeList.some((row) => String(row.storeNumber) === store)) {
            currentStore = store;
            return true;
        }
        if (activeView === 'edit') {
            const scoped = filteredStores();
            if (scoped.length === 1) {
                const only = String(scoped[0].storeNumber);
                browseScope = global.AdminScopePicker.resolveBrowseScope(scopeTree, browseScope, only);
                currentStore = only;
                scopeNavigator?.setScope?.(browseScope);
                return true;
            }
            currentStore = '';
            return false;
        }
        return Boolean(currentStore);
    }

    function renderScopeNavigator() {
        const host = ensureBackdrop().querySelector('#admin-store-logins-scope-nav');
        if (!host || !scopeTree) {
            if (host) host.innerHTML = '<p class="admin-accounts-meta">No stores in your scope.</p>';
            return;
        }

        const onScopeChange = (scope) => {
            browseScope = { ...scope };
            updateScopeSummary();
            if (activeView === 'overview') {
                renderOverview();
                return;
            }
            if (syncCurrentStoreFromScope()) {
                void loadStoreDetail();
            } else {
                storeDetail = null;
                renderEditPanel();
            }
        };

        if (!scopeNavigator) {
            scopeNavigator = global.AdminScopePicker.mountInline(host, {
                tree: scopeTree,
                initialScope: browseScope,
                preferredStore: preferredStoreNumber(),
                onChange: onScopeChange,
            });
        } else {
            scopeNavigator.setTree(scopeTree);
            scopeNavigator.setScope(browseScope);
        }
        browseScope = scopeNavigator.getScope();
        updateScopeSummary();
        syncScopeNavVisibility();
    }

    async function loadStoreDetail() {
        if (!syncCurrentStoreFromScope()) {
            storeDetail = null;
            renderEditPanel();
            return;
        }
        const res = await fetch(`/api/admin/store-logins/${encodeURIComponent(currentStore)}`, {
            credentials: 'same-origin',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not load store login detail.');
        storeDetail = data;
        renderEditPanel();
    }

    function renderOverview() {
        const root = ensureBackdrop();
        const host = root.querySelector('#admin-store-logins-overview');
        const rows = filteredStores();
        if (!rows.length) {
            host.innerHTML = '<p>No stores match this market / area / store selection.</p>';
            updateScopeSummary();
            return;
        }
        host.innerHTML = `
            <p class="admin-accounts-meta">Masked logins only. Full credentials are never shown after save.</p>
            <table class="admin-table admin-store-logins-table">
                <colgroup>
                    ${'<col class="admin-store-logins-col" />'.repeat(5)}
                </colgroup>
                <thead>
                    <tr>
                        <th>Store</th>
                        ${SERVICES.map((svc) => `<th>${SERVICE_LABELS[svc]}</th>`).join('')}
                    </tr>
                </thead>
                <tbody>
                    ${rows
                        .map((row) => {
                            const cells = SERVICES.map((svc) => {
                                const status = row.services?.[svc] || {};
                                if (!status.configured) {
                                    return '<td class="admin-store-logins-missing">Not configured</td>';
                                }
                                const primary = status.primary;
                                const lines = [];
                                if (primary?.maskedLogin) {
                                    lines.push(
                                        `<div><strong>${escapeHtml(primary.maskedLogin)}</strong></div>`
                                    );
                                    lines.push(
                                        `<div class="admin-accounts-meta">${formatWhen(primary.updatedAt, primary.updatedBy)}</div>`
                                    );
                                }
                                if (status.fallbackCount > 0) {
                                    lines.push(
                                        `<div class="admin-accounts-meta">+${status.fallbackCount} fallback${status.fallbackCount === 1 ? '' : 's'}</div>`
                                    );
                                }
                                return `<td>${lines.join('') || 'Configured'}</td>`;
                            }).join('');
                            return `<tr class="admin-store-logins-overview-row" data-store-number="${escapeAttr(row.storeNumber)}" tabindex="0" role="button">
                                <td>${escapeHtml(row.storeName || row.storeNumber)}<span class="admin-accounts-meta">${escapeHtml(row.storeNumber)}</span></td>
                                ${cells}
                            </tr>`;
                        })
                        .join('')}
                </tbody>
            </table>`;
        host.querySelectorAll('.admin-store-logins-overview-row').forEach((row) => {
            const openStore = () => {
                const storeNumber = row.getAttribute('data-store-number') || '';
                browseScope = global.AdminScopePicker.resolveBrowseScope(scopeTree, {}, storeNumber);
                currentStore = storeNumber;
                scopeNavigator?.setScope?.(browseScope);
                activeView = 'edit';
                applyViewUi();
                updateScopeSummary();
                void loadStoreDetail();
            };
            row.addEventListener('click', openStore);
            row.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openStore();
                }
            });
        });
        updateScopeSummary();
    }

    function renderCredentialBlock(entry, service, isPrimary) {
        if (!entry) {
            return '<p class="admin-accounts-meta">No login saved.</p>';
        }
        return `
            <div class="admin-store-logins-entry">
                <div><strong>${escapeHtml(entry.label || (isPrimary ? 'Primary' : 'Fallback'))}</strong></div>
                <div>${escapeHtml(entry.maskedLogin || '—')}</div>
                <div class="admin-accounts-meta">Updated by ${formatWhen(entry.updatedAt, entry.updatedBy)}</div>
                ${
                    !isPrimary && entry.id
                        ? `<button type="button" class="mic-settings-btn admin-store-logins-remove" data-fallback-id="${escapeHtml(entry.id)}">Remove</button>`
                        : ''
                }
            </div>`;
    }

    function renderEditPanel() {
        const root = ensureBackdrop();
        const body = root.querySelector('#admin-store-logins-body');
        if (!currentStore) {
            body.innerHTML = '<p>Select market, area, and store above to manage logins.</p>';
            updateScopeSummary();
            return;
        }
        const service = activeTab;
        const status = storeDetail?.services?.[service] || { configured: false, primary: null, fallbacks: [] };
        const loginField = loginFieldForService(service);
        body.innerHTML = `
            <section class="admin-store-logins-section">
                <h3>Primary ${escapeHtml(SERVICE_LABELS[service])} login — store ${escapeHtml(currentStore)}</h3>
                ${renderCredentialBlock(status.primary, service, true)}
                <form class="admin-accounts-form-grid admin-store-logins-form" data-role="primary">
                    <label class="admin-accounts-field">
                        ${escapeHtml(loginLabelForService(service))}
                        <input type="${service === 'lifelenz' ? 'email' : 'text'}" name="${loginField}" autocomplete="off" required>
                    </label>
                    <label class="admin-accounts-field">
                        Password
                        <input type="password" name="password" autocomplete="new-password" required>
                    </label>
                    <label class="admin-accounts-field">
                        Label
                        <input type="text" name="label" value="Primary">
                    </label>
                    <div class="admin-accounts-create-actions">
                        <button type="submit" class="mic-settings-btn admin-btn-primary">Verify &amp; save primary</button>
                    </div>
                </form>
            </section>
            <section class="admin-store-logins-section">
                <h3>Fallback logins</h3>
                <div class="admin-store-logins-fallbacks">
                    ${(status.fallbacks || []).map((row) => renderCredentialBlock(row, service, false)).join('') || '<p class="admin-accounts-meta">No fallbacks yet.</p>'}
                </div>
                <form class="admin-accounts-form-grid admin-store-logins-form" data-role="fallback">
                    <label class="admin-accounts-field">
                        ${escapeHtml(loginLabelForService(service))}
                        <input type="${service === 'lifelenz' ? 'email' : 'text'}" name="${loginField}" autocomplete="off" required>
                    </label>
                    <label class="admin-accounts-field">
                        Password
                        <input type="password" name="password" autocomplete="new-password" required>
                    </label>
                    <label class="admin-accounts-field">
                        Label
                        <input type="text" name="label" value="Fallback">
                    </label>
                    <div class="admin-accounts-create-actions">
                        <button type="submit" class="mic-settings-btn">Verify &amp; add fallback</button>
                    </div>
                </form>
            </section>`;

        body.querySelectorAll('.admin-store-logins-form').forEach((form) => {
            form.addEventListener('submit', (event) => {
                event.preventDefault();
                void submitForm(form);
            });
        });
        body.querySelectorAll('.admin-store-logins-remove').forEach((btn) => {
            btn.addEventListener('click', () => {
                void removeFallback(btn.dataset.fallbackId);
            });
        });
        updateScopeSummary();
    }

    function formPayload(form) {
        const data = new FormData(form);
        const payload = {};
        for (const [key, value] of data.entries()) payload[key] = String(value || '').trim();
        return payload;
    }

    async function submitForm(form) {
        setError('');
        const role = form.dataset.role;
        const payload = formPayload(form);
        const url =
            role === 'fallback'
                ? `/api/admin/store-logins/${encodeURIComponent(currentStore)}/${activeTab}/fallbacks`
                : `/api/admin/store-logins/${encodeURIComponent(currentStore)}/${activeTab}/verify`;
        const body =
            role === 'fallback'
                ? { ...payload, verify: true }
                : { ...payload, save: true, asFallback: false };
        const res = await fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            setError(data.error || 'Could not save login.');
            return;
        }
        form.reset();
        await loadStores();
        await loadScopeTree();
        ensurePreferredStoreSelected();
        renderScopeNavigator();
        browseScope = scopeNavigator?.getScope?.() || browseScope;
        ensurePreferredStoreSelected();
        await loadStoreDetail();
        if (activeView === 'overview') renderOverview();
    }

    async function removeFallback(fallbackId) {
        setError('');
        const res = await fetch(
            `/api/admin/store-logins/${encodeURIComponent(currentStore)}/${activeTab}/fallbacks/${encodeURIComponent(fallbackId)}`,
            { method: 'DELETE', credentials: 'same-origin' }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            setError(data.error || 'Could not remove fallback.');
            return;
        }
        await loadStores();
        await loadScopeTree();
        ensurePreferredStoreSelected();
        renderScopeNavigator();
        browseScope = scopeNavigator?.getScope?.() || browseScope;
        ensurePreferredStoreSelected();
        await loadStoreDetail();
        if (activeView === 'overview') renderOverview();
    }

    async function refresh() {
        setError('');
        await loadStores();
        await loadScopeTree();
        ensurePreferredStoreSelected();
        renderScopeNavigator();
        browseScope = scopeNavigator?.getScope?.() || browseScope;
        ensurePreferredStoreSelected();
        syncScopeNavVisibility();
        if (activeView === 'overview') {
            renderOverview();
            return;
        }
        if (syncCurrentStoreFromScope()) {
            await loadStoreDetail();
        } else {
            storeDetail = null;
            renderEditPanel();
        }
    }

    async function open() {
        const me = await fetchProfile();
        if (!me.canManageStoreLogins) {
            throw new Error('You do not have permission to manage store logins.');
        }
        ensureBackdrop();
        backdrop.hidden = false;
        activeTab = 'mmx';
        scopeNavigator = null;
        browseScope = { market: '', area: '', storeNumber: '' };
        currentStore = '';
        activeView = 'overview';
        applyViewUi();
        applyTabUi();
        await loadStores();
        await loadScopeTree();
        if (preferredStoreNumber()) {
            activeView = 'edit';
            applyViewUi();
        }
        await refresh();
    }

    global.AdminStoreLogins = { open, close };
})(window);
