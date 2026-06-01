/**
 * Landscape upselling podium for enabled stores (e.g. teststore / 3811 per config).
 * Reveals every 5 minutes (and on load): fade + slide up, then fade + slide down.
 */
(function upsellingPodiumModule(global) {
    const POLL_MS = 60000;
    const CYCLE_MS = 5 * 60 * 1000;
    const ANIM_MS = 550;
    const SHOW_DURATION_MS = 45 * 1000;
    const API_BASE = `${global.location.origin}/api/upselling`;

    const CROWN_SVG = `<svg class="upsell-podium__crown-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M4 18h16v2H4v-2zm1.2-8.5L7 12.2l2.8-4.1L12 11l2.2-2.9L17 12.2l1.8-2.7L22 9l-2.2 9H4.2L2 9l3.2-.5zM7.4 8.2 12 4l4.6 4.2-.9-2.2L12 7.1l-2.7-1.1-.9 2.2z"/>
    </svg>`;

    let storeNumber = '';
    let pollTimer = null;
    let cycleTimer = null;
    let hideTimer = null;
    let enabled = false;
    let lastPayload = null;
    let revealCycleActive = false;

    function apiUrl() {
        const params = new URLSearchParams();
        if (storeNumber) params.set('store', storeNumber);
        const qs = params.toString();
        return qs ? `${API_BASE}?${qs}` : API_BASE;
    }

    function ensurePodiumEl() {
        let el = document.getElementById('upsell-podium');
        if (el) return el;
        el = document.createElement('div');
        el.id = 'upsell-podium';
        el.setAttribute('hidden', '');
        el.innerHTML = `
            <div class="upsell-podium__inner" aria-live="polite">
                <div class="upsell-podium__label">Upsell leaderboard</div>
                <div class="upsell-podium__cols"></div>
                <div class="upsell-podium__updated"></div>
                <p class="upsell-podium__disclaimer">Updates every hour on the hour</p>
            </div>
        `;
        document.body.appendChild(el);
        return el;
    }

    function clearRevealTimers() {
        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
    }

    function stopRevealCycle() {
        revealCycleActive = false;
        clearRevealTimers();
        if (cycleTimer) {
            clearInterval(cycleTimer);
            cycleTimer = null;
        }
        const root = document.getElementById('upsell-podium');
        if (root) root.classList.remove('upsell-podium--revealed');
    }

    function shouldAnimatePodium() {
        if (!enabled || !lastPayload) return false;
        if (document.body.classList.contains('dashboard--portrait')) return false;
        return true;
    }

    function hidePodiumAnimated(root) {
        if (!root) return;
        root.classList.remove('upsell-podium--revealed');
    }

    function showPodiumAnimated(root) {
        if (!root || !shouldAnimatePodium()) return;
        clearRevealTimers();
        root.removeAttribute('hidden');
        root.classList.remove('upsell-podium--revealed');
        root.offsetHeight;
        requestAnimationFrame(() => {
            root.classList.add('upsell-podium--revealed');
        });
        hideTimer = setTimeout(() => {
            hideTimer = null;
            hidePodiumAnimated(root);
        }, SHOW_DURATION_MS + ANIM_MS);
    }

    function startRevealCycle() {
        if (revealCycleActive || !shouldAnimatePodium()) return;
        revealCycleActive = true;

        const root = ensurePodiumEl();
        showPodiumAnimated(root);

        cycleTimer = setInterval(() => {
            if (!shouldAnimatePodium()) return;
            showPodiumAnimated(ensurePodiumEl());
        }, CYCLE_MS);
        cycleTimer.unref?.();
    }

    /** Left-to-right podium: 4th, 2nd, 1st, 3rd, 5th. */
    function buildPodiumOrder(data) {
        const top5 = Array.isArray(data?.top5)
            ? data.top5
            : Array.isArray(data?.top3)
              ? data.top3
              : [];
        const byRank = new Map(top5.map((row) => [row.rank, row]));
        const layout = [4, 2, 1, 3, 5];
        return layout.map((rank) => byRank.get(rank)).filter(Boolean);
    }

    function formatUpdated(iso) {
        if (!iso) return '';
        try {
            const d = new Date(iso);
            return `Updated ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        } catch (_) {
            return '';
        }
    }

    function renderPodium(data) {
        const root = ensurePodiumEl();
        const portrait = document.body.classList.contains('dashboard--portrait');
        if (!data?.enabled || portrait) {
            stopRevealCycle();
            root.classList.remove('upsell-podium--revealed');
            root.setAttribute('hidden', '');
            return;
        }
        root.removeAttribute('hidden');

        const order = buildPodiumOrder(data);

        const cols = root.querySelector('.upsell-podium__cols');
        if (cols) {
            cols.innerHTML = order
                .map((row) => {
                    const barClass =
                        row.rank === 1
                            ? 'upsell-podium__bar upsell-podium__bar--first'
                            : 'upsell-podium__bar';
                    const nameHtml =
                        row.rank === 1
                            ? `<div class="upsell-podium__name-row">
                        <span class="upsell-podium__name-anchor">
                            <span class="upsell-podium__crown">${CROWN_SVG}</span>
                            <span class="upsell-podium__name">${escapeHtml(row.name)}</span>
                        </span>
                    </div>`
                            : `<div class="upsell-podium__name">${escapeHtml(row.name)}</div>`;
                    return `
                <div class="upsell-podium__col upsell-podium__col--place-${row.rank}">
                    <div class="upsell-podium__bar-slot">
                        <div class="${barClass}" aria-hidden="true"></div>
                    </div>
                    <div class="upsell-podium__place">#${row.rank}</div>
                    ${nameHtml}
                    <div class="upsell-podium__score">${escapeHtml(String(row.total))}</div>
                </div>
            `;
                })
                .join('');
        }

        const updated = root.querySelector('.upsell-podium__updated');
        if (updated) {
            const parts = [formatUpdated(data.lastSyncAt)];
            if (data.reportDate) parts.push(`Report ${data.reportDate}`);
            updated.textContent = parts.filter(Boolean).join(' · ');
        }
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    async function refresh() {
        if (!storeNumber) return;
        try {
            const res = await fetch(apiUrl(), { credentials: 'same-origin' });
            if (!res.ok) return;
            const data = await res.json();
            enabled = Boolean(data.enabled);
            lastPayload = data;
            renderPodium(data);
            if (enabled) {
                startRevealCycle();
            } else {
                stopRevealCycle();
            }
        } catch (_) {
            /* ignore transient errors */
        }
    }

    function stopPoll() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    function startPoll() {
        stopPoll();
        if (!enabled) return;
        pollTimer = setInterval(refresh, POLL_MS);
    }

    function onLayoutChange() {
        const portrait = document.body.classList.contains('dashboard--portrait');
        if (portrait) {
            stopRevealCycle();
            const root = document.getElementById('upsell-podium');
            if (root) {
                root.classList.remove('upsell-podium--revealed');
                root.setAttribute('hidden', '');
            }
        } else if (lastPayload?.enabled) {
            renderPodium(lastPayload);
            revealCycleActive = false;
            startRevealCycle();
        }
    }

    function init(nextStore) {
        storeNumber = String(nextStore || '').trim();
        ensurePodiumEl();
        refresh().then(() => startPoll());
    }

    global.upsellingPodium = {
        init,
        refresh,
        onLayoutChange,
        stopPoll,
        stopRevealCycle,
    };

    global.addEventListener('resize', onLayoutChange);
})(window);
