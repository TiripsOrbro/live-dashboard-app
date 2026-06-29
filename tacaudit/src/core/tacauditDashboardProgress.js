const {
    getAuditSchedule,
    getDismissalPeriodKey,
    listOperationalWeeksThroughCurrent,
    instantForYmdInTimeZone,
    loadAuditRecurrenceConfigSync,
} = require('../auditRecurrence');
const { buildPeriodSummary: buildPestPeriodSummary, listOpenAudits: listPestOpenAudits } = require('../../audits/Pest Walk/pestWalkStore');
const { buildPeriodSummary: buildRgmPeriodSummary, listOpenAudits: listRgmOpenAudits } = require('../../audits/RGM Cleaning/rgmCleaningStore');
const { buildPeriodSummary: buildPsiPeriodSummary, listOpenAudits: listPsiOpenAudits } = require('../../audits/Periodic Safety Inspection/psiStore');
const { buildPeriodSummary: buildCoreOpsPeriodSummary, listOpenAudits: listCoreOpsOpenAudits } = require('../../audits/CORE Operations/coreOpsStore');
const {
    buildPeriodSummary: buildCoreFoodSafetyPeriodSummary,
    listOpenAudits: listCoreFoodSafetyOpenAudits,
} = require('../../audits/CORE Food Safety/coreFoodSafetyStore');
const { buildAreaSummaries, listOpenAudits: listSquareOneOpenAudits } = require('../../audits/Square One/squareOneStore');
const { SQUARE_ONE_AREAS } = require('../../audits/Square One/squareOneAreas');

const WEEKLY_TILE_IDS = new Set(['pest-walk', 'rgm-cleaning', 'psi']);
const SQUARE_ONE_LAUNCH_TILE_PREFIX = 'square-one--';
const EXCLUDED_WEEKLY_TILE_IDS = new Set(['dfsc', 'core-ops', 'core-food-safety']);

function isWeeklyLaunchTile(tile) {
    if (!tile || tile.placeholder) return false;
    if (WEEKLY_TILE_IDS.has(tile.id)) return true;
    return String(tile.id || '').startsWith(SQUARE_ONE_LAUNCH_TILE_PREFIX);
}
const PERIODIC_WEEKLY_AUDIT_TARGET = 4;
const SQUARE_ONE_PERIOD_TARGET = SQUARE_ONE_AREAS.length;

function parseWeekKey(weekKey) {
    const m = String(weekKey || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return { year: +m[1], month: +m[2], day: +m[3] };
}

function listCurrentPeriodWeekKeys(now = new Date()) {
    const schedule = getAuditSchedule(now);
    const periodNumber = schedule.periodNumber;
    return listOperationalWeeksThroughCurrent(now)
        .filter((week) => week.periodNumber === periodNumber)
        .map((week) => week.weekStartYmd);
}

function scheduleForWeekKey(weekKey) {
    const cfg = loadAuditRecurrenceConfigSync();
    const timeZone = cfg.timeZone || 'Australia/Melbourne';
    const ymd = parseWeekKey(weekKey);
    if (!ymd) return getAuditSchedule();
    const asOf = instantForYmdInTimeZone(ymd.year, ymd.month, ymd.day, timeZone);
    return getAuditSchedule(asOf);
}

function tileStateFromLaunchTile(tile) {
    if (!tile || tile.placeholder) return 'due';
    if (tile.complete) return 'complete';
    const sub = String(tile.sub || '').toLowerCase();
    if (sub.includes('in progress') || /\b\d+\s+open\b/.test(sub) || /\bopen\b/.test(sub)) {
        return 'in_progress';
    }
    const partial = sub.match(/(\d+)\/(\d+)\s+complete/);
    if (partial && Number(partial[1]) > 0) return 'in_progress';
    return 'due';
}

function buildWeeklyProgressFromTiles(launchTiles = []) {
    const tiles = (launchTiles || []).filter((tile) => isWeeklyLaunchTile(tile));
    const items = tiles.map((tile) => ({
        id: tile.id,
        label: tile.label,
        state: tileStateFromLaunchTile(tile),
    }));
    const counts = { complete: 0, in_progress: 0, due: 0, total: items.length, items };
    for (const item of items) {
        if (item.state === 'complete') counts.complete += 1;
        else if (item.state === 'in_progress') counts.in_progress += 1;
        else counts.due += 1;
    }
    return counts;
}

function countCompletedAcrossWeeks(storeNumber, weekKeys, buildPeriod) {
    let total = 0;
    for (const weekKey of weekKeys) {
        const period = buildPeriod(storeNumber, weekKey);
        total += Math.max(0, Number(period?.completedCount) || 0);
    }
    return total;
}

function countOpenAudits(storeNumber, listOpen, access) {
    return listOpen(storeNumber, { access }).length;
}

function periodicTrackState(complete, target, openCount) {
    const done = Math.min(Math.max(0, complete), target);
    if (done >= target) return 'complete';
    if (openCount > 0 || done > 0) return 'in_progress';
    return 'due';
}

/** Units actively being worked on (open sessions), not all remaining slots in the track. */
function periodicInProgressUnits(complete, target, openCount) {
    const done = Math.min(Math.max(0, complete), target);
    const remaining = Math.max(0, target - done);
    if (!remaining || !openCount) return 0;
    return Math.min(openCount, remaining);
}

function buildPeriodicProgress(storeNumber, options = {}) {
    const store = String(storeNumber || '').trim();
    const access = options.access || {};
    const schedule = getAuditSchedule();
    const weekKeys = listCurrentPeriodWeekKeys();
    const periodLabel = schedule.periodNumber ? `PERIOD ${schedule.periodNumber}` : 'PERIOD';

    const pestComplete = Math.min(
        countCompletedAcrossWeeks(store, weekKeys, buildPestPeriodSummary),
        PERIODIC_WEEKLY_AUDIT_TARGET
    );
    const rgmComplete = Math.min(
        countCompletedAcrossWeeks(store, weekKeys, buildRgmPeriodSummary),
        PERIODIC_WEEKLY_AUDIT_TARGET
    );
    const psiComplete = Math.min(
        countCompletedAcrossWeeks(store, weekKeys, buildPsiPeriodSummary),
        PERIODIC_WEEKLY_AUDIT_TARGET
    );

    const coreOpsComplete = Math.min(
        countCompletedAcrossWeeks(store, weekKeys, buildCoreOpsPeriodSummary),
        1
    );
    const coreFsComplete = Math.min(
        countCompletedAcrossWeeks(store, weekKeys, buildCoreFoodSafetyPeriodSummary),
        1
    );

    const completedAreaIds = new Set();
    for (const weekKey of weekKeys) {
        const weekSchedule = scheduleForWeekKey(weekKey);
        for (const area of buildAreaSummaries(store, weekKey, weekSchedule.squareSlot)) {
            if (area.periodCompleted) completedAreaIds.add(area.id);
        }
    }
    const squareComplete = Math.min(completedAreaIds.size, SQUARE_ONE_PERIOD_TARGET);

    const coreOpsOpen = countOpenAudits(store, listCoreOpsOpenAudits, access);
    const coreFsOpen = countOpenAudits(store, listCoreFoodSafetyOpenAudits, access);
    const squareOpen = countOpenAudits(store, listSquareOneOpenAudits, access);
    const pestOpen = countOpenAudits(store, listPestOpenAudits, access);
    const rgmOpen = countOpenAudits(store, listRgmOpenAudits, access);
    const psiOpen = countOpenAudits(store, listPsiOpenAudits, access);

    const tracks = [
        {
            id: 'core-ops',
            label: 'CORE Operations',
            complete: coreOpsComplete,
            target: 1,
            state: periodicTrackState(coreOpsComplete, 1, coreOpsOpen),
            inProgressUnits: periodicInProgressUnits(coreOpsComplete, 1, coreOpsOpen),
        },
        {
            id: 'core-food-safety',
            label: 'CORE Food Safety',
            complete: coreFsComplete,
            target: 1,
            state: periodicTrackState(coreFsComplete, 1, coreFsOpen),
            inProgressUnits: periodicInProgressUnits(coreFsComplete, 1, coreFsOpen),
        },
        {
            id: 'square-one',
            label: 'Square One',
            complete: squareComplete,
            target: SQUARE_ONE_PERIOD_TARGET,
            state: periodicTrackState(squareComplete, SQUARE_ONE_PERIOD_TARGET, squareOpen),
            inProgressUnits: periodicInProgressUnits(squareComplete, SQUARE_ONE_PERIOD_TARGET, squareOpen),
        },
        {
            id: 'pest-walk',
            label: 'Pest Walk',
            complete: pestComplete,
            target: PERIODIC_WEEKLY_AUDIT_TARGET,
            state: periodicTrackState(pestComplete, PERIODIC_WEEKLY_AUDIT_TARGET, pestOpen),
            inProgressUnits: periodicInProgressUnits(pestComplete, PERIODIC_WEEKLY_AUDIT_TARGET, pestOpen),
        },
        {
            id: 'rgm-cleaning',
            label: 'RGM Cleaning',
            complete: rgmComplete,
            target: PERIODIC_WEEKLY_AUDIT_TARGET,
            state: periodicTrackState(rgmComplete, PERIODIC_WEEKLY_AUDIT_TARGET, rgmOpen),
            inProgressUnits: periodicInProgressUnits(rgmComplete, PERIODIC_WEEKLY_AUDIT_TARGET, rgmOpen),
        },
        {
            id: 'psi',
            label: 'PSI',
            complete: psiComplete,
            target: PERIODIC_WEEKLY_AUDIT_TARGET,
            state: periodicTrackState(psiComplete, PERIODIC_WEEKLY_AUDIT_TARGET, psiOpen),
            inProgressUnits: periodicInProgressUnits(psiComplete, PERIODIC_WEEKLY_AUDIT_TARGET, psiOpen),
        },
    ];

    const total = tracks.reduce((sum, track) => sum + track.target, 0);
    const complete = tracks.reduce((sum, track) => sum + track.complete, 0);
    const inProgressUnits = tracks.reduce((sum, track) => sum + (track.inProgressUnits || 0), 0);
    const dueUnits = Math.max(0, total - complete - inProgressUnits);
    const inProgressTracks = tracks.filter((track) => track.state === 'in_progress').length;
    const completeTracks = tracks.filter((track) => track.state === 'complete').length;
    const dueTracks = Math.max(0, tracks.length - completeTracks - inProgressTracks);

    return {
        periodLabel,
        complete,
        in_progress: inProgressUnits,
        due: dueUnits,
        total,
        items: tracks,
        statLine: `${complete} of ${total} complete`,
        breakdown: `${complete} complete · ${inProgressUnits} in progress · ${dueUnits} remaining`,
        trackSummary: `${completeTracks} complete · ${inProgressTracks} in progress · ${dueTracks} due`,
    };
}

function buildStoreDashboardProgress(storeNumber, launchTiles = [], options = {}) {
    return {
        weekly: buildWeeklyProgressFromTiles(launchTiles),
        periodic: buildPeriodicProgress(storeNumber, options),
    };
}

module.exports = {
    WEEKLY_TILE_IDS,
    SQUARE_ONE_LAUNCH_TILE_PREFIX,
    EXCLUDED_WEEKLY_TILE_IDS,
    isWeeklyLaunchTile,
    buildStoreDashboardProgress,
    buildWeeklyProgressFromTiles,
    buildPeriodicProgress,
    tileStateFromLaunchTile,
};
