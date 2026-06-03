const STORE_NUMBER =
    (window.location.pathname.match(/\/(\d{3,6})\/mic\/?$/i) || [])[1] || '';

const app = document.getElementById('app');
const REFRESH_MS = 2 * 60 * 1000;
const TIME_ZONE = 'Australia/Melbourne';
const MULTIPLIER_NOTHING_LABEL = 'Nothing Yet...';

let micData = null;
let pickerOpen = false;

const VOC_PLACEHOLDER = { count: 30, osatPercent: 83, accuracyPercent: 90 };
const SMG_REPORTING_URL = 'https://reporting.smg.com/Index.aspx';

function formatVocDisplay(voc = {}) {
    if (voc.placeholder) {
        return {
            count: voc.count ?? VOC_PLACEHOLDER.count,
            osat: voc.osatPercent ?? VOC_PLACEHOLDER.osatPercent,
            acc: voc.accuracyPercent ?? VOC_PLACEHOLDER.accuracyPercent,
        };
    }
    return {
        count: voc.count == null ? '—' : voc.count,
        osat: voc.osatPercent,
        acc: voc.accuracyPercent,
    };
}

function formatMoney(value) {
    const n = Number(value) || 0;
    return `$${n.toLocaleString('en-AU')}`;
}

function formatTime(date) {
    return date.toLocaleTimeString('en-AU', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: TIME_ZONE,
    });
}

function applyDashboardScale() {
    const scale = Math.min(1.15, Math.max(0.72, window.innerWidth / 1280));
    document.documentElement.style.setProperty('--dashboard-scale', String(scale));
}

function renderShell() {
    app.innerHTML = `
        <div class="mic-page" id="mic-page">
            <header class="mic-header">
                <div>
                    <h1>MIC OVERVIEW</h1>
                    <p class="subtitle" id="mic-store-label">Store ${STORE_NUMBER}</p>
                </div>
                <div class="mic-header-actions">
                    <div class="mic-clock">
                        <span class="mic-clock-label">Current time</span>
                        <span class="mic-clock-value" id="mic-clock">${formatTime(new Date())}</span>
                    </div>
                </div>
            </header>
            <div class="mic-grid" id="mic-grid"></div>
        </div>
        <button type="button" class="mic-settings-cog" id="mic-settings-btn" aria-label="Settings" title="Settings">
            <svg class="mic-settings-cog-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96c-.5-.38-1.05-.7-1.65-.94l-.36-2.54a.5.5 0 0 0-.49-.42h-3.84a.5.5 0 0 0-.49.42l-.36 2.54c-.6.24-1.15.56-1.65.94l-2.39-.96a.5.5 0 0 0-.6.22l-1.92 3.32a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.38 1.05.7 1.65.94l.36 2.54a.5.5 0 0 0 .49.42h3.84a.5.5 0 0 0 .49-.42l.36-2.54c.6-.24 1.15-.56 1.65-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"/>
            </svg>
        </button>
        <div id="mic-item-picker" class="mic-item-picker" hidden>
            <div class="mic-item-picker-panel">
                <h2>Select item for 3× points today</h2>
                <div class="mic-item-list" id="mic-item-list"></div>
            </div>
        </div>
        ${renderSettingsPanel()}
    `;
}

function renderStockCountTile(stock) {
    const sc = stock || {};
    const active = Boolean(sc.active);
    const clickable = Boolean(sc.clickable && sc.href);
    const tag = clickable ? 'a' : 'article';
    const hrefAttr = clickable ? ` href="${sc.href}"` : '';
    const classes = [
        'mic-tile',
        'mic-tile--stock-count',
        active ? 'mic-tile--stock-active' : 'mic-tile--stock-idle',
        clickable ? 'mic-tile--link' : '',
    ]
        .filter(Boolean)
        .join(' ');
    const foot = clickable
        ? 'Open stock count →'
        : active
          ? 'Orders to place today'
          : '';
    return `
        <${tag} class="${classes}"${hrefAttr}${clickable ? '' : ' aria-disabled="true"'}>
            <div class="mic-tile-body">
                <div class="mic-tile-label">Stock count</div>
                <div class="mic-tile-main">${active ? 'Orders to place' : 'All clear'}</div>
                <div class="mic-tile-sub">${sc.message || ''}</div>
            </div>
            ${foot ? `<div class="mic-tile-foot">${foot}</div>` : ''}
        </${tag}>
    `;
}

const CURRENT_PROMO = {
    label: 'Current Promo',
    name: 'Nacho Cheese Dip Burrito',
    imageUrl: '/images/promos/nacho-cheese-dip-burrito.png',
    pdfUrl: '/documents/promos/let-it-drip-frrop.pdf',
};

function renderSssgTile() {
    return `
        <article class="mic-tile mic-tile--sssg mic-tile--future">
            <div class="mic-tile-body">
                <div class="mic-tile-label">SSSG %</div>
                <div class="mic-tile-sub">Pipeline coming soon</div>
            </div>
        </article>
    `;
}

function renderPromoTile() {
    return `
        <a
            class="mic-tile mic-tile--link mic-tile--promo"
            href="${CURRENT_PROMO.pdfUrl}"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="${CURRENT_PROMO.label}: ${CURRENT_PROMO.name}. Tap to view FRROP."
        >
            <div class="mic-promo-media" aria-hidden="true">
                <img src="${CURRENT_PROMO.imageUrl}" alt="">
                <p class="mic-promo-name">${CURRENT_PROMO.name}</p>
            </div>
            <div class="mic-promo-idle">
                <span class="mic-tile-label">${CURRENT_PROMO.label}</span>
                <span class="mic-tile-foot mic-promo-foot">tap to view FRROP</span>
            </div>
        </a>
    `;
}

function renderSettingsPanel() {
    return `
        <div id="mic-settings-picker" class="mic-item-picker" hidden>
            <div class="mic-item-picker-panel mic-settings-panel">
                <h2>Settings</h2>
                <div class="mic-settings-actions">
                    <button type="button" class="mic-settings-btn" data-action="change-password">Change password</button>
                    <button type="button" class="mic-settings-btn" data-action="view-accounts" id="mic-view-accounts-btn" hidden>View accounts</button>
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
                        <p class="mic-settings-pref-hint">Dark background and tiles on this MIC page.</p>
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
        </div>
    `;
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

function renderSalesTile(sales) {
    const prog = sales?.progress || {
        phase: 'empty',
        timeFillPercent: 0,
        outcomeClass: 'cell-green',
        paceClass: 'cell-green',
    };
    const sp = window.SalesProgress;
    const borderColor =
        sp?.paceBorderMap?.[prog.outcomeClass] || 'var(--blank-border)';
    const showLive = prog.phase === 'during' || prog.phase === 'after';
    const fillPct = prog.phase === 'after' ? 100 : Number(prog.timeFillPercent) || 0;
    const layers =
        showLive && sp?.buildLiveProgressLayersHtml
            ? sp.buildLiveProgressLayersHtml(fillPct, prog.outcomeClass, prog.paceClass)
            : '';
    const liveClass = showLive ? ' mic-tile--sales-live' : '';
    const amounts =
        sales?.hours > 0
            ? `${formatMoney(sales.actual)} / ${formatMoney(sales.forecast)}`
            : 'Waiting for sales data';

    return `
        <a class="mic-tile mic-tile--link${liveClass}" href="/${STORE_NUMBER}" style="border: var(--cell-border) ${borderColor};">
            ${layers}
            <div class="mic-tile-sales-content">
                <div class="mic-tile-body">
                    <div class="mic-tile-label">Actual vs Forecast</div>
                    <div class="mic-tile-main mic-tile-main--sales">${amounts}</div>
                </div>
                <div class="mic-tile-foot">Go to dashboard →</div>
            </div>
        </a>
    `;
}

function renderTiles(data) {
    const grid = document.getElementById('mic-grid');
    if (!grid) return;
    const sales = data?.salesToday || { actual: 0, forecast: 0 };
    const voc = formatVocDisplay(data?.voc || {});
    const rules = data?.dailyItemMultipliers || (data?.dailyItemMultiplier ? [data.dailyItemMultiplier] : []);

    grid.innerHTML = `
        ${renderSalesTile(sales)}

        <a
            class="mic-tile mic-tile--link mic-tile--voc"
            href="${SMG_REPORTING_URL}"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="VOC — open SMG reporting"
        >
            <div class="mic-tile-body">
                <div class="mic-tile-label">VOC</div>
                <div class="mic-voc-grid">
                    <div class="mic-voc-count">${voc.count}</div>
                    <div class="mic-voc-metrics">
                        <div class="mic-voc-metric">OSAT ${voc.osat == null ? '—' : `${voc.osat}%`}</div>
                        <div class="mic-voc-metric">Acc ${voc.acc == null ? '—' : `${voc.acc}%`}</div>
                    </div>
                </div>
                <div class="mic-tile-sub">Pipeline coming soon</div>
            </div>
        </a>

        ${renderSssgTile()}

        <article class="mic-tile mic-tile--multiplier" id="mic-multiplier-tile">
            <div class="mic-tile-body">
                <div class="mic-tile-label">Daily item multipliers</div>
                ${
                    rules.length
                        ? rules
                              .map((rule) => {
                                  const pts =
                                      (Number(rule.basePoints) || 0) * (Number(rule.multiplier) || 3);
                                  return `<div class="mic-tile-sub"><strong>${rule.itemLabel}</strong> — ${rule.multiplier}× (${pts} pts)</div>`;
                              })
                              .join('')
                        : `<div class="mic-tile-main">${micData?.multiplierNothingLabel || MULTIPLIER_NOTHING_LABEL}</div>
                           <div class="mic-tile-sub">No item selected for 3× points today</div>`
                }
            </div>
            <div class="mic-tile-foot">${rules.length ? 'Tap to change' : 'Tap to choose'}</div>
        </article>

        ${renderPromoTile()}

        ${renderStockCountTile(data?.stockCount)}
    `;

    const multiplierTile = document.getElementById('mic-multiplier-tile');
    if (multiplierTile) {
        multiplierTile.style.cursor = 'pointer';
        multiplierTile.addEventListener('click', openItemPicker);
    }
}

function openItemPicker() {
    if (pickerOpen) return;
    pickerOpen = true;
    const picker = document.getElementById('mic-item-picker');
    const list = document.getElementById('mic-item-list');
    if (!picker || !list) return;
    const items = micData?.items || [];
    const nothingOption = `
        <button type="button" class="mic-item-option mic-item-option--none" data-clear="true">
            Nothing
            <span class="mic-item-option-points">No multiplier today</span>
        </button>
    `;
    list.innerHTML = items.length
        ? `${nothingOption}${items
              .map(
                  (item) => `
            <button type="button" class="mic-item-option" data-item="${encodeURIComponent(item.label)}">
                ${item.label}
                <span class="mic-item-option-points">${item.basePoints} pts normally</span>
            </button>
        `
              )
              .join('')}`
        : `${nothingOption}<p class="mic-tile-sub">No upsell items configured in .points yet.</p>`;
    picker.hidden = false;
    list.querySelectorAll('.mic-item-option').forEach((button) => {
        button.addEventListener('click', async () => {
            if (button.dataset.clear === 'true') {
                await clearDailyMultiplier();
            } else {
                const itemLabel = decodeURIComponent(button.dataset.item || '');
                await setDailyMultiplier(itemLabel);
            }
            closeItemPicker();
        });
    });
}

function closeItemPicker() {
    const picker = document.getElementById('mic-item-picker');
    if (!picker) return;
    picker.classList.add('is-closing');
    window.setTimeout(() => {
        picker.hidden = true;
        picker.classList.remove('is-closing');
        pickerOpen = false;
    }, 350);
}

let settingsOpen = false;
let settingsPanelBound = false;

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

function bindSettingsPanel() {
    if (settingsPanelBound) return;
    const page = document.getElementById('mic-page');
    const btn = document.getElementById('mic-settings-btn');
    const picker = document.getElementById('mic-settings-picker');
    if (!page || !btn || !picker) return;
    settingsPanelBound = true;

    btn.addEventListener('click', () => openSettingsPanel());

    picker.querySelector('#mic-settings-close')?.addEventListener('click', closeSettingsPanel);
    picker.addEventListener('click', (event) => {
        if (event.target === picker) closeSettingsPanel();
    });
    picker.querySelector('[data-action="change-password"]')?.addEventListener('click', () => {
        closeSettingsPanel();
        window.DashboardAccount?.openChangePasswordModal?.();
    });
    picker.querySelector('[data-action="view-accounts"]')?.addEventListener('click', () => {
        closeSettingsPanel();
        window.DashboardAccount?.openViewAccountsModal?.({ storeNumber: STORE_NUMBER });
    });
    window.DashboardAccount?.fetchProfile?.()
        .then((data) => {
            const btn = document.getElementById('mic-view-accounts-btn');
            if (btn && data.canViewManagedAccounts) btn.hidden = false;
        })
        .catch(() => {});
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
    loadMicPreferences().then((prefs) => {
        updateColourBlindToggle(prefs.colorBlind);
        updateMicDarkToggle(prefs.micDarkMode);
    });
}

async function setDailyMultiplier(itemLabel) {
    const res = await fetch('/api/mic/daily-item-multiplier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ store: STORE_NUMBER, itemLabel }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not set multiplier.');
    }
    await loadMicData();
}

async function clearDailyMultiplier() {
    const res = await fetch('/api/mic/daily-item-multiplier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ store: STORE_NUMBER, clear: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not clear multiplier.');
    }
    await loadMicData();
}

async function loadMicData() {
    const res = await fetch(`/api/mic?store=${encodeURIComponent(STORE_NUMBER)}`, {
        credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
        app.textContent = data.error || 'Could not load MIC overview.';
        return;
    }
    micData = data;
    const label = document.getElementById('mic-store-label');
    if (label) label.textContent = `Store ${STORE_NUMBER}`;
    renderTiles(data);
}

function init() {
    if (!STORE_NUMBER) {
        app.textContent = 'Invalid store.';
        return;
    }
    applyDashboardScale();
    renderShell();
    bindSettingsPanel();
    loadMicPreferences().then((prefs) => {
        updateColourBlindToggle(prefs.colorBlind);
        updateMicDarkToggle(prefs.micDarkMode);
    });
    loadMicData();
    window.setInterval(() => {
        const clock = document.getElementById('mic-clock');
        if (clock) clock.textContent = formatTime(new Date());
    }, 1000);
    window.setInterval(loadMicData, REFRESH_MS);
    window.addEventListener('resize', applyDashboardScale);
}

init();
