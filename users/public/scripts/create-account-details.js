(function () {
    const form = document.getElementById('create-account-form');
    const errorEl = document.getElementById('create-details-error');
    const statusEl = document.getElementById('create-details-status');
    const submitBtn = document.getElementById('create-account-submit');
    const levelSelect = document.getElementById('new-account-level');
    const storeField = document.getElementById('create-store-field');
    const storeSelect = document.getElementById('new-store-number');
    const marketField = document.getElementById('create-market-field');
    const marketSelect = document.getElementById('new-market');
    const areaField = document.getElementById('create-area-field');
    const areaSelect = document.getElementById('new-area');
    const mmxSection = document.getElementById('create-mmx-section');
    const firstNameInput = document.getElementById('new-first-name');
    const lastNameInput = document.getElementById('new-last-name');

    let createOptions = null;

    if (window.DashboardNavBack) {
        window.DashboardNavBack.mountBackButton(document.getElementById('create-details-back'), {
            fallback: '/Create-Account',
        });
    }

    if (window.TbaBrandMark?.svg) {
        const host = document.getElementById('login-brand-mark');
        if (host) host.innerHTML = window.TbaBrandMark.svg('create-account-details-mark');
    }

    function selectedLevelMeta() {
        const value = String(levelSelect?.value || '').trim();
        return (createOptions?.assignableLevels || []).find((row) => row.value === value) || null;
    }

    function fillSelect(select, rows, getValue, getLabel, selectedValue = '') {
        if (!select) return;
        select.innerHTML = rows
            .map((row) => {
                const value = getValue(row);
                const label = getLabel(row);
                const selected = value === selectedValue ? ' selected' : '';
                return `<option value="${String(value).replace(/"/g, '&quot;')}"${selected}>${label}</option>`;
            })
            .join('');
    }

    function syncScopeFields() {
        const meta = selectedLevelMeta();
        const requiresStore = Boolean(meta?.requiresStore);
        const requiresMarket = Boolean(meta?.requiresMarket);
        const requiresArea = Boolean(meta?.requiresArea);
        const requiresMmx = Boolean(meta?.requiresMmx);

        if (storeField) storeField.hidden = !requiresStore;
        if (marketField) marketField.hidden = !requiresMarket;
        if (areaField) areaField.hidden = !requiresArea;
        if (mmxSection) mmxSection.hidden = !requiresMmx;

        if (firstNameInput) firstNameInput.required = requiresMmx;
        if (lastNameInput) lastNameInput.required = requiresMmx;
        document.getElementById('mmx-username')?.toggleAttribute('required', requiresMmx);
        document.getElementById('mmx-password')?.toggleAttribute('required', requiresMmx);

        if (requiresStore && createOptions?.stores?.length === 1 && storeSelect) {
            storeSelect.value = String(createOptions.stores[0].storeNumber);
            storeSelect.disabled = true;
        } else if (storeSelect) {
            storeSelect.disabled = false;
        }
    }

    async function loadCreateOptions() {
        const res = await fetch('/api/account/create-options', { credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not load account options.');
        }
        createOptions = data;
        fillSelect(
            levelSelect,
            data.assignableLevels || [],
            (row) => row.value,
            (row) => row.label
        );
        fillSelect(
            storeSelect,
            data.stores || [],
            (row) => row.storeNumber,
            (row) => `${row.storeNumber} — ${row.storeName}`,
            data.defaultStore || ''
        );
        fillSelect(areaSelect, (data.areas || []).map((area) => ({ area })), (row) => row.area, (row) => row.area);
        fillSelect(
            marketSelect,
            (data.markets || []).map((market) => ({ market })),
            (row) => row.market,
            (row) => row.market
        );
        syncScopeFields();
    }

    levelSelect?.addEventListener('change', syncScopeFields);

    form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        errorEl.textContent = '';
        statusEl.hidden = true;

        const meta = selectedLevelMeta();
        const username = document.getElementById('new-username').value.trim();
        const firstName = firstNameInput?.value.trim() || '';
        const lastName = lastNameInput?.value.trim() || '';
        const password = document.getElementById('new-password').value;
        const confirmPassword = document.getElementById('new-password-confirm').value;
        const mmxUsername = document.getElementById('mmx-username')?.value.trim() || '';
        const mmxPassword = document.getElementById('mmx-password')?.value || '';

        if (password !== confirmPassword) {
            errorEl.textContent = 'Passwords do not match.';
            return;
        }
        if (!meta) {
            errorEl.textContent = 'Choose an account level.';
            return;
        }
        if (meta.requiresMmx && (!firstName || !lastName)) {
            errorEl.textContent = 'First name and last name are required for store crew accounts.';
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = meta.requiresMmx ? 'Verifying MMX…' : 'Creating…';
        if (meta.requiresMmx) {
            statusEl.hidden = false;
            statusEl.textContent = 'Testing Macromatix login — this may take up to a minute.';
        }

        try {
            const res = await fetch('/api/account/create', {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    username,
                    accountLevel: meta.value,
                    storeNumber: storeSelect?.value || '',
                    market: marketSelect?.value || '',
                    area: areaSelect?.value || '',
                    firstName,
                    lastName,
                    password,
                    confirmPassword,
                    mmxUsername,
                    mmxPassword,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                errorEl.textContent = data.error || 'Could not create account.';
                return;
            }
            statusEl.hidden = false;
            statusEl.textContent = data.message || 'Account created.';
            window.setTimeout(() => {
                window.location.href = '/login?created=1';
            }, 1200);
        } catch (_) {
            errorEl.textContent = 'Request failed. Check your connection and try again.';
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create account';
            if (errorEl.textContent) statusEl.hidden = true;
        }
    });

    loadCreateOptions().catch((error) => {
        errorEl.textContent = error.message || 'Could not load create-account options.';
    });
})();
