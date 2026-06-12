(function () {
    const form = document.getElementById('create-account-verify-form');
    const errorEl = document.getElementById('create-account-error');
    const submitBtn = document.getElementById('create-account-proceed');

    if (window.DashboardNavBack) {
        window.DashboardNavBack.mountBackButton(document.getElementById('create-account-back'), {
            fallback: '/login',
        });
    }

    if (window.TbaBrandMark?.svg) {
        const host = document.getElementById('login-brand-mark');
        if (host) host.innerHTML = window.TbaBrandMark.svg('create-account-mark');
    }

    const params = new URLSearchParams(window.location.search);
    if (params.get('error') === 'session') {
        errorEl.textContent =
            'Step 2 needs a fresh sign-in. Enter your username and password below, then tap Proceed.';
        try {
            const url = new URL(window.location.href);
            url.searchParams.delete('error');
            window.history.replaceState(null, '', url.pathname + url.search);
        } catch (_) {
            /* ignore */
        }
    }

    async function maybeSkipToDetails() {
        try {
            const res = await fetch('/api/me', { credentials: 'include' });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.success && data.canCreateAccount) {
                const optionsRes = await fetch('/api/account/create-options', { credentials: 'include' });
                const options = await optionsRes.json().catch(() => ({}));
                if (optionsRes.ok && options.success) {
                    window.location.replace('/Create-Account/details');
                }
            }
        } catch (_) {
            /* stay on step 1 */
        }
    }

    maybeSkipToDetails();

    form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        errorEl.textContent = '';
        const username = document.getElementById('create-parent-username').value.trim();
        const password = document.getElementById('create-parent-password').value;
        if (!username || !password) {
            errorEl.textContent = 'Enter your username and password.';
            return;
        }
        submitBtn.disabled = true;
        submitBtn.textContent = 'Verifying…';
        try {
            const res = await fetch('/Create-Account/verify', {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ username, password }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                errorEl.textContent = data.error || 'Could not verify account.';
                return;
            }
            window.location.href = data.nextPath || '/Create-Account/details';
        } catch (_) {
            errorEl.textContent = 'Could not reach the server. Try again.';
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Proceed';
        }
    });
})();
