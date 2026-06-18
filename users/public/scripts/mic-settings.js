(function (global) {
    const COG_SVG = `<svg class="mic-settings-cog-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96c-.5-.38-1.05-.7-1.65-.94l-.36-2.54a.5.5 0 0 0-.49-.42h-3.84a.5.5 0 0 0-.49.42l-.36 2.54c-.6.24-1.15.56-1.65.94l-2.39-.96a.5.5 0 0 0-.6.22l-1.92 3.32a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.38 1.05.7 1.65.94l.36 2.54a.5.5 0 0 0 .49.42h3.84a.5.5 0 0 0 .49-.42l.36-2.54c.6-.24 1.15-.56 1.65-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"/>
            </svg>`;

    let settingsOpen = false;
    let settingsPanelBound = false;
    let activeSettingsTab = 'account';
    let bindOptions = {};
    let savingReportEmail = false;

    function renderCog() {
        return `
        <button type="button" class="mic-settings-cog" id="mic-settings-btn" aria-label="Settings" title="Settings">
            ${COG_SVG}
        </button>`;
    }

    function escapeAttr(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    }

    function renderPanel(options = {}) {
        const darkHint = options.darkModeHint || 'Dark background and tiles on this page.';
        const hasStoreTab = Boolean(options.storeNumber);
        const email = String(options.reportEmail || '').trim();
        const adminActionsHtml = global.AdminMenu?.renderActionsHtml?.() || '';

        return `
        <div id="mic-settings-picker" class="mic-item-picker" hidden>
            <div class="mic-item-picker-panel mic-settings-panel mic-settings-panel--tabbed">
                <h2>Settings</h2>
                <div class="mic-settings-tabs" role="tablist" aria-label="Settings sections">
                    <button type="button" class="mic-settings-tab is-active" role="tab" data-settings-tab="account" aria-selected="true">Account</button>
                    <button type="button" class="mic-settings-tab" role="tab" data-settings-tab="preferences" aria-selected="false">Preferences</button>
                    ${hasStoreTab ? '<button type="button" class="mic-settings-tab" role="tab" data-settings-tab="store" aria-selected="false">Store</button>' : ''}
                    <button type="button" class="mic-settings-tab" role="tab" data-settings-tab="general" aria-selected="false">General</button>
                    <button type="button" class="mic-settings-tab" role="tab" data-settings-tab="admin" id="mic-settings-admin-tab" aria-selected="false" hidden>Admin</button>
                </div>
                <div class="mic-settings-tabpanels">
                    <div class="mic-settings-tabpanel is-active" data-settings-panel="account" role="tabpanel">
                        <div class="mic-settings-actions">
                            <button type="button" class="mic-settings-btn" data-action="change-password">Change password</button>
                            <button type="button" class="mic-settings-btn mic-settings-btn--danger" data-action="logout">Sign out</button>
                        </div>
                    </div>
                    <div class="mic-settings-tabpanel" data-settings-panel="preferences" role="tabpanel" hidden>
                        <div class="mic-settings-pref-block">
                            <div class="mic-settings-toggle-row">
                                <span class="mic-settings-toggle-label" id="mic-dark-mode-label">Dark mode</span>
                                <label class="mic-toggle-switch">
                                    <input type="checkbox" id="mic-dark-mode-toggle" role="switch" aria-labelledby="mic-dark-mode-label" />
                                    <span class="mic-toggle-slider" aria-hidden="true"></span>
                                </label>
                            </div>
                            <p class="mic-settings-pref-hint">${darkHint}</p>
                        </div>
                        <div class="mic-settings-pref-block">
                            <div class="mic-settings-toggle-row">
                                <span class="mic-settings-toggle-label" id="mic-audit-auto-collapse-label">Auto-collapse audit sections</span>
                                <label class="mic-toggle-switch">
                                    <input type="checkbox" id="mic-audit-auto-collapse-toggle" role="switch" aria-labelledby="mic-audit-auto-collapse-label" checked />
                                    <span class="mic-toggle-slider" aria-hidden="true"></span>
                                </label>
                            </div>
                            <p class="mic-settings-pref-hint">When on, completed checklist sections collapse automatically in DFSC and TacoAudit audits.</p>
                        </div>
                        <div class="mic-settings-pref-block">
                            <div class="mic-settings-toggle-row">
                                <span class="mic-settings-toggle-label" id="mic-colour-blind-label">Colour blind mode</span>
                                <label class="mic-toggle-switch">
                                    <input type="checkbox" id="mic-colour-blind-toggle" role="switch" aria-labelledby="mic-colour-blind-label" />
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
                    ${
                        hasStoreTab
                            ? `<div class="mic-settings-tabpanel" data-settings-panel="store" role="tabpanel" hidden>
                        <p class="mic-settings-pref-hint">Completed audit PDFs for this store are emailed here.</p>
                        <div class="mic-settings-store-email">
                            <label class="mic-settings-field-label" for="mic-report-email-input">Report email</label>
                            <input type="email" id="mic-report-email-input" value="${escapeAttr(email)}" placeholder="store@example.com" autocomplete="email" />
                            <button type="button" class="mic-settings-btn mic-settings-btn--primary" id="mic-save-report-email-btn"${savingReportEmail ? ' disabled' : ''}>
                                ${savingReportEmail ? 'Saving…' : 'Save email'}
                            </button>
                        </div>
                    </div>`
                            : ''
                    }
                    <div class="mic-settings-tabpanel" data-settings-panel="general" role="tabpanel" hidden>
                        <div class="mic-settings-actions">
                            <button type="button" class="mic-settings-btn" data-action="changelog">What's new</button>
                            <button type="button" class="mic-settings-btn" data-action="hard-refresh">Refresh page</button>
                        </div>
                    </div>
                    <div class="mic-settings-tabpanel" data-settings-panel="admin" role="tabpanel" hidden>
                        ${adminActionsHtml}
                    </div>
                </div>
                <button type="button" class="mic-settings-close" id="mic-settings-close">Close</button>
            </div>
        </div>`;
    }

    async function loadStoreReportEmail() {
        const store = String(bindOptions.storeNumber || '').trim();
        if (!store) return;
        try {
            const res = await fetch(`/api/tacaudit/settings?store=${encodeURIComponent(store)}`, {
                credentials: 'include',
            });
            if (!res.ok) return;
            const data = await res.json().catch(() => ({}));
            const email = String(data.settings?.reportEmail || '').trim();
            bindOptions.reportEmail = email;
            const input = document.getElementById('mic-report-email-input');
            if (input) input.value = email;
        } catch {
            /* ignore */
        }
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

    function switchSettingsTab(tabId) {
        activeSettingsTab = tabId;
        const picker = document.getElementById('mic-settings-picker');
        if (!picker) return;
        picker.querySelectorAll('[data-settings-tab]').forEach((btn) => {
            const active = btn.dataset.settingsTab === tabId;
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        picker.querySelectorAll('[data-settings-panel]').forEach((panel) => {
            const active = panel.dataset.settingsPanel === tabId;
            panel.classList.toggle('is-active', active);
            panel.hidden = !active;
        });
    }

    function setStoreContext(options = {}) {
        bindOptions = { ...bindOptions, ...options };
        const input = document.getElementById('mic-report-email-input');
        if (input && options.reportEmail !== undefined) {
            input.value = String(options.reportEmail || '').trim();
        }
    }

    async function loadMicPreferences() {
        try {
            const res = await fetch('/api/me', { credentials: 'same-origin' });
            if (!res.ok) return { colorBlind: false, micDarkMode: false, auditAutoCollapse: true };
            const me = await res.json();
            const colorBlind = Boolean(me.success && me.colorBlind);
            const micDarkMode = Boolean(me.success && me.micDarkMode);
            const auditAutoCollapse = me.auditAutoCollapse !== false;
            applyColourBlindMode(colorBlind);
            applyMicDarkMode(micDarkMode);
            global.AuditPreferences?.setAutoCollapseEnabled?.(auditAutoCollapse);
            return { colorBlind, micDarkMode, auditAutoCollapse };
        } catch {
            return { colorBlind: false, micDarkMode: false, auditAutoCollapse: true };
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

    function updateAuditAutoCollapseToggle(enabled) {
        const input = document.getElementById('mic-audit-auto-collapse-toggle');
        if (!input) return;
        input.checked = enabled !== false;
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
            if (!res.ok || !data.success) throw new Error(data.error || 'Could not save preference.');
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

    async function saveAuditAutoCollapse(enabled) {
        const input = document.getElementById('mic-audit-auto-collapse-toggle');
        if (input) input.disabled = true;
        try {
            const res = await fetch('/api/account/audit-auto-collapse', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ enabled: Boolean(enabled) }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) throw new Error(data.error || 'Could not save preference.');
            global.AuditPreferences?.setAutoCollapseEnabled?.(data.auditAutoCollapse);
            updateAuditAutoCollapseToggle(data.auditAutoCollapse);
            return data.auditAutoCollapse;
        } catch (err) {
            if (input) {
                input.checked = !enabled;
                updateAuditAutoCollapseToggle(input.checked);
            }
            alert(err.message || 'Could not save audit section setting.');
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
            if (!res.ok || !data.success) throw new Error(data.error || 'Could not save preference.');
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

    async function saveReportEmail() {
        const store = String(bindOptions.storeNumber || '').trim();
        if (!store) return;
        const input = document.getElementById('mic-report-email-input');
        const btn = document.getElementById('mic-save-report-email-btn');
        const email = String(input?.value || '').trim();
        savingReportEmail = true;
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Saving…';
        }
        try {
            const res = await fetch('/api/tacaudit/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ store, reportEmail: email }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) throw new Error(data.error || 'Could not save email.');
            const saved = data.settings?.reportEmail || email;
            bindOptions.reportEmail = saved;
            if (typeof bindOptions.onReportEmailSaved === 'function') {
                bindOptions.onReportEmailSaved(saved);
            }
        } catch (err) {
            alert(err.message || 'Could not save report email.');
        } finally {
            savingReportEmail = false;
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Save email';
            }
        }
    }

    function openSettingsPanel() {
        if (settingsOpen) return;
        settingsOpen = true;
        const picker = document.getElementById('mic-settings-picker');
        if (picker) picker.hidden = false;
        switchSettingsTab(activeSettingsTab);
        const input = document.getElementById('mic-report-email-input');
        if (input && bindOptions.reportEmail !== undefined) {
            input.value = String(bindOptions.reportEmail || '').trim();
        }
        loadMicPreferences().then((prefs) => {
            updateColourBlindToggle(prefs.colorBlind);
            updateMicDarkToggle(prefs.micDarkMode);
            updateAuditAutoCollapseToggle(prefs.auditAutoCollapse);
        });
        global.AdminStoreView?.mountSettingsBlock?.();
        global.AdminStoreView?.syncSettingsUi?.();
        if (bindOptions.storeNumber) {
            void loadStoreReportEmail();
        }
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
        bindOptions = { ...bindOptions, ...options };
        if (settingsPanelBound) {
            return;
        }
        const btn = document.getElementById('mic-settings-btn');
        const picker = document.getElementById('mic-settings-picker');
        if (!btn || !picker) return;
        settingsPanelBound = true;

        btn.addEventListener('click', () => openSettingsPanel());

        picker.querySelector('#mic-settings-close')?.addEventListener('click', closeSettingsPanel);
        picker.addEventListener('click', (event) => {
            if (event.target === picker) closeSettingsPanel();
        });

        picker.querySelectorAll('[data-settings-tab]').forEach((tabBtn) => {
            tabBtn.addEventListener('click', () => {
                switchSettingsTab(tabBtn.dataset.settingsTab);
                if (tabBtn.dataset.settingsTab === 'store') {
                    void loadStoreReportEmail();
                }
            });
        });

        picker.querySelector('[data-action="change-password"]')?.addEventListener('click', () => {
            closeSettingsPanel();
            global.DashboardAccount?.openChangePasswordModal?.();
        });
        picker.querySelector('[data-action="changelog"]')?.addEventListener('click', () => {
            closeSettingsPanel();
            global.location.href = '/changelog';
        });
        picker.querySelector('[data-action="hard-refresh"]')?.addEventListener('click', () => {
            if (global.DashboardMeta?.hardRefresh) {
                void global.DashboardMeta.hardRefresh();
                return;
            }
            global.location.reload();
        });
        picker.querySelector('[data-action="logout"]')?.addEventListener('click', () => {
            global.location.href = '/logout';
        });

        picker.querySelector('#mic-save-report-email-btn')?.addEventListener('click', () => {
            void saveReportEmail();
        });

        const getViewAccountsOptions =
            typeof bindOptions.getViewAccountsOptions === 'function'
                ? bindOptions.getViewAccountsOptions
                : () => bindOptions.viewAccountsOptions || {};

        global.AdminMenu?.bindActionButtons?.(picker.querySelector('[data-settings-panel="admin"]'), {
            onBeforeAction: closeSettingsPanel,
            getViewAccountsOptions,
        });

        if (bindOptions.resolveAdminMenuVisibility !== false) {
            global.AdminMenu?.fetchProfile?.()
                .then((data) => {
                    const adminTab = document.getElementById('mic-settings-admin-tab');
                    if (adminTab && (data.canAccessAdminMenu || data.canManageStoreLogins)) {
                        adminTab.hidden = false;
                    }
                    global.AdminMenu?.applyActionVisibility?.(
                        picker.querySelector('[data-settings-panel="admin"]'),
                        data
                    );
                    global.AdminMenu?.bind?.({
                        getViewAccountsOptions,
                        resolveVisibility: false,
                    });
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
        picker.querySelector('#mic-audit-auto-collapse-toggle')?.addEventListener('change', (event) => {
            const input = event.currentTarget;
            updateAuditAutoCollapseToggle(input.checked);
            global.AuditPreferences?.setAutoCollapseEnabled?.(input.checked);
            saveAuditAutoCollapse(input.checked);
        });
    }

    function initPreferences() {
        return Promise.all([
            global.AuditPreferences?.init?.() || Promise.resolve(),
            loadMicPreferences(),
        ]).then(([, prefs]) => {
            updateColourBlindToggle(prefs.colorBlind);
            updateMicDarkToggle(prefs.micDarkMode);
            updateAuditAutoCollapseToggle(prefs.auditAutoCollapse);
            return prefs;
        });
    }

    const MIC_OVERVIEW_REF_W = 1280;
    const MIC_OVERVIEW_REF_H = 700;
    const MIC_OVERVIEW_HEADER_RESERVE = 130;

    function applyMicOverviewScale() {
        const mobile = window.matchMedia('(max-width: 900px)').matches;
        const viewW = window.visualViewport?.width ?? window.innerWidth;
        const viewH = window.visualViewport?.height ?? window.innerHeight;
        if (mobile) {
            const scale = Math.min(1.15, Math.max(0.72, viewW / MIC_OVERVIEW_REF_W));
            document.documentElement.style.setProperty('--dashboard-scale', String(scale));
            return;
        }
        const widthScale = viewW / MIC_OVERVIEW_REF_W;
        const heightScale = Math.max(280, viewH - MIC_OVERVIEW_HEADER_RESERVE) / MIC_OVERVIEW_REF_H;
        const scale = Math.min(1.15, Math.max(0.5, Math.min(widthScale, heightScale)));
        document.documentElement.style.setProperty('--dashboard-scale', String(scale));
    }

    let micOverviewScaleBound = false;
    function bindMicOverviewScale() {
        applyMicOverviewScale();
        if (micOverviewScaleBound) return;
        micOverviewScaleBound = true;
        const onResize = () => applyMicOverviewScale();
        window.addEventListener('resize', onResize);
        window.visualViewport?.addEventListener('resize', onResize);
    }

    global.MicSettings = {
        renderCog,
        renderPanel,
        bind,
        initPreferences,
        loadMicPreferences,
        setStoreContext,
    };

    global.MicOverviewScale = {
        apply: applyMicOverviewScale,
        bind: bindMicOverviewScale,
    };
})(window);
