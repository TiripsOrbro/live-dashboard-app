function contributorFromAccess(access = {}) {
    const name = String(access.conductorFullName || '').trim();
    const username = String(access.username || '').trim();
    return {
        by: name || username || 'Unknown',
        username,
        at: new Date().toISOString(),
    };
}

function isValueSet(value) {
    return value !== null && value !== undefined && String(value).trim() !== '';
}

function ensureContributions(session) {
    if (!session.contributions || typeof session.contributions !== 'object') {
        session.contributions = { answers: {}, notes: {}, actions: {}, photos: {}, squareOnePhotoReviews: {} };
    }
    for (const key of ['answers', 'notes', 'actions', 'photos', 'squareOnePhotoReviews']) {
        if (!session.contributions[key] || typeof session.contributions[key] !== 'object') {
            session.contributions[key] = {};
        }
    }
    return session.contributions;
}

function stampAnswerContributions(session, answers, access) {
    if (!answers || typeof answers !== 'object') return;
    const contributions = ensureContributions(session);
    const stamp = contributorFromAccess(access);
    for (const [questionId, value] of Object.entries(answers)) {
        if (isValueSet(value)) {
            contributions.answers[questionId] = stamp;
        } else {
            delete contributions.answers[questionId];
        }
    }
}

function stampNoteContributions(session, notes, access) {
    if (!notes || typeof notes !== 'object') return;
    const contributions = ensureContributions(session);
    const stamp = contributorFromAccess(access);
    for (const [questionId, value] of Object.entries(notes)) {
        if (isValueSet(value)) {
            contributions.notes[questionId] = stamp;
        } else {
            delete contributions.notes[questionId];
        }
    }
}

function stampActionContribution(session, questionId, actionEntry, access) {
    if (!actionEntry?.submittedAt || !String(actionEntry.text || '').trim()) return;
    const contributions = ensureContributions(session);
    contributions.actions[questionId] = contributorFromAccess(access);
}

function normalizePhotoEntry(photo, access) {
    if (!photo) return null;
    const stamp = contributorFromAccess(access);
    if (typeof photo === 'string') {
        if (!isValueSet(photo)) return null;
        return { dataUrl: photo, ...stamp };
    }
    const dataUrl = String(photo.dataUrl || photo.url || '').trim();
    if (!dataUrl) return null;
    return {
        ...photo,
        dataUrl,
        by: stamp.by,
        username: stamp.username,
        at: stamp.at,
    };
}

function stampPhotoContributions(session, photos, access) {
    if (!photos || typeof photos !== 'object') return;
    const contributions = ensureContributions(session);
    for (const [questionId, photo] of Object.entries(photos)) {
        const normalized = normalizePhotoEntry(photo, access);
        if (normalized) {
            session.photos[questionId] = normalized;
            contributions.photos[questionId] = {
                by: normalized.by,
                username: normalized.username,
                at: normalized.at,
            };
        } else {
            delete session.photos[questionId];
            delete contributions.photos[questionId];
        }
    }
}

function stampSquareOneReviewContributions(session, reviews, access) {
    if (!reviews || typeof reviews !== 'object') return;
    const contributions = ensureContributions(session);
    const stamp = contributorFromAccess(access);
    for (const [photoId, review] of Object.entries(reviews)) {
        const rating = String(review?.rating || '').trim();
        if (rating) {
            contributions.squareOnePhotoReviews[photoId] = stamp;
        } else {
            delete contributions.squareOnePhotoReviews[photoId];
        }
    }
}

function applyCollaborativeUpdates(session, updates, access, helpers = {}) {
    const { getQuestionById, normalizeActionUpdate } = helpers;

    if (updates.answers && typeof updates.answers === 'object') {
        for (const [questionId, value] of Object.entries(updates.answers)) {
            if (typeof getQuestionById === 'function') {
                const question = getQuestionById(questionId);
                if (!question) continue;
            }
            session.answers[questionId] = value;
        }
        stampAnswerContributions(session, updates.answers, access);
    }

    if (updates.actions && typeof updates.actions === 'object') {
        session.actions = session.actions || {};
        for (const [questionId, entry] of Object.entries(updates.actions)) {
            const next = normalizeActionUpdate(entry, session.actions[questionId]);
            session.actions[questionId] = next;
            stampActionContribution(session, questionId, next, access);
        }
    }

    if (updates.notes && typeof updates.notes === 'object') {
        session.notes = { ...session.notes, ...updates.notes };
        stampNoteContributions(session, updates.notes, access);
    }

    session.photos = session.photos || {};
    if (updates.photos && typeof updates.photos === 'object') {
        stampPhotoContributions(session, updates.photos, access);
    }

    if (updates.squareOnePhotoReviews && typeof updates.squareOnePhotoReviews === 'object') {
        session.squareOnePhotoReviews = { ...session.squareOnePhotoReviews, ...updates.squareOnePhotoReviews };
        stampSquareOneReviewContributions(session, updates.squareOnePhotoReviews, access);
    }
}

function formatContributionLine(session, type, id) {
    const stamp = session?.contributions?.[type]?.[id];
    if (!stamp?.by) return '';
    const parsed = Date.parse(stamp.at || '');
    const when = Number.isFinite(parsed)
        ? new Date(parsed).toLocaleString('en-AU', {
              day: 'numeric',
              month: 'short',
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
          })
        : '';
    return when ? `${stamp.by} · ${when}` : stamp.by;
}

module.exports = {
    contributorFromAccess,
    ensureContributions,
    applyCollaborativeUpdates,
    stampAnswerContributions,
    stampNoteContributions,
    stampActionContribution,
    stampPhotoContributions,
    stampSquareOneReviewContributions,
    normalizePhotoEntry,
    formatContributionLine,
};
