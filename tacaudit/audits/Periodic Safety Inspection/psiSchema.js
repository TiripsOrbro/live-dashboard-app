/** Taco Bell Periodic Safety Inspection — 4-week rotating schema. */

const { PSI_WEEK_TITLES } = require('../../src/auditRecurrence');

const AUDIT_LABEL = 'Period Safety Inspection';

const PSI_SECTIONS = [
    { id: 'inspection', label: 'Inspection', order: 1 },
    { id: 'signOff', label: 'Sign Off', order: 2 },
];

function q(id, type, label, opts = {}) {
    return { id, section: 'inspection', type, label, required: opts.required !== false, ...opts };
}

function yes(id, label, opts = {}) {
    return q(id, 'psi_yes', label, opts);
}

function yesNa(id, label, opts = {}) {
    return q(id, 'psi_yes_na', label, opts);
}

function banner(title, subtitle) {
    return {
        id: `banner_${title.replace(/\W+/g, '_').toLowerCase()}`,
        section: 'inspection',
        type: 'banner',
        label: '',
        required: false,
        bannerTitle: title,
        bannerSubtitle: subtitle,
    };
}

const WEEK_1_QUESTIONS = [
    banner(
        'Emergency Management',
        'The following 4 questions require you to speak to at least 3 team members working today. All 3 team members must provide an acceptable response for these questions to be marked as Yes.'
    ),
    yes('w1_emergencyEvacuation', 'Are team members working aware of what to do in an emergency evacuation and know where the assembly area is?'),
    yes('w1_fireExtinguishers', 'Are team members working aware of the location of fire extinguishers and the fire blanket, and know which to use for different types of fire?'),
    yes('w1_holdUp', 'Are team members working aware of what to do in the event of a hold up?'),
    yes('w1_needleSyringe', 'Are team members working aware of what to do if they find a needle/syringe in or surrounding the restaurant?'),
    yes('w1_hsrPoster', 'Is the Health and Safety Rep (HSR) Poster displayed, and are the Safety Champions noted?'),
    yes('w1_evacDiagram', 'Is the emergency evacuation diagram in good condition, on display in the correct location, and is all the information on it correct?'),
    yes('w1_fireEquipmentAccounted', 'Is all firefighting equipment accounted for? Does all equipment on the evacuation diagram match what is physically in the restaurant?'),
    yes('w1_fireEquipmentOrder', 'Is firefighting equipment in good working order and unobstructed? (Check dial on extinguishers to ensure they are in the green)'),
    yes('w1_fireEquipmentTagged', 'Is firefighting equipment inspected and tagged at least every 6 months? (Please note date of last inspection)'),
    yes('w1_emergencyFlipchart', 'Is the emergency procedures flipchart in good condition, on display, and filled in with the correct emergency contact details?'),
    yes('w1_emergencyExits', 'Are all emergency exits clearly marked and free from obstructions?'),
    yes('w1_walkwaysClear', 'Are all walkways, doors and evacuation routes clear of obstruction?'),
    yes('w1_backDoorUnlock', 'Is the back door unlocked from the inside to allow for emergency exit?'),
    yes('w1_evacPractice', 'Has an emergency evacuation practice and debrief been conducted in the last 12 months, or have all employees completed the Fire & Evacuation training module within the last 12 months?'),
    yes('w1_fireWardenVests', 'Are Fire Warden vests (hi-vis vests) clean and stored in an easily accessible location?'),
    yes('w1_contractorQr', 'Is the contractor & visitors sign in QR code available near the counter and used by all contractors & visitors including Area Coaches, above restaurant leaders, and members for the RSC?'),
    yesNa('w1_driveThruWindows', 'Are drive-thru windows closed between serving customers and locked with the key when not in use?'),
    yes('w1_firstAidStocked', 'Is the first aid cabinet fully stocked with all required products, and are all products within their expiry dates?'),
    yes('w1_firstAidReorderSheet', 'Is the most recent first aid contents/reorder sheet displayed on or inside the first aid cabinet?'),
];

const WEEK_2_QUESTIONS = [
    banner('PPE and Electrical Safety', 'Verify PPE availability and electrical safety standards.'),
    yes('w2_ppeAvailable', 'Is all the correct PPE available, clean and in good condition? (blue long sleeve heat resistant gloves, green PVC gloves, black bin changing/carpark gloves, cut resistant gloves, freezer gloves, hi-vis vest, fry apron, wash up apron)'),
    yes('w2_ppeObserved', 'Observe a team member performing a task that requires PPE. Is PPE being worn as required?'),
    yes('w2_uniformPolicy', 'Do team member uniforms, appearance and personal hygiene meet the Uniform Policy, including correct footwear?'),
    yes('w2_ppeWorn', 'Are team members wearing the correct PPE for tasks that require them to do so?'),
    yes('w2_testTag', 'Has all electrical equipment been tested and tagged within the last 6 months? (Record the last Test & Tag date in the notes) or, is new equipment tagged with a "new to service" tag?'),
    yes('w2_cordsLocation', 'Are electrical cords located where they are not likely to suffer damage or contact water and not on the floor?'),
    yes('w2_switchesCondition', 'Are all switches and power points in good condition (not cracked, dirty, or wet)?'),
    yes('w2_cordsCondition', 'Are all electrical cords in good condition (not bent, melted, frayed or wet)?'),
    yes('w2_noDoubleAdaptors', 'There are no double adaptors in use or stored in the restaurant?'),
    yes('w2_noPersonalElectrical', 'There is no personal electrical equipment, such as phone chargers, in the restaurant?'),
    yes('w2_switchboardClearance', 'Is there clear space in front of the electrical switchboard of at least 1 metre?'),
    yes('w2_switchboardLocked', 'Is the switchboard door locked to prevent unauthorised access?'),
    yes('w2_switchboardKeys', 'Are the keys to the switchboard easily accessible to the MIC and able to be produced when asked?'),
];

const WEEK_3_QUESTIONS = [
    banner('Hazard Management', 'Review hazard controls, chemicals, equipment and housekeeping.'),
    yes('w3_stopStepBackCalendar', 'Is the Stop and Step Back calendar displayed on Bellboard and Printed from Period Priorities?'),
    yes('w3_stopStepBackQuiz', 'Have all team members working today, and who have worked a shift this period, completed the Stop & Step Back quiz for this period?'),
    yes('w3_stopStepBackAware', 'Are team members working aware of this periods Stop & Step Back focus and what it means?'),
    yes('w3_stopStepBackPlan', 'Does your restaurant have a plan in place to ensure all team members working complete the Stop & Step Back quiz before the end of next week and will your restaurant achieve over 90% compliance for the period?'),
    yes('w3_tacopediaTraining', 'Check Tacopedia for the last 3 team members hired. Have they completed all required training and certifications?'),
    yes('w3_noUnapprovedChemicals', 'There are no unapproved cleaning chemicals or fly sprays in use or stored in the restaurant?'),
    yes('w3_chemicalLabels', 'Are the labels on chemical containers legible and in good condition?'),
    yes('w3_ecolabGuide', 'Is the Ecolob Cleaning Product Guide displayed near the chemical cage and in good condition?'),
    yes('w3_co2Secured', 'Are all CO2 bottles secured with a chain?'),
    yes('w3_platformLadder', 'Is the platform ladder stored securely and in good condition (rubber feet are in place and not worn, rungs are secure and free of debris, platform is secure and clean)?'),
    yes('w3_safetyStep', 'Is the safety step easily accessible, clean, and in good condition (grips, wheels and base rings not damaged or worn)?'),
    yes('w3_deliveryTrolley', 'Is the delivery trolley in good working order (no damage to wheels/tyres, or overall structure)?'),
    yes('w3_freezerFloor', 'Is the freezer floor clean and free of ice or other slip hazards?'),
    yes('w3_walkInCondition', 'Are the walk in coldrooms and freezers clean, tidy, free from hazards, and in good working condition? Please check the fans, alarms, door seals, and shelving.'),
    yes('w3_walkInStorage', 'Are boxes in the walk in coldroom and freezer stored safely and allow for easy access in and out of the doorway?'),
    yes('w3_heavyItemsHeight', 'Are heavier items stored on shelves between thigh and shoulder height?'),
    yes('w3_bohFlooring', 'Is the flooring back of house free of trip/slip/fall hazards such as missing or damaged tiles or grout, mats, cardboard, water, oil, chemical spills, or other hazards?'),
    yes('w3_bohWetFloorSign', 'Is the flooring BOH marked with a wet floor sign if the floor has recently been mopped?'),
    yes('w3_fohFlooring', 'Is the flooring front of house free of trip/slip/fall hazards such as missing or damaged tiles or grout, mats, cardboard, water, oil, chemical spills, or other hazards?'),
    yes('w3_fohWetFloorSign', 'Is the flooring FOH marked with a wet floor sign if the floor has recently been mopped?'),
    yes('w3_wallsSurfaces', 'Are all back of house and front of house walls and surfaces clean, including the ceiling?'),
    yes('w3_airVents', 'Are all back of house and front of house air vents clean and free from build up?'),
    yes('w3_rubbishBins', 'Are rubbish bins clean, free from unpleasant odour, emptied regularly and not overflowing?'),
    yes('w3_restrooms', 'Are restrooms including the toilets, sinks and hand dryers free from damage and well maintained?'),
];

const WEEK_4_QUESTIONS = [
    banner('Building Safety', 'Inspect building structure, carpark, lighting and exhaust systems.'),
    yes('w4_buildingStructure', 'Is the building structure in good condition and free from safety hazards?'),
    yesNa('w4_carparkLineMarking', 'Does the carpark have line marking to separate between pedestrian and vehicle areas and is this line marking in good condition?'),
    yesNa('w4_bushesMaintained', 'Are bushes surrounding the restaurant maintained well, and cut back sufficiently to avoid potential intruders from hiding in or behind them?'),
    yes('w4_lighting', 'Is there sufficient lighting for security and to perform tasks both inside and outside the restaurant safely?'),
    yes('w4_lightsRepair', 'Are lights working and are light fittings and bulbs clean and in good repair?'),
    yes('w4_airConditioning', 'Is the air conditioning system working effectively?'),
    yes('w4_canopyHoodsClean', 'Are the canopy exhaust hoods clean and working well?'),
    yes('w4_canopyHoodsServiced', 'Have the canopy exhaust hoods been professionally cleaned in the last 6 months?'),
    yes('w4_storageShelves', 'Are all storage shelves in good condition (no damaged, bent, or wobbly)?'),
];

const PSI_WEEK_QUESTIONS = {
    1: WEEK_1_QUESTIONS,
    2: WEEK_2_QUESTIONS,
    3: WEEK_3_QUESTIONS,
    4: WEEK_4_QUESTIONS,
};

function normalizePsiWeek(week) {
    const n = Math.floor(Number(week));
    if (n >= 1 && n <= 4) return n;
    return 1;
}

function getQuestionsForWeek(week) {
    return PSI_WEEK_QUESTIONS[normalizePsiWeek(week)] || WEEK_1_QUESTIONS;
}

function buildWeekSchema(week) {
    const psiWeek = normalizePsiWeek(week);
    const questions = getQuestionsForWeek(psiWeek);
    const weekTitle = PSI_WEEK_TITLES[psiWeek] || `Week ${psiWeek}`;
    return {
        psiWeek,
        weekTitle,
        sections: PSI_SECTIONS.map((s) =>
            s.id === 'inspection' ? { ...s, label: weekTitle } : { ...s }
        ),
        questions,
        auditLabel: AUDIT_LABEL,
    };
}

const ALL_QUESTION_IDS = new Set(
    Object.values(PSI_WEEK_QUESTIONS).flatMap((qs) => qs.map((q) => q.id))
);

function getQuestionById(id, week) {
    const questions = week ? getQuestionsForWeek(week) : Object.values(PSI_WEEK_QUESTIONS).flat();
    return questions.find((q) => q.id === id) || null;
}

function getQuestionsForSection(session, sectionId) {
    const week = session?.psiWeek || 1;
    return getQuestionsForWeek(week).filter((q) => q.section === sectionId);
}

function isPsiYesType(type) {
    return type === 'psi_yes' || type === 'psi_yes_na';
}

function isAnswerEmpty(question, value) {
    if (!question) return true;
    if (question.type === 'banner') return false;
    if (isPsiYesType(question.type)) {
        if (question.type === 'psi_yes_na' && String(value).toLowerCase() === 'na') return false;
        return value !== 'yes' && value !== 'no' && value !== 'na';
    }
    return value === null || value === undefined || String(value).trim() === '';
}

function isNotCompliantValue(value, question) {
    if (!isPsiYesType(question?.type)) return false;
    return String(value || '').toLowerCase() === 'no';
}

function getVisibleQuestions(session, sectionId) {
    return getQuestionsForSection(session, sectionId);
}

function getScoredQuestions(session) {
    return getQuestionsForWeek(session?.psiWeek || 1).filter(
        (q) => isPsiYesType(q.type) && q.type !== 'banner'
    );
}

function getActionEntry(session, questionId) {
    const raw = session.actions?.[questionId];
    if (!raw) return { text: '', submittedAt: null };
    return { text: String(raw.text || ''), submittedAt: raw.submittedAt || null };
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
    for (const question of getScoredQuestions(session)) {
        const value = session.answers?.[question.id];
        if (!isNotCompliantValue(value, question)) continue;
        const note = String(session.notes?.[question.id] || '').trim();
        out.push({
            questionId: question.id,
            label: question.label,
            note,
            hasNote: Boolean(note),
            actionText: getActionEntry(session, question.id).text,
            actionSubmitted: isActionSubmitted(session, question.id),
        });
    }
    return out;
}

function validateSection(session, sectionId) {
    if (sectionId === 'signOff') {
        if (!String(session.signOff?.name || '').trim()) {
            return { ok: false, error: 'Manager name is required.' };
        }
        if (!String(session.signOff?.signatureDataUrl || '').trim()) {
            return { ok: false, error: 'Sign-off signature is required.' };
        }
        return { ok: true };
    }

    if (sectionId === 'inspection') {
        const questions = getVisibleQuestions(session, sectionId).filter((q) => isPsiYesType(q.type));
        for (const question of questions) {
            const value = session.answers?.[question.id];
            if (question.required && isAnswerEmpty(question, value)) {
                return { ok: false, error: `Answer required: ${question.label}` };
            }
            if (isNotCompliantValue(value, question)) {
                const note = String(session.notes?.[question.id] || '').trim();
                if (!note) {
                    return { ok: false, error: `Add a note for: ${question.label}` };
                }
            }
        }
        return { ok: true };
    }

    return { ok: true };
}

function validateSessionComplete(session) {
    for (const section of PSI_SECTIONS) {
        if (section.id === 'signOff') continue;
        const result = validateSection(session, section.id);
        if (!result.ok) return result;
    }
    return validateSection(session, 'signOff');
}

function scoreSession(session) {
    const scored = getScoredQuestions(session);
    const satisfactory = scored.filter((q) => String(session.answers?.[q.id]).toLowerCase() === 'yes');
    const nc = collectNonCompliant(session);
    const total = scored.length;
    const okCount = satisfactory.length;
    const pct = total ? Math.round((okCount / total) * 100) : 0;
    return {
        total,
        yesCount: okCount,
        percent: pct,
        flaggedCount: nc.length,
        actionCount: nc.filter((r) => r.hasNote).length,
    };
}

function buildSchemaPayload(week) {
    return buildWeekSchema(week);
}

module.exports = {
    AUDIT_LABEL,
    PSI_SECTIONS,
    PSI_WEEK_QUESTIONS,
    normalizePsiWeek,
    getQuestionsForWeek,
    buildWeekSchema,
    buildSchemaPayload,
    getQuestionById,
    getQuestionsForSection,
    getVisibleQuestions,
    getScoredQuestions,
    isPsiYesType,
    isAnswerEmpty,
    isNotCompliantValue,
    getActionEntry,
    isActionSubmitted,
    normalizeActionUpdate,
    collectNonCompliant,
    validateSection,
    validateSessionComplete,
    scoreSession,
};
