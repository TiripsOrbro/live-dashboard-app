(function (global) {
    let sessionCreds = null;

    const PURPOSE_COPY = {
        send: 'Counts are sent under <strong>your</strong> Macromatix user so Key Item Count shows who entered them.',
        'check-levels':
            'Stock level checks download Macromatix reports under <strong>your</strong> user login.',
    };

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function apiUrl(path, storeNumber) {
        const store = String(storeNumber || '').trim();
        const sep = path.includes('?') ? '&' : '?';
        return store ? `${path}${sep}store=${encodeURIComponent(store)}` : path;
    }

    async function fetchJson(url, options = {}) {
        const res = await fetch(url, { credentials: 'same-origin', ...options });
        let data = {};
        try {
            data = await res.json();
        } catch {
            data = {};
        }
        return { res, data };
    }

    function isLoginRequiredError(message) {
        return /Macromatix login is not set up|needsMmxUserLogin|Enter your MMX username|personal Macromatix login|Macromatix login is required/i.test(
            String(message || '')
        );
    }

    function loginRequestBody() {
        if (!sessionCreds?.mmxUsername || !sessionCreds?.mmxPassword) return {};
        return {
            mmxUsername: sessionCreds.mmxUsername,
            mmxPassword: sessionCreds.mmxPassword,
            remember: false,
        };
    }

    function showModal(maskedUsername = '', purpose = 'send') {
        return new Promise((resolve) => {
            const backdrop = document.createElement('div');
            backdrop.className = 'mmx-login-backdrop';
            backdrop.setAttribute('role', 'dialog');
            backdrop.setAttribute('aria-modal', 'true');
            const bodyCopy = PURPOSE_COPY[purpose] || PURPOSE_COPY.send;
            backdrop.innerHTML = `
                <div class="mmx-login-card">
                    <h2>Your Macromatix login</h2>
                    <p class="mmx-login-body">${bodyCopy}${maskedUsername ? ` Last saved: <strong>${escapeHtml(maskedUsername)}</strong>.` : ''}</p>
                    <label class="mmx-login-field">MMX username
                        <input type="text" id="mmx-login-user" autocomplete="username" />
                    </label>
                    <label class="mmx-login-field">MMX password
                        <input type="password" id="mmx-login-pass" autocomplete="current-password" />
                    </label>
                    <label class="mmx-login-remember">
                        <input type="checkbox" id="mmx-login-remember" checked />
                        Remember my Macromatix login on this account
                    </label>
                    <p id="mmx-login-error" class="mmx-login-error" hidden></p>
                    <div class="mmx-login-actions">
                        <button type="button" class="mmx-login-btn" id="mmx-login-cancel">Cancel</button>
                        <button type="button" class="mmx-login-btn mmx-login-btn--primary" id="mmx-login-submit">Continue</button>
                    </div>
                </div>`;
            document.body.appendChild(backdrop);
            const userInput = backdrop.querySelector('#mmx-login-user');
            const passInput = backdrop.querySelector('#mmx-login-pass');
            const errEl = backdrop.querySelector('#mmx-login-error');
            const submitBtn = backdrop.querySelector('#mmx-login-submit');
            const finish = (value) => {
                backdrop.remove();
                resolve(value);
            };
            backdrop.querySelector('#mmx-login-cancel')?.addEventListener('click', () => finish(null));
            backdrop.querySelector('#mmx-login-submit')?.addEventListener('click', async () => {
                const mmxUsername = String(userInput?.value || '').trim();
                const mmxPassword = String(passInput?.value || '');
                const remember = Boolean(backdrop.querySelector('#mmx-login-remember')?.checked);
                if (!mmxUsername || !mmxPassword) {
                    if (errEl) {
                        errEl.textContent = 'Enter your Macromatix username and password.';
                        errEl.hidden = false;
                    }
                    return;
                }
                if (submitBtn) submitBtn.disabled = true;
                try {
                    if (remember) {
                        const { res, data } = await fetchJson('/api/stock-count/mmx-user-login', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ mmxUsername, mmxPassword, remember: true }),
                        });
                        if (!res.ok || !data.success) {
                            if (errEl) {
                                errEl.textContent = data.error || 'Macromatix login failed.';
                                errEl.hidden = false;
                            }
                            return;
                        }
                        finish({ mmxUsername, mmxPassword, remember: true });
                        return;
                    }
                    finish({ mmxUsername, mmxPassword, remember: false });
                } finally {
                    if (submitBtn) submitBtn.disabled = false;
                }
            });
            userInput?.focus();
        });
    }

    async function ensureBeforeMmx(storeNumber, options = {}) {
        const purpose = options.purpose || 'send';
        const { res, data } = await fetchJson(apiUrl('/api/stock-count/mmx-user-login', storeNumber));
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not check Macromatix login status.');
        }
        if (!data.required || data.configured) {
            sessionCreds = null;
            return;
        }
        const creds = await showModal(data.maskedUsername || '', purpose);
        if (!creds) {
            throw new Error('Macromatix login is required to continue.');
        }
        sessionCreds = creds.remember ? null : creds;
    }

    global.MmxUserLoginPrompt = {
        ensureBeforeMmx,
        loginRequestBody,
        isLoginRequiredError,
        showModal,
    };
})(window);
