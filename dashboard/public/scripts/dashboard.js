/* -----------------------------------------------------------
   Root element — dashboard mounts here (`#app`)
----------------------------------------------------------- */
const app = document.getElementById('app');

/** Store id from URL (/Admin/A22, /MIC/3811, /kiosk/3811, or legacy /3811). */
const IS_ADMIN_AREA_DASHBOARD = /^\/Admin\/A(\d+)\/?$/i.test(window.location.pathname);
const ADMIN_AREA_MATCH = window.location.pathname.match(/^\/Admin\/A(\d+)\/?$/i);
const ADMIN_AREA_CODE = ADMIN_AREA_MATCH ? `A${ADMIN_AREA_MATCH[1]}` : '';
const IS_MIC_STORE_DASHBOARD = /^\/MIC\/(teststore|\d{3,6})\/?$/i.test(window.location.pathname);
const IS_LEGACY_ADMIN_STORE_DASHBOARD = /^\/Admin\/(teststore|\d{3,6})\/?$/i.test(
    window.location.pathname
);
const IS_ADMIN_STORE_DASHBOARD = IS_ADMIN_AREA_DASHBOARD || IS_LEGACY_ADMIN_STORE_DASHBOARD;

function storeNumberFromPath() {
    return (
        (
            window.location.pathname.match(/^\/Admin\/(teststore|\d{3,6})\/?$/i) ||
            window.location.pathname.match(/^\/MIC\/(teststore|\d{3,6})\/?$/i) ||
            window.location.pathname.match(/\/(?:nologin|kiosk)\/(\d{3,6})\/?$/i) ||
            window.location.pathname.match(/^\/(teststore|\d{3,6})\/?$/i) ||
            []
        )[1]?.toLowerCase() || ''
    );
}

function initialAdminAreaStore() {
    try {
        const fromQuery = new URLSearchParams(window.location.search).get('store');
        if (fromQuery) return String(fromQuery).toLowerCase();
        if (ADMIN_AREA_CODE) {
            const saved = sessionStorage.getItem(`admin-area-store-${ADMIN_AREA_CODE}`);
            if (saved) return String(saved).toLowerCase();
        }
    } catch {
        /* ignore */
    }
    return '';
}

let STORE_NUMBER = IS_ADMIN_AREA_DASHBOARD ? initialAdminAreaStore() : storeNumberFromPath();
const KIOSK_TOKEN =
    typeof window !== 'undefined' && window.__DASHBOARD_KIOSK__
        ? String(window.__DASHBOARD_KIOSK__)
        : '';
const STORE_QUERY = STORE_NUMBER ? `?store=${encodeURIComponent(STORE_NUMBER)}` : '';

function isKioskDashboardEntry() {
    if (/^\/kiosk(\/|$)/i.test(window.location.pathname)) return true;
    if (KIOSK_TOKEN) return true;
    try {
        if (sessionStorage.getItem('dashboard-entry') === 'kiosk') return true;
    } catch {
        /* ignore */
    }
    return document.cookie.split(';').some((c) => c.trim() === 'dashboard_entry=kiosk');
}

function isNologinDashboardEntry() {
    return document.cookie.split(';').some((c) => c.trim().startsWith('dashboard_nologin='));
}

/** Settings cog on sales dashboard — MIC and admin logins only, not wall/kiosk tablets. */
function shouldShowDashboardSettings() {
    if (isKioskDashboardEntry() || isNologinDashboardEntry()) return false;
    if (IS_ADMIN_STORE_DASHBOARD || IS_MIC_STORE_DASHBOARD) return true;
    return (
        document.cookie.split(';').some((c) => c.trim() === 'dashboard_entry=store') ||
        /^\/MIC\/(teststore|\d{3,6})\/?$/i.test(window.location.pathname) ||
        /^\/(teststore|\d{3,6})\/?$/i.test(window.location.pathname)
    );
}

function withStore(url) {
    let out = url;
    if (STORE_NUMBER) {
        const sep = out.includes('?') ? '&' : '?';
        out = `${out}${sep}store=${encodeURIComponent(STORE_NUMBER)}`;
    }
    if (KIOSK_TOKEN) {
        const sep = out.includes('?') ? '&' : '?';
        out = `${out}${sep}kiosk=${encodeURIComponent(KIOSK_TOKEN)}`;
    }
    return out;
}

const SALES_API_URL =
    typeof window !== 'undefined' && window.__DASHBOARD_SALES_API__
        ? window.__DASHBOARD_SALES_API__
        : withStore(`${window.location.origin}/api/sales`);
const STOCK_COUNT_TEST_PENDING =
    typeof window !== 'undefined' &&
    /^(1|true|yes|on)$/i.test(String(new URLSearchParams(window.location.search).get('testStockCountPending') || ''));

function salesApiUrl(extraParams = {}) {
    let url = SALES_API_URL;
    const params = new URLSearchParams();
    if (STOCK_COUNT_TEST_PENDING) params.set('testStockCountPending', '1');
    for (const [key, value] of Object.entries(extraParams)) {
        if (value != null && value !== '') params.set(key, String(value));
    }
    const qs = params.toString();
    if (!qs) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}${qs}`;
}
const AUDITS_API_URL = withStore(`${window.location.origin}/api/audits`);
function auditsApiUrl() {
    return withStore(`${window.location.origin}/api/audits`);
}
const AUDIT_SCHEDULE_URL = withStore(`${window.location.origin}/api/audit-schedule`);
const SALES_REFRESH_MINUTES = 2;

/** Preloaded admin area payloads keyed by store number (lowercase). */
const adminAreaSalesCache = new Map();

function adminAreaStorageKey() {
    return ADMIN_AREA_CODE ? `admin-area-store-${ADMIN_AREA_CODE}` : '';
}

function rememberAdminAreaStore(storeNum) {
    const key = adminAreaStorageKey();
    if (!key || !storeNum) return;
    try {
        sessionStorage.setItem(key, String(storeNum).toLowerCase());
    } catch {
        /* ignore */
    }
}

function sumHourlySlice(values) {
    if (!Array.isArray(values)) return 0;
    return values.reduce((sum, v) => sum + (Number(v) || 0), 0);
}

async function applyAdminStoreSlice(storeNum) {
    const key = String(storeNum || '').toLowerCase();
    let slice = adminAreaSalesCache.get(key);
    if (!slice) {
        try {
            const res = await fetch(
                `${window.location.origin}/api/sales?store=${encodeURIComponent(key)}`,
                { credentials: 'include' }
            );
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.success) {
                slice = data;
                adminAreaSalesCache.set(key, slice);
            }
        } catch {
            /* fall through */
        }
    }
    if (!slice) return false;

    STORE_NUMBER = key;
    rememberAdminAreaStore(key);
    applySalesPayload(slice);
    updateStoreHeader();

    if (typeof window.upsellingPodium?.init === 'function') {
        window.upsellingPodium.init(STORE_NUMBER);
    }
    if (typeof window.StockCountNotify?.initPipelineWatcher === 'function') {
        window.StockCountNotify.initPipelineWatcher(STORE_NUMBER);
    }

    await loadAuditSchedule();
    await loadAuditState();
    updateTimestamp(slice.timestamp);
    updateSalesStatus(slice);
    if (!sumHourlySlice(slice.actual) && !sumHourlySlice(slice.forecast)) {
        updateSalesStatus({
            warning: 'No hourly sales loaded for this store yet (outside trading hours or waiting on scrape).',
        });
    }
    salesDataLoadedOnce = true;
    updateGrid();
    updatePendingVendorsPanel();
    window.AdminStoreTabs?.updateActiveStore?.(STORE_NUMBER);
    window.MicSettings?.setStoreContext?.({ storeNumber: STORE_NUMBER });
    return true;
}

async function loadAdminAreaSales() {
    if (!IS_ADMIN_AREA_DASHBOARD || !ADMIN_AREA_CODE) return false;
    const res = await fetch(
        `${window.location.origin}/api/admin/area-sales?area=${encodeURIComponent(ADMIN_AREA_CODE)}`,
        { credentials: 'include' }
    );
    if (!res.ok) {
        throw new Error(`Area sales API responded with ${res.status}`);
    }
    const data = await res.json();
    if (!data.success) {
        throw new Error(data.error || 'Area sales API returned unsuccessful response');
    }

    adminAreaSalesCache.clear();
    const list = Array.isArray(data.stores) ? data.stores : [];
    for (const slice of list) {
        const num = String(slice.storeNumber || '').toLowerCase();
        if (num) adminAreaSalesCache.set(num, slice);
    }

    const prefer =
        STORE_NUMBER ||
        initialAdminAreaStore() ||
        String(list[0]?.storeNumber || '').toLowerCase();
    if (!prefer) return false;

    const applied = await applyAdminStoreSlice(prefer);
    if (!applied && list.length) {
        await applyAdminStoreSlice(list[0].storeNumber);
    }

    window.AdminStoreTabs?.refreshFromAreaSales?.(list, STORE_NUMBER, ADMIN_AREA_CODE);

    if (window.location.search) {
        const params = new URLSearchParams(window.location.search);
        if (params.has('store')) {
            params.delete('store');
            const qs = params.toString();
            history.replaceState(
                { area: ADMIN_AREA_CODE, store: STORE_NUMBER },
                '',
                qs ? `${window.location.pathname}?${qs}` : window.location.pathname
            );
        }
    }
    return true;
}

function setAdminAreaTotalsUrl(active) {
    if (!IS_ADMIN_AREA_DASHBOARD) return;
    try {
        const url = new URL(window.location.href);
        if (active) url.searchParams.set('view', 'area');
        else url.searchParams.delete('view');
        const next = `${url.pathname}${url.search}`;
        history.replaceState({ area: ADMIN_AREA_CODE, store: STORE_NUMBER, view: active ? 'area' : '' }, '', next);
    } catch {
        /* ignore */
    }
}

function wantsAdminAreaTotalsView() {
    try {
        return new URLSearchParams(window.location.search).get('view') === 'area';
    } catch {
        return false;
    }
}

async function switchAdminStore(storeNum) {
    if (!IS_ADMIN_AREA_DASHBOARD) return false;
    if (document.body.classList.contains('admin-showing-area-totals')) {
        window.AdminAreaPanel?.hide?.();
        setAdminAreaTotalsUrl(false);
        window.AdminStoreTabs?.setViewMode?.('store');
    }
    const ok = await applyAdminStoreSlice(storeNum);
    if (ok) applyDashboardScale();
    return ok;
}

async function showAdminAreaTotals(options = {}) {
    if (!IS_ADMIN_AREA_DASHBOARD || !ADMIN_AREA_CODE) return false;
    const quiet = Boolean(options.quiet);
    const panel = document.getElementById('admin-area-view');
    const grids = document.getElementById('admin-area-grids');
    try {
        if (panel && grids && !quiet) {
            panel.hidden = false;
            document.body.classList.add('admin-showing-area-totals');
            grids.innerHTML = '<p class="admin-accounts-meta">Loading area totals…</p>';
            window.AdminStoreTabs?.setViewMode?.('area');
            setAdminAreaTotalsUrl(true);
        } else if (panel && !quiet) {
            panel.hidden = false;
            document.body.classList.add('admin-showing-area-totals');
            window.AdminStoreTabs?.setViewMode?.('area');
            setAdminAreaTotalsUrl(true);
        }
        if (options.refresh) window.AdminAreaPanel?.invalidateCache?.();
        await window.AdminAreaPanel?.show?.(ADMIN_AREA_CODE);
        applyDashboardScale();
        return true;
    } catch (err) {
        console.error('Failed to load area totals:', err);
        if (!quiet) {
            window.AdminStoreTabs?.setViewMode?.('store');
            showAdminStoreView();
        }
        updateSalesStatus({
            warning: err.message || 'Could not load area dashboard. Try again in a moment.',
        });
        return false;
    }
}

async function refreshAdminAreaTotalsIfVisible() {
    if (!document.body.classList.contains('admin-showing-area-totals')) return;
    await showAdminAreaTotals({ quiet: true, refresh: true });
}

function showAdminStoreView() {
    if (!IS_ADMIN_AREA_DASHBOARD) return;
    window.AdminAreaPanel?.hide?.();
    setAdminAreaTotalsUrl(false);
    applyDashboardScale();
}

window.AdminAreaDashboard = {
    selectStore: switchAdminStore,
    reloadArea: loadAdminAreaSales,
    showAreaTotals: showAdminAreaTotals,
    showStoreView: showAdminStoreView,
};

/** Store name/number from the latest sales payload, shown in the header. */
let currentStoreLabel = STORE_NUMBER || '';
let DASHBOARD_TIME_ZONE = 'Australia/Melbourne';

function setDashboardTimeZone(value) {
    const zone = String(value || '').trim();
    if (!zone) return;
    try {
        // Throws for invalid IANA names; keep existing zone if invalid.
        new Intl.DateTimeFormat('en-AU', { timeZone: zone }).format(new Date());
        DASHBOARD_TIME_ZONE = zone;
    } catch {
        /* ignore invalid time zone */
    }
}

/* -----------------------------------------------------------
   Trading hours — grid columns and the lunch/dinner split are derived from the
   store's open/close (from .storelist, delivered by the API). Defaults to 10AM–10PM
   until the store's hours load. See setTradingHours().
----------------------------------------------------------- */
/** Absolute hour of index 0 in the raw Macromatix hourly arrays (the day-view grid starts ~5AM). */
const RAW_BASE_HOUR = 5;
/** Lunch/dinner boundary (3PM). */
const MEAL_SPLIT_HOUR = 15;

let times = [];
let TRADING_GRID_START_HOUR = 10;
let tradingCloseHour = 22;
/** First index of the dinner block within the trimmed hourly arrays (3PM column). */
let PART_LUNCH_END = 5;
let LUNCH_WALL_START = 10;
let LUNCH_WALL_END_EXCLUSIVE = MEAL_SPLIT_HOUR;
let DINNER_WALL_START = MEAL_SPLIT_HOUR;
/** Hours after close to keep hourly + meal-period colours (matches server SCRAPE_POST_CLOSE_RETAIN_HOURS). */
let postCloseGridColourHours = 2;

function setPostCloseGridColourHours(hours) {
    const n = Number(hours);
    if (Number.isFinite(n) && n >= 0) postCloseGridColourHours = Math.trunc(n);
}

function clampInt(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
}

/** Format a 24h hour (may exceed 24 for after-midnight closes) as 8AM / 1PM / 12AM. */
function hourLabel(hour) {
    const h = (((Math.trunc(hour) % 24) + 24) % 24);
    const period = h < 12 ? 'AM' : 'PM';
    const display = h % 12 === 0 ? 12 : h % 12;
    return `${display}${period}`;
}

/** Recompute grid columns and meal-period split for a store's open/close hours. */
function setTradingHours(open, close) {
    const openHour = Number.isFinite(open) ? Math.trunc(open) : 10;
    const closeHour = Number.isFinite(close) && close > openHour ? Math.trunc(close) : openHour + 12;
    TRADING_GRID_START_HOUR = openHour;
    tradingCloseHour = closeHour;
    const len = closeHour - openHour;
    times = Array.from({ length: len }, (_, i) => hourLabel(openHour + i));
    // Drive the CSS grid column count off the actual number of trading hours so the
    // grid stays aligned for any store (12h, 13h, etc.) — see --grid-hours in the CSS.
    if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.style.setProperty('--grid-hours', String(len));
    }
    PART_LUNCH_END = clampInt(MEAL_SPLIT_HOUR - openHour, 0, len);
    LUNCH_WALL_START = openHour;
    LUNCH_WALL_END_EXCLUSIVE = clampInt(MEAL_SPLIT_HOUR, openHour, closeHour);
    DINNER_WALL_START = clampInt(MEAL_SPLIT_HOUR, openHour, closeHour);
}

setTradingHours(10, 22);

function tradingEndHourExclusive() {
    return TRADING_GRID_START_HOUR + times.length;
}


/* -----------------------------------------------------------
   Sales data in memory — forecast and actual (filled by API)
----------------------------------------------------------- */
let forecastSales = [];
let liveSales = [];
/** True while the sales API request is in flight (first load shows placeholder grid). */
let salesDataLoading = false;
/** True after at least one sales payload has been applied for this page session. */
let salesDataLoadedOnce = false;
/** Display labels for vendors with scheduled orders still in Create / In Progress (no order #). */
let pendingVendors = [];
/** Vendors with stock-count catalogs ({ slug, label }). */
let stockCountVendors = [];
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

function vendorHasStockCount(label) {
    return stockCountVendors.some((v) => v.label === label);
}

function stockCountPathForVendor(label) {
    const entry = stockCountVendors.find((v) => v.label === label);
    if (!entry || !STORE_NUMBER) return null;
    return `/${STORE_NUMBER}/stock-count/${entry.slug}`;
}

/** One stock-count flow for all pending vendors (CombinedOrders branch). */
function combinedStockCountPath() {
    if (!STORE_NUMBER) return null;
    return combinedStockCountPathForStore(STORE_NUMBER, pendingVendors);
}

function visiblePendingVendorsForList(list) {
    const lastMondayMonth = isMelbourneLastMondayOfMonth();
    return (Array.isArray(list) ? list : []).filter((v) => {
        if (!lastMondayMonth && matchesLastMondayOnlyVendor(v)) return false;
        return true;
    });
}

function combinedStockCountPathForStore(storeNum, pendingList) {
    const num = String(storeNum || '').trim().toLowerCase();
    if (!num) return null;
    const visible = visiblePendingVendorsForList(pendingList);
    const hasCountable = visible.some((name) => vendorHasStockCount(name));
    if (!hasCountable) {
        if (!isMelbourneMonday() && !isMelbourneLastMondayOfMonth()) return null;
    }
    return `/${num}/stock-count/combined`;
}

function adminStockCountPickerOptions() {
    const options = [];
    for (const [num, slice] of adminAreaSalesCache) {
        const path = combinedStockCountPathForStore(num, slice.pendingVendors);
        if (!path) continue;
        const name = String(slice.storeName || num).trim();
        const visible = visiblePendingVendorsForList(slice.pendingVendors || []);
        let sub = 'Open stock count';
        if (visible.length) {
            sub = `${visible.length} vendor${visible.length === 1 ? '' : 's'} to count`;
        } else if (isMelbourneMonday()) {
            sub = 'Monday orders — open stock count';
        } else if (isMelbourneLastMondayOfMonth()) {
            sub = 'Monthly orders — open stock count';
        }
        options.push({
            id: num,
            label: name && name !== num ? `${num} — ${name}` : num,
            sub,
            href: path,
        });
    }
    return options.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
}

let adminStockCountPickerBound = false;

function bindAdminStockCountPicker() {
    if (adminStockCountPickerBound || !IS_ADMIN_AREA_DASHBOARD) return;
    adminStockCountPickerBound = true;
    document.addEventListener(
        'click',
        (event) => {
            const link = event.target.closest('a.pending-vendor-chip--combined');
            if (!link || !IS_ADMIN_AREA_DASHBOARD) return;
            const options = adminStockCountPickerOptions();
            if (options.length <= 1) return;
            event.preventDefault();
            window.AdminStorePicker?.open({
                title: 'Select store',
                hint: 'Choose a store to start stock count.',
                options,
                onPick: (_id, option) => {
                    if (option?.href) window.location.assign(option.href);
                },
            });
        },
        true
    );
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

/** Weekly audits with an in-app form — chip links to the audit page instead of dismiss-only. */
const AUDIT_FORM_ROUTES = {
    'Pest Walk': (store) => `/${store}/pest-walk`,
    'RGM Cleaning Checklist': (store) => `/${store}/rgm-cleaning`,
    'Period Safety Inspection': (store) => `/${store}/psi`,
};

const CORE_WEEKLY_AUDIT_LABELS = new Set(Object.keys(AUDIT_FORM_ROUTES));

function adminAreaNameForTacaudit() {
    if (!ADMIN_AREA_CODE) return '';
    const n = ADMIN_AREA_CODE.replace(/^A/i, '');
    return n ? `Area ${n}` : '';
}

function auditFormPath(label) {
    if (IS_ADMIN_STORE_DASHBOARD && STORE_NUMBER) {
        return (
            window.AppPaths?.tacauditAdminHub?.({
                area: adminAreaNameForTacaudit(),
            }) || null
        );
    }
    const route = AUDIT_FORM_ROUTES[label];
    if (route && STORE_NUMBER) return route(STORE_NUMBER);
    if (STORE_NUMBER && label && !CORE_WEEKLY_AUDIT_LABELS.has(label)) {
        return `/${STORE_NUMBER}/square-one`;
    }
    return null;
}

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

/** Melbourne instant for civil date used by Monday / last-Monday order rules. */
function getDashboardEffectiveInstant() {
    return new Date();
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
        const url = AUDIT_SCHEDULE_URL;
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
        const res = await fetch(auditsApiUrl());
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
        const res = await fetch(auditsApiUrl(), {
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
    if (Number.isFinite(data.openHour) && Number.isFinite(data.closeHour)) {
        setTradingHours(data.openHour, data.closeHour);
    }
    if (data.timeZone) {
        setDashboardTimeZone(data.timeZone);
    }
    if (data.postCloseRetainHours != null) {
        setPostCloseGridColourHours(data.postCloseRetainHours);
    }
    // Trim the raw Macromatix hourly arrays (index 0 ≈ RAW_BASE_HOUR) down to this store's trading window.
    const sliceStart = clampInt(TRADING_GRID_START_HOUR - RAW_BASE_HOUR, 0, Number.MAX_SAFE_INTEGER);
    const sliceEnd = tradingCloseHour - RAW_BASE_HOUR;
    forecastSales = Array.isArray(data.forecast) ? data.forecast.slice(sliceStart, sliceEnd) : [];
    liveSales = Array.isArray(data.actual) ? data.actual.slice(sliceStart, sliceEnd) : [];
    pendingVendors = Array.isArray(data.pendingVendors) ? data.pendingVendors : [];
    stockCountVendors = Array.isArray(data.stockCountVendors) ? data.stockCountVendors : [];
    for (const d of [...dismissedPendingVendors]) {
        if (!pendingVendors.includes(d)) dismissedPendingVendors.delete(d);
    }
    if (data.storeName || data.storeNumber) {
        currentStoreLabel = data.storeName || data.storeNumber;
        updateStoreHeader();
    }
    const upsellStore = data.storeNumber || STORE_NUMBER;
    if (upsellStore && typeof window.upsellingPodium?.init === 'function') {
        window.upsellingPodium.init(upsellStore);
    }
}

/** Reflect the current store in the header title and the browser tab. */
function updateStoreHeader() {
    const el = document.getElementById('store-label');
    if (el) el.textContent = currentStoreLabel ? `Store ${currentStoreLabel}` : '';
    if (currentStoreLabel) {
        document.title = `Sales Dashboard — ${currentStoreLabel}`;
    }
}

async function loadSalesData() {
    salesDataLoading = true;
    const areaTotalsVisible = document.body.classList.contains('admin-showing-area-totals');
    if (!salesDataLoadedOnce && !areaTotalsVisible) {
        updateGrid();
    }
    try {
        if (IS_ADMIN_AREA_DASHBOARD) {
            await loadAdminAreaSales();
            await refreshAdminAreaTotalsIfVisible();
            return;
        }

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
        updateTimestamp(data.timestamp);
        updateSalesStatus(data);
    } catch (err) {
        console.error('Failed to load sales data:', err);
        updateSalesStatus({ stale: true, warning: 'Unable to refresh sales data. If issue persists, contact Ash.' });
        const grid = document.querySelector('.dashboard-grid');
        if (grid && !salesDataLoadedOnce) {
            grid.innerHTML =
                '<div class="grid-error">Unable to load sales data. Let Ash know so he can sort something, it cannot be fixed if he is at work.</div>';
            pendingVendors = [];
            dismissedPendingVendors.clear();
            dismissedAudits.clear();
            auditPeriodKey = null;
            updatePendingVendorsPanel();
        }
    } finally {
        salesDataLoading = false;
        const areaTotalsVisible = document.body.classList.contains('admin-showing-area-totals');
        if (
            !areaTotalsVisible &&
            document.querySelector('.dashboard-grid') &&
            !document.querySelector('.grid-error')
        ) {
            salesDataLoadedOnce = true;
            updateGrid();
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
let lastTimestampShown = '';

function updateTimestamp(ts) {
    const el = document.getElementById('last-updated');
    if (!el) return;
    const date = new Date(ts);
    el.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: DASHBOARD_TIME_ZONE });
    if (lastTimestampShown && String(ts) !== lastTimestampShown) {
        el.classList.remove('top-info-value--updated');
        void el.offsetWidth;
        el.classList.add('top-info-value--updated');
    }
    lastTimestampShown = String(ts);
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

/* Popups — edit popup-timing.js (when/how long) and popup-content.js (text/icons) */
const iconMap = window.iconMap || {};
const POPUP_CONFIG = window.POPUP_CONFIG || {};

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
function showPopup(message, duration = POPUP_CONFIG.defaultSinglePopupMs ?? 10000, type = null, options = {}) {
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

function buildNotificationsMap() {
    const content = window.NOTIFICATION_CONTENT || {};
    const durations = window.NOTIFICATION_DURATIONS || {};
    const out = {};
    for (const key of Object.keys(content)) {
        const timing = durations[key] || {};
        out[key] = { ...content[key], ...timing };
    }
    return out;
}

function notificationDurationMs(key) {
    const durations = window.NOTIFICATION_DURATIONS || {};
    const d = durations[key];
    const defaultSec = durations._defaultSeconds ?? 15;
    if (!d) return defaultSec * 1000;
    if (typeof d.duration === 'number') return d.duration;
    if (typeof d.seconds === 'number') return d.seconds * 1000;
    return defaultSec * 1000;
}

const NOTIFICATIONS = buildNotificationsMap();
const SCHEDULE = window.SCHEDULE || [];
const BOILOUT_RULE = window.BOILOUT_RULE || {};

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
    const p = (window.NOTIFICATION_CONTENT || {})[key];
    if (!p) {
        console.warn('[Notifications] Unknown key — not in popup-content.js:', key);
        return null;
    }
    return {
        title: p.name,
        instruction: p.instruction || '',
        type: p.icon || null,
        duration: notificationDurationMs(key),
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
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
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

function melbourneHourMinuteSecond(d = new Date()) {
    const parts = new Intl.DateTimeFormat('en-AU', {
        timeZone: DASHBOARD_TIME_ZONE,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).formatToParts(d);
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    return {
        hour: get('hour'),
        minute: get('minute'),
        second: get('second'),
    };
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

function initPopupTestButton() {
    if (STORE_NUMBER !== 'teststore') return;
    let btn = document.getElementById('popup-test-btn');
    if (!btn) {
        btn = document.createElement('button');
        btn.id = 'popup-test-btn';
        btn.type = 'button';
        btn.textContent = 'Test popups';
        document.body.appendChild(btn);
    }
    btn.addEventListener('click', () => {
        const keys = Object.keys(NOTIFICATIONS);
        if (!keys.length) {
            showPopup('Add entries to popup-content.js', 8000, null, { wrapMessage: true });
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
}

window.showPopup = showPopup;
window.NOTIFICATIONS = NOTIFICATIONS;
window.showNotificationGroup = showNotificationGroup;
window.openNotificationCards = openNotificationCards;
window.registerSchedule = registerSchedule;

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
    const { hour, minute, second } = melbourneHourMinuteSecond();

    const startHour = TRADING_GRID_START_HOUR;
    const tradeEndHourExclusive = tradingEndHourExclusive();
    /** After close, keep hourly grid colours for postCloseGridColourHours (default 2h). */
    const gridColoursEndHourExclusive = tradeEndHourExclusive + postCloseGridColourHours;

    if (hour < startHour || hour >= gridColoursEndHourExclusive) {
        return { hourIndex: -1, progress: 0 };
    }

    if (hour >= tradeEndHourExclusive) {
        return { hourIndex: times.length, progress: 1 };
    }

    const hourIndex = hour - startHour;
    const progress = minute / 60 + second / 3600;

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

function buildHourlyDataCell({ index, hourProgress, forecast, actual, displayValue, portraitPastLive = false }) {
    const isFuture = index > hourProgress.hourIndex;
    if (isFuture) {
        return `<div class="grid-cell">${formatCurrency(displayValue)}</div>`;
    }

    const fn = Number(forecast) || 0;
    const an = Number(actual) || 0;
    const isCurrentHour = index === hourProgress.hourIndex && hourProgress.hourIndex >= 0;

    if (!isCurrentHour) {
        const cellClass = getActualCellClass(an, fn);
        if (portraitPastLive && cellClass) {
            const paceClass = fn > 0 ? getPaceClass(an, fn, 1) : 'cell-green';
            const layers = buildLiveProgressLayersHtml(100, cellClass, paceClass);
            const outcomeBorder = paceBorderMap[cellClass] || 'var(--blank-border)';
            return `<div class="grid-cell grid-cell--live-hour" style="border: var(--cell-border) ${outcomeBorder};">${layers}<span class="grid-cell-live-value">${formatCurrency(displayValue)}</span></div>`;
        }
        return `<div class="grid-cell${cellClass ? ` ${cellClass}` : ''}">${formatCurrency(displayValue)}</div>`;
    }

    // Current hour: the bar fills with wall-clock time through the hour (not by sales).
    // Colour still reflects pace/outcome, but width tracks time even once forecast is beaten.
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
function buildPlaceholderHourCell(extraClass = '') {
    const cls = extraClass ? ` grid-cell--placeholder ${extraClass}` : ' grid-cell--placeholder';
    return `<div class="grid-cell${cls}" aria-hidden="true"></div>`;
}

function buildLoadingForecastRow() {
    return `
        <div class="grid-label">Forecast Sales</div>
        ${times.map(() => buildPlaceholderHourCell()).join('')}
    `;
}

function buildLoadingActualRow() {
    return `
        <div class="grid-label">Actual Sales</div>
        ${times.map(() => buildPlaceholderHourCell()).join('')}
    `;
}

function buildLoadingMealPeriodRow() {
    const lunchSpanEnd = 2 + clampInt(PART_LUNCH_END, 0, times.length);
    const gridEnd = 2 + times.length;
    return `
        <div class="grid-label meal-period-label meal-period-day-sales-total">
            <div class="grid-cell grid-cell--placeholder meal-period-day-sales-placeholder"></div>
        </div>
        <div class="grid-cell grid-cell--placeholder meal-period-cell" style="grid-column: 2 / ${lunchSpanEnd}"></div>
        <div class="grid-cell grid-cell--placeholder meal-period-cell" style="grid-column: ${lunchSpanEnd} / ${gridEnd}"></div>
    `;
}

function buildLoadingGridContent() {
    return `
        ${buildHeaderRow()}
        ${buildLoadingForecastRow()}
        ${buildLoadingActualRow()}
        ${buildLoadingMealPeriodRow()}
        ${buildGridFooterRow()}
    `;
}

function buildLoadingPortraitHourRows() {
    return times
        .map(
            (time) => `
        <div class="grid-label portrait-hour-label">${time}</div>
        ${buildPlaceholderHourCell('portrait-data-cell')}
        ${buildPlaceholderHourCell('portrait-data-cell')}
    `
        )
        .join('');
}

function buildLoadingPortraitMealRows() {
    return `
        <div class="portrait-summary-box" role="region" aria-label="Lunch, dinner and day totals">
            <div class="portrait-summary-item">
                <div class="portrait-summary-item-label">Lunch</div>
                <div class="grid-cell grid-cell--placeholder portrait-summary-item-values"></div>
            </div>
            <div class="portrait-summary-item">
                <div class="portrait-summary-item-label">Dinner</div>
                <div class="grid-cell grid-cell--placeholder portrait-summary-item-values"></div>
            </div>
            <div class="portrait-summary-item">
                <div class="portrait-summary-item-label">Day Total</div>
                <div class="grid-cell grid-cell--placeholder portrait-summary-item-values"></div>
            </div>
        </div>
    `;
}

function buildLoadingPortraitGridContent() {
    return `
        ${buildLoadingPortraitMealRows()}
        ${buildPortraitHeaderRow()}
        ${buildLoadingPortraitHourRows()}
    `;
}

function shouldShowSalesLoadingGrid() {
    return salesDataLoading || !salesDataLoadedOnce;
}

function gridForecastValues() {
    return Array.from({ length: times.length }, (_, i) => Number(forecastSales[i]) || 0);
}

function gridActualValues() {
    return Array.from({ length: times.length }, (_, i) => Number(liveSales[i]) || 0);
}

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
   Lunch open–3PM (hourly slice + wall) | Dinner 3PM–close.
   The split indices/hours (PART_LUNCH_END, LUNCH_WALL_*, DINNER_WALL_START)
   are derived per store in setTradingHours().
----------------------------------------------------------- */

function sumHourSlice(values, start, end) {
    return values.slice(start, end).reduce((sum, v) => sum + (Number(v) || 0), 0);
}

function getWallClockPeriodProgress(startHour, endHourExclusive) {
    const { hour, minute, second } = melbourneHourMinuteSecond();
    const nowHourFloat = hour + minute / 60 + second / 3600;
    if (nowHourFloat <= startHour) return 0;
    if (nowHourFloat >= endHourExclusive) return 1;
    return (nowHourFloat - startHour) / (endHourExclusive - startHour);
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
    const { hour, minute, second } = melbourneHourMinuteSecond();
    const nowHourFloat = hour + minute / 60 + second / 3600;
    const wallPct = Math.round(getWallClockPeriodProgress(wallStartHour, wallEndHourExclusive) * 1000) / 10;

    if (nowHourFloat < wallStartHour) {
        return { phase: 'before', cellClass: '', inlineStyle: '', liveLayersHtml: '', outcomeBorderColor: '' };
    }

    if (nowHourFloat >= wallEndHourExclusive) {
        const finalClass = totalForecast > 0 ? getActualCellClass(totalActual, totalForecast) : 'cell-green';
        const paceClass =
            totalForecast > 0 ? getPaceClass(totalActual, totalForecast, 1) : 'cell-green';
        const liveLayersHtml = buildLiveProgressLayersHtml(100, finalClass, paceClass);
        return {
            phase: 'after',
            cellClass: finalClass,
            inlineStyle: '',
            liveLayersHtml,
            outcomeBorderColor: paceBorderMap[finalClass] || 'var(--blank-border)',
        };
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

    // During the period the bar fills with wall-clock time (10–3 lunch, 3–close dinner),
    // not by sales — so it never snaps to full just because forecast was beaten.
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

    // Grid line 1 = day-part label cell, hour columns start at line 2. Lunch spans the
    // hours before 3PM (PART_LUNCH_END of them), dinner spans the rest — derived from the
    // store's trading hours so a 12h or 13h store both stay aligned.
    const lunchSpanEnd = 2 + clampInt(PART_LUNCH_END, 0, times.length);
    const gridEnd = 2 + times.length;
    const lunchStyleAttr = [
        `grid-column: 2 / ${lunchSpanEnd}`,
        lunchPres.inlineStyle,
        lunchPres.outcomeBorderColor ? `border: var(--cell-border) ${lunchPres.outcomeBorderColor}` : '',
    ]
        .filter(Boolean)
        .join('; ');
    const dinnerStyleAttr = [
        `grid-column: ${lunchSpanEnd} / ${gridEnd}`,
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

function isPortraitMobileView() {
    return window.matchMedia('(max-width: 900px) and (orientation: portrait)').matches;
}

/** Portrait phone tab: dashboard | audits | orders */
let portraitTab = 'dashboard';

function buildPortraitTabsHtml() {
    const tabs = [
        { id: 'dashboard', label: 'Dashboard' },
        { id: 'audits', label: 'Audits' },
        { id: 'orders', label: 'Orders' },
    ];
    return `
        <nav class="dashboard-portrait-tabs" role="tablist" aria-label="Dashboard sections">
            ${tabs
                .map((tab) => {
                    const active = portraitTab === tab.id;
                    return `<button type="button" class="dashboard-portrait-tab${active ? ' dashboard-portrait-tab--active' : ''}"
                        role="tab" id="portrait-tab-${tab.id}" data-portrait-tab="${tab.id}"
                        aria-selected="${active ? 'true' : 'false'}" aria-controls="portrait-panel-${tab.id}">
                        ${tab.label}
                    </button>`;
                })
                .join('')}
        </nav>
    `;
}

function applyPortraitTabVisibility() {
    const portrait = isPortraitMobileView();
    const grid = document.querySelector('.dashboard-grid');
    const auditsPanel = document.getElementById('portrait-panel-audits');
    const ordersPanel = document.getElementById('portrait-panel-orders');
    const header = document.querySelector('.dashboard-header');
    const chrome = document.querySelector('.dashboard-portrait-chrome');

    if (!portrait) {
        document.body.removeAttribute('data-portrait-tab');
        chrome?.setAttribute('hidden', '');
        header?.removeAttribute('hidden');
        grid?.removeAttribute('hidden');
        auditsPanel?.setAttribute('hidden', '');
        ordersPanel?.setAttribute('hidden', '');
        return;
    }

    document.body.setAttribute('data-portrait-tab', portraitTab);
    chrome?.removeAttribute('hidden');

    document.querySelectorAll('.dashboard-portrait-tab').forEach((btn) => {
        const active = btn.getAttribute('data-portrait-tab') === portraitTab;
        btn.classList.toggle('dashboard-portrait-tab--active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    if (grid) grid.hidden = portraitTab !== 'dashboard';
    if (auditsPanel) auditsPanel.hidden = portraitTab !== 'audits';
    if (ordersPanel) ordersPanel.hidden = portraitTab !== 'orders';
    if (header) header.hidden = portraitTab !== 'dashboard';
}

function bindPortraitTabsOnce() {
    if (bindPortraitTabsOnce._bound) return;
    bindPortraitTabsOnce._bound = true;
    app.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-portrait-tab]');
        if (!btn || !isPortraitMobileView()) return;
        const next = btn.getAttribute('data-portrait-tab');
        if (!next || next === portraitTab) return;
        portraitTab = next;
        applyPortraitTabVisibility();
    });
}

function updatePortraitAuditsEmptyState(visibleCount) {
    const emptyEl = document.getElementById('portrait-audits-empty');
    const listWrap = document.querySelector('#portrait-panel-audits .portrait-tab-aside');
    if (!emptyEl || !listWrap) return;
    const empty = visibleCount === 0;
    emptyEl.hidden = !empty;
    listWrap.hidden = empty;
}

function updatePortraitOrdersEmptyState(hasContent) {
    const emptyEl = document.getElementById('portrait-orders-empty');
    const listWrap = document.querySelector('#portrait-panel-orders .portrait-tab-aside');
    if (!emptyEl || !listWrap) return;
    emptyEl.hidden = hasContent;
    listWrap.hidden = !hasContent;
}

function portraitCellClass(html, extra = '') {
    const add = extra ? ` portrait-data-cell ${extra}` : ' portrait-data-cell';
    return html.replace(/class="grid-cell([^"]*)"/, `class="grid-cell${add}$1"`);
}

function buildPortraitHeaderRow() {
    return `
        <div class="grid-cell header-cell portrait-header portrait-header--time">Time</div>
        <div class="grid-cell header-cell portrait-header portrait-header--actual">Actual</div>
        <div class="grid-cell header-cell portrait-header portrait-header--forecast">Forecast</div>
    `;
}

function buildPortraitHourRows() {
    const hourProgress = getCurrentHourProgress();
    const forecasts = gridForecastValues();
    const actuals = gridActualValues();
    return times
        .map((time, index) => {
            const forecastCell = portraitCellClass(
                buildHourlyDataCell({
                    index,
                    hourProgress,
                    forecast: forecasts[index],
                    actual: actuals[index],
                    displayValue: forecasts[index],
                    portraitPastLive: true,
                })
            );
            const actualCell = portraitCellClass(
                buildHourlyDataCell({
                    index,
                    hourProgress,
                    forecast: forecasts[index],
                    actual: actuals[index],
                    displayValue: actuals[index],
                    portraitPastLive: true,
                })
            );
            return `
                <div class="grid-label portrait-hour-label">${time}</div>
                ${actualCell}
                ${forecastCell}
            `;
        })
        .join('');
}

function portraitSummaryItemStatusClass(pres, actual, forecast) {
    if (pres?.liveLayersHtml) return '';
    if (pres?.phase === 'before' || pres?.phase === 'during') return '';
    if (pres?.phase === 'after' && pres.cellClass) return pres.cellClass;
    if (Number(forecast) > 0) return getActualCellClass(actual, forecast);
    return 'cell-green';
}

function getDayTotalPresentation(forecasts, actuals) {
    const dayForecast = sumHourSlice(forecasts, 0, times.length);
    const dayActual = sumHourSlice(actuals, 0, times.length);
    const wallStart = LUNCH_WALL_START;
    const wallEnd = tradingEndHourExclusive();
    const { hour, minute, second } = melbourneHourMinuteSecond();
    const nowHourFloat = hour + minute / 60 + second / 3600;
    const mainClass = dayForecast > 0 ? getActualCellClass(dayActual, dayForecast) : 'cell-green';

    if (nowHourFloat < wallStart) {
        return { phase: 'before', cellClass: '', liveLayersHtml: '', outcomeBorderColor: '' };
    }

    const hourProgress = getCurrentHourProgress();
    const expectedSoFar = getPeriodExpectedSoFarSlice(forecasts, 0, times.length, hourProgress);
    const actualSoFar = getPeriodActualSoFarSlice(actuals, 0, times.length, hourProgress);
    const elapsed = dayForecast > 0 ? expectedSoFar / dayForecast : 0;
    const paceClass =
        dayForecast <= 0 ? 'cell-green' : expectedSoFar <= 0 ? 'cell-green' : getPaceClass(actualSoFar, dayForecast, elapsed);

    const wallPct = Math.round(getWallClockPeriodProgress(wallStart, wallEnd) * 1000) / 10;
    const fillPct = nowHourFloat >= wallEnd ? 100 : wallPct;
    const phase = nowHourFloat >= wallEnd ? 'after' : 'during';
    const liveLayersHtml = buildLiveProgressLayersHtml(fillPct, mainClass, paceClass);

    return {
        phase,
        cellClass: phase === 'after' ? mainClass : '',
        liveLayersHtml,
        outcomeBorderColor: paceBorderMap[mainClass] || 'var(--blank-border)',
    };
}

function buildPortraitSummaryItem(label, actual, forecast, pres = null, extraClass = '') {
    const liveHtml = pres?.liveLayersHtml || '';
    const statusClass = portraitSummaryItemStatusClass(pres, actual, forecast);
    const borderStyle = pres?.outcomeBorderColor
        ? ` style="border: var(--cell-border) ${pres.outcomeBorderColor}"`
        : '';
    return `
        <div class="portrait-summary-item ${extraClass}">
            <div class="portrait-summary-item-label">${label}</div>
            <div class="portrait-summary-item-values ${statusClass}${liveHtml ? ' portrait-summary-item-values--live' : ''}"${borderStyle}>
                ${liveHtml}
                <div class="portrait-summary-item-amount">${formatCurrency(actual)} / ${formatCurrency(forecast)}</div>
            </div>
        </div>
    `;
}

function buildPortraitMealRows(forecasts, actuals) {
    const lunchForecast = sumHourSlice(forecasts, 0, PART_LUNCH_END);
    const lunchActual = sumHourSlice(actuals, 0, PART_LUNCH_END);
    const dinnerForecast = sumHourSlice(forecasts, PART_LUNCH_END, times.length);
    const dinnerActual = sumHourSlice(actuals, PART_LUNCH_END, times.length);
    const dayForecast = sumHourSlice(forecasts, 0, times.length);
    const dayActual = sumHourSlice(actuals, 0, times.length);
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
    const dayPres = getDayTotalPresentation(forecasts, actuals);

    return `
        <div class="portrait-summary-box" role="region" aria-label="Lunch, dinner and day totals">
            ${buildPortraitSummaryItem('Lunch', lunchActual, lunchForecast, lunchPres)}
            ${buildPortraitSummaryItem('Dinner', dinnerActual, dinnerForecast, dinnerPres)}
            ${buildPortraitSummaryItem('Day Total', dayActual, dayForecast, dayPres)}
        </div>
    `;
}

function buildPortraitGridContent() {
    const forecasts = gridForecastValues();
    const actuals = gridActualValues();
    return `
        ${buildPortraitMealRows(forecasts, actuals)}
        ${buildPortraitHeaderRow()}
        ${buildPortraitHourRows()}
    `;
}

let lastPortraitLayout = null;

function syncDashboardLayoutMode() {
    const portrait = isPortraitMobileView();
    document.body.classList.toggle('dashboard--portrait', portrait);
    document.body.classList.toggle(
        'dashboard--mobile-landscape',
        window.matchMedia('(max-width: 900px) and (orientation: landscape)').matches
    );
    return portrait;
}

function onDashboardLayoutChange() {
    if (typeof window.upsellingPodium?.onLayoutChange === 'function') {
        window.upsellingPodium.onLayoutChange();
    }
    applyDashboardScale();
    updateRotateHint();
    const wasPortrait = lastPortraitLayout === true;
    const portrait = syncDashboardLayoutMode();
    if (portrait && !wasPortrait) {
        portraitTab = 'dashboard';
    }
    if (!portrait) {
        applyPortraitTabVisibility();
    }
    if (portrait === lastPortraitLayout) return;
    lastPortraitLayout = portrait;
    const grid = document.querySelector('.dashboard-grid');
    if (!grid) return;
    if (salesDataLoadedOnce && !salesDataLoading) {
        updateGrid();
    } else {
        showGridSkeleton();
    }
    applyPortraitTabVisibility();
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
    const visible = getVisibleAudits();
    const html = visible.length
        ? visible
              .map((name) => {
                  const formPath = auditFormPath(name);
                  if (formPath) {
                      const auditAction = IS_ADMIN_STORE_DASHBOARD ? 'View' : 'Start';
                      return `<div class="audit-item"><a class="audit-chip audit-chip--link" href="${escapeHtml(formPath)}" aria-label="${auditAction} ${escapeHtml(name)}">${escapeHtml(name)}</a></div>`;
                  }
                  return `<div class="audit-item"><button type="button" class="audit-chip" data-audit="${encodeURIComponent(
                      name
                  )}" aria-label="Mark ${escapeHtml(name)} as done">${escapeHtml(name)}</button></div>`;
              })
              .join('')
        : '';

    for (const id of ['audits-list-panel', 'portrait-audits-list-panel']) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
    }
    updatePortraitAuditsEmptyState(visible.length);
}

function updatePendingVendorsPanel() {
    const visible = getVisiblePendingVendors();
    const monday = isMelbourneMonday();
    const lastMondayMonth = isMelbourneLastMondayOfMonth();
    const hasOrdersContent = visible.length > 0 || monday || lastMondayMonth;

    const mondayHtml = monday ? mondayCashOrderReminderHtml() : '';
    const lastMondayHtml = lastMondayMonth ? lastMondayMonthlyOrdersReminderHtml() : '';
    const combinedPath = combinedStockCountPath();
    const combinedChipHtml = combinedPath
        ? `<div class="pending-vendor-item pending-vendor-item--combined"><a class="pending-vendor-chip pending-vendor-chip--link pending-vendor-chip--combined" href="${escapeHtml(combinedPath)}" aria-label="Start combined stock count for all vendors today">Stock count</a></div>`
        : '';
    const chipsHtml = visible.length
        ? combinedChipHtml +
          visible
              .map((name) => {
                  if (combinedPath) {
                      return `<div class="pending-vendor-item"><span class="pending-vendor-chip pending-vendor-chip--order">${escapeHtml(name)}</span></div>`;
                  }
                  const stockPath = stockCountPathForVendor(name);
                  if (stockPath) {
                      return `<div class="pending-vendor-item"><a class="pending-vendor-chip pending-vendor-chip--link" href="${escapeHtml(stockPath)}" aria-label="Start stock count for ${escapeHtml(name)}">${escapeHtml(name)}</a></div>`;
                  }
                  return `<div class="pending-vendor-item"><span class="pending-vendor-chip pending-vendor-chip--order">${escapeHtml(name)}</span></div>`;
              })
              .join('')
        : combinedChipHtml;

    const html = hasOrdersContent ? mondayHtml + lastMondayHtml + chipsHtml : '';

    for (const id of ['pending-vendors-panel', 'portrait-pending-vendors-panel']) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
    }
    updatePortraitOrdersEmptyState(hasOrdersContent);
}

function handleFooterChipDismissClick(e) {
    if (e.target.closest('a.pending-vendor-chip--link')) return;
    if (e.target.closest('a.audit-chip--link')) return;

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
            updateAuditsPanel();
            const panel = document.getElementById('audits-list-panel');
            const aside = panel?.closest('.audits-aside');
            if (panel && panel.children.length === 0 && aside && !aside.classList.contains('portrait-tab-aside')) {
                aside.closest('.dashboard-grid-footer-lead')?.remove();
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
    const onTrack = document.body.classList.contains('color-blind-mode') ? 'Blue' : 'Green';
    return `
        <div class="dashboard-colour-note">
            <strong>Colour guide:</strong>
            <strong>Red:</strong> Not on track. <strong>Yellow:</strong> Almost on track (90%). <strong>${onTrack}:</strong> On track.
            <br>
            <strong>Current hour</strong> fills with time indicates actual sales vs forecast; the <strong>bottom strip</strong> fills with time and indicates if you are "on track" to meet sales at this minute.
        </div>
    `;
}

async function applyUserPreferences() {
    if (shouldShowDashboardSettings() && window.MicSettings?.initPreferences) {
        return window.MicSettings.initPreferences();
    }
    try {
        const res = await fetch(withStore(`${window.location.origin}/api/me`), { credentials: 'include' });
        if (!res.ok) return;
        const me = await res.json();
        if (me.success && me.colorBlind) {
            document.body.classList.add('color-blind-mode');
            document.documentElement.classList.add('color-blind-mode');
        }
    } catch {
        /* ignore */
    }
}

function bindDashboardSettings() {
    if (!shouldShowDashboardSettings() || !window.MicSettings) return;
    window.MicSettings.bind({
        getViewAccountsOptions: () => (IS_ADMIN_STORE_DASHBOARD ? { isAdmin: true, storeNumber: STORE_NUMBER || '' } : { storeNumber: STORE_NUMBER || '' }),
        storeNumber: STORE_NUMBER || '',
    });
    window.AdminMenu?.bind?.({
        getViewAccountsOptions: () => (IS_ADMIN_STORE_DASHBOARD ? { isAdmin: true, storeNumber: STORE_NUMBER || '' } : { storeNumber: STORE_NUMBER || '' }),
    });
    window.AdminAccounts?.maybeOpenFromQuery?.();
}

function renderDashboardSettingsChrome() {
    if (!shouldShowDashboardSettings() || !window.MicSettings) return '';
    return `
        ${window.MicSettings.renderCog()}
        ${window.MicSettings.renderPanel({
            adminMenuHidden: true,
            darkModeHint: 'Dark background on dashboard pages that support it.',
            storeNumber: STORE_NUMBER || '',
        })}
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
    if (isPortraitMobileView()) {
        return '';
    }

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

function showGridSkeleton() {
    const grid = document.querySelector('.dashboard-grid');
    if (!grid) return;

    syncAuditPeriodState();
    syncDashboardLayoutMode();
    grid.classList.remove('dashboard-grid--skeleton');
    grid.classList.toggle('dashboard-grid--portrait', isPortraitMobileView());
    grid.classList.toggle('dashboard-grid--loading', true);
    grid.setAttribute('aria-busy', 'true');
    grid.innerHTML = isPortraitMobileView() ? buildLoadingPortraitGridContent() : buildLoadingGridContent();
    updateAuditsPanel();
    updatePendingVendorsPanel();
    applyPortraitTabVisibility();
}

function updateGrid() {
    const grid = document.querySelector('.dashboard-grid');
    if (!grid) return;

    syncAuditPeriodState();
    syncDashboardLayoutMode();

    grid.classList.remove('dashboard-grid--skeleton', 'dashboard-grid--loading');

    if (shouldShowSalesLoadingGrid()) {
        grid.classList.toggle('dashboard-grid--portrait', isPortraitMobileView());
        grid.classList.add('dashboard-grid--loading');
        grid.setAttribute('aria-busy', 'true');
        grid.innerHTML = isPortraitMobileView() ? buildLoadingPortraitGridContent() : buildLoadingGridContent();
        updateAuditsPanel();
        updatePendingVendorsPanel();
        applyPortraitTabVisibility();
        return;
    }

    grid.classList.toggle('dashboard-grid--portrait', isPortraitMobileView());
    grid.removeAttribute('aria-busy');

    const forecasts = gridForecastValues();
    const actuals = gridActualValues();

    grid.innerHTML = isPortraitMobileView()
        ? buildPortraitGridContent()
        : `
        ${buildHeaderRow()}
        ${buildForecastRow(forecasts, actuals)}
        ${buildActualRow(actuals, forecasts)}
        ${buildMealPeriodRow(forecasts, actuals)}
        ${buildGridFooterRow()}
    `;
    updateAuditsPanel();
    updatePendingVendorsPanel();
    applyPortraitTabVisibility();
}

/* -----------------------------------------------------------
   First paint — dashboard layout, header, empty grid, popup mount point
----------------------------------------------------------- */
function renderDashboard() {
    app.classList.remove('app-boot-loading');
    app.removeAttribute('aria-busy');
    app.innerHTML = `
        <div id="rotate-hint" class="rotate-hint" hidden aria-hidden="true">
            <div class="rotate-hint-card">
                <div class="rotate-hint-icon" aria-hidden="true">↻</div>
                <h2>Rotate to landscape</h2>
                <p>The sales grid is built for a wide view. Turn your phone sideways for the best layout.</p>
                <a class="rotate-hint-back" href="${IS_ADMIN_STORE_DASHBOARD ? (window.AppPaths?.overview?.() || '/overview') : '/'}">← ${
                    IS_ADMIN_STORE_DASHBOARD ? 'Admin overview' : 'All stores'
                }</a>
            </div>
        </div>
        <div class="dashboard${IS_ADMIN_STORE_DASHBOARD ? ' dashboard--admin-store' : ''}">
            ${
                IS_ADMIN_STORE_DASHBOARD
                    ? '<div class="nav-back-host" id="admin-store-nav-back"></div>'
                    : ''
            }
            <div class="dashboard-portrait-chrome" hidden>
                ${buildPortraitTabsHtml()}
            </div>
            ${
                IS_ADMIN_STORE_DASHBOARD
                    ? ''
                    : `
            <div class="dashboard-header">
                <div class="dashboard-title">
                    <div class="dashboard-title-desktop">
                        <h1>SALES DASHBOARD</h1>
                        <p class="subtitle">Real-time sales data updated automatically.</p>
                    </div>
                    <p id="store-label" class="store-label">${currentStoreLabel ? `Store ${currentStoreLabel}` : ''}</p>
                </div>
                <div class="top-info">
                    <div class="nav-back-host" id="dashboard-nav-back"></div>
                    <div class="top-info-group">
                        <span class="top-info-label">Current Time</span>
                        <span id="time-display" class="top-info-value">${formatTime(new Date())}</span>
                    </div>
                    <div class="top-info-group" style="text-align: center;">
                        <span class="top-info-label">Last updated</span>
                        <span id="last-updated" class="top-info-value">--:--</span>
                    </div>
                </div>
            </div>`
            }
            ${
                IS_ADMIN_STORE_DASHBOARD
                    ? `
            <span id="time-display" class="dashboard-admin-clock-sink" hidden aria-hidden="true">${formatTime(new Date())}</span>
            <span id="last-updated" class="dashboard-admin-clock-sink" hidden aria-hidden="true">--:--</span>
            <p id="store-label" class="store-label" hidden aria-hidden="true"></p>`
                    : ''
            }

            <div id="sales-status" class="sales-status" role="status" aria-live="polite" hidden></div>
            <div id="audit-schedule-status" class="audit-schedule-status" role="alert" aria-live="assertive" hidden></div>

            ${
                IS_ADMIN_AREA_DASHBOARD
                    ? `<div id="admin-store-view">`
                    : ''
            }

            <div class="dashboard-grid" id="portrait-panel-dashboard"></div>

            <div id="portrait-panel-audits" class="portrait-tab-panel" role="tabpanel" aria-labelledby="portrait-tab-audits" hidden>
                <div class="audits-aside portrait-tab-aside" role="region" aria-label="List of audits">
                    <div class="audits-heading">List of Audits</div>
                    <div id="portrait-audits-list-panel" class="audits-list" aria-live="polite"></div>
                </div>
                <p id="portrait-audits-empty" class="portrait-tab-empty" hidden>No audits scheduled right now.</p>
            </div>

            <div id="portrait-panel-orders" class="portrait-tab-panel" role="tabpanel" aria-labelledby="portrait-tab-orders" hidden>
                <div class="pending-vendors-aside portrait-tab-aside" role="region" aria-label="Orders to place from Macromatix">
                    <div class="pending-vendors-heading">Orders to place</div>
                    <div id="portrait-pending-vendors-panel" class="pending-vendors-list" aria-live="polite"></div>
                </div>
                <p id="portrait-orders-empty" class="portrait-tab-empty" hidden>No orders to place right now.</p>
            </div>

            ${
                IS_ADMIN_AREA_DASHBOARD
                    ? `</div>
            <div id="admin-area-view" hidden>
                <div id="admin-area-grids" class="area-grid-stack"></div>
                <div class="dashboard-grid-footer admin-area-footer">
                    <div class="dashboard-grid-footer-ledger">
                        <div class="dashboard-grid-footer-lead">
                            <div class="audits-aside" role="region" aria-label="Stores with audits outstanding">
                                <div class="audits-heading">List of Audits</div>
                                <div id="admin-area-audits-list" class="audits-list" aria-live="polite"></div>
                            </div>
                        </div>
                        <p class="dashboard-colour-note">
                            Area view groups stores by timezone/state and sums forecast/actual by local trading hour. Click the active area name again to return to a store.
                        </p>
                        <div class="dashboard-grid-footer-trail">
                            <div class="pending-vendors-aside" role="region" aria-label="Stores with orders outstanding">
                                <div class="pending-vendors-heading">Orders to place</div>
                                <div id="admin-area-orders-list" class="pending-vendors-list" aria-live="polite"></div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>`
                    : ''
            }

            <div id="popup-container"></div>
        </div>
        ${renderDashboardSettingsChrome()}
    `;
    bindFooterChipDismissOnce();
    bindPortraitTabsOnce();
    // bindOrderDateTestPanelOnce();
    applyDashboardScale();
    updateRotateHint();
    showGridSkeleton();
    applyPortraitTabVisibility();
    bindDashboardSettings();
    if (STORE_NUMBER && typeof window.upsellingPodium?.init === 'function') {
        window.upsellingPodium.init(STORE_NUMBER);
    }
    const isKioskEntry = isKioskDashboardEntry();
    const isMicStoreEntry =
        !isKioskEntry &&
        (IS_MIC_STORE_DASHBOARD ||
            document.cookie.split(';').some((c) => c.trim() === 'dashboard_entry=store') ||
            /^\/MIC\/(teststore|\d{3,6})\/?$/i.test(window.location.pathname) ||
            /^\/\d{3,6}\/?$/i.test(window.location.pathname) ||
            /^\/teststore\/?$/i.test(window.location.pathname));
    if (STORE_NUMBER && window.DashboardNavBack) {
        if (IS_ADMIN_STORE_DASHBOARD) {
            window.DashboardNavBack.mountBackButton(document.getElementById('admin-store-nav-back'), {
                fallback: window.AppPaths?.adminOverview?.() || '/Admin/Overview',
                alwaysFallback: true,
            });
        } else if (isMicStoreEntry) {
            window.DashboardNavBack.mountBackButton(document.getElementById('dashboard-nav-back'), {
                fallback: window.AppPaths?.overview?.() || '/overview',
                alwaysFallback: true,
            });
        } else if (!isKioskEntry) {
            window.DashboardNavBack.mountBackButton(document.getElementById('dashboard-nav-back'), {
                fallback: window.AppPaths?.overview?.() || '/overview',
                alwaysFallback: true,
                fadeToStores: true,
            });
        }
    }

    if (IS_ADMIN_STORE_DASHBOARD) {
        document.body.classList.add('dashboard-page--admin-store');
        window.AdminStoreTabs?.mount?.(STORE_NUMBER, { areaCode: ADMIN_AREA_CODE });
    }
}

/* -----------------------------------------------------------
   Timer — keep header clock in sync (1s interval)
----------------------------------------------------------- */
setInterval(updateClock, 1000);

/* Rebuild grid on a short cadence so day-part / current-hour fill tracks wall clock between sales API polls */
const GRID_PROGRESS_REFRESH_MS = 10000;
setInterval(() => {
    if (salesDataLoadedOnce && !salesDataLoading && document.querySelector('.dashboard-grid')) {
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

/** Load this store's trading hours (from .storelist via /api/stores) before the first render. */
async function initTradingHours() {
    try {
        const res = await fetch(withStore(`${window.location.origin}/api/stores`), { credentials: 'include' });
        if (!res.ok) return;
        const data = await res.json();
        const stores = Array.isArray(data.stores) ? data.stores : [];
        const target = STORE_NUMBER
            ? stores.find((s) => String(s.storeNumber).toLowerCase() === STORE_NUMBER)
            : stores.find((s) => String(s.storeNumber) === String(data.defaultStore)) || stores[0];
        if (target && Number.isFinite(target.openHour) && Number.isFinite(target.closeHour)) {
            setTradingHours(target.openHour, target.closeHour);
            setDashboardTimeZone(target.timeZone);
            if (target.storeName || target.storeNumber) {
                currentStoreLabel = target.storeName || target.storeNumber;
            }
        }
    } catch (err) {
        console.warn('Failed to load store hours:', err);
    }
}

/**
 * Fit the 1920×1080 dashboard design to the viewport.
 * Desktop: scale typography/spacing via --dashboard-scale.
 * Mobile: scale to viewport width and allow vertical scroll so the footer
 * (audits / orders) is not clipped by Safari's bottom toolbar.
 */
function getMobileLayoutHeight() {
    const vv = window.visualViewport;
    const height = vv?.height ?? window.innerHeight;
    const standalone =
        window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    if (standalone) return height;
    return Math.max(height - 52, height * 0.88);
}

function applyDashboardScale() {
    syncDashboardLayoutMode();
    const portrait = isPortraitMobileView();
    const mobile = window.matchMedia('(max-width: 900px)').matches;
    const viewW = window.visualViewport?.width ?? window.innerWidth;
    const viewH = getMobileLayoutHeight();
    const dash = document.querySelector('.dashboard');
    const isAdminStore = document.body.classList.contains('dashboard-page--admin-store');
    const chromeOffset = isAdminStore ? 110 : 0;
    const layoutH = Math.max(320, viewH - chromeOffset);

    if (portrait) {
        const portraitScale = Math.min(viewW / 400, layoutH / 820, 1);
        document.documentElement.style.setProperty(
            '--dashboard-scale',
            String(Math.max(0.72, portraitScale))
        );
        if (dash) {
            dash.style.zoom = '';
            dash.style.width = '';
            dash.style.maxWidth = '';
            dash.style.marginLeft = '';
            dash.style.marginRight = '';
        }
        return;
    }

    const ratio = Math.min(viewW / 1920, layoutH / 1080);
    const minScale = mobile ? 0.28 : 0.55;
    const scale = Math.max(minScale, Math.min(ratio, 1));

    if (mobile) {
        document.documentElement.style.setProperty('--dashboard-scale', '1');
        if (dash) {
            dash.style.zoom = String(scale);
            dash.style.width = '1920px';
            dash.style.maxWidth = 'none';
            dash.style.marginLeft = 'auto';
            dash.style.marginRight = 'auto';
        }
    } else {
        document.documentElement.style.setProperty('--dashboard-scale', String(scale));
        if (dash) {
            dash.style.zoom = '';
            dash.style.width = '';
            dash.style.maxWidth = '';
            dash.style.marginLeft = '';
            dash.style.marginRight = '';
        }
    }
}

const LANDSCAPE_PREF_KEY = 'dashboard-prefer-landscape';

function isMobileDashboardView() {
    return window.matchMedia('(max-width: 900px), (max-height: 520px) and (pointer: coarse)').matches;
}

function updateRotateHint() {
    const hint = document.getElementById('rotate-hint');
    if (!hint) return;
    hint.hidden = true;
    hint.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('rotate-hint-active');
}

async function tryLockLandscape() {
    if (!screen.orientation?.lock) return;
    try {
        await screen.orientation.lock('landscape');
    } catch {
        /* Browsers only allow lock in fullscreen/PWA — rotate hint is the fallback. */
    }
}

function initMobileLandscape() {
    if (STORE_NUMBER) {
        try {
            if (sessionStorage.getItem(LANDSCAPE_PREF_KEY) !== '1') {
                sessionStorage.setItem(LANDSCAPE_PREF_KEY, '1');
            }
        } catch {
            /* ignore */
        }
    }

    updateRotateHint();
    window.addEventListener('orientationchange', onDashboardLayoutChange);
    window.addEventListener('resize', onDashboardLayoutChange);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', onDashboardLayoutChange);
    }
}

/* -----------------------------------------------------------
   Boot — render dashboard shell, then start clock & sales sync
----------------------------------------------------------- */
(async () => {
    syncDashboardLayoutMode();
    lastPortraitLayout = isPortraitMobileView();
    applyDashboardScale();
    renderDashboard();
    bindAdminStockCountPicker();
    if (IS_ADMIN_AREA_DASHBOARD) {
        showGridSkeleton();
        try {
            await loadAdminAreaSales();
            window.AdminAreaPanel?.preload?.(ADMIN_AREA_CODE);
            if (wantsAdminAreaTotalsView()) {
                await showAdminAreaTotals();
            } else {
                setAdminAreaTotalsUrl(false);
            }
        } catch (err) {
            console.error('Failed to load admin area sales:', err);
            updateSalesStatus({
                stale: true,
                warning: 'Unable to load area sales. If issue persists, contact Ash.',
            });
        }
    } else {
        await initTradingHours();
        showGridSkeleton();
    }
    await applyUserPreferences();
    initPopupTestButton();
    initMobileLandscape();
    await loadAuditSchedule();
    if (!IS_ADMIN_AREA_DASHBOARD) {
        await loadAuditState();
    }
    if (STORE_NUMBER) {
        window.StockCountNotify?.initPipelineWatcher?.(STORE_NUMBER);
    }
    startSyncedUpdates();
})();