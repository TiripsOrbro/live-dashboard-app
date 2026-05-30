/** Post-login welcome overlay — dashboard / store list load underneath while this plays. */
const WELCOME_PENDING_KEY = 'dashboard-welcome-pending';
const BRAND_MARK_CYCLE_DUR = '2.8s';

const TIMING = {
    display: 3400,
    exit: 900,
};

const PATH_DASH_VALUES = '520;520;0;0;-520;-520;520';
const PATH_DASH_TIMES = '0;0.05;0.40;0.82;0.94;0.96;1';
const PATH_OPACITY_VALUES = '0;1;1;1;1;0;0';
const PATH_OPACITY_TIMES = '0;0.05;0.40;0.82;0.94;0.96;1';
const LEAD_MOTION_POINTS = '0;0;0;1;1;0';
const LEAD_MOTION_TIMES = '0;0.05;0.05;0.40;0.96;1';
const LEAD_OPACITY_VALUES = '0;0;1;0;0;0';
const LEAD_OPACITY_TIMES = '0;0.05;0.08;0.40;0.96;1';
const TRAIL_MOTION_POINTS = '0;0;0;1;1;0';
const TRAIL_MOTION_TIMES = '0;0.18;0.18;0.78;0.96;1';
const TRAIL_OPACITY_VALUES = '0;0;1;1;0;0';
const TRAIL_OPACITY_TIMES = '0;0.18;0.22;0.78;0.82;1';

function brandMarkSvg(uid) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" class="brand-mark" aria-hidden="true">
  <defs>
    <linearGradient id="${uid}-purple" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#e040fb"/>
      <stop offset="100%" stop-color="#702082"/>
    </linearGradient>
  </defs>
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
    pathLength="520"
    stroke-dasharray="520"
    stroke-dashoffset="520"
    opacity="0"
    d="M96 268 L168 268 L208 168 L256 332 L304 204 L352 268 L416 268"
  >
    <animate class="brand-mark-cycle-anim" attributeName="stroke-dashoffset" dur="${BRAND_MARK_CYCLE_DUR}" repeatCount="indefinite" calcMode="linear"
      values="${PATH_DASH_VALUES}" keyTimes="${PATH_DASH_TIMES}"/>
    <animate class="brand-mark-cycle-anim" attributeName="opacity" dur="${BRAND_MARK_CYCLE_DUR}" repeatCount="indefinite" calcMode="linear"
      values="${PATH_OPACITY_VALUES}" keyTimes="${PATH_OPACITY_TIMES}"/>
  </path>
  <circle class="brand-mark-dot--trail" r="11" fill="#ff4081" opacity="0">
    <animate class="brand-mark-cycle-anim" attributeName="opacity" dur="${BRAND_MARK_CYCLE_DUR}" repeatCount="indefinite" calcMode="linear"
      values="${TRAIL_OPACITY_VALUES}" keyTimes="${TRAIL_OPACITY_TIMES}"/>
    <animateMotion class="brand-mark-cycle-anim" dur="${BRAND_MARK_CYCLE_DUR}" repeatCount="indefinite" calcMode="linear"
      keyTimes="${TRAIL_MOTION_TIMES}" keyPoints="${TRAIL_MOTION_POINTS}">
      <mpath href="#${uid}-pulse-path"/>
    </animateMotion>
  </circle>
  <circle class="brand-mark-dot--lead" r="16" fill="#ffc72c" opacity="0">
    <animate class="brand-mark-cycle-anim" attributeName="opacity" dur="${BRAND_MARK_CYCLE_DUR}" repeatCount="indefinite" calcMode="linear"
      values="${LEAD_OPACITY_VALUES}" keyTimes="${LEAD_OPACITY_TIMES}"/>
    <animateMotion class="brand-mark-cycle-anim" dur="${BRAND_MARK_CYCLE_DUR}" repeatCount="indefinite" calcMode="linear"
      keyTimes="${LEAD_MOTION_TIMES}" keyPoints="${LEAD_MOTION_POINTS}">
      <mpath href="#${uid}-pulse-path"/>
    </animateMotion>
  </circle>
</svg>`;
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
