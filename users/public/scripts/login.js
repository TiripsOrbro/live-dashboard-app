const loginForm = document.getElementById('login-form');
const loginRoot = document.querySelector('.login-root');
const loginStage = document.getElementById('login-stage');
const loginCard = document.getElementById('login-card');
const welcomeStage = document.getElementById('welcome-stage');
const welcomeBrand = document.querySelector('.welcome-brand');
const welcomeMessage = document.getElementById('welcome-message');
const errorEl = document.getElementById('login-error');
const submitBtn = document.getElementById('login-submit');
const submitLabel = document.querySelector('.login-submit-label');
const loginProgress = document.getElementById('login-progress');
const usernameInput = document.getElementById('login-username');
const passwordInput = document.getElementById('login-password');
const rememberInput = document.getElementById('remember-me');

const WELCOME_SKIP_KEY = 'dashboard-welcome-shown';
const DASHBOARD_TIME_ZONE = 'Australia/Melbourne';

function paintBrandMark(hostId, uid) {
    const host = document.getElementById(hostId);
    if (!host || !window.TbaBrandMark?.svg) return false;
    host.innerHTML = window.TbaBrandMark.svg(uid);
    return true;
}

function initLoginBrandMark() {
    if (paintBrandMark('login-brand-mark', 'login-mark')) return;
    if (document.querySelector('script[data-login-brand-mark]')) return;
    const script = document.createElement('script');
    script.src = '/scripts/brand-mark.js';
    script.dataset.loginBrandMark = '1';
    script.onload = () => paintBrandMark('login-brand-mark', 'login-mark');
    document.head.appendChild(script);
}

function mountBrandMark(hostId, uid) {
    paintBrandMark(hostId, uid);
}

function setBrandMarkBusy(busy) {
    window.TbaBrandMark?.setBusy(busy);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLoginBrandMark);
} else {
    initLoginBrandMark();
}

const TIMING = {
    loginFade: 550,
    welcomeDisplay: 3400,
    exit: 950,
};

function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Tap or click anywhere on the welcome screen to skip waits. */
function createWelcomeSkipController() {
    let skipped = false;
    const pending = new Set();

    function skip() {
        if (skipped) return;
        skipped = true;
        for (const cancel of pending) cancel();
        pending.clear();
    }

    function wait(ms) {
        if (skipped) return Promise.resolve();
        return new Promise((resolve) => {
            const timer = window.setTimeout(() => {
                pending.delete(cancel);
                resolve();
            }, ms);
            const cancel = () => {
                window.clearTimeout(timer);
                resolve();
            };
            pending.add(cancel);
        });
    }

    function attach(stage) {
        if (!stage) return () => {};
        const onPointer = () => skip();
        stage.addEventListener('pointerdown', onPointer);
        return () => stage.removeEventListener('pointerdown', onPointer);
    }

    return { skip, wait, attach };
}

function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function todayKey() {
    try {
        return new Date().toLocaleDateString('en-CA', { timeZone: DASHBOARD_TIME_ZONE });
    } catch {
        return new Date().toISOString().slice(0, 10);
    }
}

function shouldSkipWelcomeToday() {
    try {
        return localStorage.getItem(WELCOME_SKIP_KEY) === todayKey();
    } catch {
        return false;
    }
}

function markWelcomeShownToday() {
    try {
        localStorage.setItem(WELCOME_SKIP_KEY, todayKey());
    } catch {
        /* ignore */
    }
}

function triggerHaptic() {
    try {
        if (navigator.vibrate) {
            navigator.vibrate(12);
        }
    } catch {
        /* ignore */
    }
}

function showError(message) {
    errorEl.textContent = message || '';
}

function shakeLoginCard() {
    loginCard.classList.remove('login-card--shake');
    void loginCard.offsetWidth;
    loginCard.classList.add('login-card--shake');
}

function setFormBusy(busy) {
    if (submitBtn) submitBtn.disabled = busy;
    usernameInput.disabled = busy;
    passwordInput.disabled = busy;
    rememberInput.disabled = busy;
    if (submitBtn) {
        submitBtn.classList.toggle('login-submit--loading', busy);
    }
    if (submitLabel) submitLabel.textContent = busy ? 'Signing in...' : 'Sign in';
    if (loginProgress) {
        loginProgress.hidden = !busy;
        loginProgress.setAttribute('aria-hidden', busy ? 'false' : 'true');
    }
    setBrandMarkBusy(busy);
}

function readQueryError() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('error') === 'invalid') {
        showError('Incorrect username or password.');
        shakeLoginCard();
    }
}

function resetWelcomeAnimation() {
    welcomeBrand?.classList.remove('welcome-reveal-active');
    welcomeMessage?.classList.remove('welcome-reveal-active');
    welcomeStage.classList.remove('welcome-stage--visible', 'welcome-stage--exit');
}

function setWelcomeActive(active) {
    document.body.classList.toggle('login-body--welcome-active', active);
}

function buildWelcomeText(welcomeName) {
    const name = String(welcomeName || '').trim();
    return name ? `Welcome, ${name}` : 'Welcome';
}

function loginDestination(data, username) {
    const fromApi = String(data?.defaultPath || '').trim();
    if (fromApi && fromApi !== '/') return fromApi;
    const name = String(username || '').trim();
    const cbMatch = name.match(/^CB(\d{3,6})$/i);
    const store = cbMatch ? cbMatch[1] : /^\d{3,6}$/.test(name) ? name : '';
    if (store) return window.AppPaths?.overview?.() || '/overview';
    return '/login';
}

let dashboardPreloadFrame = null;

const OVERVIEW_SESSION_KEYS = [
    'mic-overview-area',
    'admin-view-as-store-enabled',
    'admin-view-as-store',
];
const AREA_PICKER_PENDING_KEY = 'mic-area-picker-pending';

function markAreaPickerPendingForLogin() {
    try {
        localStorage.setItem(AREA_PICKER_PENDING_KEY, '1');
    } catch {
        /* ignore */
    }
}

function clearAreaPickerPendingForLogin() {
    try {
        localStorage.removeItem(AREA_PICKER_PENDING_KEY);
    } catch {
        /* ignore */
    }
}

function clearOverviewSessionKeysInWindow(win) {
    if (!win) return;
    try {
        for (const key of OVERVIEW_SESSION_KEYS) {
            win.sessionStorage.removeItem(key);
        }
    } catch {
        /* ignore */
    }
}

function clearOverviewSessionKeysInPreloadFrame(iframe) {
    try {
        clearOverviewSessionKeysInWindow(iframe?.contentWindow);
    } catch {
        /* ignore */
    }
}

function ensureDashboardPreloadFrame() {
    if (dashboardPreloadFrame) return dashboardPreloadFrame;
    const iframe = document.createElement('iframe');
    iframe.id = 'dashboard-preload';
    iframe.className = 'dashboard-preload';
    iframe.hidden = true;
    iframe.title = 'MIC overview';
    document.body.appendChild(iframe);
    dashboardPreloadFrame = iframe;
    return iframe;
}

function preloadDashboard(dest) {
    const target = dest || '/';
    const iframe = ensureDashboardPreloadFrame();

    return new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => {
            if (settled) return;
            settled = true;
            resolve(ok);
        };

        const timeoutId = window.setTimeout(() => finish(false), 15000);

        iframe.addEventListener(
            'load',
            () => {
                window.clearTimeout(timeoutId);
                clearOverviewSessionKeysInPreloadFrame(iframe);
                try {
                    if (iframe.contentWindow?.location?.pathname === '/login') {
                        finish(false);
                        return;
                    }
                } catch {
                    /* ignore */
                }
                finish(true);
            },
            { once: true }
        );

        iframe.removeAttribute('hidden');
        iframe.src = target;
    });
}

function isDashboardPreloadReady() {
    const iframe = dashboardPreloadFrame;
    if (!iframe?.src) return false;
    try {
        if (iframe.contentWindow?.location?.pathname === '/login') return false;
        return iframe.contentDocument?.readyState === 'complete';
    } catch {
        return false;
    }
}

function revealPreloadedDashboard(dest) {
    const iframe = dashboardPreloadFrame;
    if (!iframe) return false;

    iframe.classList.add('dashboard-preload--active');
    iframe.removeAttribute('hidden');

    try {
        history.replaceState(null, '', dest || '/');
    } catch {
        /* ignore */
    }

    return true;
}

function completePreloadedTransition(dest) {
    const iframe = dashboardPreloadFrame;
    if (!iframe?.classList.contains('dashboard-preload--active')) {
        if (!revealPreloadedDashboard(dest)) return false;
    }

    welcomeStage.classList.remove('welcome-stage--visible', 'welcome-stage--exit');
    welcomeStage.hidden = true;
    welcomeStage.setAttribute('aria-hidden', 'true');
    setWelcomeActive(false);

    loginRoot?.setAttribute('hidden', '');
    loginStage?.setAttribute('hidden', '');
    document.body.classList.add('login-body--dashboard-reveal');

    try {
        const title = iframe.contentDocument?.title;
        if (title) document.title = title;
    } catch {
        /* ignore */
    }

    return true;
}

async function playWelcomeTransition(welcomeName, dest) {
    const reduced = prefersReducedMotion();
    const skipCtrl = createWelcomeSkipController();
    const preloadPromise = preloadDashboard(dest);

    resetWelcomeAnimation();
    welcomeMessage.textContent = buildWelcomeText(welcomeName);

    loginStage.classList.add('login-stage--hide');
    await delay(reduced ? 150 : TIMING.loginFade);

    welcomeStage.hidden = false;
    welcomeStage.setAttribute('aria-hidden', 'false');
    setWelcomeActive(true);
    mountBrandMark('welcome-brand-mark', `welcome-mark-${Date.now()}`);

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            welcomeStage.classList.add('welcome-stage--visible');
            triggerHaptic();
            if (reduced) {
                welcomeBrand.style.opacity = '1';
                welcomeMessage.style.opacity = '1';
                return;
            }
            welcomeBrand?.classList.add('welcome-reveal-active');
            welcomeMessage.classList.add('welcome-reveal-active');
        });
    });

    markWelcomeShownToday();

    const detachSkip = skipCtrl.attach(welcomeStage);
    try {
        await skipCtrl.wait(reduced ? 280 : TIMING.welcomeDisplay);

        const preloadReady = (await preloadPromise) || isDashboardPreloadReady();

        welcomeStage.classList.remove('welcome-stage--visible');
        welcomeStage.classList.add('welcome-stage--exit');
        if (preloadReady) {
            revealPreloadedDashboard(dest);
        }

        await skipCtrl.wait(reduced ? 180 : TIMING.exit);

        if (preloadReady || isDashboardPreloadReady()) {
            completePreloadedTransition(dest);
            return;
        }

        window.location.replace(dest || '/login');
    } finally {
        detachSkip();
    }
}

async function submitLogin() {
    showError('');

    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    const remember = rememberInput.checked;

    if (!password) {
        showError('Enter your password.');
        passwordInput.focus();
        return;
    }

    setFormBusy(true);

    try {
        const res = await fetch(`${window.location.origin}/login`, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            credentials: 'include',
            body: JSON.stringify({ username, password, remember, mode: 'mic' }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok || !data.success) {
            showError(data.error || 'Incorrect username or password.');
            shakeLoginCard();
            setFormBusy(false);
            passwordInput.focus();
            passwordInput.select();
            return;
        }

        if (data.mustChangePassword) {
            window.location.replace('/change-password');
            return;
        }

        const dest = loginDestination(data, username);
        try {
            for (const key of OVERVIEW_SESSION_KEYS) {
                sessionStorage.removeItem(key);
            }
            markAreaPickerPendingForLogin();
            sessionStorage.setItem(
                'dashboard-entry',
                String(dest || '').startsWith('/admin') ? 'admin' : 'store'
            );
        } catch (_) {
            /* ignore */
        }
        if (shouldSkipWelcomeToday()) {
            window.location.replace(dest);
            return;
        }

        await playWelcomeTransition(data.welcomeName, dest);
    } catch (err) {
        console.error('Login failed:', err);
        showError('Could not sign in. Check your connection and try again.');
        shakeLoginCard();
        setFormBusy(false);
    }
}

loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await submitLogin();
});

readQueryError();

try {
    clearAreaPickerPendingForLogin();
    for (const key of OVERVIEW_SESSION_KEYS) {
        sessionStorage.removeItem(key);
    }
} catch {
    /* ignore */
}

const loginVersionEl = document.getElementById('login-version');
const loginUpdateBtn = document.getElementById('login-update-btn');
let loginMetaPollId = null;

function formatVersionLabel(raw) {
    const label = String(raw || '').trim();
    if (!label) return '';
    return `Version ${label.replace(/^version[- ]?/i, '')}`;
}

function setLoginVersion(version) {
    if (!loginVersionEl) return;
    loginVersionEl.textContent = formatVersionLabel(version);
}

function setLoginUpdateVisible(visible) {
    if (!loginUpdateBtn) return;
    loginUpdateBtn.hidden = !visible;
}

async function refreshLoginMeta() {
    if (!window.DashboardMeta?.fetchMeta) return;
    try {
        const meta = await window.DashboardMeta.fetchMeta();
        setLoginVersion(meta.version);
        if (window.DashboardMeta.needsUpdate(meta)) {
            setLoginUpdateVisible(true);
            return;
        }
        setLoginUpdateVisible(false);
        if (!localStorage.getItem(window.DashboardMeta.BOOT_STORAGE_KEY)) {
            window.DashboardMeta.markSynced(meta);
        }
    } catch {
        /* ignore - version footer stays blank */
    }
}

if (loginUpdateBtn) {
    loginUpdateBtn.addEventListener('click', async () => {
        loginUpdateBtn.disabled = true;
        try {
            await window.DashboardMeta?.hardRefresh?.();
        } catch {
            loginUpdateBtn.disabled = false;
        }
    });
}

refreshLoginMeta();
loginMetaPollId = window.setInterval(refreshLoginMeta, 60000);
window.addEventListener('pagehide', () => {
    if (loginMetaPollId) window.clearInterval(loginMetaPollId);
});
