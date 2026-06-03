(function () {
    const ARROW_SVG = `<svg class="nav-back-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/>
    </svg>`;

    function mountBackButton(host, options = {}) {
        if (!host) return;
        const fallback = options.fallback || '/login';
        const ariaLabel = String(options.label || 'Back').replace(/^←\s*/, '').trim() || 'Back';
        host.classList.add('nav-back-host', 'nav-back-host--floating');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'nav-back-bubble';
        btn.id = 'nav-back-btn';
        btn.setAttribute('aria-label', ariaLabel);
        btn.innerHTML = ARROW_SVG;
        host.replaceChildren(btn);
        btn.addEventListener('click', () => {
            const fadeToStores = Boolean(options.fadeToStores);
            const storesDest =
                fadeToStores || fallback === '/stores'
                    ? String(options.fallback || '/stores').trim() || '/stores'
                    : '';
            if (storesDest && window.DashboardPageTransition?.navigateBackToStores) {
                window.DashboardPageTransition.navigateBackToStores(storesDest);
                return;
            }
            if (window.history.length > 1) {
                window.history.back();
                return;
            }
            window.location.href = fallback;
        });
    }

    window.DashboardNavBack = { mountBackButton };
})();
