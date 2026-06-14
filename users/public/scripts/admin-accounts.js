(function (global) {
    let backdrop = null;
    let profile = null;
    let createOptions = null;
    let currentStoreNumber = '';

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

    function ensureBackdrop() {
        if (backdrop) return backdrop;
        backdrop = document.createElement('div');
        backdrop.className = 'admin-modal-backdrop';
        backdrop.hidden = true;
        backdrop.innerHTML = `
            <div class="admin-modal admin-modal--wide" role="dialog" aria-modal="true">
                <h2>View accounts</h2>
                <div class="admin-modal-toolbar">
                    <label>
                        Store
                        <select id="admin-accounts-store"></select>
                    </label>
                    <button type="button" class="mic-settings-btn" id="admin-accounts-create-toggle">Create account</button>
                </div>
                <section id="admin-accounts-create" class="admin-accounts-create" hidden>
                    <h3>Create account</h3>
                    <form id="admin-accounts-create-form" class="admin-accounts-form-grid">
                        <label class="admin-accounts-field">
                            Username
                            <input id="admin-create-username" type="text" autocomplete="off" required>
                        </label>
                        <div class="admin-accounts-field">
                            <span>Account level</span>
                            <div id="admin-create-level-group" class="admin-accounts-choice-group" role="radiogroup"></div>
                        </div>
                        <div class="admin-accounts-field" id="admin-create-market-field" hidden>
                            <span>Market</span>
                            <div id="admin-create-market-group" class="admin-accounts-choice-group" role="radiogroup"></div>
                        </div>
                        <div class="admin-accounts-field" id="admin-create-area-field" hidden>
                            <span>Area</span>
                            <div id="admin-create-area-group" class="admin-accounts-choice-group" role="radiogroup"></div>
                        </div>
                        <p class="admin-accounts-meta" style="margin: 0;">
                            A temporary password is generated automatically. The new user must sign in, link Macromatix if required, and set a personal password.
                        </p>
                        <div class="admin-accounts-create-actions">
                            <button type="submit" class="mic-settings-btn admin-btn-primary" id="admin-create-submit">Create account</button>
                            <button type="button" class="mic-settings-btn" id="admin-create-cancel">Cancel</button>
                        </div>
                        <div id="admin-create-result" class="admin-accounts-temp-password" hidden></div>
                    </form>
                </section>
                <div id="admin-accounts-body"></div>
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
        backdrop.querySelector('#admin-accounts-create-toggle')?.addEventListener('click', () => {
            toggleCreatePanel(true);
        });
        backdrop.querySelector('#admin-create-cancel')?.addEventListener('click', () => {
            toggleCreatePanel(false);
        });
        backdrop.querySelector('#admin-create-level-group')?.addEventListener('change', syncCreateScopeFields);
        backdrop.querySelector('#admin-accounts-create-form')?.addEventListener('submit', (event) => {
            event.preventDefault();
            void submitCreateAccount();
        });
        return backdrop;
    }

    function close() {
        if (backdrop) backdrop.hidden = true;
        toggleCreatePanel(false);
    }

    function selectedRadioValue(root, name) {
        return root.querySelector(`input[type="radio"][name="${name}"]:checked`)?.value || '';
    }

    function selectedCreateLevelMeta(root) {
        const value = selectedRadioValue(root, 'accountLevel');
        return (createOptions?.assignableLevels || []).find((row) => row.value === value) || null;
    }

    function fillChoiceGroup(container, rows, name, getValue, getLabel, selectedValue = '') {
        if (!container) return;
        if (!rows.length) {
            container.innerHTML = '<p class="admin-accounts-meta">No options available.</p>';
            return;
        }
        container.innerHTML = rows
            .map((row, index) => {
                const value = getValue(row);
                const label = getLabel(row);
                const id = `${name}-${index}`;
                const checked =
                    String(value) === String(selectedValue) || (!selectedValue && index === 0)
                        ? ' checked'
                        : '';
                return `
                    <label class="admin-accounts-choice" for="${escapeAttr(id)}">
                        <input type="radio" id="${escapeAttr(id)}" name="${escapeAttr(name)}" value="${escapeAttr(value)}"${checked}>
                        <span>${escapeHtml(label)}</span>
                    </label>
                `;
            })
            .join('');
    }

    function syncCreateScopeFields() {
        if (!backdrop) return;
        const meta = selectedCreateLevelMeta(backdrop);
        const requiresMarket = Boolean(meta?.requiresMarket);
        const requiresArea = Boolean(meta?.requiresArea);
        backdrop.querySelector('#admin-create-market-field').hidden = !requiresMarket;
        backdrop.querySelector('#admin-create-area-field').hidden = !requiresArea;
    }

    async function populateCreateForm(storeNumber) {
        const root = ensureBackdrop();
        const opts = await ensureCreateOptions();
        fillChoiceGroup(
            root.querySelector('#admin-create-level-group'),
            opts.assignableLevels || [],
            'accountLevel',
            (row) => row.value,
            (row) => row.label
        );
        fillChoiceGroup(
            root.querySelector('#admin-create-market-group'),
            (opts.markets || []).map((market) => ({ market })),
            'market',
            (row) => row.market,
            (row) => row.market
        );
        fillChoiceGroup(
            root.querySelector('#admin-create-area-group'),
            (opts.areas || []).map((area) => ({ area })),
            'area',
            (row) => row.area,
            (row) => row.area
        );
        syncCreateScopeFields();
        currentStoreNumber = String(storeNumber || opts.defaultStore || '').trim();
    }

    function toggleCreatePanel(open) {
        if (!backdrop) return;
        const panel = backdrop.querySelector('#admin-accounts-create');
        const resultEl = backdrop.querySelector('#admin-create-result');
        const form = backdrop.querySelector('#admin-accounts-create-form');
        const submitBtn = backdrop.querySelector('#admin-create-submit');
        if (!panel) return;
        if (!open) {
            panel.hidden = true;
            if (resultEl) {
                resultEl.hidden = true;
                resultEl.innerHTML = '';
            }
            if (form) form.reset();
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Create account';
            }
            return;
        }
        panel.hidden = false;
        if (resultEl) {
            resultEl.hidden = true;
            resultEl.innerHTML = '';
        }
        populateCreateForm(backdrop.querySelector('#admin-accounts-store')?.value || currentStoreNumber).catch((error) => {
            backdrop.querySelector('#admin-accounts-error').textContent = error.message;
        });
        backdrop.querySelector('#admin-create-username')?.focus();
    }

    async function submitCreateAccount() {
        const root = ensureBackdrop();
        const errorEl = root.querySelector('#admin-accounts-error');
        const submitBtn = root.querySelector('#admin-create-submit');
        const resultEl = root.querySelector('#admin-create-result');
        const username = root.querySelector('#admin-create-username')?.value.trim() || '';
        const meta = selectedCreateLevelMeta(root);
        const storeNumber = String(root.querySelector('#admin-accounts-store')?.value || currentStoreNumber).trim();

        errorEl.textContent = '';
        if (!username) {
            errorEl.textContent = 'Enter a username.';
            return;
        }
        if (!meta) {
            errorEl.textContent = 'Choose an account level.';
            return;
        }
        if (meta.requiresStore && !storeNumber) {
            errorEl.textContent = 'Choose a store.';
            return;
        }
        if (meta.requiresMarket && !selectedRadioValue(root, 'market')) {
            errorEl.textContent = 'Choose a market.';
            return;
        }
        if (meta.requiresArea && !selectedRadioValue(root, 'area')) {
            errorEl.textContent = 'Choose an area.';
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
                    accountLevel: meta.value,
                    storeNumber,
                    market: selectedRadioValue(root, 'market'),
                    area: selectedRadioValue(root, 'area'),
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
            await loadIntoModal(root, storeNumber);
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

    async function loadStores(isAdmin) {
        if (isAdmin) {
            const res = await fetch('/api/stores', { credentials: 'same-origin' });
            const data = await res.json().catch(() => ({}));
            return (data.stores || []).filter((s) => !s.testStore);
        }
        const me = await fetchProfile();
        const nums = me.stores === '*' ? [] : (me.effectiveStores || me.stores || []).map(String);
        return nums.map((storeNumber) => ({ storeNumber, storeName: storeNumber }));
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
                    const levels = (opts.assignableLevels || []).map((l) => l.value).join(', ');
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
        toggleCreatePanel(false);
        const me = await fetchProfile();
        const isAdmin = Boolean(
            options.isAdmin || me.canViewCrossStoreAccounts || me.role === 'admin' || me.stores === '*'
        );
        const stores = await loadStores(isAdmin);
        const select = root.querySelector('#admin-accounts-store');
        select.innerHTML = stores
            .map(
                (s) =>
                    `<option value="${escapeHtml(s.storeNumber)}">${escapeHtml(s.storeNumber)} — ${escapeHtml(s.storeName || s.storeNumber)}</option>`
            )
            .join('');
        let storeNumber = String(options.storeNumber || select.value || '').trim();
        if (storeNumber) select.value = storeNumber;
        else if (stores.length) storeNumber = String(stores[0].storeNumber);

        select.onchange = () => {
            currentStoreNumber = select.value;
            loadIntoModal(root, select.value).catch((error) => {
                root.querySelector('#admin-accounts-error').textContent = error.message;
            });
        };

        if (!storeNumber) {
            root.querySelector('#admin-accounts-body').innerHTML = '<p>No store selected.</p>';
            return;
        }
        currentStoreNumber = storeNumber;
        await loadIntoModal(root, storeNumber);
    }

    global.AdminAccounts = { open, close };
})(window);
