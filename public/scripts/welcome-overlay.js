/** Post-login welcome overlay — dashboard / store list load underneath while this plays. */
const WELCOME_PENDING_KEY = 'dashboard-welcome-pending';

const TIMING = {
    display: 3400,
    exit: 900,
};

function brandMarkSvg(uid) {
    return window.TbaBrandMark?.svg(uid) || '';
}

function mountBrandMark(host, uid) {
    if (!host) return;
    host.innerHTML = brandMarkSvg(uid);
}

function consumeWelcomePending() {
    try {
        const raw = sessionStorage.getItem(WELCOME_PENDING_KEY);
        if (!raw) return null;
        sessionStorage.removeItem(WELCOME_PENDING_KEY);
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function buildWelcomeText(welcomeName) {
    const name = String(welcomeName || '').trim();
    return name ? `Welcome, ${name}` : 'Welcome';
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

function injectWelcomeOverlay(welcomeName) {
    if (document.getElementById('welcome-stage')) {
        return document.getElementById('welcome-stage');
    }

    const markId = `welcome-mark-${Date.now()}`;
    const stage = document.createElement('section');
    stage.id = 'welcome-stage';
    stage.className = 'welcome-stage welcome-stage--dashboard welcome-stage--visible';
    stage.setAttribute('aria-live', 'polite');
    stage.innerHTML = `
        <div class="welcome-brand" aria-hidden="true">
            <div class="welcome-logo" id="welcome-brand-mark" aria-hidden="true"></div>
        </div>
        <div class="welcome-copy">
            <p class="welcome-line">
                <span class="welcome-message"></span>
            </p>
        </div>
    `;

    document.body.prepend(stage);
    document.body.classList.add('welcome-overlay-active');
    mountBrandMark(stage.querySelector('#welcome-brand-mark'), markId);
    return stage;
}

async function runWelcomeSequence(welcomeName) {
    const reduced = prefersReducedMotion();
    const stage = injectWelcomeOverlay(welcomeName);
    const brand = stage.querySelector('.welcome-brand');
    const message = stage.querySelector('.welcome-message');
    if (!message) return;

    message.textContent = buildWelcomeText(welcomeName);

    await new Promise((resolve) => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                triggerHaptic();
                if (reduced) {
                    if (brand) brand.style.opacity = '1';
                    message.style.opacity = '1';
                } else {
                    brand?.classList.add('welcome-reveal-active');
                    message.classList.add('welcome-reveal-active');
                }
                resolve();
            });
        });
    });

    await delay(reduced ? 280 : TIMING.display);

    stage.classList.add('welcome-stage--exit');
    await delay(reduced ? 180 : TIMING.exit);

    stage.remove();
    document.body.classList.remove('welcome-overlay-active');
}

(function bootstrapWelcomeOverlay() {
    const pending = consumeWelcomePending();
    if (!pending) return;
    void runWelcomeSequence(pending.welcomeName);
})();
