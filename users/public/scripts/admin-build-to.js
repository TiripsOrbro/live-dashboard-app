(function (global) {
    let backdrop = null;
    let profile = null;
    let activeTab = 'global';
    let catalogCache = null;

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function dropdownRuleType(item) {
        const type = String(item.ruleType || '').toLowerCase();
        if (type === 'on-hand') return 'on-hand';
        if (type === 'manual' || type === 'order-manual') return 'manual';
        return 'days';
    }

    function fixedDisplayValue(item) {
        if (item.buildToFixed != null) return item.buildToFixed;
        if (dropdownRuleType(item) === 'on-hand' && item.buildToDays != null) return item.buildToDays;
        return '';
    }

    function applyRuleTypeRow(row) {
        const type = row.querySelector('[data-field="ruleType"]')?.value || 'days';
        const showDays = type === 'days';
        row.querySelectorAll('[data-buildto-group="days"]').forEach((cell) => {
            cell.hidden = !showDays;
        });
        row.querySelectorAll('[data-buildto-group="fixed"]').forEach((cell) => {
            cell.hidden = showDays;
        });
    }

    function bindRowControls() {
        const root = ensureBackdrop();
        root.querySelectorAll('tbody tr[data-item-code]').forEach((row) => {
            applyRuleTypeRow(row);
            const select = row.querySelector('[data-field="ruleType"]');
            if (select && !select.dataset.bound) {
                select.dataset.bound = '1';
                select.addEventListener('change', () => applyRuleTypeRow(row));
            }
        });
    }

    function ensureBackdrop() {
        if (backdrop) return backdrop;
        backdrop = document.createElement('div');
        backdrop.className = 'admin-modal-backdrop';
        backdrop.hidden = true;
        backdrop.innerHTML = `
            <div class="admin-modal admin-modal--wide admin-modal--build-to" role="dialog" aria-modal="true">
                <h2>Build to adjustments</h2>
                <div class="admin-tabs admin-tabs--full" id="admin-buildto-tabs">
                    <button type="button" class="admin-tab is-active" data-tab="global" id="admin-buildto-global-tab" hidden>Global</button>
                    <button type="button" class="admin-tab" data-tab="store">Stores</button>
                </div>
                <div class="admin-modal-toolbar">
                    <label id="admin-buildto-store-wrap" hidden>
                        Store
                        <select id="admin-buildto-store"></select>
                    </label>
                    <label id="admin-buildto-global-warn-wrap" hidden>
                        Default warn days
                        <input type="number" min="1" max="31" id="admin-buildto-global-warn" />
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
                applyTabUi();
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

    function applyTabUi() {
        const root = ensureBackdrop();
        root.querySelectorAll('.admin-tab').forEach((tab) => {
            if (tab.hidden) return;
            tab.classList.toggle('is-active', tab.dataset.tab === activeTab);
        });
        root.querySelector('#admin-buildto-store-wrap').hidden = activeTab === 'global';
        root.querySelector('#admin-buildto-global-warn-wrap').hidden = activeTab !== 'global';
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
        const warnInput = root.querySelector('#admin-buildto-global-warn');
        if (warnInput) {
            warnInput.value =
                data.settings?.stockWarningDays != null ? String(data.settings.stockWarningDays) : '5';
        }
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
                        <th>Count</th>
                        <th>Daily</th>
                        <th>Days</th>
                        <th>+Buffer</th>
                        <th>Fixed</th>
                        <th>Warn</th>
                    </tr>
                </thead>
                <tbody>
                    ${items
                        .map((item) => {
                            const ruleType = dropdownRuleType(item);
                            const fixedValue = fixedDisplayValue(item);
                            return `
                        <tr data-item-code="${escapeHtml(item.itemCode)}"
                            data-catalog-needs-count="${item.catalogNeedsCount ? '1' : '0'}"
                            data-catalog-include-daily="${item.catalogIncludeDaily ? '1' : '0'}"
                            data-store-skip-override="${item.storeSkipStockCountOverride != null ? '1' : '0'}"
                            data-global-skip-override="${item.globalSkipStockCountOverride != null ? '1' : '0'}"
                            data-store-skip-key-override="${item.storeSkipKeyItemCountOverride != null ? '1' : '0'}"
                            data-global-skip-key-override="${item.globalSkipKeyItemCountOverride != null ? '1' : '0'}"
                            data-store-include-daily-override="${item.storeIncludeDailyOverride != null ? '1' : '0'}"
                            data-global-include-daily-override="${item.globalIncludeDailyOverride != null ? '1' : '0'}"
                            data-initial-stock-warning="${item.stockWarningDays != null ? escapeHtml(item.stockWarningDays) : ''}"
                            data-initial-rule-type="${escapeHtml(ruleType)}">
                            <td>${escapeHtml(item.name)}<span class="admin-accounts-meta">${escapeHtml(item.itemCode)}</span></td>
                            <td>${escapeHtml(item.vendorLabel || item.vendorSlug)}</td>
                            <td>
                                <select data-field="ruleType" class="admin-buildto-type-select">
                                    <option value="days" ${ruleType === 'days' ? 'selected' : ''}>Days</option>
                                    <option value="on-hand" ${ruleType === 'on-hand' ? 'selected' : ''}>On hand</option>
                                    <option value="manual" ${ruleType === 'manual' ? 'selected' : ''}>Manual</option>
                                </select>
                            </td>
                            <td class="admin-table-check"><input type="checkbox" data-field="needsCount" ${item.needsCount ? 'checked' : ''} title="Include in weekly stock count" /></td>
                            <td class="admin-table-check"><input type="checkbox" data-field="includeDaily" ${item.includeDaily ? 'checked' : ''} title="Include in daily count" /></td>
                            <td data-buildto-group="days"><input type="number" min="0" max="31" data-field="buildToDays" value="${item.buildToDays != null ? escapeHtml(item.buildToDays) : ''}" /></td>
                            <td data-buildto-group="days"><input type="number" min="0" max="99" data-field="buildToAdd" value="${escapeHtml(item.buildToAdd || 0)}" /></td>
                            <td data-buildto-group="fixed"><input type="number" min="0" max="999" data-field="buildToFixed" value="${fixedValue !== '' ? escapeHtml(fixedValue) : ''}" /></td>
                            <td><input type="number" min="1" max="31" data-field="stockWarningDays" placeholder="${escapeHtml(item.defaultStockWarningDays ?? 5)}" value="${item.stockWarningDays != null ? escapeHtml(item.stockWarningDays) : ''}" title="Low stock warning threshold (days)" /></td>
                        </tr>`;
                        })
                        .join('')}
                </tbody>
            </table>`;
        bindRowControls();
    }

    function collectPatch() {
        const root = ensureBackdrop();
        const patch = {};
        root.querySelectorAll('tbody tr[data-item-code]').forEach((row) => {
            const code = row.getAttribute('data-item-code');
            const rule = {};
            const ruleType = row.querySelector('[data-field="ruleType"]')?.value || 'days';
            const days = row.querySelector('[data-field="buildToDays"]')?.value;
            const add = row.querySelector('[data-field="buildToAdd"]')?.value;
            const fixed = row.querySelector('[data-field="buildToFixed"]')?.value;
            const needsCount = Boolean(row.querySelector('[data-field="needsCount"]')?.checked);
            const includeDaily = Boolean(row.querySelector('[data-field="includeDaily"]')?.checked);
            const warnDays = row.querySelector('[data-field="stockWarningDays"]')?.value;
            const initialWarn = row.dataset.initialStockWarning || '';
            const catalogNeedsCount = row.dataset.catalogNeedsCount === '1';
            const catalogIncludeDaily = row.dataset.catalogIncludeDaily === '1';
            const hadSkipOverride =
                activeTab === 'global'
                    ? row.dataset.globalSkipOverride === '1'
                    : row.dataset.storeSkipOverride === '1';
            const hadSkipKeyOverride =
                activeTab === 'global'
                    ? row.dataset.globalSkipKeyOverride === '1'
                    : row.dataset.storeSkipKeyOverride === '1';
            const hadIncludeDailyOverride =
                activeTab === 'global'
                    ? row.dataset.globalIncludeDailyOverride === '1'
                    : row.dataset.storeIncludeDailyOverride === '1';
            const initialRuleType = row.dataset.initialRuleType || 'days';

            if (ruleType === 'days') {
                if (days !== '') rule.buildToDays = Number(days);
                if (add !== '') rule.buildToAdd = Number(add);
                if (initialRuleType !== 'days') {
                    rule.buildToFixed = null;
                    rule.buildToManual = null;
                    if (initialRuleType === 'on-hand' || hadSkipKeyOverride) {
                        rule.skipKeyItemCount = null;
                    }
                }
            } else if (ruleType === 'on-hand') {
                if (fixed !== '') rule.buildToFixed = Number(fixed);
                if (initialRuleType !== 'on-hand') {
                    rule.buildToDays = null;
                    rule.buildToAdd = null;
                    rule.buildToManual = null;
                    rule.skipKeyItemCount = true;
                }
            } else if (ruleType === 'manual') {
                if (fixed !== '') rule.buildToFixed = Number(fixed);
                else if (initialRuleType === 'manual') rule.buildToFixed = null;
                if (initialRuleType !== 'manual') {
                    rule.buildToDays = null;
                    rule.buildToAdd = null;
                    rule.buildToManual = true;
                    if (initialRuleType === 'on-hand' || hadSkipKeyOverride) {
                        rule.skipKeyItemCount = null;
                    }
                }
            }

            if (needsCount !== catalogNeedsCount) {
                rule.skipStockCount = !needsCount;
            } else if (hadSkipOverride) {
                rule.skipStockCount = null;
            }

            if (includeDaily !== catalogIncludeDaily) {
                rule.includeDaily = includeDaily;
            } else if (hadIncludeDailyOverride) {
                rule.includeDaily = null;
            }

            if (warnDays !== '') {
                if (String(warnDays) !== initialWarn) rule.stockWarningDays = Number(warnDays);
            } else if (initialWarn !== '') {
                rule.stockWarningDays = null;
            }

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
                ? {
                      global: patch,
                      settings: {
                          stockWarningDays: Number(root.querySelector('#admin-buildto-global-warn')?.value || 5),
                      },
                  }
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
        const globalTab = root.querySelector('#admin-buildto-global-tab');
        if (me.canEditGlobalBuildTo) {
            globalTab.hidden = false;
            activeTab = 'global';
        } else {
            globalTab.hidden = true;
            activeTab = 'store';
        }
        applyTabUi();
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
