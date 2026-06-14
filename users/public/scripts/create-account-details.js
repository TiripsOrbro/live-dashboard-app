(function () {
    const form = document.getElementById('create-account-form');
    const errorEl = document.getElementById('create-details-error');
    const statusEl = document.getElementById('create-details-status');
    const submitBtn = document.getElementById('create-account-submit');
    const successWrapEl = document.getElementById('create-details-success');
    const tempPasswordEl = document.getElementById('create-temp-password');
    const nextStepsEl = document.getElementById('create-details-next-steps');
    const levelGroup = document.getElementById('new-account-level-group');
    const storeField = document.getElementById('create-store-field');
    const storeGroup = document.getElementById('new-store-number-group');
    const marketField = document.getElementById('create-market-field');
    const marketGroup = document.getElementById('new-market-group');
    const areaField = document.getElementById('create-area-field');
    const areaGroup = document.getElementById('new-area-group');

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

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function escapeAttr(value) {
        return escapeHtml(value);
    }

    function selectedRadioValue(name) {
        return document.querySelector(`input[type="radio"][name="${name}"]:checked`)?.value || '';
    }

    function selectedLevelMeta() {
        const value = selectedRadioValue('accountLevel');
        return (createOptions?.assignableLevels || []).find((row) => row.value === value) || null;
    }

    function fillChoiceGroup(container, rows, name, getValue, getLabel, selectedValue = '') {
        if (!container) return;
        if (!rows.length) {
            container.innerHTML = '<p class="login-choice-empty">No options available.</p>';
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
                    <label class="login-choice" for="${escapeAttr(id)}">
                        <input type="radio" id="${escapeAttr(id)}" name="${escapeAttr(name)}" value="${escapeAttr(value)}"${checked}>
                        <span>${escapeHtml(label)}</span>
                    </label>
                `;
            })
            .join('');
    }

    function setChoiceGroupDisabled(group, name, disabled, forcedValue = '') {
        if (!group) return;
        group.querySelectorAll(`input[type="radio"][name="${name}"]`).forEach((input) => {
            if (forcedValue && input.value === forcedValue) {
                input.checked = true;
            }
            input.disabled = disabled;
        });
    }

    function syncScopeFields() {
        const meta = selectedLevelMeta();
        const requiresStore = Boolean(meta?.requiresStore);
        const requiresMarket = Boolean(meta?.requiresMarket);
        const requiresArea = Boolean(meta?.requiresArea);

        if (storeField) storeField.hidden = !requiresStore;
        if (marketField) marketField.hidden = !requiresMarket;
        if (areaField) areaField.hidden = !requiresArea;

        if (requiresStore && createOptions?.stores?.length === 1) {
            const only = String(createOptions.stores[0].storeNumber);
            setChoiceGroupDisabled(storeGroup, 'storeNumber', true, only);
        } else {
            setChoiceGroupDisabled(storeGroup, 'storeNumber', false);
        }
    }

    function showCreatedAccount(data) {
        if (successWrapEl) successWrapEl.hidden = false;
        if (tempPasswordEl) tempPasswordEl.textContent = data.temporaryPassword || '';
        if (nextStepsEl) {
            nextStepsEl.textContent = data.message || 'The user can sign in with this temporary password.';
        }
        if (submitBtn) {
            submitBtn.textContent = 'Create another account';
            submitBtn.type = 'button';
            submitBtn.onclick = () => window.location.reload();
        }
        form.querySelectorAll('input, button[type="submit"]').forEach((el) => {
            if (el !== submitBtn) el.disabled = true;
        });
        levelGroup?.querySelectorAll('input').forEach((el) => {
            el.disabled = true;
        });
    }

    async function loadCreateOptions() {
        if (levelGroup) levelGroup.innerHTML = '<p class="login-choice-empty">Loading access levels…</p>';
        const res = await fetch('/api/account/create-options', { credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not load account options.');
        }
        createOptions = data;
        fillChoiceGroup(
            levelGroup,
            data.assignableLevels || [],
            'accountLevel',
            (row) => row.value,
            (row) => row.label
        );
        fillChoiceGroup(
            storeGroup,
            data.stores || [],
            'storeNumber',
            (row) => row.storeNumber,
            (row) => `${row.storeNumber} — ${row.storeName}`,
            data.defaultStore || ''
        );
        fillChoiceGroup(
            areaGroup,
            (data.areas || []).map((area) => ({ area })),
            'area',
            (row) => row.area,
            (row) => row.area
        );
        fillChoiceGroup(
            marketGroup,
            (data.markets || []).map((market) => ({ market })),
            'market',
            (row) => row.market,
            (row) => row.market
        );
        syncScopeFields();
    }

    levelGroup?.addEventListener('change', syncScopeFields);

    form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (submitBtn?.type === 'button') return;
        errorEl.textContent = '';
        statusEl.hidden = true;

        const meta = selectedLevelMeta();
        const username = document.getElementById('new-username').value.trim();

        if (!username) {
            errorEl.textContent = 'Enter a username.';
            return;
        }
        if (!meta) {
            errorEl.textContent = 'Choose an account level.';
            return;
        }
        if (meta.requiresStore && !selectedRadioValue('storeNumber')) {
            errorEl.textContent = 'Choose a store.';
            return;
        }
        if (meta.requiresMarket && !selectedRadioValue('market')) {
            errorEl.textContent = 'Choose a market.';
            return;
        }
        if (meta.requiresArea && !selectedRadioValue('area')) {
            errorEl.textContent = 'Choose an area.';
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Creating…';

        try {
            const res = await fetch('/api/account/create', {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    username,
                    accountLevel: meta.value,
                    storeNumber: selectedRadioValue('storeNumber'),
                    market: selectedRadioValue('market'),
                    area: selectedRadioValue('area'),
                    useTemporaryPassword: true,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                errorEl.textContent = data.error || 'Could not create account.';
                submitBtn.disabled = false;
                submitBtn.textContent = 'Create account';
                return;
            }
            statusEl.hidden = false;
            statusEl.textContent = data.message || 'Account created.';
            showCreatedAccount(data);
        } catch (_) {
            errorEl.textContent = 'Request failed. Check your connection and try again.';
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create account';
        }
    });

    loadCreateOptions().catch((error) => {
        errorEl.textContent = error.message || 'Could not load create-account options.';
    });
})();
