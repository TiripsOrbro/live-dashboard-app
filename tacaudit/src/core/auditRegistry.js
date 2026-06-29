const { buildDfscReportPdf, buildReportFilename: buildDfscReportFilename } = require('../../audits/Daily Food Safety Check/dfscReport');
const { buildPestWalkReportPdf, buildReportFilename: buildPestWalkReportFilename } = require('../../audits/Pest Walk/pestWalkReport');
const { buildRgmCleaningReportPdf, buildReportFilename: buildRgmCleaningReportFilename } = require('../../audits/RGM Cleaning/rgmCleaningReport');
const { buildPsiReportPdf, buildReportFilename: buildPsiReportFilename } = require('../../audits/Periodic Safety Inspection/psiReport');
const {
    buildSquareOneReportPdf,
    buildReportFilename: buildSquareOneReportFilename,
} = require('../../audits/Square One/squareOneReport');
const { buildCoreOpsReportPdf, buildReportFilename: buildCoreOpsReportFilename } = require('../../audits/CORE Operations/coreOpsReport');
const {
    buildCoreFoodSafetyReportPdf,
    buildReportFilename: buildCoreFoodSafetyReportFilename,
} = require('../../audits/CORE Food Safety/coreFoodSafetyReport');
const { buildVisitCoachReportPdf, buildReportFilename: buildVisitCoachReportFilename } = require('../../audits/Visiting as a Coach/visitCoachReport');
const {
    buildVisitCustomerReportPdf,
    buildReportFilename: buildVisitCustomerReportFilename,
} = require('../../audits/Visiting as a Customer/visitCustomerReport');

const AUDIT_TYPES = [
    'dfsc',
    'pest-walk',
    'rgm-cleaning',
    'psi',
    'square-one',
    'core-ops',
    'core-food-safety',
    'visit-coach',
    'visit-customer',
];

const COACH_AUDIT_TYPES = new Set(['visit-coach', 'visit-customer']);

const REGISTRY = {
    dfsc: {
        label: 'DFSC',
        buildPdf: buildDfscReportPdf,
        buildFilename: buildDfscReportFilename,
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
    'core-ops': {
        label: 'CORE Operations',
        buildPdf: buildCoreOpsReportPdf,
        buildFilename: buildCoreOpsReportFilename,
        dateField: 'periodKey',
        sessionQueryField: 'periodKey',
        complianceLabel: 'CORE Operations Self Score',
    },
    'core-food-safety': {
        label: 'CORE Food Safety',
        buildPdf: buildCoreFoodSafetyReportPdf,
        buildFilename: buildCoreFoodSafetyReportFilename,
        dateField: 'periodKey',
        sessionQueryField: 'periodKey',
        complianceLabel: 'CORE Food Safety Self Score',
    },
    'visit-coach': {
        label: 'Visiting as a Coach',
        buildPdf: buildVisitCoachReportPdf,
        buildFilename: buildVisitCoachReportFilename,
        dateField: 'periodKey',
        sessionQueryField: 'periodKey',
        complianceLabel: 'Visiting as a Coach',
        coachOnly: true,
    },
    'visit-customer': {
        label: 'Visiting as a Customer',
        buildPdf: buildVisitCustomerReportPdf,
        buildFilename: buildVisitCustomerReportFilename,
        dateField: 'periodKey',
        sessionQueryField: 'periodKey',
        complianceLabel: 'Visiting as a Customer',
        coachOnly: true,
    },
};

function isCoachAuditType(auditType) {
    return COACH_AUDIT_TYPES.has(String(auditType || '').trim());
}

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
    COACH_AUDIT_TYPES,
    REGISTRY,
    getAuditTypeConfig,
    isValidAuditType,
    isCoachAuditType,
    summarizeSessionMeta,
};
