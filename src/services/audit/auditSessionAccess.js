function normalizeUsername(username) {
    return String(username || '').trim().toLowerCase();
}

function userOwnsSession(session, username, conductorFullName = '') {
    if (!session) return false;
    const owner = normalizeUsername(session.createdByUsername);
    const user = normalizeUsername(username);
    if (owner && user) return owner === user;
    if (!owner) {
        const conductor = String(session.conductor?.name || '').trim().toLowerCase();
        const fullName = String(conductorFullName || '').trim().toLowerCase();
        if (conductor && fullName) return conductor === fullName;
    }
    return false;
}

function hasDfscAuditAccess(access = {}) {
    return Boolean(access.canAccessDfsc || access.isAdmin);
}

/** DFSC in-progress: creator only. */
function canContinueDfscInProgress(session, access = {}) {
    if (!session || session.status !== 'in_progress') return false;
    return userOwnsSession(session, access.username, access.conductorFullName);
}

/** Pest / RGM / PSI in-progress: any user with audit access may contribute. */
function canContributeToCollaborativeInProgress(session, access = {}) {
    if (!session || session.status !== 'in_progress') return false;
    return hasDfscAuditAccess(access);
}

function canOpenInProgressSession(session, access = {}, { collaborative = false } = {}) {
    if (!session || session.status !== 'in_progress') return false;
    return collaborative
        ? canContributeToCollaborativeInProgress(session, access)
        : canContinueDfscInProgress(session, access);
}

function inProgressAccessError(collaborative = false) {
    return collaborative
        ? 'You do not have permission to contribute to this audit.'
        : 'Only the crew member who started this DFSC can continue or submit it while it is in progress.';
}

function canUserAccessSession(session, access = {}, { collaborative = false } = {}) {
    if (!session) return { ok: false, error: 'Session not found.', status: 404 };
    if (session.status === 'completed') return { ok: true };
    if (canOpenInProgressSession(session, access, { collaborative })) return { ok: true };
    return {
        ok: false,
        error: inProgressAccessError(collaborative),
        status: 403,
    };
}

function shouldListOpenAudit(session, access = {}, { collaborative = false } = {}) {
    if (!session || session.status !== 'in_progress') return false;
    return canOpenInProgressSession(session, access, { collaborative });
}

module.exports = {
    userOwnsSession,
    hasDfscAuditAccess,
    canContinueDfscInProgress,
    canContributeToCollaborativeInProgress,
    canOpenInProgressSession,
    canUserAccessSession,
    shouldListOpenAudit,
    inProgressAccessError,
};
