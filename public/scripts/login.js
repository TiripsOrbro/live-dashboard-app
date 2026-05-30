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

const BRAND_MARK_CYCLE_DUR = '4s';
const BRAND_MARK_WELCOME_CYCLE_DUR = '2.75s';

/** One cycle: yellow draws → red follows → red undraws L→R with feather tail → reset. */
const PATH_LEN = 520;
const PATH_DASH_GAP = PATH_LEN * 2;
const PATH_DASH_OFFSET_VALUES = `${PATH_LEN};${PATH_LEN};0;0;${PATH_LEN};${PATH_LEN}`;
const PATH_DASH_OFFSET_TIMES = '0;0.01;0.40;0.62;0.88;1';
const PATH_OPACITY_VALUES = '0;1;1;0;0';
const PATH_OPACITY_TIMES = '0;0.01;0.88;0.94;1';
const LEAD_MOTION_POINTS = '0;0;0;1;0';
const LEAD_MOTION_TIMES = '0;0.01;0.01;0.40;0.45';
const LEAD_OPACITY_VALUES = '0;0;1;0;0';
const LEAD_OPACITY_TIMES = '0;0.01;0.04;0.40;1';
/** Red follows the drawn line, then leads the left→right undraw. */
const TRAIL_MOTION_POINTS = '0;0;0;1;1;0;0;1;0';
const TRAIL_MOTION_TIMES = '0;0.18;0.18;0.60;0.60;0.64;0.64;0.88;0.94';
const TRAIL_OPACITY_VALUES = '0;0;1;1;0;0;1;0;0';
const TRAIL_OPACITY_TIMES = '0;0.18;0.22;0.58;0.60;0.64;0.66;0.86;0.88';
/** Soft tail slightly behind the red dot during undraw. */
const FEATHER_MOTION_POINTS = '0;0;0;0.88;0';
const FEATHER_MOTION_TIMES = '0;0.64;0.64;0.88;0.94';
const FEATHER_OPACITY_VALUES = '0;0;0.85;0.85;0';
const FEATHER_OPACITY_TIMES = '0;0.64;0.66;0.86;0.88';

function brandMarkSvg(uid, cycleDur = BRAND_MARK_CYCLE_DUR) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" class="brand-mark" aria-hidden="true">
  <defs>
    <radialGradient id="${uid}-bg" cx="50%" cy="50%" r="70%">
      <stop offset="0%" stop-color="#2d0a3d"/>
      <stop offset="100%" stop-color="#000000"/>
    </radialGradient>
    <linearGradient id="${uid}-purple" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#e040fb"/>
      <stop offset="100%" stop-color="#702082"/>
    </linearGradient>
    <radialGradient id="${uid}-feather" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ff4081" stop-opacity="0.55"/>
      <stop offset="35%" stop-color="#ffc72c" stop-opacity="0.75"/>
      <stop offset="70%" stop-color="#ffc72c" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#ffc72c" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#${uid}-bg)"/>
  <circle class="brand-mark-ring--outer" cx="256" cy="256" r="178" fill="none" stroke="#702082" stroke-width="12" opacity="0.45"/>
  <circle class="brand-mark-ring--inner" cx="256" cy="256" r="142" fill="none" stroke="url(#${uid}-purple)" stroke-width="6" opacity="0.65"/>
  <path
    id="${uid}-pulse-path"
    class="brand-mark-pulse"
    fill="none"
    stroke="#ffc72c"
    stroke-width="14"
    stroke-linecap="round"
    stroke-linejoin="round"
    pathLength="${PATH_LEN}"
    stroke-dasharray="${PATH_LEN} ${PATH_DASH_GAP}"
    stroke-dashoffset="${PATH_LEN}"
    opacity="0"
    d="M96 268 L168 268 L208 168 L256 332 L304 204 L352 268 L416 268"
  >
    <animate class="brand-mark-cycle-anim" attributeName="stroke-dashoffset" dur="${cycleDur}" repeatCount="indefinite" calcMode="linear"
      values="${PATH_DASH_OFFSET_VALUES}" keyTimes="${PATH_DASH_OFFSET_TIMES}"/>
    <animate class="brand-mark-cycle-anim" attributeName="opacity" dur="${cycleDur}" repeatCount="indefinite" calcMode="linear"
      values="${PATH_OPACITY_VALUES}" keyTimes="${PATH_OPACITY_TIMES}"/>
  </path>
  <circle class="brand-mark-feather" r="30" fill="url(#${uid}-feather)" opacity="0">
    <animate class="brand-mark-cycle-anim" attributeName="opacity" dur="${cycleDur}" repeatCount="indefinite" calcMode="linear"
      values="${FEATHER_OPACITY_VALUES}" keyTimes="${FEATHER_OPACITY_TIMES}"/>
    <animateMotion class="brand-mark-cycle-anim" dur="${cycleDur}" repeatCount="indefinite" calcMode="linear"
      keyTimes="${FEATHER_MOTION_TIMES}" keyPoints="${FEATHER_MOTION_POINTS}">
      <mpath href="#${uid}-pulse-path"/>
    </animateMotion>
  </circle>
  <circle class="brand-mark-dot--trail" r="11" fill="#ff4081" opacity="0">
    <animate class="brand-mark-cycle-anim" attributeName="opacity" dur="${cycleDur}" repeatCount="indefinite" calcMode="linear"
      values="${TRAIL_OPACITY_VALUES}" keyTimes="${TRAIL_OPACITY_TIMES}"/>
    <animateMotion class="brand-mark-cycle-anim" dur="${cycleDur}" repeatCount="indefinite" calcMode="linear"
      keyTimes="${TRAIL_MOTION_TIMES}" keyPoints="${TRAIL_MOTION_POINTS}">
      <mpath href="#${uid}-pulse-path"/>
    </animateMotion>
  </circle>
  <circle class="brand-mark-dot--lead" r="16" fill="#ffc72c" opacity="0">
    <animate class="brand-mark-cycle-anim" attributeName="opacity" dur="${cycleDur}" repeatCount="indefinite" calcMode="linear"
      values="${LEAD_OPACITY_VALUES}" keyTimes="${LEAD_OPACITY_TIMES}"/>
    <animateMotion class="brand-mark-cycle-anim" dur="${cycleDur}" repeatCount="indefinite" calcMode="linear"
      keyTimes="${LEAD_MOTION_TIMES}" keyPoints="${LEAD_MOTION_POINTS}">
      <mpath href="#${uid}-pulse-path"/>
    </animateMotion>
  </circle>
</svg>`;
}

function mountBrandMark(hostId, uid, cycleDur = BRAND_MARK_CYCLE_DUR) {
    const host = document.getElementById(hostId);
    if (!host) return;
    host.innerHTML = brandMarkSvg(uid, cycleDur);
}

function setBrandMarkBusy(busy) {
    document.querySelectorAll('.brand-mark').forEach((mark) => {
        mark.classList.toggle('brand-mark--busy', busy);
    });
}

mountBrandMark('login-brand-mark', 'login-mark');

const TIMING = {
    loginFade: 550,
    welcomeDisplay: 3400,
    exit: 950,
};

function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
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
    submitBtn.disabled = busy;
    usernameInput.disabled = busy;
    passwordInput.disabled = busy;
    rememberInput.disabled = busy;
    submitBtn.classList.toggle('login-submit--loading', busy);
    submitLabel.textContent = busy ? 'Signing in…' : 'Sign in';
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

function buildWelcomeText(welcomeName) {
    const name = String(welcomeName || '').trim();
    return name ? `Welcome, ${name}` : 'Welcome';
}

let dashboardPreloadFrame = null;

function ensureDashboardPreloadFrame() {
    if (dashboardPreloadFrame) return dashboardPreloadFrame;
    const iframe = document.createElement('iframe');
    iframe.id = 'dashboard-preload';
    iframe.className = 'dashboard-preload';
    iframe.hidden = true;
    iframe.title = 'Dashboard';
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
    const preloadPromise = preloadDashboard(dest);

    resetWelcomeAnimation();
    welcomeMessage.textContent = buildWelcomeText(welcomeName);

    loginStage.classList.add('login-stage--hide');
    await delay(reduced ? 150 : TIMING.loginFade);

    welcomeStage.hidden = false;
    welcomeStage.setAttribute('aria-hidden', 'false');
    mountBrandMark('welcome-brand-mark', 'welcome-mark', BRAND_MARK_WELCOME_CYCLE_DUR);

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

    await delay(reduced ? 280 : TIMING.welcomeDisplay);

    const preloadReady = (await preloadPromise) || isDashboardPreloadReady();

    welcomeStage.classList.remove('welcome-stage--visible');
    welcomeStage.classList.add('welcome-stage--exit');
    if (preloadReady) {
        revealPreloadedDashboard(dest);
    }

    await delay(reduced ? 180 : TIMING.exit);

    if (preloadReady || isDashboardPreloadReady()) {
        completePreloadedTransition(dest);
        return;
    }

    window.location.replace(dest || '/');
}

loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
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
            body: JSON.stringify({ username, password, remember }),
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

        const dest = data.defaultPath || '/';
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
});

readQueryError();
