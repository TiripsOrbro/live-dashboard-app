const loginForm = document.getElementById('login-form');
const loginStage = document.getElementById('login-stage');
const welcomeStage = document.getElementById('welcome-stage');
const welcomeLabel = document.getElementById('welcome-label');
const welcomeNameRow = document.getElementById('welcome-name-row');
const welcomeNameEl = document.getElementById('welcome-name');
const errorEl = document.getElementById('login-error');
const submitBtn = document.getElementById('login-submit');
const usernameInput = document.getElementById('login-username');
const passwordInput = document.getElementById('login-password');

const TIMING = {
    loginFade: 450,
    welcomeFadeIn: 450,
    welcomeHold: 1100,
    welcomeExit: 520,
};

function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function showError(message) {
    errorEl.textContent = message || '';
}

function setFormBusy(busy) {
    submitBtn.disabled = busy;
    usernameInput.disabled = busy;
    passwordInput.disabled = busy;
}

function readQueryError() {
    const params = new URLSearchParams(window.location.search);
    const err = params.get('error');
    if (err === 'invalid') {
        showError('Incorrect username or password.');
    }
}

async function playWelcomeTransition(welcomeName, dest) {
    const name = String(welcomeName || '').trim();
    const reduced = prefersReducedMotion();

    loginStage.classList.add('login-stage--hide');
    await delay(reduced ? 80 : TIMING.loginFade);

    welcomeStage.hidden = false;
    welcomeStage.setAttribute('aria-hidden', 'false');

    if (name) {
        welcomeNameEl.textContent = name;
        welcomeNameRow.hidden = false;
    } else {
        welcomeNameRow.hidden = true;
    }

    requestAnimationFrame(() => {
        welcomeStage.classList.add('welcome-stage--visible');
        if (!reduced) {
            welcomeLabel.classList.add('welcome-wipe-in');
            if (name) {
                document.querySelector('.welcome-name-wrap')?.classList.add('welcome-wipe-in');
            }
        }
    });

    await delay(reduced ? 400 : TIMING.welcomeFadeIn + TIMING.welcomeHold);

    welcomeStage.classList.add('welcome-stage--exit');
    await delay(reduced ? 120 : TIMING.welcomeExit);

    window.location.replace(dest || '/');
}

loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('');

    const username = usernameInput.value.trim();
    const password = passwordInput.value;

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
            body: JSON.stringify({ username, password }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok || !data.success) {
            showError(data.error || 'Incorrect username or password.');
            setFormBusy(false);
            passwordInput.focus();
            passwordInput.select();
            return;
        }

        await playWelcomeTransition(data.welcomeName, data.defaultPath || '/');
    } catch (err) {
        console.error('Login failed:', err);
        showError('Could not sign in. Check your connection and try again.');
        setFormBusy(false);
    }
});

readQueryError();
