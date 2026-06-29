/**
 * Prevent autosave responses from wiping answers edited while a save was in flight.
 */
(function (global) {
    const COLLABORATIVE_KEYS = [
        'answers',
        'notes',
        'actions',
        'photos',
        'squareOnePhotoReviews',
        'sectionSkips',
    ];

    function shallowCopyRecord(value) {
        return value && typeof value === 'object' ? { ...value } : {};
    }

    function captureCollaborativePatch(session) {
        if (!session) return {};
        const patch = {};
        for (const key of COLLABORATIVE_KEYS) {
            if (session[key] && typeof session[key] === 'object') {
                patch[key] = { ...session[key] };
            }
        }
        if (session.signOff && typeof session.signOff === 'object') {
            patch.signOff = { ...session.signOff };
        }
        if (session.clientMeta && typeof session.clientMeta === 'object') {
            patch.clientMeta = { ...session.clientMeta };
        }
        return patch;
    }

    function mergeCollaborativeSession(serverSession, saveStartPatch, currentSession, extras = {}) {
        if (!serverSession) return currentSession;
        const current = currentSession || {};
        const merged = { ...serverSession, ...extras };

        for (const key of COLLABORATIVE_KEYS) {
            merged[key] = {
                ...(serverSession[key] || {}),
                ...(saveStartPatch?.[key] || {}),
                ...(current[key] || {}),
            };
        }

        merged.signOff = {
            ...(serverSession.signOff || {}),
            ...(saveStartPatch?.signOff || {}),
            ...(current.signOff || {}),
        };

        if (saveStartPatch?.clientMeta || current.clientMeta || serverSession.clientMeta) {
            merged.clientMeta = {
                ...(serverSession.clientMeta || {}),
                ...(saveStartPatch?.clientMeta || {}),
                ...(current.clientMeta || {}),
            };
        }

        return merged;
    }

    function createSaveRunner() {
        let saving = false;
        let saveQueued = false;

        async function runSave({ getSession, setSession, isBlocked, save, onError }) {
            const session = typeof getSession === 'function' ? getSession() : null;
            if (!session || (typeof isBlocked === 'function' && isBlocked(session))) {
                return null;
            }
            if (saving) {
                saveQueued = true;
                return null;
            }

            saving = true;
            const saveStartPatch = captureCollaborativePatch(session);
            try {
                const data = await save(session);
                if (data?.session && typeof setSession === 'function') {
                    const merged = mergeCollaborativeSession(
                        data.session,
                        saveStartPatch,
                        getSession(),
                        data.score != null ? { score: data.score } : {}
                    );
                    setSession(merged);
                }
                return data;
            } catch (err) {
                if (typeof onError === 'function') onError(err);
                throw err;
            } finally {
                saving = false;
                if (saveQueued) {
                    saveQueued = false;
                    await runSave({ getSession, setSession, isBlocked, save, onError });
                }
            }
        }

        return { runSave, get busy() { return saving; } };
    }

    global.AuditSessionSave = {
        captureCollaborativePatch,
        mergeCollaborativeSession,
        createSaveRunner,
    };
})(window);
