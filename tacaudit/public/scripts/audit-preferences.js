(function (global) {
    let auditAutoCollapseEnabled = true;
    let loadPromise = null;

    function isAutoCollapseEnabled() {
        return auditAutoCollapseEnabled !== false;
    }

    function setAutoCollapseEnabled(enabled) {
        auditAutoCollapseEnabled = enabled !== false;
    }

    async function load() {
        try {
            const res = await fetch('/api/me', { credentials: 'same-origin' });
            if (!res.ok) return auditAutoCollapseEnabled;
            const me = await res.json();
            if (me.success) {
                setAutoCollapseEnabled(me.auditAutoCollapse);
            }
        } catch {
            /* keep default */
        }
        return auditAutoCollapseEnabled;
    }

    function init() {
        if (!loadPromise) loadPromise = load();
        return loadPromise;
    }

    global.AuditPreferences = {
        init,
        load,
        isAutoCollapseEnabled,
        setAutoCollapseEnabled,
    };
})(window);
