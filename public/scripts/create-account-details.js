(function () {
    const form = document.getElementById('create-account-form');
    const errorEl = document.getElementById('create-details-error');
    const statusEl = document.getElementById('create-details-status');
    const submitBtn = document.getElementById('create-account-submit');

    if (window.DashboardNavBack) {
        window.DashboardNavBack.mountBackButton(document.getElementById('create-details-back'), {
            fallback: '/Create-Account',
        });
    }

    if (window.TbaBrandMark?.svg) {
        const host = document.getElementById('login-brand-mark');
        if (host) host.innerHTML = window.TbaBrandMark.svg('create-account-details-mark');
    }

    form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        errorEl.textContent = '';
        statusEl.hidden = true;

        const username = document.getElementById('new-username').value.trim();
        const firstName = document.getElementById('new-first-name').value.trim();
        const lastName = document.getElementById('new-last-name').value.trim();
        const password = document.getElementById('new-password').value;
        const confirmPassword = document.getElementById('new-password-confirm').value;
        const mmxUsername = document.getElementById('mmx-username').value.trim();
        const mmxPassword = document.getElementById('mmx-password').value;

        if (!firstName || !lastName) {
            errorEl.textContent = 'First name and last name are required.';
            return;
        }

        if (password !== confirmPassword) {
            errorEl.textContent = 'Passwords do not match.';
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Verifying MMX…';
        statusEl.hidden = false;
        statusEl.textContent = 'Testing Macromatix login — this may take up to a minute.';

        try {
            const res = await fetch('/api/account/create', {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    username,
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
})();
