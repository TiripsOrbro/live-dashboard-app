/** Taco Bell Weekly Pest Inspection — question schema. */

const PEST_WALK_SECTIONS = [
    { id: 'walkingInside', label: 'Walking Inside', order: 1 },
    { id: 'walkingOutside', label: 'Walking Outside', order: 2 },
    { id: 'correctiveActions', label: 'Corrective Actions', order: 3 },
    { id: 'signOff', label: 'Sign Off', order: 4 },
];

const AUDIT_LABEL = 'Pest Walk';
const MIN_DURATION_MINUTES = 20;

function sessionElapsedMs(session, now = Date.now()) {
    const started = Date.parse(session?.startedAt || '');
    if (!Number.isFinite(started)) return 0;
    return Math.max(0, now - started);
}

function isMinimumDurationMet(session, now = Date.now()) {
    return sessionElapsedMs(session, now) >= MIN_DURATION_MINUTES * 60 * 1000;
}

function minimumDurationRemainingMs(session, now = Date.now()) {
    return Math.max(0, MIN_DURATION_MINUTES * 60 * 1000 - sessionElapsedMs(session, now));
}

function q(id, section, type, label, opts = {}) {
    return { id, section, type, label, required: opts.required !== false, ...opts };
}

const PEST_WALK_QUESTIONS = [
    q('inside_intro', 'walkingInside', 'banner', '', {
        required: false,
        group: 'Walking Inside',
        bannerTitle: 'WALKING INSIDE',
        bannerSubtitle: 'Look in the following places for the different types of pest activity:',
        bannerPoints: [
            'Wall/floor perimeter',
            'Traps',
            'Any hard to reach shadowy, tight places',
            'Under and around sinks',
            'Around packaging material on shelving',
            'Behind wall mounted equipment',
        ],
    }),
    q(
        'inside_ledTorch',
        'walkingInside',
        'pest_yes',
        'Are you using an approved LED torch to complete this pest walk? Mobile phone lights are not an approved torch',
        { group: 'Walking Inside' }
    ),

    q(
        'inside_pestLiveDead',
        'walkingInside',
        'pest_yes',
        'Live or dead pests (Rat, mice, cockroach, ant etc.) not evident',
        { group: 'A) Pest Evidence' }
    ),
    q(
        'inside_pestActivity',
        'walkingInside',
        'pest_yes',
        'Activity: Droppings not present; Signs of nesting (materials used to create a shelter for pests to live) not present; Signs of chew marks not present; no pest evidence in traps/glue boards',
        { group: 'A) Pest Evidence' }
    ),
    q('inside_pestOtherSigns', 'walkingInside', 'pest_yes', 'Other signs not present', { group: 'A) Pest Evidence' }),

    q(
        'inside_baitBackKitchen',
        'walkingInside',
        'pest_yes',
        'There are at least 4 bait stations in the back of house kitchen area',
        { group: 'B) Bait Stations' }
    ),
    q(
        'inside_baitCeiling',
        'walkingInside',
        'pest_yes',
        'There are at least 4 bait stations located in ceiling',
        { group: 'B) Bait Stations' }
    ),

    q(
        'inside_sanFoodDebris',
        'walkingInside',
        'pest_yes',
        'Food debris, trash, food build up or old POP packaging behind/underneath shelves/equipment not present',
        { group: 'C) Sanitation' }
    ),
    q('inside_sanStandingWater', 'walkingInside', 'pest_yes', 'Standing water not present', { group: 'C) Sanitation' }),
    q('inside_sanMopsHung', 'walkingInside', 'pest_yes', 'Mops are being hung to dry', { group: 'C) Sanitation' }),
    q(
        'inside_sanDrains',
        'walkingInside',
        'pest_yes',
        'Drains are clean, functioning properly and covers are in place',
        { group: 'C) Sanitation' }
    ),

    q(
        'inside_structHolesCracks',
        'walkingInside',
        'pest_yes',
        'Holes or cracks in walls larger than 6mm not present; Gaps in doors or door sweeps not present',
        { group: 'D) Structural Search' }
    ),
    q(
        'inside_structPipesSealed',
        'walkingInside',
        'pest_yes',
        'Pipes, lines, and wires coming into the building (at walls, ceilings, or floors) are completely sealed at point of entry; no gaps around pipes',
        { group: 'D) Structural Search' }
    ),
    q(
        'inside_structTilesRepair',
        'walkingInside',
        'pest_yes',
        'Ceiling tiles, door pest strips, floor tiles, baseboards are in good repair (not loose or missing).',
        { group: 'D) Structural Search' }
    ),

    q('outside_intro', 'walkingOutside', 'banner', '', {
        required: false,
        group: 'Walking Outside',
        bannerTitle: 'WALKING OUTSIDE',
        bannerSubtitle: 'Look in all of the following places for the different types of pest activity:',
        bannerPoints: [
            'The junction where the building wall meets the ground',
            'Around the shed, and/or other unattached structures',
            'Pipe drains',
            'Dumpster area',
        ],
    }),

    q(
        'outside_landscaping',
        'walkingOutside',
        'pest_yes',
        'No overgrown shrubs/bushes or overhanging trees touching building',
        { group: 'E) Landscaping' }
    ),

    q(
        'outside_pestNestingBurrows',
        'walkingOutside',
        'pest_yes',
        'Signs of nesting, insects or rodent burrow holes not present; Live or dead pests (Rat, mice, cockroach, ant etc.) not evident',
        { group: 'F) Pest Evidence' }
    ),
    q('outside_pestOtherSigns', 'walkingOutside', 'pest_yes', 'Other signs not present', { group: 'F) Pest Evidence' }),

    q(
        'outside_baitStations',
        'walkingOutside',
        'pest_yes',
        'There are at least 3 bait stations (2 around the building, 1 at the dumpster area) anchored around building placed against the wall, away from customers view if possible',
        { group: 'G) Bait Stations' }
    ),

    q(
        'outside_sanDumpster',
        'walkingOutside',
        'pest_yes',
        'Dumpster and Dumpster area kept clean and free of clutter; Piles of accumulated litter and debris not present',
        { group: 'H) Sanitation' }
    ),
    q(
        'outside_sanSprinklers',
        'walkingOutside',
        'pest_yes',
        'Sprinklers and irrigation pipes in good repair (leaks not present); Standing water not present',
        { group: 'H) Sanitation' }
    ),

    q(
        'outside_structPipesSealed',
        'walkingOutside',
        'pest_yes',
        'Pipes, lines, and wires are completely sealed at point of entry; no gaps around pipes/holes larger than 1/4" not present',
        { group: 'I) Structural Search of Building' }
    ),

    q(
        'outside_pestControlReport',
        'walkingOutside',
        'pest_yes',
        'Review Pest Control Report (Invoices) on file for 3 months. All issues, including structural, sanitation, and pest are corrected',
        { group: 'J) Pest Control Report' }
    ),

    q(
        'outside_fscReport',
        'walkingOutside',
        'pest_yes',
        'Food Standards Consultation report on file for 1 year. All issues are corrected',
        { group: 'K) Administration And Documentation' }
    ),
    q(
        'outside_healthDeptReport',
        'walkingOutside',
        'pest_yes',
        'Review last Health Department Report and keep on file for 1 year. Are all issues corrected?',
        { group: 'K) Administration And Documentation' }
    ),

    q('corrective_intro', 'correctiveActions', 'banner', '', {
        required: false,
        bannerTitle: 'CORRECTIVE ACTIONS',
        bannerSubtitle:
            'If pests or evidence of pest activity are found, outline below what was seen and where it was seen. Remove the debris, clean and sanitize the area immediately. Never leave evidence of pests. Please ensure your above restaurant leader and QA Manager notified immediately. Then contact your Pest Management Provider to inform them of your findings.',
    }),
    q('corrective_details', 'correctiveActions', 'textarea', 'Corrective action details (if pests or evidence were found)', {
        required: false,
        placeholder: 'Describe what was seen and where it was seen…',
    }),
];

const QUESTION_BY_ID = new Map(PEST_WALK_QUESTIONS.map((question) => [question.id, question]));

function getSections() {
    return [...PEST_WALK_SECTIONS].sort((a, b) => a.order - b.order);
}

function getQuestions() {
    return PEST_WALK_QUESTIONS;
}

function getQuestionById(id) {
    return QUESTION_BY_ID.get(id) || null;
}

function getQuestionsForSection(sectionId) {
    return PEST_WALK_QUESTIONS.filter((q) => q.section === sectionId);
}

function isPestYesType(type) {
    return type === 'pest_yes';
}

function isAnswerEmpty(question, value) {
    if (!question) return true;
    if (question.type === 'banner') return false;
    if (question.type === 'textarea') {
        if (!question.required) return false;
        return !String(value ?? '').trim();
    }
    if (isPestYesType(question.type)) {
        return value !== 'yes' && value !== 'no';
    }
    return value === null || value === undefined || String(value).trim() === '';
}

function isNotCompliantValue(value, question) {
    if (!isPestYesType(question?.type)) return false;
    return String(value || '').toLowerCase() === 'no';
}

function isQuestionVisible(question, session) {
    if (!question) return false;
    if (question.type === 'banner') return true;
    return true;
}

function getVisibleQuestions(session, sectionId) {
    return getQuestionsForSection(sectionId).filter((q) => isQuestionVisible(q, session));
}

function getActionEntry(session, questionId) {
    const raw = session.actions?.[questionId];
    if (!raw) return { text: '', submittedAt: null };
    return {
        text: String(raw.text || ''),
        submittedAt: raw.submittedAt || null,
    };
}

function isActionSubmitted(session, questionId) {
    const entry = getActionEntry(session, questionId);
    return Boolean(entry.submittedAt && entry.text.trim());
}

function normalizeActionUpdate(entry, previous) {
    const text = String(entry?.text ?? previous?.text ?? '').trim();
    const submittedAt = entry?.submittedAt ?? previous?.submittedAt ?? null;
    if (entry?.submit) {
        return { text, submittedAt: submittedAt || new Date().toISOString() };
    }
    return { text, submittedAt };
}

function collectNonCompliant(session) {
    const out = [];
    for (const question of PEST_WALK_QUESTIONS) {
        if (!isPestYesType(question.type)) continue;
        const value = session.answers?.[question.id];
        if (!isNotCompliantValue(value, question)) continue;
        const action = getActionEntry(session, question.id);
        out.push({
            questionId: question.id,
            label: question.label,
            actionText: action.text,
            actionSubmittedAt: action.submittedAt,
            actionSubmitted: isActionSubmitted(session, question.id),
        });
    }
    return out;
}

function validateSection(session, sectionId) {
    if (sectionId === 'correctiveActions') {
        const nc = collectNonCompliant(session);
        for (const row of nc) {
            if (!row.actionSubmitted) {
                return { ok: false, error: `Submit an action for: ${row.label}` };
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

    const questions = getVisibleQuestions(session, sectionId);
    for (const question of questions) {
        if (question.type === 'banner' || question.type === 'textarea') continue;
        const value = session.answers?.[question.id];
        if (question.required && isAnswerEmpty(question, value)) {
            return { ok: false, error: `Answer required: ${question.label}` };
        }
    }
    return { ok: true };
}

function validateSessionComplete(session) {
    for (const section of PEST_WALK_SECTIONS) {
        if (section.id === 'signOff') continue;
        const result = validateSection(session, section.id);
        if (!result.ok) return result;
    }
    return validateSection(session, 'signOff');
}

function buildSchemaPayload() {
    return {
        sections: getSections(),
        questions: getQuestions(),
        auditLabel: AUDIT_LABEL,
        minDurationMinutes: MIN_DURATION_MINUTES,
    };
}

function scoreSession(session) {
    const scored = PEST_WALK_QUESTIONS.filter((q) => isPestYesType(q.type));
    const answered = scored.filter((q) => !isAnswerEmpty(q, session.answers?.[q.id]));
    const compliant = scored.filter((q) => String(session.answers?.[q.id]).toLowerCase() === 'yes');
    const nc = collectNonCompliant(session);
    const total = scored.length;
    const yesCount = compliant.length;
    const pct = total ? Math.round((yesCount / total) * 100) : 0;
    return {
        total,
        yesCount,
        percent: pct,
        flaggedCount: nc.length,
        actionCount: nc.filter((r) => r.actionSubmitted).length,
    };
}

module.exports = {
    AUDIT_LABEL,
    MIN_DURATION_MINUTES,
    sessionElapsedMs,
    isMinimumDurationMet,
    minimumDurationRemainingMs,
    PEST_WALK_SECTIONS,
    PEST_WALK_QUESTIONS,
    getSections,
    getQuestions,
    getQuestionById,
    getQuestionsForSection,
    getVisibleQuestions,
    isPestYesType,
    isAnswerEmpty,
    isNotCompliantValue,
    isQuestionVisible,
    getActionEntry,
    isActionSubmitted,
    normalizeActionUpdate,
    collectNonCompliant,
    validateSection,
    validateSessionComplete,
    buildSchemaPayload,
    scoreSession,
};
