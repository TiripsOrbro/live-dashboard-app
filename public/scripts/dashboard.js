/* -----------------------------------------------------------
   Root element — dashboard mounts here (`#app`)
----------------------------------------------------------- */
const app = document.getElementById('app');

const SALES_API_URL =
    typeof window !== 'undefined' && window.__DASHBOARD_SALES_API__
        ? window.__DASHBOARD_SALES_API__
        : `${window.location.origin}/api/sales`;
const AUDITS_API_URL = `${window.location.origin}/api/audits`;
const AUDIT_SCHEDULE_URL = `${window.location.origin}/api/audit-schedule`;
const SALES_REFRESH_MINUTES = 2;
const DASHBOARD_TIME_ZONE = 'Australia/Melbourne';

/** DEBUG: when set to `YYYY-MM-DD`, order rules + audit schedule use that Melbourne date; “Apply” runs test scheduled-orders scrape (see server `canRunScheduledOrdersDateTest`). */
let orderDateTestYmd = null;

/* -----------------------------------------------------------
   Grid columns — one label per trading hour (10AM–9PM) uncomment for 10PM
----------------------------------------------------------- */
const times = [
    '10AM', '11AM', '12PM', '1PM', '2PM', '3PM',
    '4PM', '5PM', '6PM', '7PM', '8PM', '9PM', //'10PM'
];

const TRADING_GRID_START_HOUR = 10;

function tradingEndHourExclusive() {
    return TRADING_GRID_START_HOUR + times.length;
}


/* -----------------------------------------------------------
   Sales data in memory — forecast and actual (filled by API)
----------------------------------------------------------- */
let forecastSales = [];
let liveSales = [];
/** Display labels for vendors with scheduled orders still in Create / In Progress (no order #). */
let pendingVendors = [];
/** Labels the user has marked done this session (hidden until Macromatix drops them from the API list). */
const dismissedPendingVendors = new Set();

/**
 * Vendors that may appear in Macromatix early — we only surface them on the last Melbourne Monday of the month.
 * Match is case-insensitive with spaces removed (e.g. "Eco Lab", "ECOLAB").
 */
function matchesLastMondayOnlyVendor(label) {
    const collapsed = String(label).replace(/\s+/g, '').toLowerCase();
    return ['ecolab', 'reward', 'franke', 'staples'].includes(collapsed);
}

function getVisiblePendingVendors() {
    const lastMondayMonth = isMelbourneLastMondayOfMonth();
    return pendingVendors.filter((v) => {
        if (dismissedPendingVendors.has(v)) return false;
        if (!lastMondayMonth && matchesLastMondayOnlyVendor(v)) return false;
        return true;
    });
}

/* -----------------------------------------------------------
   Audits list — dismissal period + Square One pair from server schedule (see data/audit-recurrence.json)
----------------------------------------------------------- */
const AUDIT_FALLBACK_ITEMS = [
    'Pest Walk',
    'RGM Cleaning Checklist',
    'Period Safety Inspection',
    'Dining Room',
    'Restrooms',
];

let cachedAuditSchedule = null;
let auditPeriodKey = null;
const dismissedAudits = new Set();
let auditStateLoaded = false;

function dashboardDateParts(d = new Date()) {
    const parts = new Intl.DateTimeFormat('en-AU', {
        timeZone: DASHBOARD_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(d);
    const get = (type) => Number(parts.find((part) => part.type === type)?.value);
    return { year: get('year'), month: get('month'), day: get('day') };
}

function isMelbourneMonday(d) {
    const ref = d === undefined ? getDashboardEffectiveInstant() : d;
    const w = new Intl.DateTimeFormat('en-AU', {
        timeZone: DASHBOARD_TIME_ZONE,
        weekday: 'long',
    }).format(ref);
    return w === 'Monday';
}

function gregorianDaysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
}

/** First `Date` whose Melbourne civil date is `year`-`month`-`day`. */
function findInstantForMelbourneYmd(year, month, day) {
    const start = Date.UTC(year, month - 1, day - 1, 0, 0, 0);
    const spanMs = 120 * 60 * 60 * 1000;
    const step = 15 * 60 * 1000;
    for (let ms = 0; ms < spanMs; ms += step) {
        const t = new Date(start + ms);
        const p = dashboardDateParts(t);
        if (p.year === year && p.month === month && p.day === day) return t;
    }
    return null;
}

/** Melbourne instant for civil date used by Monday / last-Monday order rules (DEBUG date picker or live today). */
function getDashboardEffectiveInstant() {
    if (!orderDateTestYmd || !/^\d{4}-\d{2}-\d{2}$/.test(orderDateTestYmd)) {
        return new Date();
    }
    const [y, m, d] = orderDateTestYmd.split('-').map(Number);
    return findInstantForMelbourneYmd(y, m, d) || new Date();
}

function melbourneWeekdayLong(d) {
    return new Intl.DateTimeFormat('en-AU', {
        timeZone: DASHBOARD_TIME_ZONE,
        weekday: 'long',
    }).format(d);
}

/** Calendar day-of-month (1–31) of the last Monday in this Melbourne calendar month. */
function melbourneLastMondayCalendarDay(year, month) {
    const dim = gregorianDaysInMonth(year, month);
    const tLast = findInstantForMelbourneYmd(year, month, dim);
    if (!tLast) return null;
    const w = melbourneWeekdayLong(tLast);
    const iso = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7 }[w];
    if (!iso) return null;
    return dim - ((iso - 1 + 7) % 7);
}

/** True when `d` is the last Monday of the month in `DASHBOARD_TIME_ZONE` (always a Monday). */
function isMelbourneLastMondayOfMonth(d) {
    const ref = d === undefined ? getDashboardEffectiveInstant() : d;
    if (!isMelbourneMonday(ref)) return false;
    const { year, month, day } = dashboardDateParts(ref);
    const lastMon = melbourneLastMondayCalendarDay(year, month);
    if (lastMon == null) return false;
    return day === lastMon;
}

/** Fixed label for Mondays — not returned by Macromatix `pendingVendors`. */
function mondayCashOrderReminderHtml() {
    return `<div class="pending-vendor-item pending-vendor-item--info" role="status">
        <div class="pending-vendor-monday-note">${escapeHtml('Cash Order')}</div>
    </div>`;
}

/** Last Monday of the month — one row per vendor (not from Macromatix list on other days). */
function lastMondayMonthlyOrdersReminderHtml() {
    const labels = ['Eco Lab', 'Reward', 'Franke', 'Staples'];
    return labels
        .map(
            (label) =>
                `<div class="pending-vendor-item pending-vendor-item--info" role="status"><div class="pending-vendor-monday-note">${escapeHtml(
                    label
                )}</div></div>`
        )
        .join('');
}

/** Fallback only if /api/audit-schedule fails (matches old Monday-week key in Melbourne). */
function clientMelbourneMondayWeekKey(d) {
    const ref = d === undefined ? getDashboardEffectiveInstant() : d;
    const { year, month, day: date } = dashboardDateParts(ref);
    const x = new Date(year, month - 1, date);
    const day = (x.getDay() + 6) % 7;
    x.setDate(x.getDate() - day);
    x.setHours(0, 0, 0, 0);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

function getAuditListItems() {
    if (cachedAuditSchedule && Array.isArray(cachedAuditSchedule.auditListItems)) {
        return cachedAuditSchedule.auditListItems;
    }
    return AUDIT_FALLBACK_ITEMS;
}

function syncAuditPeriodState() {
    const k = cachedAuditSchedule ? cachedAuditSchedule.periodKey : clientMelbourneMondayWeekKey();
    if (auditPeriodKey !== k) {
        dismissedAudits.clear();
        auditPeriodKey = k;
        auditStateLoaded = false;
    }
}

/** True after at least one successful `/api/audit-schedule` response (used for error copy only). */
let auditScheduleFetchedOkOnce = false;

function updateAuditScheduleBanner(show, message) {
    const el = document.getElementById('audit-schedule-status');
    if (!el) return;
    if (!show) {
        el.hidden = true;
        el.textContent = '';
        return;
    }
    el.hidden = false;
    el.textContent = message;
}

async function loadAuditSchedule() {
    try {
        let url = AUDIT_SCHEDULE_URL;
        if (orderDateTestYmd && /^\d{4}-\d{2}-\d{2}$/.test(orderDateTestYmd)) {
            const sep = url.includes('?') ? '&' : '?';
            url = `${url}${sep}asOfDate=${encodeURIComponent(orderDateTestYmd)}`;
        }
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error(`Audit schedule responded with ${res.status}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Audit schedule returned unsuccessful response');
        cachedAuditSchedule = data;
        auditScheduleFetchedOkOnce = true;
        updateAuditScheduleBanner(false, '');
    } catch (err) {
        console.warn('Failed to load audit schedule:', err);
        if (!cachedAuditSchedule) {
            const k = clientMelbourneMondayWeekKey();
            cachedAuditSchedule = {
                periodKey: k,
                weekKey: k,
                auditListItems: [...AUDIT_FALLBACK_ITEMS],
                squareSlot: 0,
                timeZone: DASHBOARD_TIME_ZONE,
            };
        }
        const msg = auditScheduleFetchedOkOnce
            ? 'Could not refresh the audit checklist schedule from the server. The checklist still reflects the last successful load.'
            : 'Could not load the audit checklist schedule from the server. Using an offline fallback (Melbourne Monday week) until it is available.';
        updateAuditScheduleBanner(true, msg);
    }
    syncAuditPeriodState();
}

function getVisibleAudits() {
    return getAuditListItems().filter((label) => !dismissedAudits.has(label));
}

function applyAuditDismissals(labels) {
    const validLabels = new Set(getAuditListItems());
    dismissedAudits.clear();
    if (Array.isArray(labels)) {
        for (const label of labels) {
            if (validLabels.has(label)) dismissedAudits.add(label);
        }
    }
}

async function loadAuditState() {
    await loadAuditSchedule();
    syncAuditPeriodState();
    try {
        const res = await fetch(AUDITS_API_URL);
        if (!res.ok) throw new Error(`Audit API responded with ${res.status}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Audit API returned unsuccessful response');
        const serverKey = data.periodKey || data.weekKey;
        if (serverKey === auditPeriodKey) {
            applyAuditDismissals(data.dismissed);
        }
        auditStateLoaded = true;
        if (document.querySelector('.dashboard-grid')) updateGrid();
    } catch (err) {
        console.warn('Failed to load audit state:', err);
        auditStateLoaded = true;
    }
}

async function saveAuditState() {
    syncAuditPeriodState();
    try {
        const res = await fetch(AUDITS_API_URL, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dismissed: [...dismissedAudits] }),
        });
        if (!res.ok) throw new Error(`Audit API responded with ${res.status}`);
    } catch (err) {
        console.warn('Failed to save audit state:', err);
    }
}

/* -----------------------------------------------------------
   Sales API — fetch JSON from API, trim hours, refresh grid & timestamp
----------------------------------------------------------- */
function applySalesPayload(data) {
    forecastSales = Array.isArray(data.forecast) ? data.forecast.slice(5, -4) : [];
    liveSales = Array.isArray(data.actual) ? data.actual.slice(5, -4) : [];
    pendingVendors = Array.isArray(data.pendingVendors) ? data.pendingVendors : [];
    for (const d of [...dismissedPendingVendors]) {
        if (!pendingVendors.includes(d)) dismissedPendingVendors.delete(d);
    }
}

function orderDateTestSetHint(text, hidden = false) {
    const el = document.getElementById('order-date-test-hint');
    if (!el) return;
    el.textContent = text || '';
    el.hidden = hidden || !text;
}

async function loadSalesDataForOrderDateTest() {
    if (!orderDateTestYmd) return;
    orderDateTestSetHint('Scraping Macromatix for that scheduled-orders date… (can take up to a couple of minutes)', false);
    try {
        const sep = SALES_API_URL.includes('?') ? '&' : '?';
        const res = await fetch(`${SALES_API_URL}${sep}testScheduledOrdersDate=${encodeURIComponent(orderDateTestYmd)}`, {
            credentials: 'include',
        });
        if (!res.ok) {
            throw new Error(`API responded with ${res.status}`);
        }
        const data = await res.json();
        if (!data.success) {
            throw new Error(data.error || 'API returned unsuccessful response');
        }
        applySalesPayload(data);
        if (data.testScheduledOrdersDate !== orderDateTestYmd) {
            orderDateTestSetHint(
                'Test scrape was not run (unlock this dashboard in the browser, or set DASHBOARD_ENABLE_ORDER_DATE_TEST=1 on the server). Showing cached sales.',
                false
            );
        } else {
            orderDateTestSetHint(
                `DEBUG: rules use Melbourne date ${orderDateTestYmd}. Sales auto-refresh is paused until you click “Live date”.`,
                false
            );
        }
        await loadAuditSchedule();
        updateGrid();
        updateTimestamp(data.timestamp);
        updateSalesStatus(data);
    } catch (err) {
        console.error('Failed to load sales data (order date test):', err);
        orderDateTestSetHint(String(err && err.message ? err.message : err), false);
        updateSalesStatus({ stale: true, warning: 'Order date test scrape failed.' });
    }
}

async function loadSalesData() {
    if (orderDateTestYmd) {
        return;
    }
    try {
        const res = await fetch(SALES_API_URL, { credentials: 'include' });
        if (!res.ok) {
            throw new Error(`API responded with ${res.status}`);
        }

        const data = await res.json();
        if (!data.success) {
            throw new Error(data.error || 'API returned unsuccessful response');
        }

        // Remove early hours (store closed) and keep only 10AM–9PM, can -4 to -5 for a 10PM store
        applySalesPayload(data);

        await loadAuditSchedule();
        updateGrid();
        updateTimestamp(data.timestamp);
        updateSalesStatus(data);

    } catch (err) {
        console.error('Failed to load sales data:', err);
        updateSalesStatus({ stale: true, warning: 'Unable to refresh sales data. If issue persists, contact Ash.' });
        const grid = document.querySelector('.dashboard-grid');
        if (grid && !liveSales.length) {
            grid.innerHTML = '<div class="grid-error">Unable to load sales data. Let Ash know so he can sort something, it cannot be fixed if he is at work.</div>';
            pendingVendors = [];
            dismissedPendingVendors.clear();
            dismissedAudits.clear();
            auditPeriodKey = null;
            updatePendingVendorsPanel();
        }
    }
}

/* -----------------------------------------------------------
   Header clock — updates `#time-display` every second
----------------------------------------------------------- */
function formatTime(dateObj) {
    return dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: DASHBOARD_TIME_ZONE });
}

function updateClock() {
    const timeDisplay = document.getElementById('time-display');
    if (timeDisplay) {
        timeDisplay.textContent = formatTime(new Date());
    }
}

/* -----------------------------------------------------------
   Header "Last updated" — formats API `timestamp` for `#last-updated`
----------------------------------------------------------- */
function updateTimestamp(ts) {
    const el = document.getElementById('last-updated');
    if (el) {
        const date = new Date(ts);
        el.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: DASHBOARD_TIME_ZONE });
    }
}

function updateSalesStatus(data = {}) {
    const el = document.getElementById('sales-status');
    if (!el) return;

    if (data.stale || data.warning) {
        const age = Number(data.staleAgeSeconds);
        const ageText = Number.isFinite(age) && age > 0 ? ` (${Math.round(age / 60)} min old)` : '';
        el.textContent = `${data.warning || 'Showing cached sales data.'}${ageText}`;
        el.hidden = false;
        return;
    }

    el.textContent = '';
    el.hidden = true;
}

/* -----------------------------------------------------------
   Notification defaults — animation length, easing, sound URL & volume
----------------------------------------------------------- */
window.POPUP_CONFIG = window.POPUP_CONFIG || {
    transitionDuration: 350,
    easing: 'cubic-bezier(0.22,1,0.36,1)',
    soundUrl: '/assets/sounds/8_bit.mp3',
    soundVolume: 0.9,
    // Adjust this to make notification cards taller/shorter.
    cardMinHeight: 160,
};

/* -----------------------------------------------------------
   Notification icons — task type label → sprite image path
----------------------------------------------------------- */
window.iconMap = window.iconMap || {
    "Clean": "/assets/Sprites/Clean.png",
    "Close": "/assets/Sprites/Close.png",
    "Front Counter": "/assets/Sprites/Front%20Counter.png",
    "Fry": "/assets/Sprites/Fry2.png",
    "Toilets": "/assets/Sprites/Toilets.png",
};
const iconMap = window.iconMap;
const POPUP_CONFIG = window.POPUP_CONFIG;

if (typeof POPUP_CONFIG.cardMinHeight === 'number') {
    document.documentElement.style.setProperty('--popup-card-min-height', `${POPUP_CONFIG.cardMinHeight}px`);
}

/* -----------------------------------------------------------
   Notification sound — preload file, play, Web Audio beep fallback
----------------------------------------------------------- */
let _popupAudio = null;
function preloadPopupAudio() {
    try {
        if (POPUP_CONFIG.soundUrl) {
            _popupAudio = new Audio(POPUP_CONFIG.soundUrl);
            _popupAudio.volume = POPUP_CONFIG.soundVolume ?? 1.0;
            _popupAudio.preload = 'auto';
            _popupAudio.load();
        }
    } catch (e) {
        _popupAudio = null;
    }
}
preloadPopupAudio();

function playNotificationSound() {
    try {
        if (_popupAudio) {
            _popupAudio.pause();
            _popupAudio.currentTime = 0;
            _popupAudio.volume = POPUP_CONFIG.soundVolume ?? 1.0;
            _popupAudio.play().catch(() => generateBeep());
            return;
        }
    } catch (e) {}
    generateBeep();
}

function generateBeep({duration = 140, frequency = 880, volume = 0.06} = {}) {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = frequency;
        g.gain.value = volume;
        o.connect(g);
        g.connect(ctx.destination);
        o.start();
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration / 1000);
        setTimeout(() => { try { o.stop(); ctx.close(); } catch (e) {} }, duration + 20);
    } catch (e) {}
}

/* -----------------------------------------------------------
   Single notification — one message, top progress bar (drains R→L)
----------------------------------------------------------- */
function showPopup(message, duration = 10000, type = null, options = {}) {
    const container = document.getElementById('popup-container');
    if (!container) return;

    const popup = document.createElement('div');
    popup.className = 'popup';

    const progressEl = document.createElement('div');
    progressEl.className = 'popup-progress';
    /* scaleX 1→0 with origin left: fill shrinks from the right (empties R→L) */
    progressEl.style.transformOrigin = 'left center';

    const inner = document.createElement('div');
    inner.className = 'popup-inner';

    const iconWrapper = document.createElement('div');
    iconWrapper.className = 'popup-icon';
    if (type && iconMap[type]) {
        const img = document.createElement('img');
        img.src = iconMap[type];
        img.alt = type;
        iconWrapper.appendChild(img);
    } else {
        iconWrapper.style.visibility = 'hidden';
    }

    const messageEl = document.createElement('div');
    messageEl.className = 'popup-message';
    messageEl.textContent = message || '';
    if (options.wrapMessage) messageEl.classList.add('wrap');

    popup.appendChild(progressEl);
    inner.appendChild(iconWrapper);
    inner.appendChild(messageEl);
    popup.appendChild(inner);
    container.appendChild(popup);

    // show
    requestAnimationFrame(() => popup.classList.add('popup-show'));
    try { playNotificationSound(); } catch (e) {}

    // animate top progress (empties toward the left)
    progressEl.style.animation = 'none';
    void progressEl.offsetWidth;
    progressEl.style.animation = `drain ${duration}ms linear forwards`;

    const dismissPopup = () => {
        if (!popup.isConnected) return;
        popup.classList.remove('popup-show');
        popup.classList.add('popup-hide');
        setTimeout(() => popup.remove(), POPUP_CONFIG.transitionDuration + 50);
    };

    // dismiss by tap/click
    popup.addEventListener('pointerdown', dismissPopup);

    // remove after duration + transition
    setTimeout(dismissPopup, duration);
}

/* -----------------------------------------------------------
   Two independent cards — same shell as single popup, no shared wrapper
   Config shape: { title, instruction, message, type, duration, options }
----------------------------------------------------------- */
function makeMultiPopupCard(cfg, cellDuration, iconSide) {
    const card = document.createElement('div');
    card.className = `popup popup-multi popup-multi-icon-${iconSide}`;

    const titleBox = document.createElement('div');
    titleBox.className = 'popup-title-box';

    const titleProgress = document.createElement('div');
    titleProgress.className = 'popup-title-progress';
    titleProgress.style.transformOrigin = 'left center';
    titleBox.appendChild(titleProgress);

    const title = document.createElement('div');
    title.className = 'popup-title';
    title.textContent = cfg.title || (cfg.type ? cfg.type : 'Notification');
    titleBox.appendChild(title);

    const progress = document.createElement('div');
    progress.className = 'popup-progress';
    progress.style.transformOrigin = 'left center';
    card.appendChild(progress);
    card.appendChild(titleBox);

    if (cfg.type && iconMap && iconMap[cfg.type]) {
        const iconSmall = document.createElement('div');
        iconSmall.className = 'popup-cell-icon';
        const img = document.createElement('img');
        img.src = iconMap[cfg.type];
        img.alt = cfg.type;
        iconSmall.appendChild(img);
        card.appendChild(iconSmall);
    }

    const instruction = document.createElement('div');
    instruction.className = 'popup-instruction';
    instruction.textContent = cfg.instruction || cfg.message || '';

    card.appendChild(instruction);

    requestAnimationFrame(() => {
        progress.style.animation = `drain ${cellDuration}ms linear forwards`;
        titleProgress.style.animation = `drain ${cellDuration}ms linear forwards`;
    });

    return card;
}

/* ============================================================
   NOTIFICATIONS — edit this object only (no coding knowledge needed)

   Each entry needs:
   • A short key on the left (e.g. fryCheck) — you use that key in the schedule below.
   • name        — big heading on the card
   • instruction — smaller text under it
   • icon        — must match a name from the icon list under window.iconMap above
                   (e.g. "Fry", "Close", "Clean", "Front Counter", "Toilets")

   Optional: duration — how long the card stays (milliseconds), default 15000 (15 sec)
            seconds  — alternative: seconds (e.g. seconds: 20)
   ============================================================ */
const NOTIFICATIONS = {

    //BOILOUTS (see processBoiloutSchedule). */
    boiloutOilDump: { name: 'Dump the oil (boilout prep)', instruction: 'Dump the oil tonightfor boilout, tomorrow is the scheduled boilout.', icon: 'Fry', seconds: 600 },
    boiloutComplete: { name: 'Complete a boilout', instruction: 'Complete the scheduled fryer boilout for this period.', icon: 'Fry', seconds: 3400 },

    // "Before 9:30PM"

    cleanToilets: {name: 'Clean and stock Toilets',instruction: 'Clean and stock Toilets', icon: 'Toilets', seconds: 600},
    diningBins: {name: 'Dining room bins',instruction: 'Empty, clean and reline dining room bins', icon: 'Clean', seconds: 600},
    patioBins: {name: 'Patio bins',instruction: 'Empty, clean and reline patio bins', icon: 'Clean', seconds: 600},
    removeBins: {name: 'Remove and clean bins',instruction: 'Remove and clean inside and outside of bins, then allow them to air dry. Leave 1 bin for the line and one 1 for washup, bins should be relined once they are dry', icon: 'Clean', seconds: 600},
    smallVats: {name: 'Begin shutting down 2 small fry vats',instruction: 'Complete a full daily filter on all 3 vats and shut fown the 2 smaller vats, leaving the largest vat running. make sure a full scrub vat, wash, rinse and full polish is completed before moving on to the next vat. While waiting for the vats to filter, use degreaser to clean the front of the fryer', icon: 'Fry', seconds: 600},
    hotLine: {name: 'Clean Hot Line (KEEPING PRODUCTS HOT!!!)',instruction: 'Clean the hot line well by well by shifting the pans back on row and then replacing them once complete, pans should NEVER be left on the bench!!!', icon: 'Clean', seconds: 600},
    filterPan: {name: 'Last fry filter',instruction: 'Ensure there are enough chips to make orders for 5 minutes before completing an express filter on the large vat, once that is complete, allow filter pan to cool before carefully removing the filter pan and taking it to washup to be cleaned and left to dry', icon: 'Fry', seconds: 600},
    removeExtras: {name: 'Remove any EXTRAs from line',instruction: 'Nothing that impacts speed should be removed, only holders for cantina bowls, dipping cups and lids, wrappers, chip bag holders, scale insert, underline fridge and containers', icon: 'Clean', seconds: 600},   
    DTBench: {name: 'Clean DT bench',instruction: 'Remove tray and items from bench to clean underneath them and then put back, if tray is dirty consider replacing it with a new clean one and leaving the old one at washup', icon: 'Clean', seconds: 600},  
    prepBench: {name: 'Clean Prep Bench',instruction: 'Unplug and move the rice cooker to clean under it, check if the seasoning, sugar and rice tub are clean, if not clean them and leave to air dry', icon: 'Clean', seconds: 600},
    fryBench: {name: 'Clean Fry Bench',instruction: "Use degreaser to clean the fry bench, don't neglect the rails that hold the baskets or the shelf that holds nacho chips", icon: 'Fry', seconds: 600},   
    cleanFloors: {name: 'Begin cleaning floors',instruction: 'Clean all floors except in use line, make sure to clean under shelves, benches, equipement (Drink machines, Fryer, Retherm) and the line', icon: 'Clean', seconds: 600},
    drains: {name: 'Clean drains',instruction: 'Remove drains from wherever you have mopped, remove any buildup from underneath the catchers', icon: 'Clean', seconds: 600},   
    setupCarryover: {name: 'Setup Carryover Sink',instruction: 'Sink should be filled 3/4 of the way with just ice, water will be added to it later in the night', icon: 'Clean', seconds: 600},
    cleanRetherm: {name: 'Clean Retherm',instruction: 'Drain and clean inside the retherm following the standard card, once the inside has been cleaned, close the lids and valves and clean the outside of the retherm', icon: 'Clean', seconds: 600},
    
        //MIC ONLY

    removeStickers: {name: 'MIC - Remove Stickers',instruction: 'Remove Stickers of anything that is going to before open tomorrow, typically stickers that have hold times of 24 hours or less', icon: 'Close', seconds: 600},
    wipePrepGuide: {name: 'MIC - Wipe off Prep Guide',instruction: 'Use Grafitti cleaner to remove sharpie, then use either degreaser, glass cleaner or hand sanitizer to remove residue', icon: 'Close', seconds: 600},
    wipeTREDPoster: {name: 'MIC - Wipe off TRED Poster',instruction: 'Use Grafitti cleaner to remove sharpie, then use either degreaser, glass cleaner or hand sanitizer to remove residue', icon: 'Close', seconds: 600},

    // "After 9:30PM"

    mopDining: {name: 'Mop dining room',instruction: 'Clean dining room using the green mop and bucket, use multiple bucket loads if your water is turning grey. REMINDER: make sure the mop is properly wrung out before using it to avoid flooding the floor', icon: 'Clean', seconds: 600},  
    carryoverPan: {name: 'Setup Carryover pan',instruction: 'Setup Carryover pan, line it with enough bags for your expected carryover, a full pan of chicken= 2 bags, beef = 3, nacho = 2', icon: 'Clean', seconds: 600},  
    carryoverFirstRound: {name: 'First Round of Carryover',instruction: 'Check with MIC if there are any ingredients that can be carried over, ensuring there is enough product to last the night, if there are any issues, inform MIC and they will handle it', icon: 'Clean', seconds: 600},  
    chipDump: {name: 'Clean Chip Dump',instruction: 'Remove all chips and peices from the inside chip dump, inclusing the grill on the top of the dump', icon: 'Clean', seconds: 600},     
    coldLine: {name: 'Clean cold line',instruction: 'Clean cold line, items should only be removed from the cold line for a short period of time to avoid them warming up and becoming unsafe to eat', icon: 'Clean', seconds: 600},    
    remainingFloors: {name: 'Clean floors',instruction: 'Clean remaining floors that were missed during the night', icon: 'Clean', seconds: 600},
    
        //MIC ONLY
    
    stockCount: {name: 'MIC -Complete Stock Count',instruction: 'While completing your count remove any half opened boxes, after completing count, investigate any red variances', icon: 'Close', seconds: 600},    
    countSafe: {name: 'MIC - Count safe',instruction: "MIC - Stock up tills to ensure you don't need to swap around any money at the end of the night and then Count safe", icon: 'Close', seconds: 600},     
    bigGrillFirstAlert: {name: 'MIC - Switch off Big Grill',instruction: 'Turn off the big grill, and allow to cool for 20 minutes', icon: 'Close', seconds: 600}, 
    bigGrillSecondAlert: {name: 'MIC - Clean Big Grill',instruction: 'Put on PPE and begin cleaning the big grill, ensuring that you are pouring chemicals on the scrubber not directly on the grill. remember clean the entire grill,the chemical is heat activated and takes time to heat up and remove build up.', icon: 'Close', seconds: 600},

    // "After Close"

    drinkNozzles: {name: 'Drink Nozzles',instruction: 'Get a bucket of clean sanitiser water, collect all the drink nozzles and place them in the bucket, then clean the nozzles with the sanitiser water before laying them out on cloths', icon: 'Close', seconds: 3600}, 
    remainingBins: {name: 'Remove Bins',instruction: 'Remove remaining bins cleaned them and allow them to airdry and relined dry bins', icon: 'Clean', seconds: 3600},
    carryover: {name: 'Carryover',instruction: 'Complete remaining carryover, keeping products hot in the hotline until they are being carried over', icon: 'Clean', seconds: 3600},
    cleanOutSpotSweeps: {name: 'Clean spot sweeps',instruction: 'Disassemble and clean out spot sweeps and leave them to air dry', icon: 'Clean', seconds: 3600},
    checkThawing: {name: 'Check if more thawing is needed',instruction: 'Check thwaing guide and confirm if more thawing is needed', icon: 'Clean', seconds: 600},
    organiseFreezer: {name: 'Organise Freezer',instruction: 'Organise freezer stock, removing any expired products and organising the stock correctly', icon: 'Clean', seconds: 600},

        //MIC ONLY

    printReports: {name: 'MIC- print reports',instruction: 'Print Daily Roster and Prep Guide', icon: 'Clean', seconds: 600},
    shutDownTills: {name: 'MIC - Shut down tills',instruction: 'Close tills and deposit money into safe for the night', icon: 'Clean', seconds: 3600},


};						

/* ============================================================
   SCHEDULE — when to show 1, 2, or 3 cards at the same time

   • time — 24-hour clock as "HH:MM" (e.g. "14:30" for 2:30 PM)
   • show — list of keys from NOTIFICATIONS above (1 to 3 names)

   Examples:
     { time: '9:00',  show: ['fryCheck'] }
     { time: '14:15', show: ['closeSoon', 'volumeCheck'] }
     { time: '20:00', show: ['fryCheck', 'volumeCheck', 'closeSoon'] }
   ============================================================ */
const SCHEDULE = [

    // "Before 9:30PM"
    { time: '20:00', show: ['smallVats','prepBench', 'fryBench']},    
    { time: '20:10', show: ['DTBench', 'setupCarryover','removeExtras'] },
    { time: '20:20', show: ['cleanFloors', 'drains','cleanRetherm'] },
    { time: '20:30', show: ['cleanToilets', 'patioBins','diningBins']},
    { time: '20:40', show: ['removeBins', 'wipeTREDPoster','filterPan'] },
    { time: '20:50', show: ['wipePrepGuide', 'carryoverPan', 'removeStickers']},
    { time: '21:00', show: ['countSafe', 'printReports','carryoverFirstRound'] },

    // "After 9:30PM"
    { time: '21:10', show: ['bigGrillFirstAlert','checkThawing','hotLine']},
    { time: '21:20', show: ['stockCount','organiseFreezer','chipDump']},
    { time: '21:30', show: ['mopDining','coldLine','bigGrillSecondAlert'] },
    { time: '21:40', show: ['remainingFloors'] },                                   //Room for 2 more to be added


    // "After Close"
    { time: '22:00', show: ['drinkNozzles'] },
    { time: '22:00', show: ['remainingBins'] },
    { time: '22:00', show: ['carryover'] },
    { time: '22:00', show: ['cleanOutSpotSweeps'] },
    { time: '22:00', show: ['shutDownTills'] },
];

const _notificationSchedule = [];
const _iconSides = ['left', 'left', 'left'];

function parseScheduleTime(value) {
    if (typeof value !== 'string') return null;
    const parts = value.trim().split(':');
    if (parts.length !== 2) return null;
    let h = parseInt(parts[0], 10);
    let m = parseInt(parts[1], 10);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return {
        hour: Math.max(0, Math.min(23, h)),
        minute: Math.max(0, Math.min(59, m)),
    };
}

function presetKeyToCardConfig(key) {
    const p = NOTIFICATIONS[key];
    if (!p) {
        console.warn('[Notifications] Unknown key — not in NOTIFICATIONS:', key);
        return null;
    }
    let duration = 15000;
    if (typeof p.duration === 'number') duration = p.duration;
    else if (typeof p.seconds === 'number') duration = p.seconds * 1000;
    return {
        title: p.name,
        instruction: p.instruction || '',
        type: p.icon || null,
        duration,
    };
}

function openNotificationCards(configs) {
    if (!configs.length) return;
    const container = document.getElementById('popup-container');
    if (!container) return;
    try { playNotificationSound(); } catch (e) {}
    configs.forEach((cfg, i) => {
        const side = _iconSides[i % _iconSides.length];
        const card = makeMultiPopupCard(cfg, cfg.duration, side);
        container.appendChild(card);
        requestAnimationFrame(() => card.classList.add('popup-show'));

        const dismissCard = () => {
            if (!card.isConnected) return;
            card.classList.remove('popup-show');
            card.classList.add('popup-hide');
            setTimeout(() => card.remove(), POPUP_CONFIG.transitionDuration + 50);
        };

        // dismiss by tap/click
        card.addEventListener('pointerdown', dismissCard);

        setTimeout(dismissCard, cfg.duration);
    });
}

/** Pass 1–3 keys from NOTIFICATIONS (e.g. showNotificationGroup(['fryCheck', 'closeSoon'])) */
function showNotificationGroup(keys) {
    const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean).slice(0, 3);
    if (list.length > 3) console.warn('[Notifications] Only 3 cards at once; ignoring extras.');
    const configs = list.map(presetKeyToCardConfig).filter(Boolean);
    openNotificationCards(configs);
}

function registerSchedule(rows) {
    _notificationSchedule.length = 0;
    rows.forEach((row) => {
        const t = parseScheduleTime(row.time);
        if (!t) {
            console.warn('[Notifications] Invalid time (use HH:MM):', row);
            return;
        }
        const show = Array.isArray(row.show) ? row.show.filter(Boolean).slice(0, 3) : [];
        if (!show.length) {
            console.warn('[Notifications] Add at least one name in show:', row);
            return;
        }
        _notificationSchedule.push({
            hour: t.hour,
            minute: t.minute,
            show,
            _triggeredForYmd: null,
        });
    });
}

function processPopupSchedule() {
    const now = new Date();
    const { hour: hh, minute: mm } = melbourneHourMinute(now);
    const todayYmd = melbourneYmdFromDate(now);
    const ymdToday = formatYmd(todayYmd.year, todayYmd.month, todayYmd.day);
    _notificationSchedule.forEach((entry) => {
        if (entry.hour !== hh || entry.minute !== mm) return;
        if (entry._triggeredForYmd === ymdToday) return;
        entry._triggeredForYmd = ymdToday;
        showNotificationGroup(entry.show);
    });
}

/* ============================================================
   BOILOUT_RULE — calendar reminders (Melbourne date + times)

   • anchor       — first day of period 0 (YYYY-MM-DD). Next Period 1 June
   • periodDays   — length of each period (28).
   • Each period: the **first Monday** on or after the block start, still inside the block, is “boilout day”.
   • oilDump      — evening **calendar day before** that Monday (Sunday night if boilout is Monday).
   Times use **Australia/Melbourne** wall clock (not the PC timezone).
   ============================================================ */
const BOILOUT_RULE = {
    anchor: '2026-06-01',
    periodDays: 28,
    oilDump: { time: '21:30', show: ['boiloutOilDump'] },
    boilout: { time: '07:00', show: ['boiloutComplete'] },
};

function gregorianToJd(y, m, d) {
    const a = Math.floor((14 - m) / 12);
    const yy = y + 4800 - a;
    const mm = m + 12 * a - 3;
    return (
        d +
        Math.floor((153 * mm + 2) / 5) +
        365 * yy +
        Math.floor(yy / 4) -
        Math.floor(yy / 100) +
        Math.floor(yy / 400) -
        32045
    );
}

function jdToGregorian(jd) {
    const a = jd + 32044;
    const b = Math.floor((4 * a + 3) / 146097);
    const c = a - Math.floor((146097 * b) / 4);
    const d = Math.floor((4 * c + 3) / 1461);
    const e = c - Math.floor((1461 * d) / 4);
    const f = Math.floor((5 * e + 2) / 153);
    const day = e - Math.floor((153 * f + 2) / 5) + 1;
    const month = f + 3 - 12 * Math.floor(f / 10);
    const year = b * 100 + d - 4800 + Math.floor(f / 10);
    return { year, month, day };
}

function isoWeekdayFromYmd(y, m, d) {
    const t = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const w = t.getUTCDay();
    return w === 0 ? 7 : w;
}

function formatYmd(y, m, d) {
    return `${y}-${String(m).padStart(2, '0')}-${String(m).padStart(2, '0')}`;
}

function parseBoiloutAnchorYmd(s) {
    const m = String(s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return { year: +m[1], month: +m[2], day: +m[3] };
}

function melbourneYmdFromDate(d = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: DASHBOARD_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(d);
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    return { year: get('year'), month: get('month'), day: get('day') };
}

function melbourneHourMinute(d = new Date()) {
    const parts = new Intl.DateTimeFormat('en-AU', {
        timeZone: DASHBOARD_TIME_ZONE,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(d);
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    return { hour: get('hour'), minute: get('minute') };
}

/** First Monday with JD in [periodStartJd, periodEndJd] inclusive. */
function firstMondayYmdInJdRange(periodStartJd, periodEndJd) {
    for (let jd = periodStartJd; jd <= periodEndJd; jd += 1) {
        const g = jdToGregorian(jd);
        if (isoWeekdayFromYmd(g.year, g.month, g.day) === 1) {
            return g;
        }
    }
    return null;
}

/**
 * Melbourne calendar: YMD of the boilout Monday for the period containing `today`,
 * or null if today is before anchor.
 */
function boiloutMondayYmdContaining(todayYmd, rule) {
    const anchor = parseBoiloutAnchorYmd(rule.anchor);
    if (!anchor) return null;
    const periodDays = Math.max(1, Math.floor(Number(rule.periodDays) || 28));
    const todayJd = gregorianToJd(todayYmd.year, todayYmd.month, todayYmd.day);
    const anchorJd = gregorianToJd(anchor.year, anchor.month, anchor.day);
    const diff = todayJd - anchorJd;
    if (diff < 0) return null;
    const periodIndex = Math.floor(diff / periodDays);
    const periodStartJd = anchorJd + periodIndex * periodDays;
    const periodEndJd = periodStartJd + periodDays - 1;
    return firstMondayYmdInJdRange(periodStartJd, periodEndJd);
}

function ymdBefore(y, m, d) {
    const jd = gregorianToJd(y, m, d) - 1;
    return jdToGregorian(jd);
}

let _boiloutOilDumpTriggeredForYmd = null;
let _boiloutCompleteTriggeredForYmd = null;

function processBoiloutSchedule(now = new Date()) {
    const rule = BOILOUT_RULE;
    if (!rule || !rule.anchor) return;
    const todayYmd = melbourneYmdFromDate(now);
    const todayStr = formatYmd(todayYmd.year, todayYmd.month, todayYmd.day);
    const boilMon = boiloutMondayYmdContaining(todayYmd, rule);
    if (!boilMon) return;

    const boilStr = formatYmd(boilMon.year, boilMon.month, boilMon.day);
    const beforeBoil = ymdBefore(boilMon.year, boilMon.month, boilMon.day);
    const oilDumpStr = formatYmd(beforeBoil.year, beforeBoil.month, beforeBoil.day);

    const { hour: hh, minute: mm } = melbourneHourMinute(now);

    if (todayStr === oilDumpStr) {
        const row = rule.oilDump;
        if (row && row.time) {
            const t = parseScheduleTime(row.time);
            if (t && t.hour === hh && t.minute === mm && _boiloutOilDumpTriggeredForYmd !== todayStr) {
                showNotificationGroup(row.show || []);
                _boiloutOilDumpTriggeredForYmd = todayStr;
            }
        }
    }
    if (todayStr === boilStr) {
        const row = rule.boilout;
        if (row && row.time) {
            const t = parseScheduleTime(row.time);
            if (t && t.hour === hh && t.minute === mm && _boiloutCompleteTriggeredForYmd !== todayStr) {
                showNotificationGroup(row.show || []);
                _boiloutCompleteTriggeredForYmd = todayStr;
            }
        }
    }
}

registerSchedule(SCHEDULE);
processPopupSchedule();
processBoiloutSchedule();
setInterval(() => {
    processPopupSchedule();
    processBoiloutSchedule();
}, 1000);

document.getElementById('popup-test-btn')?.addEventListener('click', () => {
    const keys = Object.keys(NOTIFICATIONS);
    if (!keys.length) {
        showPopup('Add entries to NOTIFICATIONS in dashboard.js', 8000, null, { wrapMessage: true });
        return;
    }
    const count = Math.floor(Math.random() * 3) + 1;
    const picked = [];
    while (picked.length < count) {
        const k = keys[Math.floor(Math.random() * keys.length)];
        if (!picked.includes(k)) picked.push(k);
    }
    showNotificationGroup(picked);
});

window.showPopup = showPopup;
window.NOTIFICATIONS = NOTIFICATIONS;
window.SCHEDULE = SCHEDULE;
window.showNotificationGroup = showNotificationGroup;
window.openNotificationCards = openNotificationCards;
window.registerSchedule = registerSchedule;
window.BOILOUT_RULE = BOILOUT_RULE;

/* -----------------------------------------------------------
   Past-hour cells — actual vs forecast (beat / slightly low / well below)
----------------------------------------------------------- */
function getActualCellClass(actual, forecast) {
    const difference = actual - forecast;
    const ratio = difference / forecast;

    if (ratio >= 0) return 'cell-green';
    if (ratio >= -0.1) return 'cell-orange';
    return 'cell-red';
}


/* -----------------------------------------------------------
   Current trading hour — which column is "now" + fraction through the hour
----------------------------------------------------------- */
function getCurrentHourProgress() {
    const now = new Date();
    const hour = now.getHours();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();

    const startHour = TRADING_GRID_START_HOUR;
    const tradeEndHourExclusive = tradingEndHourExclusive();
    /** After close (e.g. 10PM), keep hourly grid colours for one more wall-clock hour (until 11PM). */
    const gridColoursEndHourExclusive = tradeEndHourExclusive + 1;

    if (hour < startHour || hour >= gridColoursEndHourExclusive) {
        return { hourIndex: -1, progress: 0 };
    }

    if (hour >= tradeEndHourExclusive) {
        return { hourIndex: times.length, progress: 1 };
    }

    const hourIndex = hour - startHour;
    const progress = minutes / 60 + seconds / 3600;

    return { hourIndex, progress };
}


/* Pace fill — same palette as .cell-green / .cell-orange / .cell-red */
const paceFillMap = {
    'cell-green': 'var(--good)',
    'cell-orange': 'var(--near)',
    'cell-red': 'var(--bad)',
};

/* Darker rim per status — pairs with paceFillMap like solid grid cells */
const paceBorderMap = {
    'cell-green': 'var(--good-border)',
    'cell-orange': 'var(--near-border)',
    'cell-red': 'var(--bad-border)',
};


/* -----------------------------------------------------------
   Grid numbers — pace vs forecast for current hour + `$` formatting for cells
----------------------------------------------------------- */
function getPaceClass(actual, forecast, elapsedProgress) {
    const f = Number(forecast) || 0;
    const a = Number(actual) || 0;
    const p = Number(elapsedProgress) || 0;
    if (f <= 0 || p <= 0) return 'cell-green';

    const expectedSales = f * p;

    if (a >= expectedSales) return 'cell-green';

    const shortfall = (expectedSales - a) / expectedSales;
    if (shortfall <= 0.1) return 'cell-orange';

    return 'cell-red';
}

function formatCurrency(value) {
    const numericValue = Number(value);
    if (Number.isNaN(numericValue)) {
        return String(value);
    }

    const options = {
        minimumFractionDigits: Number.isInteger(numericValue) ? 0 : 2,
        maximumFractionDigits: 2,
    };

    return `$${numericValue.toLocaleString(undefined, options)}`;
}

/** Always two fractional digits (e.g. $4,914.00) — charcoal day-total forecast only. */
function formatCurrencyTwoDecimals(value) {
    const numericValue = Number(value);
    if (Number.isNaN(numericValue)) {
        return String(value);
    }
    return `$${numericValue.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })}`;
}


/* -----------------------------------------------------------
   Live progress — dual fills (main = vs forecast, strip = pace)
----------------------------------------------------------- */
function buildLiveProgressLayersHtml(timeFillPercent, outcomeClass, paceClass) {
    const p = Math.max(0, Math.min(100, timeFillPercent));
    const mainBg = paceFillMap[outcomeClass] || 'var(--blank)';
    const paceBg = paceFillMap[paceClass] || 'var(--bad)';
    return `<div class="grid-cell-live-layers" aria-hidden="true">
        <div class="grid-cell-live-main-frame">
            <div class="grid-cell-live-main-fill" style="width: ${p}%; background-color: ${mainBg};"></div>
        </div>
        <div class="grid-cell-live-pace-row">
            <div class="grid-cell-live-pace-grow" style="width: ${p}%;">
                <div class="grid-cell-live-pace-bar" style="border-top: var(--cell-border) ${paceBg}; background-color: ${paceBg};"></div>
            </div>
        </div>
    </div>`;
}

function hasBeatenHourForecast(actual, forecast) {
    const f = Number(forecast) || 0;
    const a = Number(actual) || 0;
    if (f <= 0) return true;
    return a >= f;
}

function hasBeatenPeriodForecast(totalActual, totalForecast) {
    const f = Number(totalForecast) || 0;
    const a = Number(totalActual) || 0;
    if (f <= 0) return true;
    return a >= f;
}

function buildHourlyDataCell({ index, hourProgress, forecast, actual, displayValue }) {
    const isFuture = index > hourProgress.hourIndex;
    if (isFuture) {
        return `<div class="grid-cell">${formatCurrency(displayValue)}</div>`;
    }

    const fn = Number(forecast) || 0;
    const an = Number(actual) || 0;
    const isCurrentHour = index === hourProgress.hourIndex && hourProgress.hourIndex >= 0;

    if (!isCurrentHour) {
        const cellClass = getActualCellClass(an, fn);
        return `<div class="grid-cell${cellClass ? ` ${cellClass}` : ''}">${formatCurrency(displayValue)}</div>`;
    }

    if (hasBeatenHourForecast(an, fn)) {
        const cellClass = getActualCellClass(an, fn);
        return `<div class="grid-cell${cellClass ? ` ${cellClass}` : ''}">${formatCurrency(displayValue)}</div>`;
    }

    const { progress } = hourProgress;
    const paceClass = getPaceClass(an, fn, progress);
    const outcomeClass = getActualCellClass(an, fn);
    const progressPct = Math.round(progress * 1000) / 10;
    const layers = buildLiveProgressLayersHtml(progressPct, outcomeClass, paceClass);
    const outcomeBorder = paceBorderMap[outcomeClass] || 'var(--blank-border)';
    return `<div class="grid-cell grid-cell--live-hour" style="border: var(--cell-border) ${outcomeBorder};">${layers}<span class="grid-cell-live-value">${formatCurrency(displayValue)}</span></div>`;
}

/* -----------------------------------------------------------
   Sales grid rows — HTML for forecast row and actual row
----------------------------------------------------------- */
function buildHeaderRow() {
    return `
        <div class="grid-label header-label">Time</div>
        ${times.map((time) => `<div class="grid-cell header-cell">${time}</div>`).join('')}
    `;
}

function buildForecastRow(forecasts, actuals) {
    const hourProgress = getCurrentHourProgress();
    return `
        <div class="grid-label">Forecast Sales</div>
        ${forecasts.map((value, index) =>
            buildHourlyDataCell({
                index,
                hourProgress,
                forecast: value,
                actual: actuals[index],
                displayValue: value,
            })
        ).join('')}
    `;
}

function buildActualRow(values, forecasts) {
    const hourProgress = getCurrentHourProgress();
    return `
        <div class="grid-label">Actual Sales</div>
        ${values.map((value, index) =>
            buildHourlyDataCell({
                index,
                hourProgress,
                forecast: forecasts[index],
                actual: value,
                displayValue: value,
            })
        ).join('')}
    `;
}

/* -----------------------------------------------------------
   Day part row — charcoal cell shows full-day total (colour bar only).
   Lunch 10AM–3PM (hourly slice + wall) | Dinner 3PM–close
----------------------------------------------------------- */
/** First index of 3PM column in `times` / hourly arrays (dinner starts here). */
const PART_LUNCH_END = 5;
const LUNCH_WALL_START = 10;
const LUNCH_WALL_END_EXCLUSIVE = 15;
const DINNER_WALL_START = 15;

function sumHourSlice(values, start, end) {
    return values.slice(start, end).reduce((sum, v) => sum + (Number(v) || 0), 0);
}

function todayAt(hour, minute = 0, second = 0, millisecond = 0) {
    const d = new Date();
    d.setHours(hour, minute, second, millisecond);
    return d.getTime();
}

function getWallClockPeriodProgress(startHour, endHourExclusive) {
    const t0 = todayAt(startHour, 0, 0, 0);
    const t1 = todayAt(endHourExclusive, 0, 0, 0);
    const now = Date.now();
    if (now <= t0) return 0;
    if (now >= t1) return 1;
    return (now - t0) / (t1 - t0);
}

function getPeriodExpectedSoFarSlice(forecasts, startIdx, endExclusive, hourProgress) {
    const { hourIndex, progress } = hourProgress;
    let expected = 0;
    for (let i = startIdx; i < endExclusive; i++) {
        const f = Number(forecasts[i]) || 0;
        if (hourIndex < 0) break;
        if (i < hourIndex) expected += f;
        else if (i === hourIndex) {
            expected += f * progress;
            break;
        } else break;
    }
    return expected;
}

function getPeriodActualSoFarSlice(actuals, startIdx, endExclusive, hourProgress) {
    const { hourIndex } = hourProgress;
    if (hourIndex < 0) return 0;
    let actual = 0;
    for (let i = startIdx; i < endExclusive; i++) {
        if (i <= hourIndex) actual += Number(actuals[i]) || 0;
        else break;
    }
    return actual;
}

function getDayPartPresentation(forecasts, actuals, startIdx, endExclusive, wallStartHour, wallEndHourExclusive) {
    const hourProgress = getCurrentHourProgress();
    const totalForecast = sumHourSlice(forecasts, startIdx, endExclusive);
    const totalActual = sumHourSlice(actuals, startIdx, endExclusive);
    const tStart = todayAt(wallStartHour, 0, 0, 0);
    const tEnd = todayAt(wallEndHourExclusive, 0, 0, 0);
    const now = Date.now();
    const wallPct = Math.round(getWallClockPeriodProgress(wallStartHour, wallEndHourExclusive) * 1000) / 10;

    if (now < tStart) {
        return { phase: 'before', cellClass: '', inlineStyle: '', liveLayersHtml: '', outcomeBorderColor: '' };
    }

    if (now >= tEnd) {
        const finalClass = totalForecast > 0 ? getActualCellClass(totalActual, totalForecast) : 'cell-green';
        return { phase: 'after', cellClass: finalClass, inlineStyle: '', liveLayersHtml: '', outcomeBorderColor: '' };
    }

    let paceClass = 'cell-green';
    if (totalForecast <= 0) {
        paceClass = 'cell-green';
    } else {
        const expectedSoFar = getPeriodExpectedSoFarSlice(forecasts, startIdx, endExclusive, hourProgress);
        const actualSoFar = getPeriodActualSoFarSlice(actuals, startIdx, endExclusive, hourProgress);
        const ep = totalForecast > 0 ? expectedSoFar / totalForecast : 0;
        if (expectedSoFar <= 0) {
            paceClass = 'cell-green';
        } else {
            paceClass = getPaceClass(actualSoFar, totalForecast, ep);
        }
    }

    if (hasBeatenPeriodForecast(totalActual, totalForecast)) {
        const finalClass = totalForecast > 0 ? getActualCellClass(totalActual, totalForecast) : 'cell-green';
        return { phase: 'during', cellClass: finalClass, inlineStyle: '', liveLayersHtml: '', outcomeBorderColor: '' };
    }

    const mainClass = totalForecast > 0 ? getActualCellClass(totalActual, totalForecast) : 'cell-green';
    const liveLayersHtml = buildLiveProgressLayersHtml(wallPct, mainClass, paceClass);
    const outcomeBorderColor = paceBorderMap[mainClass] || 'var(--blank-border)';

    return {
        phase: 'during',
        cellClass: '',
        inlineStyle: '',
        liveLayersHtml,
        outcomeBorderColor,
    };
}

/** Full-day total in charcoal cell — bar always full width; colour = green / yellow / red vs forecast (same as hourly cells). */
function buildDayPartCharcoalCellHtml(forecasts, actuals) {
    if (!Array.isArray(forecasts) || forecasts.length === 0) {
        return `<div class="grid-label meal-period-label meal-period-day-sales-total">
            <div class="meal-period-day-sales-stack">
                <div class="meal-period-day-sales-muted">Waiting for sales data</div>
            </div>
            <div class="meal-period-day-sales-fullbar" style="background-color: ${paceFillMap['cell-green']}"></div>
        </div>`;
    }
    const dayForecast = sumHourSlice(forecasts, 0, times.length);
    const dayActual = sumHourSlice(actuals, 0, times.length);
    let statusClass = 'cell-green';
    if (dayForecast > 0) {
        statusClass = getActualCellClass(dayActual, dayForecast);
    }
    const barBg = paceFillMap[statusClass] || paceFillMap['cell-green'];
    return `<div class="grid-label meal-period-label meal-period-day-sales-total" role="region" aria-label="Day sales total">
        <div class="meal-period-day-sales-stack">
            <div class="meal-period-day-sales-figures">
                <div class="meal-period-day-sales-line">A${formatCurrencyTwoDecimals(dayActual)}</div>
                <div class="meal-period-day-sales-line">F${formatCurrencyTwoDecimals(dayForecast)}</div>
            </div>
        </div>
        <div class="meal-period-day-sales-fullbar" style="background-color: ${barBg}"></div>
    </div>`;
}

function buildMealPeriodRow(forecasts, actuals) {
    const lunchForecast = sumHourSlice(forecasts, 0, PART_LUNCH_END);
    const lunchActual = sumHourSlice(actuals, 0, PART_LUNCH_END);
    const dinnerForecast = sumHourSlice(forecasts, PART_LUNCH_END, times.length);
    const dinnerActual = sumHourSlice(actuals, PART_LUNCH_END, times.length);

    const dinnerWallEnd = tradingEndHourExclusive();
    const lunchPres = getDayPartPresentation(
        forecasts,
        actuals,
        0,
        PART_LUNCH_END,
        LUNCH_WALL_START,
        LUNCH_WALL_END_EXCLUSIVE
    );
    const dinnerPres = getDayPartPresentation(
        forecasts,
        actuals,
        PART_LUNCH_END,
        times.length,
        DINNER_WALL_START,
        dinnerWallEnd
    );

    const lunchCellClasses = ['grid-cell', 'meal-period-cell'];
    if (lunchPres.cellClass) lunchCellClasses.push(lunchPres.cellClass);
    if (lunchPres.liveLayersHtml) lunchCellClasses.push('meal-period-cell--live');

    const dinnerCellClasses = ['grid-cell', 'meal-period-cell'];
    if (dinnerPres.cellClass) dinnerCellClasses.push(dinnerPres.cellClass);
    if (dinnerPres.liveLayersHtml) dinnerCellClasses.push('meal-period-cell--live');

    const lunchStyleAttr = [
        'grid-column: 2 / 7',
        lunchPres.inlineStyle,
        lunchPres.outcomeBorderColor ? `border: var(--cell-border) ${lunchPres.outcomeBorderColor}` : '',
    ]
        .filter(Boolean)
        .join('; ');
    const dinnerStyleAttr = [
        'grid-column: 7 / 14',
        dinnerPres.inlineStyle,
        dinnerPres.outcomeBorderColor ? `border: var(--cell-border) ${dinnerPres.outcomeBorderColor}` : '',
    ]
        .filter(Boolean)
        .join('; ');

    return `
        ${buildDayPartCharcoalCellHtml(forecasts, actuals)}
        <div class="${lunchCellClasses.join(' ')}" style="${lunchStyleAttr}">
            ${lunchPres.liveLayersHtml || ''}
            <div class="meal-period-body">
                <div class="meal-period-title">Lunch</div>
                <div class="meal-period-stats">
                    <div class="meal-period-line"><span class="meal-period-value">${formatCurrency(lunchActual)} / ${formatCurrency(lunchForecast)}</span></div>
                </div>
            </div>
        </div>
        <div class="${dinnerCellClasses.join(' ')}" style="${dinnerStyleAttr}">
            ${dinnerPres.liveLayersHtml || ''}
            <div class="meal-period-body">
                <div class="meal-period-title">Dinner</div>
                <div class="meal-period-stats">
                    <div class="meal-period-line"><span class="meal-period-value">${formatCurrency(dinnerActual)} / ${formatCurrency(dinnerForecast)}</span></div>
                </div>
            </div>
        </div>
    `;
}

/* -----------------------------------------------------------
   Refresh sales grid — header row + forecast + actual from global arrays
----------------------------------------------------------- */
function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function updateAuditsPanel() {
    const el = document.getElementById('audits-list-panel');
    if (!el) return;

    const visible = getVisibleAudits();
    if (!visible.length) {
        el.innerHTML = '';
        return;
    }

    el.innerHTML = visible
        .map(
            (name) =>
                `<div class="audit-item"><button type="button" class="audit-chip" data-audit="${encodeURIComponent(
                    name
                )}" aria-label="Mark ${escapeHtml(name)} as done">${escapeHtml(name)}</button></div>`
        )
        .join('');
}

function updatePendingVendorsPanel() {
    const el = document.getElementById('pending-vendors-panel');
    if (!el) return;

    const visible = getVisiblePendingVendors();
    const monday = isMelbourneMonday();
    const lastMondayMonth = isMelbourneLastMondayOfMonth();
    if (!visible.length && !monday && !lastMondayMonth) {
        el.innerHTML = '';
        return;
    }

    const mondayHtml = monday ? mondayCashOrderReminderHtml() : '';
    const lastMondayHtml = lastMondayMonth ? lastMondayMonthlyOrdersReminderHtml() : '';
    const chipsHtml = visible.length
        ? visible
              .map(
                  (name) =>
                      `<div class="pending-vendor-item"><button type="button" class="pending-vendor-chip" data-vendor="${encodeURIComponent(
                          name
                      )}" aria-label="Mark ${escapeHtml(name)} as done">${escapeHtml(name)}</button></div>`
              )
              .join('')
        : '';

    el.innerHTML = mondayHtml + lastMondayHtml + chipsHtml;
}

function handleFooterChipDismissClick(e) {
    const vBtn = e.target.closest('button.pending-vendor-chip');
    if (vBtn && !vBtn.classList.contains('pending-vendor-chip--dismissing')) {
        const enc = vBtn.getAttribute('data-vendor');
        if (!enc) return;
        const label = decodeURIComponent(enc);
        dismissedPendingVendors.add(label);
        const item = vBtn.closest('.pending-vendor-item');
        vBtn.classList.add('pending-vendor-chip--dismissing');
        if (item) item.classList.add('pending-vendor-item--dismissing');
        let removed = false;
        const finishRemove = () => {
            if (removed) return;
            removed = true;
            item?.remove();
            const panel = document.getElementById('pending-vendors-panel');
            const aside = document.querySelector('.pending-vendors-aside');
            if (panel && panel.children.length === 0 && aside) {
                aside.remove();
                document.querySelector('.dashboard-grid-footer-trail')?.remove();
            }
        };
        const onAnimEnd = (ev) => {
            if (ev.target !== vBtn) return;
            const names = String(ev.animationName || '');
            if (!names.includes('pending-vendor-chip-exit')) return;
            finishRemove();
        };
        vBtn.addEventListener('animationend', onAnimEnd, { once: true });
        window.setTimeout(finishRemove, 1000);
        return;
    }

    const aBtn = e.target.closest('button.audit-chip');
    if (aBtn && !aBtn.classList.contains('audit-chip--dismissing')) {
        const enc = aBtn.getAttribute('data-audit');
        if (!enc) return;
        const label = decodeURIComponent(enc);
        dismissedAudits.add(label);
        saveAuditState();
        const item = aBtn.closest('.audit-item');
        aBtn.classList.add('audit-chip--dismissing');
        if (item) item.classList.add('audit-item--dismissing');
        let removed = false;
        const finishRemove = () => {
            if (removed) return;
            removed = true;
            item?.remove();
            const panel = document.getElementById('audits-list-panel');
            const aside = document.querySelector('.audits-aside');
            if (panel && panel.children.length === 0 && aside) {
                aside.remove();
                document.querySelector('.dashboard-grid-footer-lead')?.remove();
            }
        };
        const onAnimEnd = (ev) => {
            if (ev.target !== aBtn) return;
            const names = String(ev.animationName || '');
            if (!names.includes('audit-chip-exit')) return;
            finishRemove();
        };
        aBtn.addEventListener('animationend', onAnimEnd, { once: true });
        window.setTimeout(finishRemove, 1000);
    }
}

function bindFooterChipDismissOnce() {
    if (bindFooterChipDismissOnce._bound) return;
    bindFooterChipDismissOnce._bound = true;
    app.addEventListener('click', handleFooterChipDismissClick);
}

function buildColourGuideNoteHtml() {
    return `
        <div class="dashboard-colour-note">
            <strong>Colour guide:</strong>
            <strong>Red:</strong> Not on track. <strong>Yellow:</strong> Almost on track (90%). <strong>Green:</strong> On track.
            <br>
            <strong>Current hour</strong> fills with time indicates actual sales vs forecast; the <strong>bottom strip</strong> fills with time and indicates if you are "on track" to meet sales at this minute.
        </div>
    `;
}

function buildAuditsAsideHtml() {
    if (!getVisibleAudits().length) {
        return '';
    }
    return `
        <div class="audits-aside" role="region" aria-label="List of audits">
            <div class="audits-heading">List of Audits</div>
            <div id="audits-list-panel" class="audits-list" aria-live="polite"></div>
        </div>
    `;
}

function buildPendingVendorsAsideHtml() {
    if (!getVisiblePendingVendors().length && !isMelbourneMonday() && !isMelbourneLastMondayOfMonth()) {
        return '';
    }
    return `
        <div class="pending-vendors-aside" role="region" aria-label="Orders to place from Macromatix">
            <div class="pending-vendors-heading">Orders to place</div>
            <div id="pending-vendors-panel" class="pending-vendors-list" aria-live="polite"></div>
        </div>
    `;
}

function buildGridFooterRow() {
    const leadInner = buildAuditsAsideHtml();
    const lead = leadInner ? `<div class="dashboard-grid-footer-lead">${leadInner}</div>` : '';
    const ordersAside = buildPendingVendorsAsideHtml();
    const trail = ordersAside ? `<div class="dashboard-grid-footer-trail">${ordersAside}</div>` : '';
    return `
        <div class="dashboard-grid-footer">
            <div class="dashboard-grid-footer-ledger">
                ${lead}
                ${buildColourGuideNoteHtml()}
                ${trail}
            </div>
        </div>
    `;
}

function updateGrid() {
    const grid = document.querySelector('.dashboard-grid');
    if (!grid) return;

    syncAuditPeriodState();

    grid.innerHTML = `
        ${buildHeaderRow()}
        ${buildForecastRow(forecastSales, liveSales)}
        ${buildActualRow(liveSales, forecastSales)}
        ${buildMealPeriodRow(forecastSales, liveSales)}
        ${buildGridFooterRow()}
    `;
    updateAuditsPanel();
    updatePendingVendorsPanel();
}

function buildOrderDateTestPanelHtml() {
    return `
        <div id="order-date-test-panel" class="order-date-test-panel" role="region" aria-label="DEBUG: test scheduled orders date (Macromatix)">
            <span class="order-date-test-label">DEBUG — test orders date</span>
            <input type="date" id="order-date-test-input" class="order-date-test-input" autocomplete="off" />
            <button type="button" id="order-date-test-apply" class="order-date-test-btn">Apply and re-scrape</button>
            <button type="button" id="order-date-test-clear" class="order-date-test-btn order-date-test-btn--secondary">Live date</button>
            <span id="order-date-test-hint" class="order-date-test-hint" hidden></span>
        </div>`;
}

function bindOrderDateTestPanelOnce() {
    if (bindOrderDateTestPanelOnce._done) return;
    bindOrderDateTestPanelOnce._done = true;
    app.addEventListener('click', (ev) => {
        const t = ev.target;
        if (!(t instanceof HTMLElement)) return;
        if (t.id === 'order-date-test-apply') {
            const inp = document.getElementById('order-date-test-input');
            const v = inp && inp.value;
            if (!v) {
                orderDateTestSetHint('Pick a date first.', false);
                return;
            }
            orderDateTestYmd = v;
            dismissedPendingVendors.clear();
            loadSalesDataForOrderDateTest();
            return;
        }
        if (t.id === 'order-date-test-clear') {
            orderDateTestYmd = null;
            orderDateTestSetHint('', true);
            loadSalesData();
        }
    });
}

/* -----------------------------------------------------------
   First paint — dashboard layout, header, empty grid, popup mount point
----------------------------------------------------------- */
function renderDashboard() {
    app.innerHTML = `
        <div class="dashboard">
            <div class="dashboard-header">
                <div class="dashboard-title">
                    <h1>SALES DASHBOARD</h1>
                    <p class="subtitle">Real-time sales data updated automatically.</p>
                </div>
                <div class="top-info">
                    <div class="top-info-group">
                        <span class="top-info-label">Current Time</span>
                        <span id="time-display" class="top-info-value">${formatTime(new Date())}</span>
                    </div>
                    <div class="top-info-group" style="text-align: center;">
                        <span class="top-info-label">Last updated</span>
                        <span id="last-updated" class="top-info-value">--:--</span>
                    </div>
                </div>
            </div>

            <div id="sales-status" class="sales-status" role="status" aria-live="polite" hidden></div>
            <div id="audit-schedule-status" class="audit-schedule-status" role="alert" aria-live="assertive" hidden></div>
            ${buildOrderDateTestPanelHtml()}

            <div class="dashboard-grid"></div>

            <div id="popup-container"></div>
        </div>
    `;
    bindFooterChipDismissOnce();
    bindOrderDateTestPanelOnce();
}

/* -----------------------------------------------------------
   Timer — keep header clock in sync (1s interval)
----------------------------------------------------------- */
setInterval(updateClock, 1000);

/* Rebuild grid on a short cadence so day-part / current-hour fill tracks wall clock between sales API polls */
const GRID_PROGRESS_REFRESH_MS = 10000;
setInterval(() => {
    if (forecastSales.length && document.querySelector('.dashboard-grid')) {
        updateGrid();
    }
}, GRID_PROGRESS_REFRESH_MS);

/* -----------------------------------------------------------
   Sales polling — load now, then every N minutes on wall-clock boundaries
----------------------------------------------------------- */
function startSyncedUpdates() {
    // Load immediately
    loadSalesData();

    // Calculate time until next refresh boundary
    const now = new Date();
    const msUntilNext =
        (SALES_REFRESH_MINUTES - (now.getMinutes() % SALES_REFRESH_MINUTES)) * 60 * 1000 -
        (now.getSeconds() * 1000) -
        now.getMilliseconds();

    // Wait until the boundary, then start interval
    setTimeout(() => {
        loadSalesData();
        setInterval(loadSalesData, SALES_REFRESH_MINUTES * 60 * 1000);
    }, msUntilNext);
}

/* -----------------------------------------------------------
   Boot — render dashboard shell, then start clock & sales sync
----------------------------------------------------------- */
(async () => {
    renderDashboard();
    await loadAuditSchedule();
    await loadAuditState();
    startSyncedUpdates();
})();