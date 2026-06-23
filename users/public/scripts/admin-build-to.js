(function (global) {
    let backdrop = null;
    let pageHost = null;
    let profile = null;
    let activeTab = 'global';
    let catalogCache = null;
    let storeList = [];
    let scopeTree = null;
    let scopeNavigator = null;
    let browseScope = { market: '', area: '', storeNumber: '' };

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

    function warnDisplayValue(item) {
        if (item.stockWarningDays != null) return item.stockWarningDays;
        return item.defaultStockWarningDays ?? 5;
    }

    function applyRuleTypeRow(row) {
        const type = row.querySelector('[data-field="ruleType"]')?.value || 'days';
        const showDaysBuffer = type === 'days' || type === 'on-hand';
        const showFixed = type === 'manual';
        row.querySelectorAll('[data-buildto-group="days"]').forEach((cell) => {
            cell.classList.toggle('admin-buildto-group--off', !showDaysBuffer);
        });
        row.querySelectorAll('[data-buildto-group="fixed"]').forEach((cell) => {
            cell.classList.toggle('admin-buildto-group--off', !showFixed);
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

    function getRoot() {
        return pageHost || backdrop;
    }

    function isInline() {
        return Boolean(pageHost);
    }

    const BUILD_TO_MODAL_HTML = `
            <div class="admin-modal admin-modal--wide admin-modal--build-to" role="dialog" aria-modal="true">
                <div class="admin-buildto-header">
                    <h2>Build to adjustments</h2>
                    <p class="admin-buildto-subtitle">Set build-to rules, item codes (MMX / vendor / fallbacks), and low-stock thresholds. Global, area, or per-store.</p>
                </div>
                <div class="admin-tabs admin-tabs--full" id="admin-buildto-tabs">
                    <button type="button" class="admin-tab is-active" data-tab="global" id="admin-buildto-global-tab" hidden>Global</button>
                    <button type="button" class="admin-tab" data-tab="store">Stores</button>
                </div>
                <div id="admin-buildto-scope-wrap" class="admin-buildto-scope-wrap" hidden>
                    <div id="admin-buildto-scope-nav" class="admin-buildto-scope-nav"></div>
                </div>
                <div class="admin-modal-toolbar admin-buildto-toolbar">
                    <div class="admin-buildto-search-wrap">
                        <input type="search" id="admin-buildto-search" placeholder="Search items…" aria-label="Search items" />
                    </div>
                    <button type="button" class="mic-settings-btn admin-btn-primary admin-buildto-save" id="admin-buildto-save">Save changes</button>
                </div>
                <div class="admin-buildto-table-wrap" id="admin-buildto-body"></div>
                <p id="admin-buildto-error" class="admin-modal-error" role="alert"></p>
                <div class="admin-modal-actions admin-buildto-actions">
                    <button type="button" class="admin-buildto-close-btn" id="admin-buildto-close">Close</button>
                </div>
            </div>`;

    function bindPanel(root) {
        if (root.dataset.adminBuildToBound) return;
        root.dataset.adminBuildToBound = '1';
        root.querySelector('#admin-buildto-close')?.addEventListener('click', close);
        root.querySelector('#admin-buildto-save')?.addEventListener('click', () => {
            void saveChanges();
        });
        root.querySelector('#admin-buildto-search')?.addEventListener('input', () => renderRows());
        root.querySelectorAll('[data-tab]').forEach((btn) => {
            btn.addEventListener('click', () => {
                activeTab = btn.dataset.tab;
                applyTabUi();
                if (activeTab === 'store') renderScopeNavigator();
                void loadCatalog();
            });
        });
    }

    function ensureBackdrop() {
        if (pageHost) {
            if (!pageHost.querySelector('.admin-modal')) {
                pageHost.innerHTML = BUILD_TO_MODAL_HTML;
                bindPanel(pageHost);
            }
            return pageHost;
        }
        if (backdrop) return backdrop;
        backdrop = document.createElement('div');
        backdrop.className = 'admin-modal-backdrop';
        backdrop.hidden = true;
        backdrop.innerHTML = BUILD_TO_MODAL_HTML;
        document.body.appendChild(backdrop);
        backdrop.addEventListener('click', (event) => {
            if (event.target === backdrop) close();
        });
        bindPanel(backdrop);
        return backdrop;
    }

    function close() {
        if (isInline()) return;
        if (backdrop) backdrop.hidden = true;
    }

    function applyTabUi() {
        const root = ensureBackdrop();
        root.querySelectorAll('.admin-tab').forEach((tab) => {
            if (tab.hidden) return;
            tab.classList.toggle('is-active', tab.dataset.tab === activeTab);
        });
        root.querySelector('#admin-buildto-scope-wrap').hidden = activeTab === 'global';
    }

    function formatFallbackCodes(codes) {
        return (codes || []).filter(Boolean).join(', ');
    }

    function getOverrideScope() {
        if (activeTab === 'global') return { level: 'global' };
        const area = String(browseScope.area || '').trim();
        const store = String(browseScope.storeNumber || '').trim();
        if (store) return { level: 'store', store, area };
        if (area) return { level: 'area', area };
        return { level: 'none' };
    }

    function scopeCatalogParams() {
        const scope = getOverrideScope();
        const params = new URLSearchParams();
        if (scope.level === 'store' && scope.store) params.set('store', scope.store);
        else if (scope.level === 'area' && scope.area) params.set('area', scope.area);
        return { scope, params };
    }

    async function loadScopeTree() {
        if (!global.AdminScopePicker) throw new Error('Store picker not available.');
        const raw = await global.AdminScopePicker.loadScopeTree();
        scopeTree = global.AdminScopePicker.filterScopeTreeForStores(raw, storeList);
        return scopeTree;
    }

    function renderScopeNavigator() {
        const root = ensureBackdrop();
        const host = root.querySelector('#admin-buildto-scope-nav');
        if (!host) return;
        if (!scopeTree || !global.AdminScopePicker) {
            host.innerHTML = '<p class="admin-accounts-meta">No stores available.</p>';
            return;
        }

        const onScopeChange = (scope) => {
            browseScope = { ...scope };
            void loadCatalog();
        };

        if (!scopeNavigator) {
            scopeNavigator = global.AdminScopePicker.mountInline(host, {
                tree: scopeTree,
                initialScope: browseScope,
                preferredStore: browseScope.storeNumber,
                scopePrefix: 'buildto',
                onChange: onScopeChange,
            });
        } else {
            scopeNavigator.setTree(scopeTree);
            scopeNavigator.setScope(browseScope);
        }
        browseScope = scopeNavigator.getScope();
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
        const body = root.querySelector('#admin-buildto-body');
        const { scope, params } = scopeCatalogParams();
        if (activeTab === 'store' && scope.level === 'none') {
            catalogCache = null;
            body.innerHTML = '<p>Select an area or store to view build-to adjustments.</p>';
            return;
        }
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
            <table class="admin-table admin-buildto-table">
                <thead>
                    <tr>
                        <th>Item</th>
                        <th>Vendor</th>
                        <th>MMX code</th>
                        <th>Vendor code</th>
                        <th>Fallback codes</th>
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
                            const defaultWarn = item.defaultStockWarningDays ?? 5;
                            const warnValue = warnDisplayValue(item);
                            const fallbacks = formatFallbackCodes(item.fallbackCodes);
                            const scopeFallbacks = formatFallbackCodes(item.scopeFallbackCodes);
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
                            data-default-stock-warning="${escapeHtml(defaultWarn)}"
                            data-initial-stock-warning="${item.stockWarningDays != null ? escapeHtml(item.stockWarningDays) : ''}"
                            data-initial-rule-type="${escapeHtml(ruleType)}"
                            data-catalog-mmx="${escapeHtml(item.catalogMmxCode || item.itemCode)}"
                            data-loaded-mmx="${escapeHtml(item.mmxCode || item.itemCode)}"
                            data-initial-mmx="${item.scopeMmxCode != null ? escapeHtml(item.scopeMmxCode) : ''}"
                            data-catalog-vendor="${escapeHtml(item.catalogMmxCode || item.itemCode)}"
                            data-loaded-vendor="${escapeHtml(item.vendorCode || item.itemCode)}"
                            data-initial-vendor="${item.scopeVendorCode != null ? escapeHtml(item.scopeVendorCode) : ''}"
                            data-loaded-fallbacks="${escapeHtml(fallbacks)}"
                            data-initial-fallbacks="${escapeHtml(scopeFallbacks)}"
                            data-file-fallbacks="${escapeHtml(formatFallbackCodes(item.fileFallbackCodes))}">
                            <td class="admin-buildto-item-cell">${escapeHtml(item.name)}<span class="admin-accounts-meta">${escapeHtml(item.itemCode)}</span></td>
                            <td class="admin-buildto-vendor-cell">${escapeHtml(item.vendorLabel || item.vendorSlug)}</td>
                            <td><input type="text" data-field="mmxCode" class="admin-buildto-code-input" value="${escapeHtml(item.mmxCode || item.itemCode)}" title="MMX / Key Item Count code" /></td>
                            <td><input type="text" data-field="vendorCode" class="admin-buildto-code-input" value="${escapeHtml(item.vendorCode || item.itemCode)}" title="Vendor order code" /></td>
                            <td><input type="text" data-field="fallbackCodes" class="admin-buildto-fallback-input" value="${escapeHtml(fallbacks)}" placeholder="${escapeHtml(formatFallbackCodes(item.fileFallbackCodes) || 'code1, code2')}" title="Extra ISE/SOH codes, tried in order (comma-separated)" /></td>
                            <td>
                                <select data-field="ruleType" class="admin-buildto-type-select">
                                    <option value="days" ${ruleType === 'days' ? 'selected' : ''}>Days</option>
                                    <option value="on-hand" ${ruleType === 'on-hand' ? 'selected' : ''}>On hand</option>
                                    <option value="manual" ${ruleType === 'manual' ? 'selected' : ''}>Manual</option>
                                </select>
                            </td>
                            <td class="admin-table-check"><input type="checkbox" data-field="needsCount" ${item.needsCount ? 'checked' : ''} title="Include in weekly stock count" /></td>
                            <td class="admin-table-check"><input type="checkbox" data-field="includeDaily" ${item.includeDaily ? 'checked' : ''} title="Include in daily count" /></td>
                            <td data-buildto-group="days"><input type="number" min="0" max="31" data-field="buildToDays" class="admin-buildto-num-input" value="${item.buildToDays != null ? escapeHtml(item.buildToDays) : ''}" /></td>
                            <td data-buildto-group="days"><input type="number" min="0" max="99" data-field="buildToAdd" class="admin-buildto-num-input" value="${escapeHtml(item.buildToAdd || 0)}" /></td>
                            <td data-buildto-group="fixed"><input type="number" min="0" max="999" data-field="buildToFixed" class="admin-buildto-num-input" value="${fixedValue !== '' ? escapeHtml(fixedValue) : ''}" /></td>
                            <td class="admin-buildto-warn-cell"><input type="number" min="1" max="31" data-field="stockWarningDays" class="admin-buildto-num-input admin-buildto-warn-input" value="${escapeHtml(warnValue)}" title="Low stock warning threshold (days)" /></td>
                        </tr>`;
                        })
                        .join('')}
                </tbody>
            </table>`;
        bindRowControls();
    }

    function parseFallbackInput(value) {
        return String(value || '')
            .split(/[,;\s]+/)
            .map((part) => part.trim())
            .filter(Boolean);
    }

    function sameCodeList(a, b) {
        const left = parseFallbackInput(a).map((c) => c.toUpperCase());
        const right = parseFallbackInput(b).map((c) => c.toUpperCase());
        if (left.length !== right.length) return false;
        return left.every((code, i) => code === right[i]);
    }

    function collectCodePatch(row, rule) {
        const mmx = String(row.querySelector('[data-field="mmxCode"]')?.value || '').trim();
        const vendor = String(row.querySelector('[data-field="vendorCode"]')?.value || '').trim();
        const fallbacks = String(row.querySelector('[data-field="fallbackCodes"]')?.value || '').trim();
        const catalogMmx = row.dataset.catalogMmx || '';
        const loadedMmx = row.dataset.loadedMmx || '';
        const initialMmx = row.dataset.initialMmx || '';
        const loadedVendor = row.dataset.loadedVendor || '';
        const initialVendor = row.dataset.initialVendor || '';
        const loadedFallbacks = row.dataset.loadedFallbacks || '';
        const initialFallbacks = row.dataset.initialFallbacks || '';

        if (mmx !== loadedMmx) {
            rule.mmxCode = mmx && mmx !== catalogMmx ? mmx : null;
        } else if (initialMmx && mmx === catalogMmx) {
            rule.mmxCode = null;
        }

        if (vendor !== loadedVendor) {
            rule.vendorCode = vendor && vendor !== catalogMmx ? vendor : null;
        } else if (initialVendor && vendor === catalogMmx) {
            rule.vendorCode = null;
        }

        if (!sameCodeList(fallbacks, loadedFallbacks)) {
            const list = parseFallbackInput(fallbacks);
            rule.fallbackCodes = list.length ? list : null;
        } else if (initialFallbacks && !fallbacks) {
            rule.fallbackCodes = null;
        }
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

            const defaultWarn = row.dataset.defaultStockWarning || '5';
            const effectiveWarn = warnDays !== '' ? String(warnDays) : defaultWarn;
            if (initialWarn !== '') {
                if (effectiveWarn !== initialWarn) {
                    rule.stockWarningDays = effectiveWarn === defaultWarn ? null : Number(effectiveWarn);
                }
            } else if (effectiveWarn !== defaultWarn) {
                rule.stockWarningDays = Number(effectiveWarn);
            }

            collectCodePatch(row, rule);

            if (Object.keys(rule).length) patch[code] = rule;
        });
        return patch;
    }

    async function saveChanges() {
        const root = ensureBackdrop();
        root.querySelector('#admin-buildto-error').textContent = '';
        const patch = collectPatch();
        const scope = getOverrideScope();
        if (activeTab === 'store' && scope.level === 'none') throw new Error('Select an area or store first.');
        let body = {};
        if (activeTab === 'global') {
            body = { global: patch };
        } else if (scope.level === 'store') {
            body = { stores: { [scope.store]: patch } };
        } else if (scope.level === 'area') {
            body = { areas: { [scope.area]: patch } };
        } else {
            throw new Error('Select an area or store first.');
        }
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
        if (!isInline()) root.hidden = false;
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
        storeList = await loadStores();
        await loadScopeTree();
        renderScopeNavigator();
        root.querySelector('#admin-buildto-body').innerHTML = '<p>Loading…</p>';
        try {
            await loadCatalog();
        } catch (error) {
            root.querySelector('#admin-buildto-error').textContent = error.message;
        }
    }

    function mount(host, options = {}) {
        pageHost = host;
        return open(options);
    }

    function setInlineHost(host) {
        pageHost = host || null;
    }

    function unmount() {
        pageHost = null;
    }

    global.AdminBuildTo = { open, close, mount, unmount, setInlineHost };
})(window);
