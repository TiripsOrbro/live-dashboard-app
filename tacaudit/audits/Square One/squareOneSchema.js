const generated = require('./squareOneQuestions.generated.json');
const { getAreaById } = require('./squareOneAreas');

const SQUARE_ONE_SECTIONS = [
    { id: 'checklist', label: 'Checklist', order: 1 },
    { id: 'signOff', label: 'Sign Off', order: 2 },
];

const AUDIT_LABEL = 'Square One';

function cleanLabel(text) {
    return String(text || '')
        .replace(/\.?Select one$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function q(id, section, type, label, opts = {}) {
    return { id, section, type, label, required: opts.required !== false, ...opts };
}

function standardQuestion(raw, areaId, index) {
    const label = cleanLabel(raw.label);
    const options = raw.allowNa
        ? [
              ['complete', 'Completed to Standard'],
              ['not_complete', 'Not Complete'],
              ['na', 'N/A'],
          ]
        : [
              ['complete', 'Completed to Standard'],
              ['not_complete', 'Not Complete'],
          ];
    return q(`${areaId}_${raw.id}`, 'checklist', 'square_standard', label, {
        group: cleanLabel(raw.group) || 'Checklist',
        options,
        photoRequired: true,
    });
}

function buildQuestionsForArea(areaId) {
    const area = generated.areas.find((a) => a.id === areaId);
    if (!area) return [];
    const questions = [];
    const safetyLine = area.questions.find((raw) => /SAFETY ALERT/i.test(raw.label));
    if (safetyLine) {
        questions.push(
            q(`${areaId}_safety_banner`, 'checklist', 'banner', '', {
                required: false,
                bannerTitle: area.title.toUpperCase(),
                bannerSubtitle: cleanLabel(safetyLine.label),
            })
        );
    } else {
        questions.push(
            q(`${areaId}_intro_banner`, 'checklist', 'banner', '', {
                required: false,
                bannerTitle: area.title.toUpperCase(),
                bannerSubtitle: 'Mark each task completed to standard or not complete. Photo evidence is required for every answer.',
            })
        );
    }
    for (const [index, raw] of area.questions.entries()) {
        if (/SAFETY ALERT/i.test(raw.label)) continue;
        questions.push(standardQuestion(raw, areaId, index));
    }
    return questions;
}

const QUESTION_CACHE = new Map();

function getQuestionsForArea(areaId) {
    const id = String(areaId || '').trim();
    if (!QUESTION_CACHE.has(id)) {
        QUESTION_CACHE.set(id, buildQuestionsForArea(id));
    }
    return QUESTION_CACHE.get(id);
}

function getQuestionById(questionId, areaId) {
    return getQuestionsForArea(areaId).find((q) => q.id === questionId) || null;
}

function isSquareStandardType(type) {
    return type === 'square_standard' || type === 'square_checkbox';
}

function isAnswerEmpty(question, value) {
    if (!question) return true;
    if (question.type === 'banner') return false;
    if (isSquareStandardType(question.type)) {
        if (!question.required && (value === '' || value == null)) return false;
        return value !== 'complete' && value !== 'not_complete' && value !== 'na';
    }
    if (question.type === 'checkbox') {
        return !value;
    }
    return value === null || value === undefined || String(value).trim() === '';
}

function isNotCompliantValue(value, question) {
    if (!isSquareStandardType(question?.type)) return false;
    return String(value || '').toLowerCase() === 'not_complete';
}

function photoRequiredForQuestion(question, value, photos = {}) {
    if (!question?.photoRequired) return false;
    if (isAnswerEmpty(question, value)) return false;
    if (String(value).toLowerCase() === 'na' && question.options?.some((o) => o[0] === 'na')) {
        return true;
    }
    return !photos?.[question.id];
}

function getVisibleQuestions(session, sectionId) {
    const areaId = session?.areaId;
    return getQuestionsForArea(areaId).filter((q) => q.section === sectionId);
}

function collectNonCompliant(session) {
    const out = [];
    for (const question of getQuestionsForArea(session.areaId)) {
        if (!isSquareStandardType(question.type)) continue;
        const value = session.answers?.[question.id];
        if (!isNotCompliantValue(value, question)) continue;
        const note = String(session.notes?.[question.id] || '').trim();
        out.push({
            questionId: question.id,
            label: question.label,
            group: question.group,
            note,
            hasNote: Boolean(note),
        });
    }
    return out;
}

function validateSection(session, sectionId) {
    if (sectionId === 'signOff') return { ok: true };
    const questions = getVisibleQuestions(session, sectionId);
    for (const question of questions) {
        if (!question.required) continue;
        const value = session.answers?.[question.id];
        if (isAnswerEmpty(question, value)) {
            return { ok: false, error: `Answer all required checklist items (${question.label.slice(0, 60)}…).` };
        }
        if (photoRequiredForQuestion(question, value, session.photos)) {
            return { ok: false, error: `Photo evidence required: ${question.label.slice(0, 60)}…` };
        }
        if (isNotCompliantValue(value, question) && !String(session.notes?.[question.id] || '').trim()) {
            return { ok: false, error: `Add a note for not-complete items (${question.label.slice(0, 60)}…).` };
        }
    }
    return { ok: true };
}

function validateSessionComplete(session) {
    for (const section of SQUARE_ONE_SECTIONS) {
        if (section.id === 'signOff') {
            if (!String(session.signOff?.name || '').trim()) {
                return { ok: false, error: 'Sign-off name is required.' };
            }
            if (!String(session.signOff?.signatureDataUrl || '').trim()) {
                return { ok: false, error: 'Sign-off signature is required.' };
            }
            continue;
        }
        const result = validateSection(session, section.id);
        if (!result.ok) return result;
    }
    return { ok: true };
}

function scoreSession(session) {
    const scored = getQuestionsForArea(session.areaId).filter(
        (q) => isSquareStandardType(q.type) && q.required !== false
    );
    if (!scored.length) return 100;
    const complete = scored.filter((q) => String(session.answers?.[q.id]).toLowerCase() === 'complete').length;
    return Math.round((complete / scored.length) * 100);
}

function buildSchemaPayload(areaId) {
    const area = getAreaById(areaId);
    return {
        auditLabel: AUDIT_LABEL,
        areaId,
        areaTitle: area?.title || 'Square One',
        dashboardLabel: area?.dashboardLabel || '',
        sections: SQUARE_ONE_SECTIONS,
        questions: getQuestionsForArea(areaId),
    };
}

module.exports = {
    AUDIT_LABEL,
    SQUARE_ONE_SECTIONS,
    buildSchemaPayload,
    getQuestionsForArea,
    getQuestionById,
    getVisibleQuestions,
    isSquareStandardType,
    isAnswerEmpty,
    isNotCompliantValue,
    photoRequiredForQuestion,
    collectNonCompliant,
    validateSection,
    validateSessionComplete,
    scoreSession,
};
