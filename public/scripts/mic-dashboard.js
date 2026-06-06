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
        ${window.MicSettings?.renderCog?.() || ''}
        <div id="mic-item-picker" class="mic-item-picker" hidden>
            <div class="mic-item-picker-panel">
                <h2>Select item for 3× points today</h2>
                <div class="mic-item-list" id="mic-item-list"></div>
            </div>
        </div>
        ${window.MicSettings?.renderPanel?.({
            darkModeHint: 'Dark background and tiles on this MIC page.',
        }) || ''}
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
    imageUrl: '/images/promos/let-it-drip-banner.png',
    pdfUrl: '/documents/promos/let-it-drip-frrop.pdf',
};

function renderSssgTile(sales = {}) {
    const sssg = sales.sssgPercent;
    const hasValue = sssg != null && Number.isFinite(Number(sssg));
    const futureClass = hasValue ? '' : ' mic-tile--future';
    return `
        <article class="mic-tile mic-tile--sssg${futureClass}">
            <div class="mic-tile-body">
                <div class="mic-tile-label">SSSG %</div>
                <div class="mic-sssg-value">${hasValue ? `${sssg}%` : '—'}</div>
                <div class="mic-tile-sub">${hasValue ? 'Same store sales growth' : 'Pipeline coming soon'}</div>
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

        ${renderSssgTile(sales)}

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
    window.MicSettings?.bind?.({
        getViewAccountsOptions: () => ({ storeNumber: STORE_NUMBER }),
    });
    window.MicSettings?.initPreferences?.();
    loadMicData();
    window.setInterval(() => {
        const clock = document.getElementById('mic-clock');
        if (clock) clock.textContent = formatTime(new Date());
    }, 1000);
    window.setInterval(loadMicData, REFRESH_MS);
    window.addEventListener('resize', applyDashboardScale);
}

init();
