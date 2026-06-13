(function (global) {
    let backdrop = null;
    let profile = null;
    let activeTab = 'store';
    let catalogCache = null;

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
                <h2>Build to adjustments</h2>
                <div class="admin-tabs" id="admin-buildto-tabs">
                    <button type="button" class="admin-tab is-active" data-tab="store">By store</button>
                    <button type="button" class="admin-tab" data-tab="global" id="admin-buildto-global-tab" hidden>Global</button>
                </div>
                <div class="admin-modal-toolbar">
                    <label id="admin-buildto-store-wrap">
                        Store
                        <select id="admin-buildto-store"></select>
                    </label>
                    <input type="search" id="admin-buildto-search" placeholder="Search items…" />
                    <button type="button" class="mic-settings-btn" id="admin-buildto-save">Save changes</button>
                </div>
                <div id="admin-buildto-body"></div>
                <p id="admin-buildto-error" class="admin-modal-error" role="alert"></p>
                <div class="admin-modal-actions">
                    <button type="button" id="admin-buildto-close">Close</button>
                </div>
            </div>`;
        document.body.appendChild(backdrop);
        backdrop.addEventListener('click', (event) => {
            if (event.target === backdrop) close();
        });
        backdrop.querySelector('#admin-buildto-close')?.addEventListener('click', close);
        backdrop.querySelector('#admin-buildto-save')?.addEventListener('click', () => {
            void saveChanges();
        });
        backdrop.querySelector('#admin-buildto-search')?.addEventListener('input', () => renderRows());
        backdrop.querySelectorAll('[data-tab]').forEach((btn) => {
            btn.addEventListener('click', () => {
                activeTab = btn.dataset.tab;
                backdrop.querySelectorAll('.admin-tab').forEach((tab) => {
                    tab.classList.toggle('is-active', tab.dataset.tab === activeTab);
                });
                backdrop.querySelector('#admin-buildto-store-wrap').hidden = activeTab === 'global';
                renderRows();
            });
        });
        backdrop.querySelector('#admin-buildto-store')?.addEventListener('change', () => {
            void loadCatalog();
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

    async function loadStores() {
        const me = await fetchProfile();
        if (me.canViewCrossStoreAccounts) {
            const res = await fetch('/api/stores', { credentials: 'same-origin' });
            const data = await res.json().catch(() => ({}));
            return (data.stores || []).filter((s) => !s.testStore);
        }
        const nums = me.stores === '*' ? [] : (me.effectiveStores || me.stores || []).map(String);
        return nums.map((storeNumber) => ({ storeNumber, storeName: storeNumber }));
    }

    async function loadCatalog() {
        const root = ensureBackdrop();
        const store = root.querySelector('#admin-buildto-store')?.value || '';
        const params = new URLSearchParams({ store });
        const res = await fetch(`/api/admin/build-to/catalog?${params}`, { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not load build-to catalog.');
        catalogCache = data;
        renderRows();
    }

    function allItems() {
        const items = [];
        for (const vendor of catalogCache?.vendors || []) {
            for (const item of vendor.items || []) items.push({ ...item, vendorSlug: vendor.slug, vendorLabel: vendor.label });
        }
        return items;
    }

    function renderRows() {
        const root = ensureBackdrop();
        const body = root.querySelector('#admin-buildto-body');
        const q = String(root.querySelector('#admin-buildto-search')?.value || '')
            .trim()
            .toLowerCase();
        const items = allItems().filter((item) => {
            if (!q) return true;
            return (
                String(item.itemCode || '').toLowerCase().includes(q) ||
                String(item.name || '').toLowerCase().includes(q)
            );
        });
        if (!items.length) {
            body.innerHTML = '<p>No items match.</p>';
            return;
        }
        body.innerHTML = `
            <table class="admin-table">
                <thead>
                    <tr>
                        <th>Item</th>
                        <th>Vendor</th>
                        <th>Type</th>
                        <th>Days</th>
                        <th>+Buffer</th>
                        <th>Fixed</th>
                    </tr>
                </thead>
                <tbody>
                    ${items
                        .map(
                            (item) => `
                        <tr data-item-code="${escapeHtml(item.itemCode)}">
                            <td>${escapeHtml(item.name)}<span class="admin-accounts-meta">${escapeHtml(item.itemCode)}</span></td>
                            <td>${escapeHtml(item.vendorLabel || item.vendorSlug)}</td>
                            <td>${escapeHtml(item.ruleType)}</td>
                            <td><input type="number" min="0" max="31" data-field="buildToDays" value="${item.buildToDays != null ? escapeHtml(item.buildToDays) : ''}" /></td>
                            <td><input type="number" min="0" max="99" data-field="buildToAdd" value="${escapeHtml(item.buildToAdd || 0)}" /></td>
                            <td><input type="number" min="0" max="999" data-field="buildToFixed" value="${item.buildToFixed != null ? escapeHtml(item.buildToFixed) : ''}" /></td>
                        </tr>`
                        )
                        .join('')}
                </tbody>
            </table>`;
    }

    function collectPatch() {
        const root = ensureBackdrop();
        const patch = {};
        root.querySelectorAll('tbody tr[data-item-code]').forEach((row) => {
            const code = row.getAttribute('data-item-code');
            const rule = {};
            const days = row.querySelector('[data-field="buildToDays"]')?.value;
            const add = row.querySelector('[data-field="buildToAdd"]')?.value;
            const fixed = row.querySelector('[data-field="buildToFixed"]')?.value;
            if (days !== '') rule.buildToDays = Number(days);
            if (add !== '') rule.buildToAdd = Number(add);
            if (fixed !== '') rule.buildToFixed = Number(fixed);
            if (Object.keys(rule).length) patch[code] = rule;
        });
        return patch;
    }

    async function saveChanges() {
        const root = ensureBackdrop();
        root.querySelector('#admin-buildto-error').textContent = '';
        const patch = collectPatch();
        const body =
            activeTab === 'global'
                ? { global: patch }
                : { stores: { [root.querySelector('#admin-buildto-store').value]: patch } };
        const res = await fetch('/api/admin/build-to/overrides', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Save failed.');
        await loadCatalog();
    }

    async function open() {
        const root = ensureBackdrop();
        root.hidden = false;
        root.querySelector('#admin-buildto-error').textContent = '';
        const me = await fetchProfile();
        if (me.canEditGlobalBuildTo) {
            root.querySelector('#admin-buildto-global-tab').hidden = false;
        }
        const stores = await loadStores();
        const select = root.querySelector('#admin-buildto-store');
        select.innerHTML = stores
            .map(
                (s) =>
                    `<option value="${escapeHtml(s.storeNumber)}">${escapeHtml(s.storeNumber)} — ${escapeHtml(s.storeName || s.storeNumber)}</option>`
            )
            .join('');
        root.querySelector('#admin-buildto-body').innerHTML = '<p>Loading…</p>';
        try {
            await loadCatalog();
        } catch (error) {
            root.querySelector('#admin-buildto-error').textContent = error.message;
        }
    }

    global.AdminBuildTo = { open, close };
})(window);
