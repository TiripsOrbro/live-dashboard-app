(function (global) {
    let backdrop = null;
    let profile = null;
    let createOptions = null;

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
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
                    <button type="button" class="mic-settings-btn" id="admin-accounts-create">Create account</button>
                </div>
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
        backdrop.querySelector('#admin-accounts-create')?.addEventListener('click', () => {
            global.location.href = '/Create-Account';
        });
        return backdrop;
    }

    function close() {
        if (backdrop) backdrop.hidden = true;
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
            body.innerHTML = '<p>No MIC accounts have been created for this store yet.</p>';
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
            loadIntoModal(root, select.value).catch((error) => {
                root.querySelector('#admin-accounts-error').textContent = error.message;
            });
        };

        if (!storeNumber) {
            root.querySelector('#admin-accounts-body').innerHTML = '<p>No store selected.</p>';
            return;
        }
        await loadIntoModal(root, storeNumber);
    }

    global.AdminAccounts = { open, close };
})(window);
