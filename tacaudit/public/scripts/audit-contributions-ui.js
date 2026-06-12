(function (global) {
    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function formatContributionTime(iso) {
        if (!iso) return '';
        const parsed = Date.parse(iso);
        if (!Number.isFinite(parsed)) return iso;
        return new Date(parsed).toLocaleString('en-AU', {
            day: 'numeric',
            month: 'short',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
        });
    }

    function getContributionStamp(session, type, id) {
        return session?.contributions?.[type]?.[id] || null;
    }

    function renderContributionStamp(session, type, id, { prefix = 'Updated' } = {}) {
        const stamp = getContributionStamp(session, type, id);
        if (!stamp?.by) return '';
        const when = formatContributionTime(stamp.at);
        const label = when ? `${prefix} by ${stamp.by} · ${when}` : `${prefix} by ${stamp.by}`;
        return `<p class="dfsc-contribution-stamp">${escapeHtml(label)}</p>`;
    }

    global.AuditContributionsUi = {
        getContributionStamp,
        renderContributionStamp,
        formatContributionTime,
    };
})(window);
