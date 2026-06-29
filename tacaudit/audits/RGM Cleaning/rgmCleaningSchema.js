/** Weekly RGM Cleaning Assessment - question schema. */

const { SQUARE_ONE_PLACEHOLDERS } = require('../../src/auditRecurrence');

const RGM_CLEANING_SECTIONS = [
    { id: 'cleaningAssessment', label: 'Cleaning Assessment', order: 1 },
    { id: 'squareOneReview', label: 'Square One Photos', order: 2 },
    { id: 'actionPlan', label: 'Action Plan', order: 3 },
    { id: 'signOff', label: 'Sign Off', order: 4 },
];

const AUDIT_LABEL = 'RGM Cleaning Checklist';

/** Maps cleaning-assessment groups to action-plan field ids. */
const ACTION_PLAN_AREAS = [
    { group: 'Drink Machines', fieldId: 'action_drinkMachines', label: 'Drink Machines' },
    { group: 'Drains', fieldId: 'action_drains', label: 'Drains' },
    { group: 'Floors', fieldId: 'action_floors', label: 'Floors' },
    { group: 'Restrooms', fieldId: 'action_restrooms', label: 'Restrooms' },
    { group: 'Bin Room', fieldId: 'action_dumpsterBins', label: 'Dumpster & Bins' },
    { group: 'BOH/FOH Bins', fieldId: 'action_dumpsterBins', label: 'Dumpster & Bins' },
];

function q(id, section, type, label, opts = {}) {
    return { id, section, type, label, required: opts.required !== false, ...opts };
}

function rating(id, section, label, group, opts = {}) {
    return q(id, section, 'cleaning_rating', label, { group, ...opts });
}

const RGM_CLEANING_QUESTIONS = [
    q('assessment_intro', 'cleaningAssessment', 'banner', '', {
        required: false,
        bannerTitle: 'CLEANING ASSESSMENT',
        bannerSubtitle:
            'Complete this audit each Monday and follow up with your management team on areas needing improvement. Walk through each area, inspect each item, and mark satisfactory or not satisfactory. For items not to standard, take a photo and describe what needs to improve in the notes. Complete the action plan with actions and due dates.',
    }),

    rating('drink_underneath', 'cleaningAssessment', 'Underneath (floor area)', 'Drink Machines'),
    rating('drink_backsplash', 'cleaningAssessment', 'Backsplash', 'Drink Machines'),
    rating('drink_nozzles', 'cleaningAssessment', 'Nozzles', 'Drink Machines'),
    rating('drink_lidStrawCondiment', 'cleaningAssessment', 'Lid/Straw/Condiment Holders', 'Drink Machines'),
    rating('drink_sidesBehind', 'cleaningAssessment', 'Sides and Behind', 'Drink Machines'),
    rating('drink_ceilingVent', 'cleaningAssessment', 'Ceiling Tile and Vent Grate', 'Drink Machines'),
    rating('drink_underside', 'cleaningAssessment', 'Underside of machine', 'Drink Machines'),
    rating('drink_countertops', 'cleaningAssessment', 'Countertops', 'Drink Machines'),
    rating('drink_iceChute', 'cleaningAssessment', 'Ice Chute', 'Drink Machines'),
    rating('drink_floorDrains', 'cleaningAssessment', 'Floor Drains [if applicable]', 'Drink Machines', {
        required: false,
    }),
    rating('drink_trayDripPan', 'cleaningAssessment', 'Tray/Drip Pan', 'Drink Machines'),
    rating('drink_cabinetHoses', 'cleaningAssessment', 'Cabinet and Hoses', 'Drink Machines'),

    rating('drains_grateCover', 'cleaningAssessment', 'Grate/Cover', 'Drains'),
    rating('drains_basket', 'cleaningAssessment', 'Drain Basket', 'Drains'),
    rating('drains_basin', 'cleaningAssessment', 'Basin', 'Drains'),
    rating('drains_covers', 'cleaningAssessment', 'Drain Covers', 'Drains'),
    rating('drains_pipe', 'cleaningAssessment', 'Drain Pipe', 'Drains'),

    rating('floors_baseboards', 'cleaningAssessment', 'Baseboards/Cove Tiles', 'Floors'),
    rating('floors_grout', 'cleaningAssessment', 'Grout Lines and Tile', 'Floors'),
    rating('floors_underRacks', 'cleaningAssessment', 'Under Storage Racks', 'Floors'),
    rating('floors_mats', 'cleaningAssessment', 'Floor Mats', 'Floors'),
    rating('floors_underRetherm', 'cleaningAssessment', 'Under Rethermalizer', 'Floors'),
    rating('floors_underHeatedCabinet', 'cleaningAssessment', 'Under Heated Cabinet', 'Floors'),
    rating('floors_under3CompSink', 'cleaningAssessment', 'Under 3-Compartment Sink', 'Floors'),
    rating('floors_underFryer', 'cleaningAssessment', 'Under Fryer', 'Floors'),
    rating('floors_underProdLine', 'cleaningAssessment', 'Under Production Line', 'Floors'),

    rating('restroom_toilets', 'cleaningAssessment', 'Toilets', 'Restrooms'),
    rating('restroom_ceiling', 'cleaningAssessment', 'Ceiling', 'Restrooms'),
    rating('restroom_handDryer', 'cleaningAssessment', 'Hand Dryer', 'Restrooms'),
    rating('restroom_floorsDrains', 'cleaningAssessment', 'Floors and Drains', 'Restrooms'),
    rating('restroom_vents', 'cleaningAssessment', 'Vents', 'Restrooms'),
    rating('restroom_trashBins', 'cleaningAssessment', 'Trash Bins', 'Restrooms'),
    rating('restroom_kickboards', 'cleaningAssessment', 'Kickboards', 'Restrooms'),
    rating('restroom_sink', 'cleaningAssessment', 'Sink', 'Restrooms'),
    rating('restroom_lights', 'cleaningAssessment', 'Lights', 'Restrooms'),
    rating('restroom_changingStation', 'cleaningAssessment', 'Changing Station [if applicable]', 'Restrooms', {
        required: false,
    }),
    rating('restroom_soapDispensers', 'cleaningAssessment', 'Soap Dispensers', 'Restrooms'),
    rating('restroom_doors', 'cleaningAssessment', 'Doors', 'Restrooms'),
    rating('restroom_mirrors', 'cleaningAssessment', 'Mirrors', 'Restrooms'),

    rating('bin_gatesRollerdoor', 'cleaningAssessment', 'Gates / Rollerdoor - Interior and Exterior', 'Bin Room'),
    rating('bin_dumpstersClosed', 'cleaningAssessment', 'Dumpsters Closed and not Overflowing', 'Bin Room'),
    rating('bin_rampGround', 'cleaningAssessment', 'Dumpster Room Ramp or Ground - External', 'Bin Room'),
    rating('bin_floor', 'cleaningAssessment', 'Floor of Bin Room', 'Bin Room'),

    rating('bins_interior', 'cleaningAssessment', 'Interior of Bins', 'BOH/FOH Bins'),
    rating('bins_exterior', 'cleaningAssessment', 'Exterior of Bins', 'BOH/FOH Bins'),

    q('square_one_review', 'squareOneReview', 'square_one_photos', 'Square One photo review', {
        required: false,
        bannerTitle: 'SQUARE ONE PHOTO REVIEW',
        bannerSubtitle:
            'Photos captured during this week\'s Square One audits can be reviewed here and marked satisfactory or not satisfactory. When Square One audits are completed, their photos will appear automatically.',
    }),

    q('action_plan_intro', 'actionPlan', 'banner', '', {
        required: false,
        bannerTitle: 'ACTION PLAN',
        bannerSubtitle:
            'Complete the action plan for each area with issues. Include actions required (e.g. schedule task, purchase cleaning tool or chemical) and due dates.',
    }),
    q('action_drinkMachines', 'actionPlan', 'textarea', 'Drink Machines', {
        required: false,
        placeholder: 'Actions and due dates for Drink Machines…',
        actionPlanArea: 'Drink Machines',
    }),
    q('action_drains', 'actionPlan', 'textarea', 'Drains', {
        required: false,
        placeholder: 'Actions and due dates for Drains…',
        actionPlanArea: 'Drains',
    }),
    q('action_floors', 'actionPlan', 'textarea', 'Floors', {
        required: false,
        placeholder: 'Actions and due dates for Floors…',
        actionPlanArea: 'Floors',
    }),
    q('action_restrooms', 'actionPlan', 'textarea', 'Restrooms', {
        required: false,
        placeholder: 'Actions and due dates for Restrooms…',
        actionPlanArea: 'Restrooms',
    }),
    q('action_dumpsterBins', 'actionPlan', 'textarea', 'Dumpster & Bins', {
        required: false,
        placeholder: 'Actions and due dates for Dumpster & Bins…',
        actionPlanArea: 'Dumpster & Bins',
    }),
];

const QUESTION_BY_ID = new Map(RGM_CLEANING_QUESTIONS.map((question) => [question.id, question]));

function getSections() {
    return [...RGM_CLEANING_SECTIONS].sort((a, b) => a.order - b.order);
}

function getQuestions() {
    return RGM_CLEANING_QUESTIONS;
}

function getQuestionById(id) {
    return QUESTION_BY_ID.get(id) || null;
}

function getQuestionsForSection(sectionId) {
    return RGM_CLEANING_QUESTIONS.filter((q) => q.section === sectionId);
}

function isCleaningRatingType(type) {
    return type === 'cleaning_rating';
}

function isAnswerEmpty(question, value) {
    if (!question) return true;
    if (question.type === 'banner' || question.type === 'square_one_photos') return false;
    if (question.type === 'textarea') {
        if (!question.required) return false;
        return !String(value ?? '').trim();
    }
    if (isCleaningRatingType(question.type)) {
        if (!question.required && (value === '' || value == null)) return false;
        return value !== 'satisfactory' && value !== 'not_satisfactory';
    }
    return value === null || value === undefined || String(value).trim() === '';
}

function isNotCompliantValue(value, question) {
    if (!isCleaningRatingType(question?.type)) return false;
    return String(value || '').toLowerCase() === 'not_satisfactory';
}

function isQuestionVisible(question) {
    return Boolean(question);
}

function getVisibleQuestions(session, sectionId) {
    return getQuestionsForSection(sectionId).filter((q) => isQuestionVisible(q, session));
}

function getScoredQuestions() {
    return RGM_CLEANING_QUESTIONS.filter((q) => isCleaningRatingType(q.type));
}

function groupsWithNonCompliant(session) {
    const groups = new Set();
    for (const question of getScoredQuestions()) {
        if (isNotCompliantValue(session.answers?.[question.id], question)) {
            groups.add(question.group);
        }
    }
    if (
        getScoredQuestions().some(
            (q) =>
                (q.group === 'Bin Room' || q.group === 'BOH/FOH Bins') &&
                isNotCompliantValue(session.answers?.[q.id], q)
        )
    ) {
        groups.add('Dumpster & Bins');
    }
    return groups;
}

function actionPlanFieldForGroup(groupName) {
    if (groupName === 'Bin Room' || groupName === 'BOH/FOH Bins') return 'action_dumpsterBins';
    const row = ACTION_PLAN_AREAS.find((a) => a.group === groupName);
    return row?.fieldId || null;
}

function getActionEntry(session, questionId) {
    const raw = session.actions?.[questionId];
    if (!raw) return { text: '', submittedAt: null, dueDate: null };
    return {
        text: String(raw.text || ''),
        submittedAt: raw.submittedAt || null,
        dueDate: raw.dueDate || null,
    };
}

function isActionSubmitted(session, questionId) {
    const entry = getActionEntry(session, questionId);
    return Boolean(entry.submittedAt && entry.text.trim());
}

function normalizeActionUpdate(entry, previous) {
    const text = String(entry?.text ?? previous?.text ?? '').trim();
    const submittedAt = entry?.submittedAt ?? previous?.submittedAt ?? null;
    const dueDate = entry?.dueDate ?? previous?.dueDate ?? null;
    if (entry?.submit) {
        return {
            text,
            submittedAt: submittedAt || new Date().toISOString(),
            dueDate: dueDate || null,
        };
    }
    return { text, submittedAt, dueDate: dueDate || null };
}

function collectNonCompliant(session) {
    const out = [];
    for (const question of RGM_CLEANING_QUESTIONS) {
        if (!isCleaningRatingType(question.type)) continue;
        const value = session.answers?.[question.id];
        if (!isNotCompliantValue(value, question)) continue;
        const note = String(session.notes?.[question.id] || '').trim();
        out.push({
            questionId: question.id,
            label: question.label,
            group: question.group,
            note,
            hasNote: Boolean(note),
            actionText: getActionEntry(session, question.id).text,
            actionSubmitted: isActionSubmitted(session, question.id),
        });
    }
    return out;
}

function getSquareOnePhotoCandidates(session, options = {}) {
    const candidates = Array.isArray(options.squareOnePhotoCandidates)
        ? options.squareOnePhotoCandidates
        : session.squareOnePhotoCandidates;
    return Array.isArray(candidates) ? candidates : [];
}

function collectPendingSquareOneReviews(session, options = {}) {
    const candidates = getSquareOnePhotoCandidates(session, options);
    const reviews = session.squareOnePhotoReviews || {};
    const pending = [];
    for (const photo of candidates) {
        const id = String(photo.id || '').trim();
        if (!id) continue;
        const rating = String(reviews[id]?.rating || '').toLowerCase();
        if (rating !== 'satisfactory' && rating !== 'not_satisfactory') {
            pending.push(photo);
        }
    }
    return pending;
}

function validateSection(session, sectionId, options = {}) {

    if (sectionId === 'squareOneReview') {
        const pending = collectPendingSquareOneReviews(session, options);
        if (pending.length) {
            return {
                ok: false,
                error: `Review all Square One photos (${pending.length} remaining).`,
            };
        }
        return { ok: true };
    }

    if (sectionId === 'actionPlan') {
        const ncGroups = groupsWithNonCompliant(session);
        const areaLabels = {
            'Drink Machines': 'action_drinkMachines',
            Drains: 'action_drains',
            Floors: 'action_floors',
            Restrooms: 'action_restrooms',
            'Dumpster & Bins': 'action_dumpsterBins',
        };
        for (const group of ncGroups) {
            const normalized = group === 'Bin Room' || group === 'BOH/FOH Bins' ? 'Dumpster & Bins' : group;
            const fieldId = areaLabels[normalized];
            if (!fieldId) continue;
            const text = String(session.answers?.[fieldId] || '').trim();
            if (!text) {
                return { ok: false, error: `Action plan required for ${normalized}.` };
            }
        }
        return { ok: true };
    }

    if (sectionId === 'signOff') {
        if (!String(session.signOff?.name || '').trim()) {
            return { ok: false, error: 'Manager name is required.' };
        }
        if (!String(session.signOff?.signatureDataUrl || '').trim()) {
            return { ok: false, error: 'Sign-off signature is required.' };
        }
        return { ok: true };
    }

    if (sectionId === 'cleaningAssessment') {
        const questions = getVisibleQuestions(session, sectionId).filter((q) => isCleaningRatingType(q.type));
        for (const question of questions) {
            const value = session.answers?.[question.id];
            if (question.required && isAnswerEmpty(question, value)) {
                return { ok: false, error: `Answer required: ${question.label}` };
            }
            if (isNotCompliantValue(value, question)) {
                const note = String(session.notes?.[question.id] || '').trim();
                if (!note) {
                    return {
                        ok: false,
                        error: `Add a note for not satisfactory item: ${question.label}`,
                    };
                }
            }
        }
        return { ok: true };
    }

    return { ok: true };
}

function validateSessionComplete(session, options = {}) {
    for (const section of RGM_CLEANING_SECTIONS) {
        if (section.id === 'signOff') continue;
        const result = validateSection(session, section.id, options);
        if (!result.ok) return result;
    }
    return validateSection(session, 'signOff', options);
}

function scoreSession(session) {
    const scored = getScoredQuestions();
    const answered = scored.filter((q) => !isAnswerEmpty(q, session.answers?.[q.id]));
    const satisfactory = scored.filter(
        (q) => String(session.answers?.[q.id]).toLowerCase() === 'satisfactory'
    );
    const nc = collectNonCompliant(session);
    const total = scored.length;
    const okCount = satisfactory.length;
    const pct = total ? Math.round((okCount / total) * 100) : 0;
    return {
        total,
        satisfactoryCount: okCount,
        percent: pct,
        flaggedCount: nc.length,
        actionCount: nc.length,
    };
}

function buildSchemaPayload() {
    return {
        sections: getSections(),
        questions: getQuestions(),
        auditLabel: AUDIT_LABEL,
        squareOneAreas: SQUARE_ONE_PLACEHOLDERS,
    };
}

module.exports = {
    AUDIT_LABEL,
    RGM_CLEANING_SECTIONS,
    RGM_CLEANING_QUESTIONS,
    ACTION_PLAN_AREAS,
    getSections,
    getQuestions,
    getQuestionById,
    getQuestionsForSection,
    getVisibleQuestions,
    getScoredQuestions,
    isCleaningRatingType,
    isAnswerEmpty,
    isNotCompliantValue,
    getSquareOnePhotoCandidates,
    collectPendingSquareOneReviews,
    getActionEntry,
    isActionSubmitted,
    normalizeActionUpdate,
    collectNonCompliant,
    groupsWithNonCompliant,
    validateSection,
    validateSessionComplete,
    scoreSession,
    buildSchemaPayload,
};
