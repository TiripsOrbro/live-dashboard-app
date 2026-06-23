/**
 * Area / market scoped MIC overview - used by mic-dashboard.js for non-store scopes.
 */
(function (global) {
    const REFRESH_MS = 2 * 60 * 1000;
    const SCRAPE_POLL_MS = 15 * 1000;
    const TIME_ZONE = 'Australia/Melbourne';
    const VOC_PLACEHOLDER = { count: 30, osatPercent: 83, accuracyPercent: 90 };
    const SMG_REPORTING_URL = 'https://reporting.smg.com/Index.aspx';
    const DEFAULT_AREA = 'Area 22';
    const MARKET_LABEL = 'Market 1';
    const MIC_TAB_STORAGE_KEY = 'mic-overview-active-tab';
    const DAILY_COUNT_STORE_KEY = 'daily-count-store';

    let app = null;
    let meProfile = null;
    let overviewData = null;
    let dfscStatus = null;
    let areaIndex = 0;
    let marketViewActive = false;
    let lastSalesUpdatedAt = null;
    let overviewLoadInFlight = false;
    let activeMicTab = sessionStorage.getItem(MIC_TAB_STORAGE_KEY) || 'sales';
    let micOverviewTabsBound = false;
    let intervals = [];

    function isMarketScope() {
        return meProfile?.overviewScope === 'market' || meProfile?.overviewScope === 'super';
    }

    function subtitleForScope() {
        const scope = meProfile?.overviewScope;
        if (scope === 'market' || scope === 'super') {
            const markets = meProfile?.accessibleMarkets;
            if (Array.isArray(markets) && markets.length) return markets[0];
            return MARKET_LABEL;
        }
        if (scope === 'area') {
            const areas = meProfile?.accessibleAreas;
            if (Array.isArray(areas) && areas.length === 1) return areas[0];
            if (Array.isArray(areas) && areas.length > 1) return areas.join(' · ');
            return 'Area overview';
        }
        return 'Overview';
    }

    function formatVocDisplay(voc = {}) {
        if (voc.placeholder) {
            return {
                count: voc.count ?? VOC_PLACEHOLDER.count,
                osat: voc.osatPercent ?? VOC_PLACEHOLDER.osatPercent,
                acc: voc.accuracyPercent ?? VOC_PLACEHOLDER.accuracyPercent,
            };
        }
        return {
            count: voc.count == null ? '-' : voc.count,
            osat: voc.osatPercent,
            acc: voc.accuracyPercent,
        };
    }

    function formatMoney(value) {
        return `$${(Number(value) || 0).toLocaleString('en-AU')}`;
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function sortStoresByNumber(stores) {
        return [...(stores || [])].sort((a, b) =>
            String(a.storeNumber).localeCompare(String(b.storeNumber), undefined, { numeric: true })
        );
    }

    function areaCodeFromName(name) {
        const m = String(name || '').match(/(\d+)/);
        return m ? `A${Number(m[1])}` : '';
    }

    function adminStoreSnapOptions(area) {
        return {
            storeBasePath: '/Admin',
            adminAreaCode: areaCodeFromName(area?.name),
            adminAreaLinkOnly: true,
        };
    }

    function formatTime(date) {
        return date.toLocaleTimeString('en-AU', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
            timeZone: TIME_ZONE,
        });
    }

    function defaultAreaIndex(areas) {
        const list = areas || [];
        if (!list.length) return 0;
        const idx = list.findIndex((a) => String(a?.name || '').trim() === DEFAULT_AREA);
        return idx >= 0 ? idx : 0;
    }

    function currentArea() {
        const areas = overviewData?.areas || [];
        if (!areas.length) return null;
        return areas[areaIndex % areas.length];
    }

    function mergeMarketHourly(areas) {
        const list = areas || [];
        let openHour = 10;
        let closeHour = 22;
        let maxHours = 0;
        const chunks = [];
        for (const area of list) {
            const st = area.salesToday || {};
            const actualHourly = Array.isArray(st.actualHourly) ? st.actualHourly : [];
            const forecastHourly = Array.isArray(st.forecastHourly) ? st.forecastHourly : [];
            if (!actualHourly.length && !forecastHourly.length) continue;
            chunks.push({ actualHourly, forecastHourly });
            maxHours = Math.max(maxHours, actualHourly.length, forecastHourly.length);
            if (Number.isFinite(st.openHour)) openHour = st.openHour;
            if (Number.isFinite(st.closeHour)) closeHour = st.closeHour;
        }
        const actual = new Array(maxHours).fill(0);
        const forecast = new Array(maxHours).fill(0);
        for (const chunk of chunks) {
            for (let i = 0; i < maxHours; i++) {
                actual[i] += Number(chunk.actualHourly[i]) || 0;
                forecast[i] += Number(chunk.forecastHourly[i]) || 0;
            }
        }
        return { actual, forecast, openHour, closeHour, hours: maxHours };
    }

    function computeMarketProgress(areas, actual, forecast) {
        const hourly = mergeMarketHourly(areas);
        if (hourly.hours > 0 && global.SalesProgress?.computeDaySalesPresentation) {
            return global.SalesProgress.computeDaySalesPresentation({
                actual: hourly.actual,
                forecast: hourly.forecast,
                openHour: hourly.openHour,
                closeHour: hourly.closeHour,
                timeZone: TIME_ZONE,
            });
        }
        const outcomeClass = global.SalesProgress?.getActualCellClass?.(actual, forecast) || 'cell-green';
        const sample = (areas || [])
            .map((area) => area.salesToday?.progress)
            .find((progress) => progress && progress.timeFillPercent != null);
        return {
            phase: sample?.phase || 'during',
            timeFillPercent: sample?.timeFillPercent ?? 0,
            outcomeClass,
            paceClass: sample?.paceClass || outcomeClass,
        };
    }

    function buildMarketAggregate(areas) {
        const list = areas || [];
        const storeSales = sortStoresByNumber(list.flatMap((a) => a.storeSales || []));
        let actual = 0;
        let forecast = 0;
        for (const area of list) {
            const st = area.salesToday || {};
            actual += Number(st.actual) || 0;
            forecast += Number(st.forecast) || 0;
        }
        const progress = computeMarketProgress(list, actual, forecast);
        const wtdValues = list
            .map((a) => a.sssgWtdTotals)
            .filter((t) => t && (Number(t.lyTotal) > 0 || Number(t.actualTotal) > 0));
        let wtdPercent = null;
        if (wtdValues.length) {
            let actualTotal = 0;
            let lyTotal = 0;
            for (const totals of wtdValues) {
                actualTotal += Number(totals.actualTotal) || 0;
                lyTotal += Number(totals.lyTotal) || 0;
            }
            if (lyTotal > 0) {
                wtdPercent = Math.round(((actualTotal - lyTotal) / lyTotal) * 1000) / 10;
            }
        }
        return {
            name: MARKET_LABEL,
            areaKey: 'market-1',
            salesToday: { actual, forecast, progress },
            storeSales,
            sssgTodayPercent: formatAreaSssgFromStores({ storeSales }),
            sssgWtdPercent: wtdPercent,
        };
    }

    function currentDisplayArea() {
        const areas = overviewData?.areas || [];
        if (!areas.length) return null;
        if (marketViewActive && isMarketScope()) return buildMarketAggregate(areas);
        return currentArea();
    }

    function ordersForDisplay() {
        const all = overviewData?.storesNeedingOrders || [];
        if (marketViewActive && isMarketScope()) return all;
        const area = currentArea();
        if (!area) return [];
        const inArea = new Set((area.storeSales || []).map((s) => String(s.storeNumber).trim()).filter(Boolean));
        if (!inArea.size) {
            const key = area.areaKey;
            const name = area.name;
            return all.filter((s) => (key && s.areaKey === key) || (name && s.areaName === name));
        }
        return all.filter((s) => inArea.has(String(s.storeNumber).trim()));
    }

    function mergeAuditTileSummaries(summaryLists) {
        const byKey = new Map();
        for (const list of summaryLists || []) {
            for (const tile of list || []) {
                const key = `${tile.kind || 'weekly'}\0${tile.label}`;
                const existing = byKey.get(key);
                if (!existing) {
                    byKey.set(key, {
                        ...tile,
                        stats: { ...(tile.stats || {}) },
                    });
                    continue;
                }
                existing.stats.notStarted = (Number(existing.stats.notStarted) || 0) + (Number(tile.stats?.notStarted) || 0);
                existing.stats.inProgress = (Number(existing.stats.inProgress) || 0) + (Number(tile.stats?.inProgress) || 0);
                existing.stats.completed = (Number(existing.stats.completed) || 0) + (Number(tile.stats?.completed) || 0);
                existing.done = existing.stats.notStarted === 0 && existing.stats.inProgress === 0;
                existing.sub = formatStoreStatsSub(existing.stats);
            }
        }
        return [...byKey.values()];
    }

    function auditTilesForDisplay() {
        const areas = overviewData?.areas || [];
        if (!areas.length) return [];
        if (marketViewActive && isMarketScope()) {
            return mergeAuditTileSummaries(areas.map((a) => a.auditTileSummaries));
        }
        const area = currentArea();
        return area?.auditTileSummaries || [];
    }

    function currentVoc() {
        const list = overviewData?.vocByArea || [];
        if (!list.length) return null;
        return list[areaIndex % list.length];
    }

    function areaSssgToday(area) {
        const v = area?.sssgTodayPercent;
        if (v == null || Number.isNaN(Number(v))) return formatAreaSssgFromStores(area);
        return Number(v);
    }

    function areaSssgWtd(area) {
        const v = area?.sssgWtdPercent;
        return v == null || Number.isNaN(Number(v)) ? null : Number(v);
    }

    function formatAreaSssgFromStores(area) {
        const stores = Array.isArray(area?.storeSales) ? area.storeSales : [];
        const values = stores
            .map((s) => s.sssgPercent)
            .filter((v) => v != null && !Number.isNaN(Number(v)))
            .map((v) => Number(v));
        if (!values.length) return null;
        return Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 10) / 10;
    }

    function formatSssgDisplay(value) {
        if (value == null || Number.isNaN(Number(value))) {
            return { text: '-', toneClass: 'mic-sssg--na' };
        }
        const n = Number(value);
        const sign = n > 0 ? '+' : '';
        const toneClass = n > 0 ? 'mic-sssg--up' : n < 0 ? 'mic-sssg--down' : 'mic-sssg--na';
        return { text: `${sign}${n}%`, toneClass };
    }

    function isMicMobileView() {
        return global.matchMedia('(max-width: 900px)').matches;
    }

    let lastMicMobileLayout = null;

    function syncMicLayoutMode() {
        const mobile = isMicMobileView();
        document.body.classList.toggle('mic-overview--mobile', mobile);
        document.documentElement.classList.toggle('mic-overview--mobile', mobile);
        if (lastMicMobileLayout !== null && lastMicMobileLayout !== mobile && overviewData) {
            renderTiles();
        }
        lastMicMobileLayout = mobile;
        return mobile;
    }

    function renderMicTabPanel(tabId, content) {
        return `
        <section
            class="mic-tab-panel mic-tab-panel--${tabId}"
            data-mic-tab-panel="${tabId}"
            id="mic-tabpanel-${tabId}"
            role="tabpanel"
            aria-labelledby="mic-tab-${tabId}"
        >${content}</section>`;
    }

    const MIC_OVERVIEW_TABS = [
        { id: 'sales', label: 'Sales' },
        { id: 'results', label: 'Results' },
        { id: 'orders', label: 'Orders' },
        { id: 'audits', label: 'Audits' },
    ];

    function renderMicOverviewTabsHtml() {
        return MIC_OVERVIEW_TABS.map(({ id, label }) => {
            const isActive = activeMicTab === id;
            return `<button type="button" class="mic-overview-tab${isActive ? ' is-active' : ''}" role="tab" id="mic-tab-${id}" aria-selected="${isActive ? 'true' : 'false'}" aria-controls="mic-tabpanel-${id}" data-mic-overview-tab="${id}">${escapeHtml(label)}</button>`;
        }).join('');
    }

    function applyMicOverviewTab(tabId) {
        if (!MIC_OVERVIEW_TABS.some((tab) => tab.id === tabId)) tabId = 'sales';
        activeMicTab = tabId;
        sessionStorage.setItem(MIC_TAB_STORAGE_KEY, tabId);
        document.querySelectorAll('[data-mic-overview-tab]').forEach((button) => {
            const isActive = button.dataset.micOverviewTab === tabId;
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        const tabClasses = [
            'mic-overview-tab--sales',
            'mic-overview-tab--results',
            'mic-overview-tab--orders',
            'mic-overview-tab--audits',
        ];
        document.body.classList.remove(...tabClasses);
        document.documentElement.classList.remove(...tabClasses);
        document.body.classList.add(`mic-overview-tab--${tabId}`);
        document.documentElement.classList.add(`mic-overview-tab--${tabId}`);
        const grid = document.getElementById('mic-grid');
        if (!grid) return;
        grid.querySelectorAll('[data-mic-tab-panel]').forEach((panel) => {
            const isActive = panel.dataset.micTabPanel === tabId;
            panel.hidden = !isActive;
            panel.classList.toggle('is-tab-active', isActive);
        });
    }

    function bindMicOverviewTabs() {
        const nav = document.getElementById('mic-overview-tabs');
        if (!nav || micOverviewTabsBound) return;
        nav.addEventListener('click', (event) => {
            const button = event.target.closest('[data-mic-overview-tab]');
            if (!button) return;
            applyMicOverviewTab(button.dataset.micOverviewTab);
        });
        micOverviewTabsBound = true;
    }

    function syncMicOverviewTabs(mobile) {
        const nav = document.getElementById('mic-overview-tabs');
        const tabClasses = [
            'mic-overview-tab--sales',
            'mic-overview-tab--results',
            'mic-overview-tab--orders',
            'mic-overview-tab--audits',
        ];
        if (!mobile) {
            if (nav) nav.hidden = true;
            document.body.classList.remove(...tabClasses);
            document.documentElement.classList.remove(...tabClasses);
            return;
        }
        if (!nav) return;
        nav.hidden = false;
        nav.innerHTML = renderMicOverviewTabsHtml();
        bindMicOverviewTabs();
    }

    function renderAreaSalesTotal(sales) {
        const actual = Number(sales?.actual) || 0;
        const forecast = Number(sales?.forecast) || 0;
        const progress = sales?.progress || {};
        const paceClass = progress.paceClass || 'cell-green';
        const outcomeClass = progress.outcomeClass || paceClass;
        const timeFill = global.SalesProgress?.paceFillPercentFromProgress?.(progress) ?? 0;
        const layers =
            global.SalesProgress?.buildLiveProgressLayersHtml?.(timeFill, outcomeClass, paceClass) ||
            global.SalesProgress?.buildPaceStripHtml?.(timeFill, paceClass) ||
            '';
        return `
        <div class="mic-store-lead-sales-stack">
            <div class="mic-store-lead-total-amount">${formatMoney(actual)} / ${formatMoney(forecast)}</div>
            <div class="mic-store-lead-pace-band">${layers}</div>
        </div>`;
    }

    function areaRowCells(areas) {
        const last = areas.length - 1;
        const parts = [];
        areas.forEach((a, idx) => {
            const active = !marketViewActive && idx === areaIndex % areas.length;
            parts.push(
                `<button type="button" class="admin-area-text-tab${active ? ' is-active' : ''}" role="tab" aria-selected="${active}" data-area-index="${idx}">${escapeHtml(a.name)}</button>`
            );
            if (idx < last) parts.push('<span class="admin-area-text-pipe" aria-hidden="true"> |</span>');
        });
        return parts.join('');
    }

    function renderAreaTextSelector({ live = false } = {}) {
        const areas = overviewData?.areas || [];
        if (!areas.length) return '';
        const liveAttr = live ? ' aria-live="polite"' : '';
        const marketRow = isMarketScope()
            ? `<div class="admin-market-text-row${marketViewActive ? '' : ' is-dimmed'}">
                <button type="button" class="admin-market-text-tab${marketViewActive ? ' is-active' : ''}" role="tab" aria-selected="${marketViewActive}" data-view="market">${MARKET_LABEL}</button>
            </div><span class="admin-area-text-pipe admin-area-text-pipe--market" aria-hidden="true"> |</span>`
            : '';
        return `
        <div class="admin-area-text-track" role="tablist"${liveAttr} data-area-count="${areas.length}">
            ${marketRow}
            <div class="admin-area-text-row${marketViewActive && isMarketScope() ? ' is-dimmed' : ''}">${areaRowCells(areas)}</div>
        </div>`;
    }

    function setActiveAreaTab(track, index) {
        track.querySelectorAll('.admin-area-text-tab').forEach((tab, idx) => {
            const active = !marketViewActive && idx === index;
            tab.classList.toggle('is-active', active);
            tab.setAttribute('aria-selected', String(active));
        });
    }

    function applyAreaHighlight() {
        const track = document.querySelector('.admin-area-text-track');
        const areas = overviewData?.areas || [];
        if (!track || !areas.length) return;
        const marketTab = track.querySelector('.admin-market-text-tab');
        if (marketTab) {
            marketTab.classList.toggle('is-active', marketViewActive);
            marketTab.setAttribute('aria-selected', String(marketViewActive));
        }
        track.querySelector('.admin-market-text-row')?.classList.toggle('is-dimmed', !marketViewActive);
        track.querySelector('.admin-area-text-row')?.classList.toggle('is-dimmed', marketViewActive && isMarketScope());
        setActiveAreaTab(track, areaIndex % areas.length);
    }

    function renderAreaStoresTile(area, { tabbed = false } = {}) {
        const sales = area?.salesToday || { actual: 0, forecast: 0 };
        const rows =
            global.StoreSnapRow?.renderStoreSnapList?.(
                sortStoresByNumber(area?.storeSales),
                formatMoney,
                undefined,
                adminStoreSnapOptions(area)
            ) || '<p class="mic-store-lead-empty">No stores in this area yet.</p>';
        const posClass = tabbed ? '' : ' mic-tile--pos-area-stores';
        const mobileClass = tabbed ? ' mic-store-lead--mobile' : '';
        return `
        <article class="mic-tile mic-tile--store-leaderboard${posClass}">
            <div class="mic-store-lead mic-store-lead--purple${mobileClass}">
                ${renderAreaTextSelector({ live: true })}
                <div class="mic-store-lead-sales">${renderAreaSalesTotal(sales)}</div>
            </div>
            <div class="mic-store-lead-list${tabbed ? ' mic-store-lead-list--dashboard' : ''}" role="list">${rows}</div>
        </article>`;
    }

    function renderSssgTile(area, { tabbed = false } = {}) {
        const today = formatSssgDisplay(areaSssgToday(area));
        const wtd = formatSssgDisplay(areaSssgWtd(area));
        const hasData = today.text !== '-' || wtd.text !== '-';
        const futureClass = hasData ? '' : ' mic-tile--future';
        const posClass = tabbed ? '' : ' mic-tile--pos-sssg';
        return `
        <article class="mic-tile mic-tile--sssg mic-tile--metric-card${futureClass}${posClass}">
            <div class="mic-tile-body mic-metric-card">
                <div class="mic-metric-card__head">
                    <div class="mic-tile-label">Today SSSG</div>
                </div>
                <div class="mic-sssg-grid">
                    <div class="mic-sssg-value ${today.toneClass}">${escapeHtml(today.text)}</div>
                    <div class="mic-sssg-footer">
                        <span class="mic-sssg-wtd ${wtd.toneClass}">WTD ${escapeHtml(wtd.text)}</span>
                    </div>
                </div>
            </div>
        </article>`;
    }

    function useMicStyleTiles() {
        return marketViewActive && isMarketScope();
    }

    function renderVocTile(vocRaw, { tabbed = false, inRow = false } = {}) {
        const voc = formatVocDisplay(useMicStyleTiles() ? VOC_PLACEHOLDER : vocRaw);
        const posClass = tabbed || inRow ? '' : ' mic-tile--pos-voc';
        const osatText = voc.osat == null ? '—' : `${voc.osat}%`;
        const accText = voc.acc == null ? '—' : `${voc.acc}%`;
        const footnote = 'Pipeline coming soon';
        return `
        <a class="mic-tile mic-tile--link mic-tile--voc mic-tile--metric-card${posClass}" href="${SMG_REPORTING_URL}" target="_blank" rel="noopener noreferrer" aria-label="VOC - open SMG reporting">
            <div class="mic-tile-body mic-metric-card">
                <div class="mic-metric-card__head">
                    <div class="mic-tile-label">VOC</div>
                </div>
                <div class="mic-voc-grid">
                    <div class="mic-voc-count">${voc.count}</div>
                    <div class="mic-voc-metrics">
                        <span class="mic-voc-metric">OSAT ${osatText}</span>
                        <span class="mic-voc-metric">Acc ${accText}</span>
                    </div>
                </div>
                <div class="mic-tile-sub mic-tile-sub--footnote">${footnote}</div>
            </div>
        </a>`;
    }

    function dfscStoresForArea(area) {
        const stores = dfscStatus?.stores || [];
        if (!area) return [];
        const inArea = new Set((area.storeSales || []).map((s) => String(s.storeNumber).trim()).filter(Boolean));
        if (inArea.size) return stores.filter((s) => inArea.has(String(s.storeNumber).trim()));
        const key = area.areaKey || area.key;
        const name = String(area.name || '').trim();
        return stores.filter((s) => {
            const storeArea = String(s.area || '').trim();
            if (name && storeArea === name) return true;
            if (key && String(s.areaKey || '').trim() === String(key).trim()) return true;
            return false;
        });
    }

    function dfscSubtextForDisplay() {
        if (!dfscStatus?.stores) return 'Loading…';
        const area = useMicStyleTiles() ? null : currentArea();
        const rows = useMicStyleTiles() ? dfscStatus.stores : dfscStoresForArea(area);
        if (!rows.length) return 'No stores in this area';
        const amDone = rows.filter((r) => r.amCompleted).length;
        const pmDone = rows.filter((r) => r.pmCompleted).length;
        const inProgress = rows.filter((r) => r.inProgress).length;
        let text = `AM ${amDone}/${rows.length} · PM ${pmDone}/${rows.length}`;
        if (inProgress) text += ` · ${inProgress} in progress`;
        return text;
    }

    function renderDfscAdminTile({ tabbed = false, inRow = false } = {}) {
        const posClass = tabbed || inRow ? '' : ' mic-tile--pos-dfsc';
        const sub = escapeHtml(dfscSubtextForDisplay());
        const href = tacauditDfscAdminHref();
        const body = `
            <div class="mic-tile-body">
                <div class="mic-tile-label">DFSC</div>
                <div class="mic-tile-sub">${sub}</div>
            </div>`;
        if (href) {
            return `
        <a class="mic-tile mic-tile--link mic-tile--dfsc${posClass}" href="${escapeHtml(href)}" aria-label="DFSC - open TacAudit summary">${body}</a>`;
        }
        return `<article class="mic-tile mic-tile--dfsc${posClass}">${body}</article>`;
    }

    function renderAdminLabelTile({
        label,
        posClass,
        sub = 'Coming soon',
        tabbed = false,
        inRow = false,
        href = '',
    }) {
        const gridPos = tabbed || inRow ? '' : ` ${posClass}`;
        const body = `
            <div class="mic-tile-body">
                <div class="mic-tile-label">${escapeHtml(label)}</div>
                <div class="mic-tile-sub">${escapeHtml(sub)}</div>
            </div>`;
        if (href) {
            return `
        <a class="mic-tile mic-tile--link${gridPos}" href="${escapeHtml(href)}" aria-label="${escapeHtml(`${label} - ${sub}`)}">${body}</a>`;
        }
        return `<article class="mic-tile${gridPos}">${body}</article>`;
    }

    function dailyStockCountForDisplay() {
        const area = currentDisplayArea();
        const dc = area?.dailyStockCount;
        if (dc?.configured) return dc;
        if (!marketViewActive || !isMarketScope()) return dc || {};
        const areas = overviewData?.areas || [];
        const storeNumbers = [
            ...new Set(
                areas
                    .flatMap((a) => a.dailyStockCount?.storeNumbers || [])
                    .map((n) => String(n).trim())
                    .filter(Boolean)
            ),
        ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        if (!storeNumbers.length) return {};
        const subs = areas.map((a) => a.dailyStockCount?.sub).filter(Boolean);
        return {
            configured: true,
            clickable: true,
            href: `/${storeNumbers[0]}/daily-stock-count`,
            storeNumbers,
            message: 'Open daily count',
            sub:
                subs.find((s) => /variance|Macromatix|completed/i.test(String(s))) ||
                `${storeNumbers.length} stores - select store to count`,
        };
    }

    function dailyCountHrefForArea(dc) {
        let href = dc.href || '/daily-stock-count';
        try {
            const saved = sessionStorage.getItem('daily-count-store');
            if (saved && Array.isArray(dc.storeNumbers) && dc.storeNumbers.map(String).includes(saved)) {
                href = `/${saved}/daily-stock-count`;
            }
        } catch {
            /* ignore */
        }
        return href;
    }

    function adminUsesStorePicker(storeCount) {
        return Boolean(meProfile?.canViewCrossStoreAccounts) && Number(storeCount) !== 1;
    }

    function storeLabelFromOverview(storeNumber) {
        const num = String(storeNumber || '').trim();
        const areas = overviewData?.areas || [];
        for (const area of areas) {
            const match = (area.storeSales || []).find((s) => String(s.storeNumber).trim() === num);
            if (match?.storeName) return `${num} - ${match.storeName}`;
        }
        const order = (overviewData?.storesNeedingOrders || []).find((s) => String(s.storeNumber).trim() === num);
        if (order?.storeName) return `${num} - ${order.storeName}`;
        return num;
    }

    function openDailyCountStorePicker() {
        const dc = dailyStockCountForDisplay();
        const storeNumbers = (dc.storeNumbers || []).map((n) => String(n).trim()).filter(Boolean);
        if (!storeNumbers.length) return;
        if (storeNumbers.length === 1) {
            const store = storeNumbers[0].toLowerCase();
            try {
                sessionStorage.setItem(DAILY_COUNT_STORE_KEY, store);
            } catch {
                /* ignore */
            }
            global.location.assign(`/${store}/daily-stock-count`);
            return;
        }
        global.AdminStorePicker?.open({
            title: 'Select store',
            hint: 'Choose a store to start daily count.',
            options: storeNumbers.map((num) => ({
                id: num.toLowerCase(),
                label: storeLabelFromOverview(num),
            })),
            onPick: (store) => {
                try {
                    sessionStorage.setItem(DAILY_COUNT_STORE_KEY, store);
                } catch {
                    /* ignore */
                }
                global.location.assign(`/${store}/daily-stock-count`);
            },
        });
    }

    function openStockCountStorePicker() {
        const list = ordersForDisplay();
        if (!list.length) return;
        if (list.length === 1 && list[0]?.href) {
            global.location.assign(list[0].href);
            return;
        }
        global.AdminStorePicker?.open({
            title: 'Select store',
            hint: 'Choose a store to start stock count.',
            options: list.map((entry) => ({
                id: String(entry.storeNumber).toLowerCase(),
                label: entry.storeName ? `${entry.storeNumber} - ${entry.storeName}` : String(entry.storeNumber),
                sub: ordersStoreDetail(entry),
                href: entry.href,
            })),
            onPick: (_store, option) => {
                if (option?.href) global.location.assign(option.href);
            },
        });
    }

    function renderDailyCountTile({ tabbed = false, inRow = false } = {}) {
        const dc = dailyStockCountForDisplay();
        if (!dc.configured) return '';
        const sub = dc.sub || dc.message || 'Open daily count';
        const href = dailyCountHrefForArea(dc);
        const storeNumbers = (dc.storeNumbers || []).map((n) => String(n).trim()).filter(Boolean);
        const usePicker = adminUsesStorePicker(storeNumbers.length);
        const posClass = tabbed || inRow ? '' : ' mic-tile--pos-daily-count';
        const body = `
            <div class="mic-tile-body">
                <div class="mic-tile-label">Daily count</div>
                <div class="mic-tile-sub">${escapeHtml(sub)}</div>
            </div>`;
        if (dc.clickable && (href || usePicker)) {
            if (usePicker) {
                return `
        <button
            type="button"
            class="mic-tile mic-tile--link mic-tile--daily-count${posClass}"
            data-store-picker="daily-count"
            aria-label="${escapeHtml(`Daily count - ${sub}`)}"
        >${body}</button>`;
            }
            return `
        <a
            class="mic-tile mic-tile--link mic-tile--daily-count${posClass}"
            href="${escapeHtml(href)}"
            aria-label="${escapeHtml(`Daily count - ${sub}`)}"
        >${body}</a>`;
        }
        return `<article class="mic-tile mic-tile--daily-count${posClass}">${body}</article>`;
    }

    function ordersStoreDetail(entry) {
        const count = Number(entry?.pendingCount) || 0;
        if (count > 0) return `${count} vendor${count === 1 ? '' : 's'} to count`;
        return entry?.message || 'Open stock count';
    }

    function renderEqualWidthRow(tileHtmlList, { rowNum, tabbed = false, extraClass = '' } = {}) {
        const tiles = tileHtmlList.filter(Boolean);
        if (!tiles.length) return '';
        const colCount = tiles.length;
        if (tabbed) {
            return `<div class="mic-tab-tile-row mic-tab-tile-row--cols-${colCount}">${tiles.join('')}</div>`;
        }
        const rowClass = rowNum ? ` mic-grid-equal-row--row-${rowNum}` : '';
        return `<div class="mic-grid-equal-row mic-grid-equal-row--cols-${colCount}${rowClass}${extraClass ? ` ${extraClass}` : ''}">${tiles.join('')}</div>`;
    }

    function countAdminContentRows(auditTiles) {
        let rows = 2;
        if ((auditTiles || []).length > 0) rows += 1;
        return rows;
    }

    function formatStoreStatsSub(stats = {}) {
        const notStarted = Number(stats.notStarted) || 0;
        const inProgress = Number(stats.inProgress) || 0;
        const complete = Number(stats.completed) || 0;
        return [
            `${notStarted} store${notStarted === 1 ? '' : 's'} not started`,
            `${inProgress} store${inProgress === 1 ? '' : 's'} in progress`,
            `${complete} store${complete === 1 ? '' : 's'} complete`,
        ].join(' · ');
    }

    function auditStatLine(count, phrase) {
        const n = Number(count) || 0;
        return `${n} store${n === 1 ? '' : 's'} ${phrase}`;
    }

    function firstStoreNumberInDisplayScope() {
        const area = currentDisplayArea();
        const fromArea = sortStoresByNumber(area?.storeSales || [])
            .map((s) => String(s.storeNumber).trim())
            .filter(Boolean);
        if (fromArea.length) return fromArea[0].toLowerCase();
        for (const a of overviewData?.areas || []) {
            for (const s of sortStoresByNumber(a.storeSales || [])) {
                const n = String(s.storeNumber).trim();
                if (n) return n.toLowerCase();
            }
        }
        return '';
    }

    function tacauditAreaQuery() {
        const areas = overviewData?.areas || [];
        if (marketViewActive && isMarketScope()) {
            return String(areas[0]?.name || '').trim();
        }
        return String(currentDisplayArea()?.name || areas[0]?.name || '').trim();
    }

    function tacauditHrefForTile() {
        if (!global.AppPaths?.tacauditAdminHub) return '';
        return global.AppPaths.tacauditAdminHub({
            area: tacauditAreaQuery(),
        });
    }

    function tacauditDfscAdminHref() {
        if (!global.AppPaths?.tacauditAdminHub) return '';
        return global.AppPaths.tacauditAdminHub({
            area: tacauditAreaQuery(),
        });
    }

    function auditStatTextScaleClass(notStarted, inProgress, complete) {
        const lines = [
            auditStatLine(notStarted, 'not started'),
            auditStatLine(inProgress, 'in progress'),
            auditStatLine(complete, 'complete'),
        ];
        const maxLen = Math.max(...lines.map((line) => line.length));
        if (maxLen > 24) return 'mic-audit-stat-scale--sm';
        if (maxLen > 19) return 'mic-audit-stat-scale--md';
        return 'mic-audit-stat-scale--lg';
    }

    function tileHasAuditStats(tile) {
        return tile?.stats && typeof tile.stats === 'object';
    }

    function aggregatedSquareOneStats(tiles) {
        const stats = { notStarted: 0, inProgress: 0, completed: 0 };
        for (const tile of allSquareOneAuditTiles(tiles)) {
            stats.notStarted += Number(tile.stats?.notStarted) || 0;
            stats.inProgress += Number(tile.stats?.inProgress) || 0;
            stats.completed += Number(tile.stats?.completed) || 0;
        }
        return stats;
    }

    function pickAdminAuditTilesForRow(tiles) {
        const all = tiles || [];
        const squareDue = all.filter((t) => t.kind === 'square-one' && !t.done);
        const weekly = all.filter((t) => t.kind === 'weekly');
        const weeklyDue = weekly.filter((t) => !t.done);
        const weeklyPick = weeklyDue.length ? weeklyDue : weekly;
        if (squareDue.length >= 2) {
            return [...squareDue.slice(0, 2), ...weeklyPick.slice(0, 2)];
        }
        return [...squareDue, ...weeklyPick].slice(0, 4);
    }

    function dueSquareOneAuditTiles(tiles) {
        return (tiles || []).filter((t) => t.kind === 'square-one' && !t.done);
    }

    function allSquareOneAuditTiles(tiles) {
        return (tiles || []).filter((t) => t.kind === 'square-one');
    }

    function renderSquareOneMiddleTileAdmin(tiles, { tabbed = false, inRow = false } = {}) {
        const due = dueSquareOneAuditTiles(tiles);
        if (due.length >= 2) return '';
        if (due.length === 1) {
            return renderAdminAuditTile(due[0], { tabbed, inRow });
        }
        const all = allSquareOneAuditTiles(tiles);
        if (all.length) {
            return renderAdminAuditTile(
                {
                    tileLabel: 'Square One',
                    kind: 'square-one',
                    stats: aggregatedSquareOneStats(tiles),
                    done: all.every((t) => t.done),
                },
                { tabbed, inRow }
            );
        }
        return '';
    }

    function shouldShowAdminOrdersTile() {
        if (!useMicStyleTiles()) return true;
        return ordersForDisplay().length > 0;
    }

    function renderOrdersSummaryTile({ tabbed = false, inRow = false } = {}) {
        const list = ordersForDisplay();
        const storeCount = list.length;
        const vendorCount = list.reduce((sum, row) => sum + (Number(row.pendingCount) || 0), 0);
        const active = storeCount > 0;
        const sub = active
            ? `${storeCount} store${storeCount === 1 ? '' : 's'} · ${vendorCount} vendor${vendorCount === 1 ? '' : 's'} to count`
            : 'All orders are placed for today';
        const posClass = tabbed || inRow ? '' : ' mic-tile--pos-orders';
        const stateClass = active ? ' mic-tile--orders-active' : ' mic-tile--orders-idle';
        const body = `
            <div class="mic-tile-body">
                <div class="mic-tile-label">Orders to place</div>
                <div class="mic-tile-sub">${escapeHtml(sub)}</div>
            </div>`;
        const usePicker = active && adminUsesStorePicker(storeCount);
        if (active && (usePicker || (storeCount === 1 && list[0]?.href))) {
            if (usePicker) {
                return `
        <button
            type="button"
            class="mic-tile mic-tile--link mic-tile--orders-to-place${stateClass}${posClass}"
            data-store-picker="stock-count"
            aria-label="${escapeHtml(`Orders to place - ${sub}`)}"
        >${body}</button>`;
            }
            return `
        <a
            class="mic-tile mic-tile--link mic-tile--orders-to-place${stateClass}${posClass}"
            href="${escapeHtml(list[0].href)}"
            aria-label="${escapeHtml(`Orders to place - ${sub}`)}"
        >${body}</a>`;
        }
        return `<article class="mic-tile mic-tile--orders-to-place${stateClass}${posClass}">${body}</article>`;
    }

    function renderAdminAuditTile(tile, { tabbed = false, inRow = false } = {}) {
        const label = escapeHtml(tile?.tileLabel || tile?.label || 'Audit');
        const plainLabel = tile?.tileLabel || tile?.label || 'Audit';
        const doneClass = tile?.done ? ' mic-tile--audit-complete' : ' mic-tile--audit-due';
        const kindClass = tile?.kind === 'square-one' ? ' mic-tile--square-one' : '';
        const gridPos = tabbed || inRow ? '' : '';
        const tacauditHref = tacauditHrefForTile(tile);
        const linkClass = tacauditHref ? ' mic-tile--link' : '';
        const tag = tacauditHref ? 'a' : 'article';
        const hrefAttr = tacauditHref ? ` href="${escapeHtml(tacauditHref)}"` : '';
        const ariaAttr = tacauditHref
            ? ` aria-label="${escapeHtml(`${plainLabel} - open TacAudit`)}"`
            : '';

        if (tileHasAuditStats(tile)) {
            const notStarted = Number(tile.stats.notStarted) || 0;
            const inProgress = Number(tile.stats.inProgress) || 0;
            const complete = Number(tile.stats.completed) || 0;
            const scaleClass = auditStatTextScaleClass(notStarted, inProgress, complete);
            return `
        <${tag} class="mic-tile mic-tile--weekly-audit mic-tile--audit-stats${kindClass}${doneClass}${linkClass}${gridPos}"${hrefAttr}${ariaAttr}>
            <div class="mic-tile-body mic-tile-body--audit-stats ${scaleClass}">
                <div class="mic-tile-label mic-tile-label--audit-stats">${label}</div>
                <div class="mic-audit-stat mic-audit-stat--not-started">
                    <span class="mic-audit-stat-line">${escapeHtml(auditStatLine(notStarted, 'not started'))}</span>
                </div>
                <div class="mic-audit-stat mic-audit-stat--in-progress">
                    <span class="mic-audit-stat-line">${escapeHtml(auditStatLine(inProgress, 'in progress'))}</span>
                </div>
                <div class="mic-audit-stat mic-audit-stat--complete">
                    <span class="mic-audit-stat-line">${escapeHtml(auditStatLine(complete, 'complete'))}</span>
                </div>
            </div>
        </${tag}>`;
        }

        const sub = escapeHtml(tile?.sub || (tile?.done ? 'Complete' : 'Due this week'));
        return `
        <${tag} class="mic-tile mic-tile--weekly-audit${kindClass}${doneClass}${linkClass}${gridPos}"${hrefAttr}${ariaAttr}>
            <div class="mic-tile-body">
                <div class="mic-tile-label">${label}</div>
                <div class="mic-tile-sub">${sub}</div>
            </div>
        </${tag}>`;
    }

    function renderAdminAuditTilesOnly(tiles, { tabbed = false, rowNum = 2 } = {}) {
        const picked = (tiles || []).map((tile) => renderAdminAuditTile(tile));
        if (!picked.length) return '';
        if (tabbed) return renderEqualWidthRow(picked, { tabbed: true });
        return renderEqualWidthRow(picked, {
            rowNum,
            extraClass: 'mic-tile--pos-weekly-audit-row',
        });
    }

    function renderCoreCountdownTile({ tabbed = false, inRow = false } = {}) {
        return global.CoreCountdown?.renderTileHtml?.({ tabbed, inRow }) || '';
    }

    function renderAdminTopRow(vocRaw) {
        const tiles = [
            renderVocTile(vocRaw, { inRow: true }),
            renderDfscAdminTile({ inRow: true }),
            renderCoreCountdownTile({ inRow: true }),
        ].filter(Boolean);
        if (!tiles.length) return '';
        return renderEqualWidthRow(tiles, { rowNum: 'top' });
    }

    function renderAdminMiddleRow({ tabbed = false } = {}) {
        const auditTiles = auditTilesForDisplay();
        const tiles = [];
        if (useMicStyleTiles()) {
            const squareTile = renderSquareOneMiddleTileAdmin(auditTiles, { tabbed, inRow: !tabbed });
            if (squareTile) tiles.push(squareTile);
        }
        tiles.push(renderDailyCountTile({ tabbed, inRow: !tabbed }));
        if (shouldShowAdminOrdersTile()) {
            tiles.push(renderOrdersSummaryTile({ tabbed, inRow: !tabbed }));
        }
        const filtered = tiles.filter(Boolean);
        if (!filtered.length) return '';
        if (tabbed) return renderEqualWidthRow(filtered, { tabbed: true });
        return renderEqualWidthRow(filtered, { rowNum: 1, extraClass: 'mic-tile--pos-middle-row' });
    }

    function renderMobileOrdersTab() {
        const tiles = [];
        if (shouldShowAdminOrdersTile()) {
            tiles.push(renderOrdersSummaryTile({ tabbed: true }));
        }
        tiles.push(renderDailyCountTile({ tabbed: true }));
        return renderEqualWidthRow(tiles.filter(Boolean), { tabbed: true });
    }

    function renderDesktopTiles() {
        const displayArea = currentDisplayArea();
        const vocRaw = useMicStyleTiles() ? VOC_PLACEHOLDER : currentVoc() || {};
        const auditTiles = auditTilesForDisplay();
        return `
        ${renderAreaStoresTile(displayArea)}
        ${renderAdminTopRow(vocRaw)}
        ${renderAdminMiddleRow()}
        ${renderAdminAuditTilesOnly(auditTiles)}`;
    }

    function renderMobileTabbedTiles() {
        const displayArea = currentDisplayArea();
        const vocRaw = useMicStyleTiles() ? VOC_PLACEHOLDER : currentVoc() || {};
        const auditTiles = auditTilesForDisplay();
        return `
        ${renderMicTabPanel('sales', renderAreaStoresTile(displayArea, { tabbed: true }))}
        ${renderMicTabPanel('results', `${renderVocTile(vocRaw, { tabbed: true })}${renderCoreCountdownTile({ tabbed: true })}${renderSssgTile(displayArea, { tabbed: true })}`)}
        ${renderMicTabPanel('orders', renderMobileOrdersTab())}
        ${renderMicTabPanel('audits', `${renderDfscAdminTile({ tabbed: true })}${renderAdminAuditTilesOnly(auditTiles, { tabbed: true })}`)}`;
    }

    function bindStorePickerTiles() {
        const grid = document.getElementById('mic-grid');
        if (!grid) return;
        grid.querySelectorAll('[data-store-picker="daily-count"]').forEach((btn) => {
            btn.addEventListener('click', () => openDailyCountStorePicker());
        });
        grid.querySelectorAll('[data-store-picker="stock-count"]').forEach((btn) => {
            btn.addEventListener('click', () => openStockCountStorePicker());
        });
    }

    function bindTacauditTileLinks() {
        const grid = document.getElementById('mic-grid');
        if (!grid || grid.dataset.tacauditLinksBound === '1') return;
        grid.dataset.tacauditLinksBound = '1';
        grid.addEventListener('click', (event) => {
            const anchor = event.target.closest('a.mic-tile--link');
            if (!anchor) return;
            const href = anchor.getAttribute('href') || '';
            if (!/\/tacaudit\//i.test(href)) return;
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            if (!global.DashboardPageTransition?.navigateTo) return;
            event.preventDefault();
            global.DashboardPageTransition.navigateTo(anchor.href);
        });
    }

    function bindAreaTextSelector() {
        const grid = document.getElementById('mic-grid');
        if (!grid) return;
        grid.querySelectorAll('.admin-market-text-tab').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                marketViewActive = true;
                renderTiles();
            });
        });
        grid.querySelectorAll('.admin-area-text-tab').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const idx = Number(btn.dataset.areaIndex);
                if (!Number.isFinite(idx)) return;
                marketViewActive = false;
                areaIndex = idx;
                renderTiles();
            });
        });
    }

    function renderTiles() {
        const grid = document.getElementById('mic-grid');
        if (!grid || !overviewData) return;
        const mobile = syncMicLayoutMode();
        const auditTiles = auditTilesForDisplay();
        syncMicOverviewTabs(mobile);
        grid.classList.toggle('mic-grid--tabbed', mobile);
        if (!mobile) {
            grid.style.setProperty('--mic-content-rows', String(countAdminContentRows(auditTiles)));
        } else {
            grid.style.removeProperty('--mic-content-rows');
        }
        grid.innerHTML = mobile ? renderMobileTabbedTiles() : renderDesktopTiles();
        global.CoreCountdown?.refreshTiles?.();
        global.CoreCountdown?.startTick?.();
        bindStorePickerTiles();
        bindTacauditTileLinks();
        bindAreaTextSelector();
        applyAreaHighlight();
        if (mobile) applyMicOverviewTab(activeMicTab);
        loadDfscStatus();
    }

    function renderShell(promoBannerHtml) {
        app.innerHTML = `
        <div class="mic-page mic-page--admin" id="mic-page">
            <header class="mic-header mic-header--admin">
                <div class="mic-header-brand">
                    <div>
                        <h1>MIC OVERVIEW</h1>
                        <p class="subtitle" id="mic-store-label">${escapeHtml(subtitleForScope())}</p>
                    </div>
                </div>
                ${promoBannerHtml || ''}
                <div class="mic-header-actions">
                    <div class="mic-clock">
                        <span class="mic-clock-label">Current time</span>
                        <span class="mic-clock-value" id="mic-clock">${formatTime(new Date())}</span>
                    </div>
                </div>
            </header>
            <nav class="mic-overview-tabs" id="mic-overview-tabs" role="tablist" aria-label="MIC overview sections" hidden></nav>
            <div class="mic-grid mic-grid--admin" id="mic-grid"></div>
        </div>
        ${global.MicSettings?.renderCog?.() || ''}
        ${global.MicSettings?.renderPanel?.({
            darkModeHint: 'Dark background and tiles on this MIC page.',
        }) || ''}`;

        global.MicSettings?.bind?.({
            getViewAccountsOptions: () => ({
                isAdmin: Boolean(meProfile?.canViewCrossStoreAccounts),
            }),
            resolveAdminMenuVisibility: !meProfile?.canAccessAdminMenu,
        });
        global.AdminMenu?.bind?.({
            getViewAccountsOptions: () => ({
                isAdmin: Boolean(meProfile?.canViewCrossStoreAccounts),
            }),
        });
        global.AdminAccounts?.maybeOpenFromQuery?.();
        global.MicSettings?.initPreferences?.();
    }

    async function loadDfscStatus() {
        try {
            const res = await fetch('/api/admin/dfsc/status', { credentials: 'same-origin' });
            const data = await res.json();
            if (res.ok && data.success) {
                dfscStatus = data;
                const sub = document.querySelector('.mic-tile--dfsc .mic-tile-sub');
                if (sub) sub.textContent = dfscSubtextForDisplay();
            }
        } catch {
            /* ignore */
        }
    }

    async function loadOverview() {
        if (overviewLoadInFlight) return;
        overviewLoadInFlight = true;
        try {
            const res = await fetch('/api/overview', { credentials: 'same-origin' });
            const data = await res.json();
            if (!res.ok || !data.success) {
                app.textContent = data.error || 'Could not load overview.';
                return;
            }
            if (data.salesUpdatedAt) lastSalesUpdatedAt = data.salesUpdatedAt;
            overviewData = data;
            const areas = data.areas || [];
            const isFirstLoad = !document.getElementById('mic-grid');
            if (areas.length && isFirstLoad) areaIndex = defaultAreaIndex(areas);
            if (!document.getElementById('mic-grid')) renderShell(global.MicOverviewShared?.renderPromoBanner?.());
            renderTiles();
        } finally {
            overviewLoadInFlight = false;
        }
    }

    async function checkForScrapeUpdate() {
        if (overviewLoadInFlight) return;
        try {
            const res = await fetch('/api/admin/overview/status', { credentials: 'same-origin' });
            const data = await res.json();
            if (!res.ok || !data.success) return;
            const updatedAt = data.salesUpdatedAt || null;
            if (!updatedAt) return;
            if (!lastSalesUpdatedAt) {
                lastSalesUpdatedAt = updatedAt;
                return;
            }
            if (updatedAt !== lastSalesUpdatedAt) await loadOverview();
        } catch {
            /* ignore */
        }
    }

    function clearIntervals() {
        for (const id of intervals) global.clearInterval(id);
        intervals = [];
    }

    function start(profile, appEl, promoBannerHtml) {
        meProfile = profile;
        app = appEl;
        clearIntervals();
        document.documentElement.classList.add('mic-overview-page');
        document.body.classList.add('mic-overview-page');
        marketViewActive = isMarketScope();
        renderShell(promoBannerHtml);
        syncMicLayoutMode();
        global.CoreCountdown?.init?.().then(() => loadOverview());
        intervals.push(
            global.setInterval(() => {
                const clock = document.getElementById('mic-clock');
                if (clock) clock.textContent = formatTime(new Date());
            }, 1000)
        );
        intervals.push(global.setInterval(loadOverview, REFRESH_MS));
        intervals.push(global.setInterval(checkForScrapeUpdate, SCRAPE_POLL_MS));
        global.addEventListener('resize', () => {
            syncMicLayoutMode();
        });
    }

    global.MicOverviewMulti = { start, loadOverview };
})(window);
