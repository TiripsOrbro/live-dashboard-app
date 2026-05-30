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

const TIMING = {
    loginFade: 400,
    welcomeDisplay: 1800,
    exit: 550,
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
    await delay(reduced ? 100 : TIMING.loginFade);

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

    await delay(reduced ? 200 : TIMING.welcomeDisplay);

    welcomeStage.classList.add('welcome-stage--exit');
    await delay(reduced ? 120 : TIMING.exit);

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
