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
    let canEditItemCodes = false;

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

    function displayMmxCode(item) {
        return String(item.fileMmxCode || item.mmxCode || item.catalogMmxCode || item.itemCode || '').trim();
    }

    function displayVendorCode(item) {
        return String(item.fileVendorCode || item.vendorCode || item.catalogMmxCode || item.itemCode || '').trim();
    }

    function displayFallbackCodes(item) {
        const effective = formatFallbackCodes(item.fallbackCodes);
        if (effective) return effective;
        return formatFallbackCodes(item.fileFallbackCodes);
    }

    function applyItemCodeFields(row, item) {
        const mmx = displayMmxCode(item);
        const vendor = displayVendorCode(item);
        const fallbacks = displayFallbackCodes(item);
        const catalogMmx = String(item.catalogMmxCode || item.itemCode || '').trim();

        row.dataset.catalogMmx = catalogMmx;
        row.dataset.loadedMmx = mmx;
        row.dataset.loadedVendor = vendor;
        row.dataset.loadedFallbacks = fallbacks;
        row.dataset.fileFallbacks = formatFallbackCodes(item.fileFallbackCodes);

        const mmxInput = row.querySelector('[data-field="mmxCode"]');
        const vendorInput = row.querySelector('[data-field="vendorCode"]');
        const fallbackInput = row.querySelector('[data-field="fallbackCodes"]');
        const codeLocked = !canEditItemCodes;
        const lockedTitle = 'Area Manager or above can change item codes';
        if (mmxInput) {
            mmxInput.value = mmx;
            mmxInput.readOnly = codeLocked;
            mmxInput.classList.toggle('admin-buildto-code-input--locked', codeLocked);
            mmxInput.title = codeLocked ? lockedTitle : 'MMX / Key Item Count code';
        }
        if (vendorInput) {
            vendorInput.value = vendor;
            vendorInput.readOnly = codeLocked;
            vendorInput.classList.toggle('admin-buildto-code-input--locked', codeLocked);
            vendorInput.title = codeLocked ? lockedTitle : 'Vendor order code';
        }
        if (fallbackInput) {
            fallbackInput.value = fallbacks;
            fallbackInput.placeholder = fallbacks ? '' : '-';
            fallbackInput.readOnly = codeLocked;
            fallbackInput.classList.toggle('admin-buildto-code-input--locked', codeLocked);
            fallbackInput.title = codeLocked
                ? lockedTitle
                : 'Extra ISE/SOH codes, tried in order (comma-separated)';
        }
    }

    function bindRowControls(itemsByCode) {
        const root = ensureBackdrop();
        root.querySelectorAll('tbody tr[data-item-code]').forEach((row) => {
            const item = itemsByCode?.get(row.getAttribute('data-item-code'));
            if (item) applyItemCodeFields(row, item);
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
                <div id="admin-buildto-scope-tabs-wrap" class="admin-settings-segmented-tabs admin-accounts-org-nav">
                    <div class="admin-accounts-scope-row-wrap">
                        <span class="admin-accounts-scope-row-label">Scope</span>
                        <div class="admin-accounts-scope-row admin-accounts-scope-row--equal" id="admin-buildto-tabs" role="tablist" style="--scope-cols: 2">
                            <button type="button" class="admin-accounts-scope-chip" data-tab="global" id="admin-buildto-global-tab" hidden role="tab">Global</button>
                            <button type="button" class="admin-accounts-scope-chip" data-tab="store" role="tab">Stores</button>
                        </div>
                    </div>
                </div>
                <div id="admin-buildto-browse-scope" class="admin-accounts-browse-scope admin-accounts-org-nav"></div>
                <div class="admin-modal-toolbar admin-buildto-toolbar">
                    <div class="admin-buildto-search-wrap">
                        <input type="search" id="admin-buildto-search" placeholder="Search items…" aria-label="Search items" />
                    </div>
                    <button type="button" class="mic-settings-btn admin-buildto-add" id="admin-buildto-add" hidden>+ New item</button>
                    <button type="button" class="mic-settings-btn admin-btn-primary admin-buildto-save" id="admin-buildto-save">Save changes</button>
                </div>
                <div class="admin-buildto-new-wrap" id="admin-buildto-new-wrap" hidden></div>
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
        root.querySelector('#admin-buildto-add')?.addEventListener('click', () => {
            toggleNewItemForm();
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
        const row = root.querySelector('#admin-buildto-tabs');
        let visibleCount = 0;
        root.querySelectorAll('#admin-buildto-tabs [data-tab]').forEach((tab) => {
            if (tab.hidden) return;
            visibleCount += 1;
            tab.classList.toggle('is-active', tab.dataset.tab === activeTab);
        });
        if (row) row.style.setProperty('--scope-cols', String(Math.max(visibleCount, 1)));

        const globalTab = root.querySelector('#admin-buildto-global-tab');
        const scopeTabsWrap = root.querySelector('#admin-buildto-scope-tabs-wrap');
        if (scopeTabsWrap) scopeTabsWrap.hidden = Boolean(globalTab?.hidden);

        const browseScopeHost = root.querySelector('#admin-buildto-browse-scope');
        if (browseScopeHost) browseScopeHost.hidden = activeTab === 'global';
    }

    function formatFallbackCodes(codes) {
        if (Array.isArray(codes)) return codes.filter(Boolean).join(', ');
        if (codes == null || codes === '') return '';
        return String(codes).trim();
    }

    function asStoreNumbers(list) {
        if (!list) return [];
        if (Array.isArray(list)) return list.map(String);
        return [String(list)];
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
        const rows = global.AdminScopePicker.asStoreRows
            ? global.AdminScopePicker.asStoreRows(storeList)
            : storeList;
        scopeTree = global.AdminScopePicker.filterScopeTreeForStores(raw, rows);
        return scopeTree;
    }

    function renderScopeNavigator() {
        const root = ensureBackdrop();
        const host = root.querySelector('#admin-buildto-browse-scope');
        if (!host) return;
        if (!scopeTree || !global.AdminScopePicker) {
            host.innerHTML = '<p class="admin-scope-picker-empty">No stores available.</p>';
            return;
        }

        const onScopeChange = (scope) => {
            browseScope = { ...scope };
            void loadCatalog().catch((error) => {
                const root = ensureBackdrop();
                root.querySelector('#admin-buildto-error').textContent = error.message || 'Could not load catalog.';
            });
        };

        if (!scopeNavigator) {
            scopeNavigator = global.AdminScopePicker.mountInline(host, {
                tree: scopeTree,
                initialScope: browseScope,
                preferredStore: browseScope.storeNumber,
                scopePrefix: 'browse',
                onChange: onScopeChange,
            });
        } else {
            scopeNavigator.setTree(scopeTree);
            scopeNavigator.setScope(browseScope);
        }
        if (scopeNavigator) {
            browseScope = scopeNavigator.getScope();
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

    async function loadStores() {
        const me = await fetchProfile();
        if (me.canViewCrossStoreAccounts) {
            const res = await fetch('/api/stores', { credentials: 'same-origin' });
            const data = await res.json().catch(() => ({}));
            return (data.stores || []).filter((s) => !s.testStore);
        }
        const nums =
            me.stores === '*'
                ? []
                : asStoreNumbers(me.effectiveStores || me.stores);
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
        try {
            renderRows();
        } catch (error) {
            throw new Error(error.message || 'Could not render build-to catalog.');
        }
    }

    function allItems() {
        const items = [];
        for (const vendor of catalogCache?.vendors || []) {
            for (const item of vendor.items || []) {
                items.push({ ...item, vendorSlug: vendor.slug, vendorLabel: vendor.label });
            }
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
        const itemsByCode = new Map(items.map((item) => [String(item.itemCode), item]));
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
                            data-initial-mmx="${item.scopeMmxCode != null ? escapeHtml(item.scopeMmxCode) : ''}"
                            data-initial-vendor="${item.scopeVendorCode != null ? escapeHtml(item.scopeVendorCode) : ''}"
                            data-initial-fallbacks="${escapeHtml(scopeFallbacks)}">
                            <td class="admin-buildto-item-cell">${escapeHtml(item.name)}<span class="admin-accounts-meta">${escapeHtml(item.itemCode)}</span></td>
                            <td class="admin-buildto-vendor-cell">${escapeHtml(item.vendorLabel || item.vendorSlug)}</td>
                            <td><input type="text" data-field="mmxCode" class="admin-buildto-code-input" autocomplete="off" title="MMX / Key Item Count code" /></td>
                            <td><input type="text" data-field="vendorCode" class="admin-buildto-code-input" autocomplete="off" title="Vendor order code" /></td>
                            <td><input type="text" data-field="fallbackCodes" class="admin-buildto-fallback-input" autocomplete="off" title="Extra ISE/SOH codes, tried in order (comma-separated)" /></td>
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
        bindRowControls(itemsByCode);
    }

    function newItemVendors() {
        return (catalogCache?.vendors || []).map((vendor) => ({
            slug: vendor.slug,
            label: vendor.label || vendor.slug,
            locations: Array.isArray(vendor.locations) ? vendor.locations : [],
        }));
    }

    function renderNewItemLocations(form, vendorSlug) {
        const host = form.querySelector('[data-new-item="locations"]');
        if (!host) return;
        const vendor = newItemVendors().find((v) => v.slug === vendorSlug);
        const locations = vendor?.locations || [];
        host.innerHTML = `
            ${locations
                .map(
                    (loc) => `
                <label class="admin-buildto-new-loc">
                    <input type="checkbox" data-new-item-location value="${escapeHtml(loc)}" />
                    <span>${escapeHtml(loc)}</span>
                </label>`
                )
                .join('')}
            <input type="text" data-new-item="newLocation" class="admin-buildto-code-input" placeholder="New location…" title="Optional: a new stock-count tab/location name" />`;
    }

    function applyNewItemRuleType(form) {
        const type = form.querySelector('[data-new-item="ruleType"]')?.value || 'days';
        const showDays = type === 'days' || type === 'on-hand';
        form.querySelectorAll('[data-new-item-group="days"]').forEach((el) => {
            el.classList.toggle('admin-buildto-group--off', !showDays);
        });
        form.querySelectorAll('[data-new-item-group="fixed"]').forEach((el) => {
            el.classList.toggle('admin-buildto-group--off', showDays);
        });
    }

    function renderNewItemForm() {
        const root = ensureBackdrop();
        const wrap = root.querySelector('#admin-buildto-new-wrap');
        if (!wrap) return;
        const vendors = newItemVendors();
        if (!vendors.length) {
            wrap.innerHTML = '<p>Load a catalog first.</p>';
            return;
        }
        wrap.innerHTML = `
            <div class="admin-buildto-new" id="admin-buildto-new">
                <h3>New item</h3>
                <div class="admin-buildto-new-grid">
                    <label>Vendor
                        <select data-new-item="vendor" class="admin-buildto-type-select">
                            ${vendors.map((v) => `<option value="${escapeHtml(v.slug)}">${escapeHtml(v.label)}</option>`).join('')}
                        </select>
                    </label>
                    <label>Item name
                        <input type="text" data-new-item="name" class="admin-buildto-code-input" placeholder="e.g. TB SAUCE VERDE 10X1KG" />
                    </label>
                    <label>MMX / item code
                        <input type="text" data-new-item="itemCode" class="admin-buildto-code-input" placeholder="e.g. 38123" title="Macromatix Key Item Count / ISE code" />
                    </label>
                    <label>Vendor code <span class="admin-buildto-new-optional">optional</span>
                        <input type="text" data-new-item="vendorCode" class="admin-buildto-code-input" placeholder="Same as item code" title="Vendor order code, if different" />
                    </label>
                    <label>Fallback codes <span class="admin-buildto-new-optional">optional</span>
                        <input type="text" data-new-item="fallbackCodes" class="admin-buildto-code-input" placeholder="Comma-separated" title="Extra ISE/SOH codes, tried in order" />
                    </label>
                    <label>Type
                        <select data-new-item="ruleType" class="admin-buildto-type-select">
                            <option value="days" selected>Days</option>
                            <option value="on-hand">On hand</option>
                            <option value="manual">Manual</option>
                        </select>
                    </label>
                    <label data-new-item-group="days">Days
                        <input type="number" min="1" max="31" data-new-item="buildToDays" class="admin-buildto-num-input" value="10" />
                    </label>
                    <label data-new-item-group="days">+Buffer
                        <input type="number" min="0" max="99" data-new-item="buildToAdd" class="admin-buildto-num-input" value="0" />
                    </label>
                    <label data-new-item-group="fixed" class="admin-buildto-group--off">Fixed build-to
                        <input type="number" min="0" max="999" step="any" data-new-item="buildToFixed" class="admin-buildto-num-input" placeholder="Blank = stock count only" />
                    </label>
                    <label>Outer unit
                        <input type="text" data-new-item="unit0" class="admin-buildto-code-input" value="Boxes" title="First count column (Boxes, Cartons, Bags…)" />
                    </label>
                    <label>Inner unit
                        <input type="text" data-new-item="unit1" class="admin-buildto-code-input" value="N/a" title="Second count column, or N/a" />
                    </label>
                    <label>Unit
                        <input type="text" data-new-item="unit2" class="admin-buildto-code-input" value="N/a" title="Third count column (KGs, Each…), or N/a" />
                    </label>
                    <label>Inner per carton <span class="admin-buildto-new-optional">optional</span>
                        <input type="number" min="0" step="any" data-new-item="innerPerCarton" class="admin-buildto-num-input" placeholder="-" title="Inner units per carton (e.g. 10 packs per box)" />
                    </label>
                </div>
                <div class="admin-buildto-new-locrow">
                    <span class="admin-buildto-new-label">Count locations</span>
                    <div class="admin-buildto-new-locs" data-new-item="locations"></div>
                </div>
                <div class="admin-buildto-new-flags">
                    <label><input type="checkbox" data-new-item="includeKeyItem" /> Key Item Count</label>
                    <label><input type="checkbox" data-new-item="includeDaily" /> Daily count</label>
                </div>
                <p class="admin-modal-error admin-buildto-new-error" data-new-item="error" role="alert"></p>
                <div class="admin-buildto-new-actions">
                    <button type="button" class="mic-settings-btn admin-btn-primary" data-new-item="submit">Add item</button>
                    <button type="button" class="admin-buildto-close-btn" data-new-item="cancel">Cancel</button>
                </div>
            </div>`;

        const form = wrap.querySelector('#admin-buildto-new');
        const vendorSelect = form.querySelector('[data-new-item="vendor"]');
        renderNewItemLocations(form, vendorSelect.value);
        vendorSelect.addEventListener('change', () => renderNewItemLocations(form, vendorSelect.value));
        form.querySelector('[data-new-item="ruleType"]').addEventListener('change', () => applyNewItemRuleType(form));
        form.querySelector('[data-new-item="cancel"]').addEventListener('click', () => {
            wrap.hidden = true;
        });
        form.querySelector('[data-new-item="submit"]').addEventListener('click', () => {
            void submitNewItem(form);
        });
    }

    function toggleNewItemForm() {
        const root = ensureBackdrop();
        const wrap = root.querySelector('#admin-buildto-new-wrap');
        if (!wrap) return;
        if (wrap.hidden) {
            renderNewItemForm();
            wrap.hidden = false;
            wrap.querySelector('[data-new-item="name"]')?.focus();
        } else {
            wrap.hidden = true;
        }
    }

    async function submitNewItem(form) {
        const field = (key) => form.querySelector(`[data-new-item="${key}"]`);
        const errorEl = field('error');
        errorEl.textContent = '';

        const locations = [...form.querySelectorAll('[data-new-item-location]:checked')].map((el) => el.value);
        const newLocation = String(field('newLocation')?.value || '').trim();
        if (newLocation) locations.push(newLocation);

        const body = {
            vendor: field('vendor')?.value || '',
            name: String(field('name')?.value || '').trim(),
            itemCode: String(field('itemCode')?.value || '').trim(),
            vendorCode: String(field('vendorCode')?.value || '').trim(),
            fallbackCodes: String(field('fallbackCodes')?.value || '').trim(),
            ruleType: field('ruleType')?.value || 'days',
            buildToDays: field('buildToDays')?.value,
            buildToAdd: field('buildToAdd')?.value,
            buildToFixed: field('buildToFixed')?.value,
            units: [field('unit0')?.value, field('unit1')?.value, field('unit2')?.value],
            locations,
            innerPerCarton: field('innerPerCarton')?.value,
            includeKeyItem: Boolean(field('includeKeyItem')?.checked),
            includeDaily: Boolean(field('includeDaily')?.checked),
        };
        if (!body.name) {
            errorEl.textContent = 'Item name is required.';
            return;
        }
        if (!body.itemCode) {
            errorEl.textContent = 'Item code is required.';
            return;
        }

        const submitBtn = field('submit');
        submitBtn.disabled = true;
        try {
            const res = await fetch('/api/admin/build-to/items', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) throw new Error(data.error || 'Could not add item.');
            const root = ensureBackdrop();
            const wrap = root.querySelector('#admin-buildto-new-wrap');
            if (wrap) wrap.hidden = true;
            const search = root.querySelector('#admin-buildto-search');
            if (search) search.value = data.itemCode || body.itemCode;
            await loadCatalog();
        } catch (error) {
            errorEl.textContent = error.message || 'Could not add item.';
        } finally {
            submitBtn.disabled = false;
        }
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
        if (!canEditItemCodes) return;
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
                if (days !== '') rule.buildToDays = Number(days);
                if (add !== '') rule.buildToAdd = Number(add);
                rule.buildToFixed = null;
                if (initialRuleType !== 'on-hand') {
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
        canEditItemCodes = Boolean(me.canEditGlobalBuildTo);
        const addBtn = root.querySelector('#admin-buildto-add');
        if (addBtn) addBtn.hidden = !canEditItemCodes;
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
