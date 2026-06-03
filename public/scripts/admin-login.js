(function () {
    const form = document.getElementById('admin-login-form');
    const errorEl = document.getElementById('admin-login-error');
    const passkeyBtn = document.getElementById('admin-passkey-btn');

    if (window.DashboardNavBack) {
        window.DashboardNavBack.mountBackButton(document.getElementById('admin-login-back'), {
            fallback: '/login',
        });
    }

    if (window.TbaBrandMark?.svg) {
        const host = document.getElementById('login-brand-mark');
        if (host) host.innerHTML = window.TbaBrandMark.svg('admin-login-mark');
    }

    const params = new URLSearchParams(window.location.search);
    if (params.get('error') === 'invalid') {
        errorEl.textContent = 'Incorrect username or password.';
    }

    function showError(msg) {
        errorEl.textContent = msg || '';
    }

    form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        showError('');
        const username = document.getElementById('admin-username').value.trim();
        const password = document.getElementById('admin-password').value;
        const remember = document.getElementById('admin-remember').checked;
        try {
            const res = await fetch('/admin/login', {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ username, password, remember }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                showError(data.error || 'Sign in failed.');
                return;
            }
            window.location.replace(data.defaultPath || '/admin/overview');
        } catch (err) {
            showError('Could not sign in. Check your connection.');
        }
    });

    passkeyBtn?.addEventListener('click', async () => {
        showError('');
        if (!window.SimpleWebAuthnBrowser && !window.startAuthentication) {
            showError('Passkey sign-in is not available in this browser.');
            return;
        }
        const { startAuthentication } = window.SimpleWebAuthnBrowser || window;
        try {
            const optRes = await fetch('/api/webauthn/login/options', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: document.getElementById('admin-username').value.trim() }),
            });
            const optData = await optRes.json();
            if (!optData.success) throw new Error(optData.error || 'Could not start passkey login.');
            const authResp = await startAuthentication({ optionsJSON: optData.options });
            const verifyRes = await fetch('/api/webauthn/login/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(authResp),
            });
            const verifyData = await verifyRes.json();
            if (!verifyRes.ok || !verifyData.success) {
                throw new Error(verifyData.error || 'Passkey verification failed.');
            }
            window.location.replace(verifyData.defaultPath || '/admin/overview');
        } catch (err) {
            showError(err.message || 'Passkey sign-in failed.');
        }
    });
})();
