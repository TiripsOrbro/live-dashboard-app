(function (global) {
    const COG_SVG = `<svg class="mic-settings-cog-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96c-.5-.38-1.05-.7-1.65-.94l-.36-2.54a.5.5 0 0 0-.49-.42h-3.84a.5.5 0 0 0-.49.42l-.36 2.54c-.6.24-1.15.56-1.65.94l-2.39-.96a.5.5 0 0 0-.6.22l-1.92 3.32a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.38 1.05.7 1.65.94l.36 2.54a.5.5 0 0 0 .49.42h3.84a.5.5 0 0 0 .49-.42l.36-2.54c.6-.24 1.15-.56 1.65-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"/>
            </svg>`;

    let settingsOpen = false;
    let settingsPanelBound = false;

    function renderCog() {
        return `
        <button type="button" class="mic-settings-cog" id="mic-settings-btn" aria-label="Settings" title="Settings">
            ${COG_SVG}
        </button>`;
    }

    function renderPanel(options = {}) {
        const darkHint =
            options.darkModeHint || 'Dark background and tiles on this page.';
        const viewAccountsHidden = options.viewAccountsHidden !== false;
        return `
        <div id="mic-settings-picker" class="mic-item-picker" hidden>
            <div class="mic-item-picker-panel mic-settings-panel">
                <h2>Settings</h2>
                <div class="mic-settings-actions">
                    <button type="button" class="mic-settings-btn" data-action="change-password">Change password</button>
                    <button type="button" class="mic-settings-btn" data-action="view-accounts" id="mic-view-accounts-btn"${viewAccountsHidden ? ' hidden' : ''}>View accounts</button>
                    <button type="button" class="mic-settings-btn" data-action="changelog">What's new</button>
                    <div class="mic-settings-pref-block">
                        <div class="mic-settings-toggle-row">
                            <span class="mic-settings-toggle-label" id="mic-dark-mode-label">Dark mode</span>
                            <label class="mic-toggle-switch">
                                <input
                                    type="checkbox"
                                    id="mic-dark-mode-toggle"
                                    role="switch"
                                    aria-labelledby="mic-dark-mode-label"
                                >
                                <span class="mic-toggle-slider" aria-hidden="true"></span>
                            </label>
                        </div>
                        <p class="mic-settings-pref-hint">${darkHint}</p>
                    </div>
                    <div class="mic-settings-pref-block">
                        <div class="mic-settings-toggle-row">
                            <span class="mic-settings-toggle-label" id="mic-colour-blind-label">Colour blind mode</span>
                            <label class="mic-toggle-switch">
                                <input
                                    type="checkbox"
                                    id="mic-colour-blind-toggle"
                                    role="switch"
                                    aria-labelledby="mic-colour-blind-label"
                                >
                                <span class="mic-toggle-slider" aria-hidden="true"></span>
                            </label>
                        </div>
                        <p class="mic-settings-pref-hint">On-track status colours on the sales dashboard:</p>
                        <div class="mic-colour-samples" id="mic-colour-samples" aria-live="polite">
                            <div class="mic-colour-sample">
                                <span class="mic-colour-sample-box mic-colour-sample-box--good" aria-hidden="true"></span>
                                <span class="mic-colour-sample-label">On track</span>
                            </div>
                            <div class="mic-colour-sample">
                                <span class="mic-colour-sample-box mic-colour-sample-box--near" aria-hidden="true"></span>
                                <span class="mic-colour-sample-label">Near</span>
                            </div>
                            <div class="mic-colour-sample">
                                <span class="mic-colour-sample-box mic-colour-sample-box--bad" aria-hidden="true"></span>
                                <span class="mic-colour-sample-label">Behind</span>
                            </div>
                        </div>
                    </div>
                </div>
                <button type="button" class="mic-settings-close" id="mic-settings-close">Close</button>
            </div>
        </div>`;
    }

    function applyColourBlindMode(enabled) {
        document.body.classList.toggle('color-blind-mode', Boolean(enabled));
        document.documentElement.classList.toggle('color-blind-mode', Boolean(enabled));
    }

    function applyMicDarkMode(enabled) {
        const on = Boolean(enabled);
        document.body.classList.toggle('mic-dark-mode', on);
        document.documentElement.classList.toggle('mic-dark-mode', on);
        const theme = document.querySelector('meta[name="theme-color"]');
        if (theme) theme.setAttribute('content', on ? '#161616' : '#7a3eb1');
    }

    async function loadMicPreferences() {
        try {
            const res = await fetch('/api/me', { credentials: 'same-origin' });
            if (!res.ok) return { colorBlind: false, micDarkMode: false };
            const me = await res.json();
            const colorBlind = Boolean(me.success && me.colorBlind);
            const micDarkMode = Boolean(me.success && me.micDarkMode);
            applyColourBlindMode(colorBlind);
            applyMicDarkMode(micDarkMode);
            return { colorBlind, micDarkMode };
        } catch {
            return { colorBlind: false, micDarkMode: false };
        }
    }

    function updateColourBlindToggle(enabled) {
        const input = document.getElementById('mic-colour-blind-toggle');
        const samples = document.getElementById('mic-colour-samples');
        if (input) {
            input.checked = Boolean(enabled);
            input.disabled = false;
        }
        samples?.classList.toggle('is-colour-blind', Boolean(enabled));
    }

    function updateMicDarkToggle(enabled) {
        const input = document.getElementById('mic-dark-mode-toggle');
        if (!input) return;
        input.checked = Boolean(enabled);
        input.disabled = false;
    }

    async function saveColourBlindMode(enabled) {
        const input = document.getElementById('mic-colour-blind-toggle');
        if (input) input.disabled = true;
        try {
            const res = await fetch('/api/account/colour-blind-mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ enabled: Boolean(enabled) }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                throw new Error(data.error || 'Could not save preference.');
            }
            applyColourBlindMode(data.colorBlind);
            updateColourBlindToggle(data.colorBlind);
            return data.colorBlind;
        } catch (err) {
            if (input) {
                input.checked = !enabled;
                updateColourBlindToggle(input.checked);
            }
            alert(err.message || 'Could not save colour blind setting.');
            return null;
        } finally {
            if (input) input.disabled = false;
        }
    }

    async function saveMicDarkMode(enabled) {
        const input = document.getElementById('mic-dark-mode-toggle');
        if (input) input.disabled = true;
        try {
            const res = await fetch('/api/account/mic-dark-mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ enabled: Boolean(enabled) }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                throw new Error(data.error || 'Could not save preference.');
            }
            applyMicDarkMode(data.micDarkMode);
            updateMicDarkToggle(data.micDarkMode);
            return data.micDarkMode;
        } catch (err) {
            if (input) {
                input.checked = !enabled;
                updateMicDarkToggle(input.checked);
            }
            alert(err.message || 'Could not save dark mode setting.');
            return null;
        } finally {
            if (input) input.disabled = false;
        }
    }

    function openSettingsPanel() {
        if (settingsOpen) return;
        settingsOpen = true;
        const picker = document.getElementById('mic-settings-picker');
        if (picker) picker.hidden = false;
        loadMicPreferences().then((prefs) => {
            updateColourBlindToggle(prefs.colorBlind);
            updateMicDarkToggle(prefs.micDarkMode);
        });
    }

    function closeSettingsPanel() {
        const picker = document.getElementById('mic-settings-picker');
        if (!picker) return;
        picker.classList.add('is-closing');
        window.setTimeout(() => {
            picker.hidden = true;
            picker.classList.remove('is-closing');
            settingsOpen = false;
        }, 350);
    }

    function bind(options = {}) {
        if (settingsPanelBound) return;
        const btn = document.getElementById('mic-settings-btn');
        const picker = document.getElementById('mic-settings-picker');
        if (!btn || !picker) return;
        settingsPanelBound = true;

        btn.addEventListener('click', () => openSettingsPanel());

        picker.querySelector('#mic-settings-close')?.addEventListener('click', closeSettingsPanel);
        picker.addEventListener('click', (event) => {
            if (event.target === picker) closeSettingsPanel();
        });
        picker.querySelector('[data-action="change-password"]')?.addEventListener('click', () => {
            closeSettingsPanel();
            global.DashboardAccount?.openChangePasswordModal?.();
        });
        picker.querySelector('[data-action="view-accounts"]')?.addEventListener('click', () => {
            closeSettingsPanel();
            const viewOpts =
                typeof options.getViewAccountsOptions === 'function'
                    ? options.getViewAccountsOptions()
                    : options.viewAccountsOptions || {};
            global.DashboardAccount?.openViewAccountsModal?.(viewOpts);
        });
        picker.querySelector('[data-action="changelog"]')?.addEventListener('click', () => {
            closeSettingsPanel();
            global.location.href = '/changelog';
        });

        if (options.resolveViewAccountsVisibility !== false) {
            global.DashboardAccount?.fetchProfile?.()
                .then((data) => {
                    const viewBtn = document.getElementById('mic-view-accounts-btn');
                    if (viewBtn && data.canViewManagedAccounts) viewBtn.hidden = false;
                })
                .catch(() => {});
        }

        picker.querySelector('#mic-dark-mode-toggle')?.addEventListener('change', (event) => {
            const input = event.currentTarget;
            updateMicDarkToggle(input.checked);
            applyMicDarkMode(input.checked);
            saveMicDarkMode(input.checked);
        });
        picker.querySelector('#mic-colour-blind-toggle')?.addEventListener('change', (event) => {
            const input = event.currentTarget;
            updateColourBlindToggle(input.checked);
            applyColourBlindMode(input.checked);
            saveColourBlindMode(input.checked);
        });
    }

    function initPreferences() {
        return loadMicPreferences().then((prefs) => {
            updateColourBlindToggle(prefs.colorBlind);
            updateMicDarkToggle(prefs.micDarkMode);
            return prefs;
        });
    }

    global.MicSettings = {
        renderCog,
        renderPanel,
        bind,
        initPreferences,
        loadMicPreferences,
    };
})(window);
