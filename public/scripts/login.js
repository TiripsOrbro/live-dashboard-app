const loginForm = document.getElementById('login-form');
const loginStage = document.getElementById('login-stage');
const loginCard = document.getElementById('login-card');
const welcomeStage = document.getElementById('welcome-stage');
const welcomeBrand = document.querySelector('.welcome-brand');
const welcomeMessage = document.getElementById('welcome-message');
const errorEl = document.getElementById('login-error');
const submitBtn = document.getElementById('login-submit');
const submitLabel = document.querySelector('.login-submit-label');
const usernameInput = document.getElementById('login-username');
const passwordInput = document.getElementById('login-password');
const rememberInput = document.getElementById('remember-me');

const WELCOME_SKIP_KEY = 'dashboard-welcome-shown';
const DASHBOARD_TIME_ZONE = 'Australia/Melbourne';

function brandMarkSvg(uid) {
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
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#${uid}-bg)"/>
  <circle class="brand-mark-ring--outer" cx="256" cy="256" r="178" fill="none" stroke="#702082" stroke-width="12" opacity="0.45"/>
  <circle class="brand-mark-ring--inner" cx="256" cy="256" r="142" fill="none" stroke="url(#${uid}-purple)" stroke-width="6" opacity="0.65"/>
  <path
    class="brand-mark-pulse"
    fill="none"
    stroke="#ffc72c"
    stroke-width="14"
    stroke-linecap="round"
    stroke-linejoin="round"
    pathLength="520"
    d="M96 268 L168 268 L208 168 L256 332 L304 204 L352 268 L416 268"
  />
  <circle class="brand-mark-dot--peak" cx="256" cy="332" r="10" fill="#ff4081"/>
  <circle class="brand-mark-dot--center" cx="256" cy="256" r="12" fill="#ffc72c"/>
</svg>`;
}

function mountBrandMark(hostId, uid) {
    const host = document.getElementById(hostId);
    if (!host) return;
    host.innerHTML = brandMarkSvg(uid);
}

function setBrandMarkBusy(busy) {
    document.querySelectorAll('.brand-mark').forEach((mark) => {
        mark.classList.toggle('brand-mark--busy', busy);
    });
}

mountBrandMark('login-brand-mark', 'login-mark');
mountBrandMark('welcome-brand-mark', 'welcome-mark');

const TIMING = {
    loginFade: 550,
    welcomeDisplay: 3400,
    exit: 900,
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

async function playWelcomeTransition(welcomeName, dest) {
    const reduced = prefersReducedMotion();

    resetWelcomeAnimation();
    welcomeMessage.textContent = buildWelcomeText(welcomeName);

    loginStage.classList.add('login-stage--hide');
    await delay(reduced ? 150 : TIMING.loginFade);

    welcomeStage.hidden = false;
    welcomeStage.setAttribute('aria-hidden', 'false');

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

    welcomeStage.classList.add('welcome-stage--exit');
    await delay(reduced ? 180 : TIMING.exit);

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
