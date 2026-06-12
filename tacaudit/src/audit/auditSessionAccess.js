const {
    accountLevelRank,
    lookupAccountLevelByUsername,
} = require('../../../users/src/core/dashboardUsers');

function normalizeUsername(username) {
    return String(username || '').trim().toLowerCase();
}

function resolveAccessAccountLevel(access = {}) {
    const level = String(access.accountLevel || '').trim().toLowerCase();
    if (level) return level;
    if (access.isAdmin) return 'it';
    return 'manager';
}

function creatorLevelForSession(session) {
    const owner = String(session?.createdByUsername || '').trim();
    if (owner) {
        const fromLookup = lookupAccountLevelByUsername(owner);
        if (fromLookup) return fromLookup;
    }
    return 'manager';
}

function canCompleteAudit(access = {}) {
    if (access.isAdmin) return true;
    if (access.canCompleteAudits === false) return false;
    if (access.canCompleteAudits === true) return true;
    return accountLevelRank(resolveAccessAccountLevel(access)) > accountLevelRank('tm');
}

function inCompleteAccessError() {
    return 'Only a manager or above can mark this audit as complete. Team members can contribute while it is in progress.';
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

/** Pest / RGM / PSI in-progress: crew with audit access; TMs only when started by someone above TM. */
function canContributeToCollaborativeInProgress(session, access = {}) {
    if (!session || session.status !== 'in_progress') return false;
    if (!hasDfscAuditAccess(access)) return false;
    const level = resolveAccessAccountLevel(access);
    if (level !== 'tm') return true;
    return accountLevelRank(creatorLevelForSession(session)) > accountLevelRank('tm');
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
    canCompleteAudit,
    canContinueDfscInProgress,
    canContributeToCollaborativeInProgress,
    canOpenInProgressSession,
    canUserAccessSession,
    shouldListOpenAudit,
    inProgressAccessError,
    inCompleteAccessError,
    creatorLevelForSession,
};
