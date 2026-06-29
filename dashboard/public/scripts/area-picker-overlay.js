/** Area picker at login — overview loads underneath; pick is remembered until the next sign-in. */
(function (global) {
    const STORAGE_KEY = 'mic-overview-area';
    const PENDING_KEY = 'mic-area-picker-pending';
    const TIMING = { exit: 900, pickFade: 100 };

    function areaDisplayLabel(name) {
        return global.AreaDisplay?.label?.(name) ?? String(name || '').trim();
    }

    function renderAreaOptions(areaNames) {
        const last = areaNames.length - 1;
        const parts = [];
        areaNames.forEach((name, idx) => {
            parts.push(
                `<button type="button" class="area-picker-option area-picker-option--text" role="option" data-area-name="${escapeAttr(name)}">${escapeHtml(areaDisplayLabel(name))}</button>`
            );
            if (idx < last) {
                parts.push('<span class="area-picker-pipe" aria-hidden="true">|</span>');
            }
        });
        return `<div class="area-picker-options area-picker-options--text" role="listbox" aria-label="Select area">${parts.join('')}</div>`;
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function escapeAttr(value) {
        return escapeHtml(value);
    }

    function getStoredArea() {
        try {
            return String(sessionStorage.getItem(STORAGE_KEY) || '').trim();
        } catch {
            return '';
        }
    }

    function setStoredArea(name) {
        try {
            const value = String(name || '').trim();
            if (value) sessionStorage.setItem(STORAGE_KEY, value);
        } catch {
            /* ignore */
        }
    }

    function marketLabel(profile) {
        const markets = profile?.accessibleMarkets;
        if (Array.isArray(markets) && markets.length) return markets[0];
        return 'Market 1';
    }

    function shouldShowPicker(profile) {
        if (!scopeNeedsAreaPicker(profile)) return false;
        if (isPickerPending()) return true;
        if (getStoredArea()) return false;
        return true;
    }

    function resolveInitialAreaNames(profile, overviewAreas) {
        const fromOverview = (overviewAreas || []).map((row) => String(row?.name || '').trim()).filter(Boolean);
        if (fromOverview.length) return fromOverview;
        const fromProfile = (profile?.accessibleAreas || []).map((name) => String(name || '').trim()).filter(Boolean);
        if (fromProfile.length) return fromProfile;
        const scope = profile?.overviewScope;
        if (scope === 'market' || scope === 'super') {
            return ['VIC-1', 'WA-1', 'QLD-1'];
        }
        return [];
    }

    function areaIndexForName(areas, name) {
        const target = String(name || '').trim();
        const idx = (areas || []).findIndex((row) => String(row?.name || '').trim() === target);
        return idx >= 0 ? idx : 0;
    }

    function clearStoredArea() {
        try {
            sessionStorage.removeItem(STORAGE_KEY);
        } catch {
            /* ignore */
        }
    }

    /** Set on successful sign-in (localStorage — visible to login preload iframe). */
    function isPickerPending() {
        try {
            return localStorage.getItem(PENDING_KEY) === '1';
        } catch {
            return false;
        }
    }

    function markPickerPending() {
        try {
            localStorage.setItem(PENDING_KEY, '1');
        } catch {
            /* ignore */
        }
    }

    function clearPickerPending() {
        try {
            localStorage.removeItem(PENDING_KEY);
        } catch {
            /* ignore */
        }
    }

    function scopeNeedsAreaPicker(profile) {
        const scope = profile?.overviewScope;
        if (!profile || scope === 'store') return false;
        if (scope === 'area') return (profile.accessibleAreas || []).length > 1;
        if (scope === 'market' || scope === 'super') return true;
        return false;
    }

    function hostDocument() {
        try {
            if (global.frameElement && global.parent?.document) {
                return global.parent.document;
            }
        } catch {
            /* ignore */
        }
        return global.document;
    }

    function overlayDocument() {
        return hostDocument();
    }

    function isWelcomeActive(doc) {
        if (!doc?.body) return false;
        if (doc.body.classList.contains('welcome-overlay-active')) return true;
        if (doc.body.classList.contains('login-body--welcome-active')) return true;
        const stage = doc.getElementById('welcome-stage');
        if (!stage) return false;
        if (stage.hidden || stage.getAttribute('aria-hidden') === 'true') return false;
        return (
            stage.classList.contains('welcome-stage--visible') &&
            !stage.classList.contains('welcome-stage--exit')
        );
    }

    function waitForWelcomeGone() {
        return new Promise((resolve) => {
            const poll = () => {
                if (!isWelcomeActive(overlayDocument())) {
                    resolve();
                    return;
                }
                global.requestAnimationFrame(poll);
            };
            poll();
        });
    }

    function waitForFrameVisible() {
        const maxWaitMs = 12000;
        const started = Date.now();
        return new Promise((resolve) => {
            const poll = () => {
                const frame = global.frameElement;
                if (!frame) {
                    resolve();
                    return;
                }
                if (frame.classList.contains('dashboard-preload--active')) {
                    resolve();
                    return;
                }
                try {
                    if (global.parent.document.body.classList.contains('login-body--dashboard-reveal')) {
                        resolve();
                        return;
                    }
                } catch {
                    resolve();
                    return;
                }
                if (Date.now() - started >= maxWaitMs) {
                    resolve();
                    return;
                }
                global.requestAnimationFrame(poll);
            };
            poll();
        });
    }

    async function waitForReadyToShow() {
        if (!isPickerPending()) return;
        const doc = overlayDocument();
        if (!isWelcomeActive(doc) && !global.frameElement) return;
        await waitForWelcomeGone();
        await waitForFrameVisible();
    }

    let activeStage = null;
    let dismissResolver = null;

    function injectStage(profile, areaNames, onPick) {
        const doc = overlayDocument();
        if (doc.getElementById('area-picker-stage')) {
            return doc.getElementById('area-picker-stage');
        }

        const stage = doc.createElement('section');
        stage.id = 'area-picker-stage';
        stage.className =
            'welcome-stage area-picker-stage area-picker-stage--text welcome-stage--dashboard welcome-stage--visible';
        stage.setAttribute('role', 'dialog');
        stage.setAttribute('aria-modal', 'true');
        stage.setAttribute('aria-label', 'Select area');

        stage.innerHTML = `
            <div class="welcome-stage-inner area-picker-stage-inner area-picker-stage-inner--text">
                ${renderAreaOptions(areaNames)}
            </div>`;

        doc.body.prepend(stage);
        doc.body.classList.add('area-picker-overlay-active');
        stage.classList.add('area-picker-stage--ready');

        global.requestAnimationFrame(() => {
            global.requestAnimationFrame(() => {
                stage.classList.add('area-picker-stage--ready');
            });
        });

        stage.querySelectorAll('.area-picker-option').forEach((btn) => {
            btn.addEventListener('click', () => {
                const name = btn.dataset.areaName || '';
                if (!name) return;
                stage.querySelectorAll('.area-picker-option').forEach((row) => {
                    row.classList.toggle('is-active', row === btn);
                });
                setStoredArea(name);
                onPick?.(name);
            });
        });

        activeStage = stage;
        return stage;
    }

    async function dismiss() {
        const doc = overlayDocument();
        const stage = activeStage || doc.getElementById('area-picker-stage');
        if (!stage) {
            dismissResolver?.();
            dismissResolver = null;
            return;
        }
        const reduced = global.matchMedia('(prefers-reduced-motion: reduce)').matches;
        doc.body.classList.add('area-picker-overlay-exiting');
        stage.classList.add('welcome-stage--exit', 'area-picker-stage--exit');
        await new Promise((resolve) => {
            global.setTimeout(resolve, reduced ? 180 : TIMING.exit);
        });
        stage.remove();
        doc.body.classList.remove('area-picker-overlay-active', 'area-picker-overlay-exiting');
        activeStage = null;
        dismissResolver?.();
        dismissResolver = null;
    }

    /**
     * Show the picker when needed. Resolves when the overlay is dismissed.
     * @returns {Promise<string>} selected area name, or '' if skipped
     */
    async function show({ profile, areaNames, onPick }) {
        const names = (areaNames || []).filter(Boolean);
        const pending = isPickerPending();

        if (!pending) {
            const stored = getStoredArea();
            if (stored) return stored;
        } else {
            clearStoredArea();
        }

        if (!shouldShowPicker(profile) || names.length <= 1) {
            clearPickerPending();
            if (names.length === 1) setStoredArea(names[0]);
            return names[0] || '';
        }

        await waitForReadyToShow();

        return new Promise((resolve) => {
            let picked = '';
            dismissResolver = () => {
                clearPickerPending();
                resolve(picked || getStoredArea());
            };

            injectStage(profile, names, (name) => {
                picked = name;
                setStoredArea(name);
                clearPickerPending();
                onPick?.(name);
                global.setTimeout(() => {
                    void dismiss();
                }, TIMING.pickFade);
            });
        });
    }

    global.MicAreaPicker = {
        shouldShowPicker,
        isPickerPending,
        markPickerPending,
        clearPickerPending,
        getStoredArea,
        setStoredArea,
        clearStoredArea,
        show,
        dismiss,
        areaIndexForName,
        resolveInitialAreaNames,
        marketLabel,
    };
})();
