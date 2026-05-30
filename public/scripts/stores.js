/* Store picker — fetches the master store list and renders clickable tiles linking to /<storeNumber>. */
const grid = document.getElementById('store-grid');
const LANDSCAPE_PREF_KEY = 'dashboard-prefer-landscape';

function markLandscapePreference() {
    try {
        sessionStorage.setItem(LANDSCAPE_PREF_KEY, '1');
    } catch {
        /* ignore */
    }
}

grid.addEventListener('click', (event) => {
    if (event.target.closest('a.store-tile')) {
        markLandscapePreference();
    }
});

function hourLabel(hour) {
    const h = (((Math.trunc(hour) % 24) + 24) % 24);
    const period = h < 12 ? 'AM' : 'PM';
    const display = h % 12 === 0 ? 12 : h % 12;
    return `${display}${period}`;
}

function showMessage(text) {
    grid.innerHTML = `<p class="stores-message">${text}</p>`;
}

function renderStores(stores) {
    if (!stores.length) {
        showMessage('No stores configured yet. Add stores to the .storelist file on the server.');
        return;
    }

    const sorted = [...stores].sort((a, b) => String(a.storeNumber).localeCompare(String(b.storeNumber), undefined, { numeric: true }));

    grid.innerHTML = sorted
        .map((s) => {
            const number = String(s.storeNumber || '').replace(/[^0-9]/g, '');
            if (!number) return '';
            const name = s.storeName && s.storeName !== number ? s.storeName : '';
            const hours =
                Number.isFinite(s.openHour) && Number.isFinite(s.closeHour)
                    ? `${hourLabel(s.openHour)}–${hourLabel(s.closeHour)}`
                    : '';
            return `
                <a class="store-tile" href="/${number}">
                    <span class="store-tile-number">${number}</span>
                    ${name ? `<span class="store-tile-name">${name}</span>` : ''}
                    ${hours ? `<span class="store-tile-hours">${hours}</span>` : ''}
                </a>`;
        })
        .join('');
}

async function loadStores() {
    try {
        const res = await fetch(`${window.location.origin}/api/stores`, { credentials: 'include' });
        if (!res.ok) throw new Error(`API responded with ${res.status}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Failed to load stores');
        renderStores(Array.isArray(data.stores) ? data.stores : []);
    } catch (err) {
        console.error('Failed to load stores:', err);
        showMessage('Could not load the store list. Please try again shortly.');
    }
}

loadStores();
