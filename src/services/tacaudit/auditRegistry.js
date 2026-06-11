const { buildDfscReportPdf, buildReportFilename: buildDfscReportFilename, buildDfscReportText } = require('../dfsc/dfscReport');
const { buildPestWalkReportPdf, buildReportFilename: buildPestWalkReportFilename } = require('../pestWalk/pestWalkReport');
const { buildRgmCleaningReportPdf, buildReportFilename: buildRgmCleaningReportFilename } = require('../rgmCleaning/rgmCleaningReport');
const { buildPsiReportPdf, buildReportFilename: buildPsiReportFilename } = require('../periodicSafety/psiReport');
const {
    buildSquareOneReportPdf,
    buildReportFilename: buildSquareOneReportFilename,
} = require('../squareOne/squareOneReport');

const AUDIT_TYPES = ['dfsc', 'pest-walk', 'rgm-cleaning', 'psi', 'square-one'];

const REGISTRY = {
    dfsc: {
        label: 'DFSC',
        buildPdf: buildDfscReportPdf,
        buildFilename: buildDfscReportFilename,
        buildText: buildDfscReportText,
        dateField: 'dateKey',
        sessionQueryField: 'dateKey',
    },
    'pest-walk': {
        label: 'Pest Walk',
        buildPdf: buildPestWalkReportPdf,
        buildFilename: buildPestWalkReportFilename,
        dateField: 'periodKey',
        sessionQueryField: 'periodKey',
    },
    'rgm-cleaning': {
        label: 'RGM Cleaning',
        buildPdf: buildRgmCleaningReportPdf,
        buildFilename: buildRgmCleaningReportFilename,
        dateField: 'periodKey',
        sessionQueryField: 'periodKey',
    },
    psi: {
        label: 'PSI',
        buildPdf: buildPsiReportPdf,
        buildFilename: buildPsiReportFilename,
        dateField: 'periodKey',
        sessionQueryField: 'periodKey',
    },
    'square-one': {
        label: 'Square One',
        buildPdf: buildSquareOneReportPdf,
        buildFilename: buildSquareOneReportFilename,
        dateField: 'periodKey',
        sessionQueryField: 'periodKey',
    },
};

function getAuditTypeConfig(auditType) {
    return REGISTRY[String(auditType || '').trim()] || null;
}

function isValidAuditType(auditType) {
    return AUDIT_TYPES.includes(String(auditType || '').trim());
}

function summarizeSessionMeta(session, auditType) {
    const cfg = getAuditTypeConfig(auditType);
    const dateField = cfg?.dateField || 'dateKey';
    const started = Date.parse(session.startedAt || '');
    const completed = Date.parse(session.completedAt || '');
    let durationMinutes = session.durationMinutes ?? null;
    if (durationMinutes == null && Number.isFinite(started) && Number.isFinite(completed) && completed >= started) {
        durationMinutes = Math.round((completed - started) / 60000);
    }
    return {
        conductorName: session.conductor?.name || '',
        signOffName: session.signOff?.name || '',
        completedAt: session.completedAt,
        durationMinutes,
        nonCompliantCount: Array.isArray(session.nonCompliant) ? session.nonCompliant.length : null,
        score: session.score ?? null,
        dateKey: session.dateKey || null,
        shift: session.shift || null,
        periodKey: session.periodKey || null,
        psiWeek: session.psiWeek ?? null,
        areaId: session.areaId || null,
        areaTitle: session.areaTitle || null,
        dashboardLabel: session.dashboardLabel || null,
        [dateField]: session[dateField] || null,
    };
}

module.exports = {
    AUDIT_TYPES,
    REGISTRY,
    getAuditTypeConfig,
    isValidAuditType,
    summarizeSessionMeta,
};
