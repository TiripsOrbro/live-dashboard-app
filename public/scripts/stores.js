/* Store picker — fetches the master store list and renders clickable tiles linking to /<storeNumber>. */
const grid = document.getElementById('store-grid');
const greetingEl = document.getElementById('stores-greeting');
const LANDSCAPE_PREF_KEY = 'dashboard-prefer-landscape';

function markLandscapePreference() {
    try {
        sessionStorage.setItem(LANDSCAPE_PREF_KEY, '1');
    } catch {
        /* ignore */
    }
}

grid.addEventListener('click', (event) => {
    if (event.target.closest('a.store-tile')) {
        markLandscapePreference();
    }
});

function hourLabel(hour) {
    const h = (((Math.trunc(hour) % 24) + 24) % 24);
    const period = h < 12 ? 'AM' : 'PM';
    const display = h % 12 === 0 ? 12 : h % 12;
    return `${display}${period}`;
}

function showMessage(text) {
    grid.innerHTML = `<p class="stores-message">${text}</p>`;
}

function normalizeAreaKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

function areaCodeFromValue(value) {
    const s = String(value || '').trim();
    const m = s.match(/(?:^|\b)area\D*(\d+)\b/i) || s.match(/^a(\d+)$/i) || s.match(/^(\d+)$/);
    if (!m) return '';
    return `A${String(Number(m[1]))}`;
}

function areaPathFromGroup(group) {
    const areaCode = areaCodeFromValue(group?.name || group?.key || '');
    if (areaCode) {
        return `${window.AppPaths?.adminArea?.(areaCode) || `/Admin/${areaCode}`}?view=area`;
    }
    const areaKey = group?.key || normalizeAreaKey(group?.name || '');
    return `/area/${encodeURIComponent(areaKey)}`;
}

function adminStoreHref(store) {
    const code = areaCodeFromValue(store?.area || store?.areaKey || '');
    const num = String(store?.storeNumber || '').replace(/[^0-9]/g, '');
    if (store?.testStore) return window.AppPaths?.adminStore?.('teststore') || '/Admin/teststore';
    if (code && num) {
        return window.AppPaths?.adminAreaWithStore?.(code, num) || `/Admin/${code}?store=${encodeURIComponent(num)}`;
    }
    return num
        ? window.AppPaths?.adminStore?.(num) || `/Admin/${num}`
        : window.AppPaths?.adminOverview?.() || '/Admin/Overview';
}

function ensureVisibleAreas(groups) {
    const required = ['Area 1', 'Area 2', 'Area 21', 'Area 22'];
    const out = Array.isArray(groups) ? [...groups] : [];
    const have = new Set(out.map((g) => normalizeAreaKey(g?.name || g?.key || '')));
    required.forEach((name) => {
        const key = normalizeAreaKey(name);
        if (have.has(key)) return;
        out.push({ name, key, stores: [] });
        have.add(key);
    });
    return out;
}

function renderStoreTiles(stores) {
    const sorted = [...stores].sort((a, b) =>
        String(a.storeNumber).localeCompare(String(b.storeNumber), undefined, { numeric: true })
    );
    return sorted
        .map((s) => {
            const isTest = Boolean(s.testStore);
            const number = isTest ? 'teststore' : String(s.storeNumber || '').replace(/[^0-9]/g, '');
            if (!number) return '';
            const name = isTest ? '1 Store' : s.storeName && s.storeName !== number ? s.storeName : '';
            const hours = isTest
                ? 'Test Store Environment'
                : Number.isFinite(s.openHour) && Number.isFinite(s.closeHour)
                  ? `${hourLabel(s.openHour)}–${hourLabel(s.closeHour)}`
                  : '';
            const tz =
                !isTest && s.timeZone ? `<span class="store-tile-hours">${String(s.timeZone).replace('Australia/', '')}</span>` : '';
            const tileClass = isTest ? 'store-tile store-tile--test' : 'store-tile';
            const label = isTest ? 'Test Store' : number;
            return `
                <a class="${tileClass}" href="${adminStoreHref(s)}">
                    <span class="store-tile-number">${label}</span>
                    ${name ? `<span class="store-tile-name">${name}</span>` : ''}
                    ${hours ? `<span class="store-tile-hours">${hours}</span>` : ''}
                    ${tz}
                </a>`;
        })
        .join('');
}

function renderStores(stores, areas) {
    if (!stores.length) {
        showMessage('No stores configured yet. Add stores to the .storelist file on the server.');
        return;
    }

    const groupsRaw = Array.isArray(areas) && areas.length ? areas : [{ name: 'Area 22', key: 'area-22', stores }];
    const groups = ensureVisibleAreas(groupsRaw);
    const testStores = stores.filter((s) => s?.testStore);
    const areaTiles = groups
        .map((group) => {
            if (/^test\s*store$/i.test(String(group?.name || ''))) return '';
            const storesInGroup = Array.isArray(group.stores) ? group.stores : [];
            const nonTestStores = storesInGroup.filter((s) => !s?.testStore);
            const areaName = group.name || 'Area';
            const count = nonTestStores.length;
            const areaPath = areaPathFromGroup(group);
            return `
                <details class="group-item area-tile-card">
                    <summary class="area-tile-summary">
                        <div class="store-tile area-tile" role="button" aria-label="${areaName}">
                            <span class="area-tile-topline">
                                <button type="button" class="area-return-btn" aria-label="Return to all areas">Return</button>
                            </span>
                            <span class="store-tile-name area-tile-title">${areaName}</span>
                            <span class="store-tile-name">${count} store${count === 1 ? '' : 's'}</span>
                            <span class="store-tile-hours">Tap to expand</span>
                        </div>
                    </summary>
                    <div class="area-tile-panel">
                        <div class="area-tile-store-grid">
                            ${
                                count
                                    ? `<a class="store-tile store-tile--area-dashboard" href="${areaPath}">
                                <span class="store-tile-number">Area</span>
                                <span class="store-tile-name">Area Dashboard</span>
                            </a>`
                                    : `<div class="store-tile store-tile--empty-area" aria-live="polite">
                                <span class="store-tile-name">No stores configured yet</span>
                            </div>`
                            }
                            ${renderStoreTiles(nonTestStores)}
                        </div>
                    </div>
                </details>`;
        })
        .join('');

    grid.innerHTML = `
        <section class="group-grid" aria-label="Area tiles">
            ${testStores.length ? renderStoreTiles(testStores) : ''}
            ${areaTiles}
        </section>
    `;
    initAreaTileInteractions();
}

const AREA_EXPAND_MS = 1050;
const AREA_STORES_DELAY_MS = 480;

function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Measure tile vs grid before layout changes — header stretches to 100% after expand. */
function captureExpandClip(card, groupGrid) {
    const tile = card.querySelector('.area-tile');
    if (!tile || !groupGrid) return;
    const gridBox = groupGrid.getBoundingClientRect();
    const tileBox = tile.getBoundingClientRect();
    const left = Math.max(0, Math.round(tileBox.left - gridBox.left));
    const right = Math.max(0, Math.round(gridBox.right - tileBox.right));
    const headerH = Math.max(140, Math.round(tileBox.height));
    card.style.setProperty('--clip-left', `${left}px`);
    card.style.setProperty('--clip-right', `${right}px`);
    card.style.setProperty('--clip-bottom', `calc(100% - ${headerH}px)`);
}

function clearExpandClip(card) {
    card.style.removeProperty('--clip-left');
    card.style.removeProperty('--clip-right');
    card.style.removeProperty('--clip-bottom');
}

function initAreaTileInteractions() {
    const groupGrid = grid.querySelector('.group-grid');
    if (!groupGrid) return;

    // Include standalone tiles (like teststore) in the hide/show choreography.
    groupGrid.querySelectorAll(':scope > .store-tile').forEach((tile) => {
        tile.classList.add('group-item');
    });

    const cards = [...groupGrid.querySelectorAll('.area-tile-card')];
    const openTimers = new Map();

    function pinGridSlots() {
        groupGrid.querySelectorAll(':scope > .group-item').forEach((item) => {
            const row = getComputedStyle(item).gridRowStart;
            const col = getComputedStyle(item).gridColumnStart;
            if (row && row !== 'auto') item.style.gridRow = row;
            if (col && col !== 'auto') item.style.gridColumnStart = col;
        });
    }

    function clearGridSlots() {
        groupGrid.querySelectorAll(':scope > .group-item').forEach((item) => {
            item.style.gridRow = '';
            item.style.gridColumn = '';
            item.style.gridColumnStart = '';
        });
    }

    function clearOpenTimers(card) {
        const timers = openTimers.get(card);
        if (timers?.storesTimer) clearTimeout(timers.storesTimer);
        if (timers?.collapseTimer) clearTimeout(timers.collapseTimer);
        if (timers?.doneTimer) clearTimeout(timers.doneTimer);
        openTimers.delete(card);
    }

    function resetFocusState() {
        groupGrid.classList.remove('area-focus-active');
        cards.forEach((c) => {
            c.classList.remove(
                'is-closing',
                'is-collapsing-wide',
                'is-opening',
                'is-expanding-wide',
                'is-expanding-down',
                'is-revealed',
                'is-stores-revealed'
            );
            delete c.dataset.areaExpanded;
            clearOpenTimers(c);
            clearExpandClip(c);
        });
        groupGrid.querySelectorAll('.group-item').forEach((item) => {
            item.classList.remove('is-selected', 'is-dimmed');
            item.removeAttribute('aria-hidden');
        });
        clearGridSlots();
    }

    function isAreaExpanded(card) {
        return card.dataset.areaExpanded === 'true';
    }

    function syncDetailsOpen(card) {
        card.dataset.areaExpanded = 'true';
        card.open = true;
    }

    function syncDetailsClosed(card) {
        delete card.dataset.areaExpanded;
        card.open = false;
    }

    function finishAreaClose(card) {
        clearOpenTimers(card);
        clearExpandClip(card);
        card.classList.remove(
            'is-closing',
            'is-collapsing-wide',
            'is-opening',
            'is-expanding-wide',
            'is-expanding-down',
            'is-revealed',
            'is-stores-revealed'
        );
        syncDetailsClosed(card);
        resetFocusState();
    }

    function beginAreaClose(card) {
        if (!isAreaExpanded(card) || card.classList.contains('is-closing')) return;

        clearOpenTimers(card);
        card.classList.remove('is-revealed', 'is-opening', 'is-expanding-wide', 'is-expanding-down');
        card.classList.add('is-closing', 'is-collapsing-wide');

        const storeHideDelay = prefersReducedMotion() ? 0 : AREA_EXPAND_MS - AREA_STORES_DELAY_MS;
        const storesTimer = setTimeout(() => {
            card.classList.remove('is-stores-revealed');
        }, storeHideDelay);

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                card.classList.remove('is-collapsing-wide');
            });
        });

        const doneTimer = setTimeout(() => {
            finishAreaClose(card);
        }, AREA_EXPAND_MS);

        openTimers.set(card, { doneTimer, storesTimer });
    }

    function closeAreaCard(card, { animate = false } = {}) {
        if (card.classList.contains('is-closing')) return;
        if (animate && isAreaExpanded(card) && !prefersReducedMotion()) {
            beginAreaClose(card);
            return;
        }
        finishAreaClose(card);
    }

    function beginAreaOpen(card) {
        cards.forEach((other) => {
            if (other !== card && isAreaExpanded(other)) closeAreaCard(other);
        });

        clearOpenTimers(card);
        card.classList.remove(
            'is-closing',
            'is-collapsing-wide',
            'is-revealed',
            'is-expanding-down',
            'is-expanding-wide',
            'is-opening',
            'is-stores-revealed'
        );
        syncDetailsOpen(card);
        pinGridSlots();
        captureExpandClip(card, groupGrid);

        groupGrid.classList.add('area-focus-active');
        const pinnedRow = card.style.gridRow;
        if (pinnedRow) card.style.gridRow = pinnedRow;
        card.style.gridColumn = '1 / -1';
        groupGrid.querySelectorAll('.group-item').forEach((item) => {
            const isSelected = item === card;
            item.classList.toggle('is-selected', isSelected);
            item.classList.toggle('is-dimmed', !isSelected);
            if (!isSelected) item.setAttribute('aria-hidden', 'true');
            else item.removeAttribute('aria-hidden');
        });

            requestAnimationFrame(() => {
                card.classList.add('is-opening');
                requestAnimationFrame(() => {
                    card.classList.add('is-expanding-wide', 'is-expanding-down');
                });

                const storesTimer = setTimeout(() => {
                    card.classList.add('is-stores-revealed');
                }, prefersReducedMotion() ? 0 : AREA_STORES_DELAY_MS);

                const doneTimer = setTimeout(() => {
                    card.classList.remove('is-opening', 'is-expanding-wide', 'is-expanding-down');
                    card.classList.add('is-revealed', 'is-stores-revealed');
                    openTimers.delete(card);
                }, AREA_EXPAND_MS);

                openTimers.set(card, { doneTimer, storesTimer });
            });
    }

    cards.forEach((card) => {
        const summary = card.querySelector('.area-tile-summary');
        const returnBtn = card.querySelector('.area-return-btn');

        if (returnBtn) {
            returnBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                closeAreaCard(card, { animate: true });
            });
        }

        if (summary) {
            summary.addEventListener('click', (event) => {
                if (event.target.closest('.area-return-btn')) return;
                event.preventDefault();
                event.stopPropagation();
                if (isAreaExpanded(card)) {
                    closeAreaCard(card, { animate: true });
                    return;
                }
                beginAreaOpen(card);
            });
        }

        // Keep <details open> in sync if the browser toggles it natively.
        card.addEventListener('toggle', () => {
            if (isAreaExpanded(card) && !card.open) {
                clearOpenTimers(card);
                clearExpandClip(card);
                card.classList.remove(
                    'is-closing',
                    'is-collapsing-wide',
                    'is-opening',
                    'is-expanding-wide',
                    'is-expanding-down',
                    'is-revealed',
                    'is-stores-revealed'
                );
                resetFocusState();
                return;
            }
            if (!isAreaExpanded(card) && card.open) {
                card.open = false;
            }
        });
    });
}

function showUserGreeting(me) {
    if (!greetingEl || !me?.success) return;
    const name = String(me.welcomeName || me.displayName || me.username || '').trim();
    if (!name) return;
    greetingEl.textContent = `Hi, ${name}`;
    greetingEl.hidden = false;
}

function storePathFromProfile(me) {
    const fromApi = String(me?.defaultPath || '').trim();
    if (fromApi && fromApi !== '/') return fromApi;
    const name = String(me?.username || '').trim();
    const cbMatch = name.match(/^CB(\d{3,6})$/i);
    if (cbMatch) return `/${cbMatch[1]}`;
    if (/^\d{3,6}$/.test(name)) return `/${name}`;
    return '';
}

async function loadStores() {
    try {
        const meRes = await fetch(`${window.location.origin}/api/me`, { credentials: 'include' });
        if (meRes.ok) {
            const me = await meRes.json();
            showUserGreeting(me);
            const dest = storePathFromProfile(me);
            if (me.success && me.skipStorePicker && dest) {
                markLandscapePreference();
                window.location.replace(dest);
                return;
            }
        }

        const res = await fetch(`${window.location.origin}/api/stores`, { credentials: 'include' });
        if (!res.ok) throw new Error(`API responded with ${res.status}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Failed to load stores');
        renderStores(Array.isArray(data.stores) ? data.stores : [], Array.isArray(data.areas) ? data.areas : []);
    } catch (err) {
        console.error('Failed to load stores:', err);
        showMessage('Could not load the store list. Please try again shortly.');
    }
}

loadStores();
