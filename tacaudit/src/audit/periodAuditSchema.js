/** Build a period-audit schema module from generated question JSON. */

function showWhenAnswerMatches(actual, expected) {
    const options = Array.isArray(expected) ? expected : [expected];
    const actualNorm = String(actual ?? '').toLowerCase();
    return options.some((e) => actualNorm === String(e).toLowerCase() || actualNorm.includes(String(e).toLowerCase()));
}

function createPeriodAuditSchema(generated) {
    const AUDIT_LABEL = generated.auditLabel || 'Audit';
    const PASS_THRESHOLD = generated.passThreshold ?? null;
    const SECTIONS = (generated.sections || []).map((s) => ({
        id: s.id,
        label: s.label,
        order: s.order ?? 0,
    }));
    const QUESTIONS = generated.questions || [];

    function getSections() {
        return [...SECTIONS].sort((a, b) => a.order - b.order);
    }

    function getQuestions() {
        return QUESTIONS;
    }

    function getQuestionById(id) {
        return QUESTIONS.find((q) => q.id === id) || null;
    }

    function getQuestionsForSection(sectionId) {
        return QUESTIONS.filter((q) => q.section === sectionId);
    }

    function isScoredType(type) {
        return ['yes_no_points', 'yes_no_na', 'standard_rating', 'compliant_nc', 'select', 'overall_result'].includes(type);
    }

    function isAnswerEmpty(question, value) {
        if (question.type === 'checkbox') return value !== true && value !== 'true' && value !== '1';
        if (question.type === 'signature') return !String(value || '').trim();
        return value === null || value === undefined || String(value).trim() === '';
    }

    function isQuestionVisible(question, session) {
        if (!question) return false;
        if (question.showWhenAnswer) {
            for (const [qId, expected] of Object.entries(question.showWhenAnswer)) {
                const actual = session.answers?.[qId];
                if (!showWhenAnswerMatches(actual, expected)) return false;
            }
        }
        if (question.hideWhenAnswer) {
            for (const [qId, expected] of Object.entries(question.hideWhenAnswer)) {
                const actual = session.answers?.[qId];
                if (showWhenAnswerMatches(actual, expected)) return false;
            }
        }
        return true;
    }

    function getVisibleQuestions(session, sectionId) {
        return getQuestionsForSection(sectionId).filter((q) => isQuestionVisible(q, session));
    }

    function deviationPoints(question, value) {
        const raw = String(value || '').toLowerCase();
        if (question.type === 'yes_no_points') {
            if (raw === 'no') return Number(question.noPoints ?? question.points ?? 0);
            return 0;
        }
        if (question.type === 'standard_rating') {
            if (raw === 'significant') return 10;
            if (raw === 'secondary') return 3;
            return 0;
        }
        if (question.type === 'compliant_nc') {
            if (raw.includes('non')) return Number(question.points ?? 1);
            return 0;
        }
        return 0;
    }

    function isNotCompliantValue(value, question) {
        const raw = String(value || '').toLowerCase();
        if (question.type === 'yes_no_points' || question.type === 'yes_no_na') return raw === 'no';
        if (question.type === 'standard_rating') return raw === 'significant' || raw === 'secondary';
        if (question.type === 'compliant_nc') return raw.includes('non');
        return false;
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
        for (const question of QUESTIONS) {
            if (!isScoredType(question.type)) continue;
            if (!isQuestionVisible(question, session)) continue;
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
        if (sectionId === 'sign_off') {
            if (!String(session.signOff?.name || '').trim()) {
                return { ok: false, error: 'Sign-off name is required.' };
            }
            if (!String(session.signOff?.signatureDataUrl || '').trim()) {
                return { ok: false, error: 'Sign-off signature is required.' };
            }
            return { ok: true };
        }

        const questions = getVisibleQuestions(session, sectionId);
        for (const question of questions) {
            if (question.type === 'textarea' && !question.required) continue;
            const value = session.answers?.[question.id];
            if (question.required && isAnswerEmpty(question, value)) {
                return { ok: false, error: `Answer required: ${question.label}` };
            }
            if (isScoredType(question.type) && isNotCompliantValue(value, question)) {
                if (!isActionSubmitted(session, question.id)) {
                    return { ok: false, error: `Submit a corrective action for: ${question.label}` };
                }
            }
        }
        return { ok: true };
    }

    function validateSessionComplete(session) {
        for (const section of getSections()) {
            if (section.id === 'sign_off') continue;
            const result = validateSection(session, section.id);
            if (!result.ok) return result;
        }
        return validateSection(session, 'sign_off');
    }

    function scoreSession(session) {
        let deviationTotal = 0;
        let scoredCount = 0;
        let compliantCount = 0;
        for (const question of QUESTIONS) {
            if (!isScoredType(question.type)) continue;
            if (!isQuestionVisible(question, session)) continue;
            const value = session.answers?.[question.id];
            if (isAnswerEmpty(question, value)) continue;
            scoredCount += 1;
            const pts = deviationPoints(question, value);
            deviationTotal += pts;
            if (!isNotCompliantValue(value, question)) compliantCount += 1;
        }
        const nc = collectNonCompliant(session);
        const rating =
            PASS_THRESHOLD != null
                ? deviationTotal <= PASS_THRESHOLD
                    ? 'PASS'
                    : 'Not at Standard'
                : null;
        return {
            deviationTotal,
            passThreshold: PASS_THRESHOLD,
            rating,
            total: scoredCount,
            compliantCount,
            percent: scoredCount ? Math.round((compliantCount / scoredCount) * 100) : 0,
            flaggedCount: nc.length,
            actionCount: nc.filter((r) => r.actionSubmitted).length,
        };
    }

    function buildSchemaPayload() {
        return {
            sections: getSections(),
            questions: getQuestions(),
            auditLabel: AUDIT_LABEL,
            passThreshold: PASS_THRESHOLD,
            minDurationMinutes: 0,
        };
    }

    return {
        AUDIT_LABEL,
        PASS_THRESHOLD,
        getSections,
        getQuestions,
        getQuestionById,
        getQuestionsForSection,
        getVisibleQuestions,
        isQuestionVisible,
        isAnswerEmpty,
        isNotCompliantValue,
        collectNonCompliant,
        validateSection,
        validateSessionComplete,
        buildSchemaPayload,
        scoreSession,
        normalizeActionUpdate,
        getActionEntry,
        isActionSubmitted,
        isMinimumDurationMet: () => true,
        minimumDurationRemainingMs: () => 0,
        MIN_DURATION_MINUTES: 0,
    };
}

module.exports = { createPeriodAuditSchema, showWhenAnswerMatches };
