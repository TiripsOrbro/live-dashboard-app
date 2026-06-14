(function (global) {
    let backdrop = null;
    let profile = null;
    let createOptions = null;
    let currentStoreNumber = '';
    let browseScope = { market: '', area: '', storeNumber: '' };

    const LEVEL_LABELS = {
        market: 'Market',
        area: 'Area',
        manager: 'Manager',
        mic: 'MIC',
        tm: 'TM',
    };

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

    function levelNeedsMarket(level) {
        return ['market', 'area', 'manager', 'mic', 'tm'].includes(level);
    }

    function levelNeedsArea(level) {
        return ['area', 'manager', 'mic', 'tm'].includes(level);
    }

    function levelNeedsStore(level) {
        return ['manager', 'mic', 'tm'].includes(level);
    }

    function ensureBackdrop() {
        if (backdrop) return backdrop;
        backdrop = document.createElement('div');
        backdrop.className = 'admin-modal-backdrop';
        backdrop.hidden = true;
        backdrop.innerHTML = `
            <div class="admin-modal admin-modal--wide" role="dialog" aria-modal="true">
                <h2>Accounts</h2>
                <section id="admin-accounts-create" class="admin-accounts-create">
                    <h3>Create account</h3>
                    <form id="admin-accounts-create-form" class="admin-accounts-form-grid">
                        <label class="admin-accounts-field">
                            Username
                            <input id="admin-create-username" type="text" autocomplete="off" required>
                        </label>
                        <div class="admin-accounts-field">
                            <span>Access level</span>
                            <div id="admin-create-level-group" class="admin-accounts-level-bar" role="radiogroup" aria-label="Access level"></div>
                        </div>
                        <div id="admin-create-scope-stack" class="admin-accounts-scope-stack"></div>
                        <p class="admin-accounts-meta" style="margin: 0;">
                            A temporary password is generated automatically. The new user must sign in, link Macromatix if required, and set a personal password.
                        </p>
                        <div class="admin-accounts-create-actions">
                            <button type="submit" class="mic-settings-btn admin-btn-primary" id="admin-create-submit">Create account</button>
                            <button type="reset" class="mic-settings-btn" id="admin-create-reset">Clear form</button>
                        </div>
                        <div id="admin-create-result" class="admin-accounts-temp-password" hidden></div>
                    </form>
                </section>
                <section class="admin-accounts-existing">
                    <h3>Existing accounts</h3>
                    <div id="admin-accounts-browse-scope" class="admin-accounts-browse-scope"></div>
                    <div id="admin-accounts-body"></div>
                </section>
                <p id="admin-accounts-error" class="admin-modal-error" role="alert"></p>
                <div class="admin-modal-actions">
                    <button type="button" id="admin-accounts-close">Close</button>
                </div>
            </div>`;
        document.body.appendChild(backdrop);
        backdrop.addEventListener('click', (event) => {
            if (event.target === backdrop) close();
        });
        backdrop.querySelector('#admin-accounts-close')?.addEventListener('click', close);
        backdrop.querySelector('#admin-create-level-group')?.addEventListener('change', syncCreateScopeUI);
        backdrop.querySelector('#admin-create-scope-stack')?.addEventListener('change', syncCreateScopeUI);
        backdrop.querySelector('#admin-accounts-browse-scope')?.addEventListener('change', () => {
            void onBrowseScopeChange();
        });
        backdrop.querySelector('#admin-accounts-create-form')?.addEventListener('submit', (event) => {
            event.preventDefault();
            void submitCreateAccount();
        });
        backdrop.querySelector('#admin-accounts-create-form')?.addEventListener('reset', () => {
            window.setTimeout(() => {
                syncCreateScopeUI();
                backdrop.querySelector('#admin-create-result').hidden = true;
                backdrop.querySelector('#admin-create-result').innerHTML = '';
                const submitBtn = backdrop.querySelector('#admin-create-submit');
                submitBtn.disabled = false;
                submitBtn.textContent = 'Create account';
            }, 0);
        });
        return backdrop;
    }

    function close() {
        if (backdrop) backdrop.hidden = true;
        resetCreateForm();
    }

    function resetCreateForm() {
        if (!backdrop) return;
        const form = backdrop.querySelector('#admin-accounts-create-form');
        const resultEl = backdrop.querySelector('#admin-create-result');
        const submitBtn = backdrop.querySelector('#admin-create-submit');
        form?.reset();
        if (resultEl) {
            resultEl.hidden = true;
            resultEl.innerHTML = '';
        }
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create account';
        }
        syncCreateScopeUI();
    }

    function selectedRadioValue(root, name) {
        return root.querySelector(`input[type="radio"][name="${name}"]:checked`)?.value || '';
    }

    function resolveScopeSelections(level, tree, selections = {}) {
        let market = selections.market || '';
        let area = selections.area || '';
        let storeNumber = selections.storeNumber || '';

        if (levelNeedsMarket(level)) {
            if (!market && tree.markets.length === 1) market = tree.markets[0];
            if (!market && tree.defaults?.market) market = tree.defaults.market;
        } else {
            market = '';
        }

        const areas = market ? tree.areasByMarket[market] || [] : [];
        if (levelNeedsArea(level)) {
            if (area && !areas.includes(area)) area = '';
            if (!area && areas.length === 1) area = areas[0];
            if (!area && tree.defaults?.area && areas.includes(tree.defaults.area)) area = tree.defaults.area;
        } else {
            area = '';
        }

        const stores = area ? tree.storesByArea[area] || [] : [];
        if (levelNeedsStore(level)) {
            if (storeNumber && !stores.some((row) => row.storeNumber === storeNumber)) storeNumber = '';
            if (!storeNumber && stores.length === 1) storeNumber = stores[0].storeNumber;
            if (
                !storeNumber &&
                tree.defaults?.storeNumber &&
                stores.some((row) => row.storeNumber === tree.defaults.storeNumber)
            ) {
                storeNumber = tree.defaults.storeNumber;
            }
        } else {
            storeNumber = '';
        }

        return { market, area, storeNumber };
    }

    function resolveBrowseScope(tree, selections = {}, preferredStore = '') {
        let market = selections.market || '';
        let area = selections.area || '';
        let storeNumber = String(preferredStore || selections.storeNumber || '').trim();

        if (storeNumber) {
            for (const [areaName, stores] of Object.entries(tree.storesByArea || {})) {
                if (!stores.some((row) => row.storeNumber === storeNumber)) continue;
                area = areaName;
                for (const [marketName, areas] of Object.entries(tree.areasByMarket || {})) {
                    if ((areas || []).includes(areaName)) {
                        market = marketName;
                        break;
                    }
                }
                break;
            }
        }

        if (!market && tree.markets.length === 1) market = tree.markets[0];
        if (!market && tree.defaults?.market) market = tree.defaults.market;

        const areas = market ? tree.areasByMarket[market] || [] : [];
        if (area && !areas.includes(area)) area = '';
        if (!area && areas.length === 1) area = areas[0];
        if (!area && tree.defaults?.area && areas.includes(tree.defaults.area)) area = tree.defaults.area;

        const stores = area ? tree.storesByArea[area] || [] : [];
        if (storeNumber && !stores.some((row) => row.storeNumber === storeNumber)) storeNumber = '';
        if (!storeNumber && stores.length === 1) storeNumber = stores[0].storeNumber;
        if (
            !storeNumber &&
            tree.defaults?.storeNumber &&
            stores.some((row) => row.storeNumber === tree.defaults.storeNumber)
        ) {
            storeNumber = tree.defaults.storeNumber;
        }

        return { market, area, storeNumber };
    }

    function renderScopeRow(name, label, rows, selectedValue, getValue, getLabel) {
        const labelFn = getLabel || getValue;
        const isStoreRow = String(name).includes('store');
        const rowClass = isStoreRow && rows.length > 5 ? ' admin-accounts-scope-row--grid' : '';
        const items = rows
            .map((row, index) => {
                const value = getValue(row);
                const id = `${name}-${index}`;
                const checked = String(value) === String(selectedValue) ? ' checked' : '';
                return `
                    <label class="admin-accounts-scope-chip" for="${escapeAttr(id)}">
                        <input type="radio" id="${escapeAttr(id)}" name="${escapeAttr(name)}" value="${escapeAttr(value)}"${checked}>
                        <span>${escapeHtml(labelFn(row))}</span>
                    </label>
                `;
            })
            .join('');
        return `
            <div class="admin-accounts-scope-row-wrap">
                <span class="admin-accounts-scope-row-label">${escapeHtml(label)}</span>
                <div class="admin-accounts-scope-row${rowClass}" role="radiogroup" aria-label="${escapeAttr(label)}">${items}</div>
            </div>
        `;
    }

    function renderScopeSection(name, label, rows, selectedValue, getValue, getLabel) {
        return renderScopeRow(name, label, rows, selectedValue, getValue, getLabel);
    }

    function renderBrowseScopeNavigator(root, tree, preferredStore = '') {
        const host = root.querySelector('#admin-accounts-browse-scope');
        if (!host || !tree) {
            if (host) host.innerHTML = '';
            return null;
        }

        browseScope = resolveBrowseScope(tree, {
            market: selectedRadioValue(root, 'browse-market') || browseScope.market,
            area: selectedRadioValue(root, 'browse-area') || browseScope.area,
            storeNumber: selectedRadioValue(root, 'browse-store') || browseScope.storeNumber,
        }, preferredStore);

        const rows = [];
        if (tree.markets.length > 1) {
            rows.push(renderScopeRow('browse-market', 'Market', tree.markets, browseScope.market, (row) => row));
        }

        const areas = browseScope.market ? tree.areasByMarket[browseScope.market] || [] : [];
        if (areas.length > 1) {
            rows.push(renderScopeRow('browse-area', 'Area', areas, browseScope.area, (row) => row));
        }

        const stores = browseScope.area ? tree.storesByArea[browseScope.area] || [] : [];
        if (stores.length > 1) {
            rows.push(
                renderScopeRow(
                    'browse-store',
                    'Store',
                    stores,
                    browseScope.storeNumber,
                    (row) => row.storeNumber,
                    (row) => row.storeNumber
                )
            );
        }

        host.innerHTML = rows.join('');
        browseScope = resolveBrowseScope(tree, {
            market: selectedRadioValue(root, 'browse-market') || browseScope.market,
            area: selectedRadioValue(root, 'browse-area') || browseScope.area,
            storeNumber: selectedRadioValue(root, 'browse-store') || browseScope.storeNumber,
        }, preferredStore);
        return browseScope.storeNumber;
    }

    async function onBrowseScopeChange() {
        if (!backdrop || !createOptions?.scopeTree) return;
        const root = backdrop;
        const storeNumber = renderBrowseScopeNavigator(root, createOptions.scopeTree, currentStoreNumber);
        if (!storeNumber) {
            currentStoreNumber = '';
            root.querySelector('#admin-accounts-body').innerHTML = '<p>Select a store to view accounts.</p>';
            return;
        }
        if (storeNumber === currentStoreNumber) return;
        currentStoreNumber = storeNumber;
        try {
            await loadIntoModal(root, storeNumber);
        } catch (error) {
            root.querySelector('#admin-accounts-error').textContent = error.message;
        }
    }

    function renderLevelBar(container, levels, selected = '') {
        if (!container) return;
        if (!levels.length) {
            container.innerHTML = '<p class="admin-accounts-meta">No account levels available.</p>';
            return;
        }
        const pick = selected && levels.includes(selected) ? selected : levels[0];
        container.innerHTML = levels
            .map((value) => {
                const id = `accountLevel-${value}`;
                const checked = value === pick ? ' checked' : '';
                return `
                    <label class="admin-accounts-level-btn" for="${escapeAttr(id)}">
                        <input type="radio" id="${escapeAttr(id)}" name="accountLevel" value="${escapeAttr(value)}"${checked}>
                        <span>${escapeHtml(LEVEL_LABELS[value] || value)}</span>
                    </label>
                `;
            })
            .join('');
    }

    function renderScopeStack(root, level) {
        const stack = root.querySelector('#admin-create-scope-stack');
        const tree = createOptions?.scopeTree;
        if (!stack || !tree || !level) {
            if (stack) stack.innerHTML = '';
            return;
        }

        const selections = resolveScopeSelections(level, tree, {
            market: selectedRadioValue(root, 'market'),
            area: selectedRadioValue(root, 'area'),
            storeNumber: selectedRadioValue(root, 'storeNumber'),
        });

        const sections = [];

        if (levelNeedsMarket(level) && tree.markets.length > 1) {
            sections.push(renderScopeSection('market', 'Market', tree.markets, selections.market, (row) => row));
        }

        const areas = selections.market ? tree.areasByMarket[selections.market] || [] : [];
        if (levelNeedsArea(level) && areas.length > 1) {
            sections.push(renderScopeSection('area', 'Area', areas, selections.area, (row) => row));
        }

        const stores = selections.area ? tree.storesByArea[selections.area] || [] : [];
        if (levelNeedsStore(level) && stores.length > 1) {
            sections.push(
                renderScopeSection(
                    'storeNumber',
                    'Store',
                    stores,
                    selections.storeNumber,
                    (row) => row.storeNumber,
                    (row) => row.storeNumber
                )
            );
        }

        stack.innerHTML = sections.join('');
    }

    function syncCreateScopeUI() {
        if (!backdrop || !createOptions) return;
        const level = selectedRadioValue(backdrop, 'accountLevel');
        renderScopeStack(backdrop, level);
    }

    async function populateCreateForm(storeNumber) {
        const root = ensureBackdrop();
        const levelGroup = root.querySelector('#admin-create-level-group');
        const errorEl = root.querySelector('#admin-accounts-error');
        if (levelGroup) levelGroup.innerHTML = '<p class="admin-accounts-meta">Loading access levels…</p>';
        createOptions = null;
        try {
            const opts = await ensureCreateOptions();
            const levels = opts.levelChoices?.length
                ? opts.levelChoices
                : (opts.assignableLevels || []).map((row) => row.value);
            if (!levels.length) {
                if (levelGroup) {
                    levelGroup.innerHTML = '<p class="admin-accounts-meta">No account levels available for your login.</p>';
                }
                return;
            }
            const defaultLevel =
                levels.find((level) => level === 'manager') ||
                levels.find((level) => level === 'mic') ||
                levels[0] ||
                '';
            renderLevelBar(levelGroup, levels, defaultLevel);
            if (opts.scopeTree?.defaults) {
                opts.scopeTree.defaults.storeNumber =
                    String(storeNumber || opts.scopeTree.defaults.storeNumber || opts.defaultStore || '').trim() ||
                    opts.scopeTree.defaults.storeNumber;
            }
            syncCreateScopeUI();
            currentStoreNumber = String(storeNumber || opts.defaultStore || '').trim();
        } catch (error) {
            if (levelGroup) {
                levelGroup.innerHTML = `<p class="admin-accounts-meta">${escapeHtml(error.message || 'Could not load access levels.')}</p>`;
            }
            if (errorEl) errorEl.textContent = error.message || 'Could not load access levels.';
            throw error;
        }
    }

    async function submitCreateAccount() {
        const root = ensureBackdrop();
        const errorEl = root.querySelector('#admin-accounts-error');
        const submitBtn = root.querySelector('#admin-create-submit');
        const resultEl = root.querySelector('#admin-create-result');
        const username = root.querySelector('#admin-create-username')?.value.trim() || '';
        const level = selectedRadioValue(root, 'accountLevel');
        const tree = createOptions?.scopeTree;
        const resolved = tree
            ? resolveScopeSelections(level, tree, {
                  market: selectedRadioValue(root, 'market'),
                  area: selectedRadioValue(root, 'area'),
                  storeNumber: selectedRadioValue(root, 'storeNumber'),
              })
            : { market: '', area: '', storeNumber: '' };
        const listStore = currentStoreNumber;
        const storeNumber = resolved.storeNumber || listStore;

        errorEl.textContent = '';
        if (!username) {
            errorEl.textContent = 'Enter a username.';
            return;
        }
        if (!level) {
            errorEl.textContent = 'Choose an access level.';
            return;
        }
        if (levelNeedsMarket(level) && !resolved.market) {
            errorEl.textContent = 'Choose a market.';
            return;
        }
        if (levelNeedsArea(level) && !resolved.area) {
            errorEl.textContent = 'Choose an area.';
            return;
        }
        if (levelNeedsStore(level) && !storeNumber) {
            errorEl.textContent = 'Choose a store.';
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Creating…';
        try {
            const res = await fetch('/api/account/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({
                    username,
                    accountLevel: level,
                    storeNumber,
                    market: resolved.market,
                    area: resolved.area,
                    useTemporaryPassword: true,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                throw new Error(data.error || 'Could not create account.');
            }
            if (resultEl) {
                resultEl.hidden = false;
                resultEl.innerHTML = `
                    <strong>Account created for ${escapeHtml(data.username || username)}</strong>
                    <span class="admin-accounts-meta">Copy this temporary password now — it will not be shown again.</span>
                    <code>${escapeHtml(data.temporaryPassword || '')}</code>
                    <span class="admin-accounts-meta">${escapeHtml(data.message || '')}</span>
                `;
            }
            submitBtn.textContent = 'Created';
            if (storeNumber) {
                currentStoreNumber = storeNumber;
                renderBrowseScopeNavigator(root, createOptions.scopeTree, storeNumber);
                await loadIntoModal(root, storeNumber);
            }
        } catch (error) {
            errorEl.textContent = error.message;
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create account';
        }
    }

    async function fetchProfile() {
        if (profile) return profile;
        const res = await fetch('/api/me', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error('Could not load profile.');
        profile = data;
        return data;
    }

    async function fetchAccounts(storeNumber) {
        const params = new URLSearchParams({ store: storeNumber });
        const res = await fetch(`/api/account/managed-accounts?${params}`, { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not load accounts.');
        return data;
    }

    async function deleteAccount(storeNumber, username) {
        const res = await fetch('/api/account/managed-accounts', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ store: storeNumber, username }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Delete failed.');
    }

    async function patchAccount(storeNumber, username, patch) {
        const res = await fetch('/api/account/managed-accounts', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ store: storeNumber, username, ...patch }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Update failed.');
        return data;
    }

    async function fetchLoginHistory(storeNumber, username) {
        const params = new URLSearchParams({ store: storeNumber, username, limit: '20' });
        const res = await fetch(`/api/account/login-history?${params}`, { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not load login history.');
        return data.events || [];
    }

    async function ensureCreateOptions() {
        if (createOptions) return createOptions;
        const res = await fetch('/api/account/create-options', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not load account options.');
        createOptions = data;
        return data;
    }

    function renderAccounts(root, accounts, storeNumber, reload) {
        const body = root.querySelector('#admin-accounts-body');
        if (!accounts.length) {
            body.innerHTML = '<p>No crew accounts have been created for this store yet.</p>';
            return;
        }
        body.innerHTML = `<ul class="admin-accounts-list"></ul>`;
        const list = body.querySelector('.admin-accounts-list');
        accounts.forEach((row) => {
            const li = document.createElement('li');
            const storesLabel = (row.stores || []).join(', ') || storeNumber;
            li.innerHTML = `
                <div>
                    <strong>${escapeHtml(row.nickname || row.username)}</strong>
                    <span class="admin-accounts-meta">${escapeHtml(row.username)} · ${escapeHtml(row.accountLevel || 'mic')} · stores: ${escapeHtml(storesLabel)}</span>
                    <span class="admin-accounts-meta">Last login: ${escapeHtml(row.lastLoginAt || '—')}</span>
                </div>
                <div>
                    <button type="button" class="mic-settings-btn" data-action="edit">Edit</button>
                    <button type="button" class="mic-settings-btn" data-action="history">History</button>
                    <button type="button" class="mic-settings-btn mic-settings-btn--danger" data-action="delete">Delete</button>
                </div>`;
            li.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
                if (!window.confirm(`Delete account “${row.nickname || row.username}”?`)) return;
                try {
                    await deleteAccount(storeNumber, row.username);
                    await reload();
                } catch (error) {
                    root.querySelector('#admin-accounts-error').textContent = error.message;
                }
            });
            li.querySelector('[data-action="history"]')?.addEventListener('click', async () => {
                try {
                    const events = await fetchLoginHistory(storeNumber, row.username);
                    const lines = events.length
                        ? events
                              .map(
                                  (ev) =>
                                      `${ev.at || ''} · ${ev.success === false ? 'failed' : 'ok'}${ev.ip ? ` · ${ev.ip}` : ''}`
                              )
                              .join('\n')
                        : 'No login events recorded yet.';
                    window.alert(lines);
                } catch (error) {
                    root.querySelector('#admin-accounts-error').textContent = error.message;
                }
            });
            li.querySelector('[data-action="edit"]')?.addEventListener('click', async () => {
                try {
                    const opts = await ensureCreateOptions();
                    const levels = (opts.levelChoices || opts.assignableLevels || [])
                        .map((row) => (typeof row === 'string' ? row : row.value))
                        .join(', ');
                    const nextLevel = window.prompt(
                        `Account level for ${row.username}\nAllowed: ${levels}`,
                        row.accountLevel || 'mic'
                    );
                    const nextStores = window.prompt(
                        `Store access (comma-separated) for ${row.username}`,
                        (row.stores || [storeNumber]).join(', ')
                    );
                    const patch = {};
                    if (nextLevel && nextLevel.trim()) patch.accountLevel = nextLevel.trim();
                    if (nextStores != null) {
                        patch.stores = nextStores
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean);
                    }
                    await patchAccount(storeNumber, row.username, patch);
                    await reload();
                } catch (error) {
                    root.querySelector('#admin-accounts-error').textContent = error.message;
                }
            });
            list.appendChild(li);
        });
    }

    async function loadIntoModal(root, storeNumber) {
        root.querySelector('#admin-accounts-error').textContent = '';
        root.querySelector('#admin-accounts-body').innerHTML = '<p>Loading…</p>';
        const data = await fetchAccounts(storeNumber);
        renderAccounts(root, data.accounts || [], storeNumber, () => loadIntoModal(root, storeNumber));
    }

    async function open(options = {}) {
        const root = ensureBackdrop();
        root.hidden = false;
        root.querySelector('#admin-accounts-error').textContent = '';
        resetCreateForm();
        let storeNumber = String(options.storeNumber || '').trim();

        try {
            await populateCreateForm(storeNumber);
        } catch (error) {
            root.querySelector('#admin-accounts-error').textContent = error.message;
            return;
        }

        const tree = createOptions?.scopeTree;
        if (tree) {
            storeNumber =
                renderBrowseScopeNavigator(root, tree, storeNumber || currentStoreNumber) ||
                resolveBrowseScope(tree, {}, storeNumber || currentStoreNumber).storeNumber;
        }
        currentStoreNumber = storeNumber;

        if (storeNumber) {
            await loadIntoModal(root, storeNumber);
        } else {
            root.querySelector('#admin-accounts-body').innerHTML = '<p>No store selected.</p>';
        }

        if (options.focusCreate) {
            root.querySelector('#admin-create-username')?.focus();
        }
    }

    function maybeOpenFromQuery() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('accounts') !== '1') return;
        params.delete('accounts');
        const query = params.toString();
        const next = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash || ''}`;
        window.history.replaceState(null, '', next);
        void open({ focusCreate: true });
    }

    global.AdminAccounts = { open, close, maybeOpenFromQuery };
})(window);
