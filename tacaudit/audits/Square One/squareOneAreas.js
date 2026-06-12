const generated = require('./squareOneQuestions.generated.json');

/** @type {Array<{id:string,dashboardLabel:string,title:string,week:number,slotIndex:number,tileLabel:string}>} */
const SQUARE_ONE_AREAS = generated.areas.map((area, slotIndex) => ({
    id: area.id,
    dashboardLabel: area.dashboardLabel,
    title: area.title,
    week: area.week,
    slotIndex,
    tileLabel: tileLabelFor(area),
}));

const AREA_BY_ID = new Map(SQUARE_ONE_AREAS.map((a) => [a.id, a]));
const AREA_BY_LABEL = new Map(SQUARE_ONE_AREAS.map((a) => [a.dashboardLabel, a]));

function tileLabelFor(area) {
    const title = String(area.title || area.dashboardLabel || '').trim();
    if (title.length <= 22) return title;
    const short = {
        'Walls, Floors, Drains, Shelves...': 'BOH walls & floors',
        'Bins, Bin Room, Office...': 'Bins & bin room',
        'Prep and Washup': 'Prep & washup',
        'Drink Station': 'Drink stations',
        'Production Line': 'Production line',
    };
    return short[area.dashboardLabel] || title.split(':')[0].trim();
}

function getAreaById(areaId) {
    return AREA_BY_ID.get(String(areaId || '').trim()) || null;
}

function getAreaByDashboardLabel(label) {
    return AREA_BY_LABEL.get(String(label || '').trim()) || null;
}

/** Two areas due for the current square-slot (0–3). */
function getDueAreasForSlot(squareSlot) {
    const slot = ((Number(squareSlot) % 4) + 4) % 4;
    const i = slot * 2;
    return [SQUARE_ONE_AREAS[i], SQUARE_ONE_AREAS[i + 1]].filter(Boolean);
}

/** Labels used on the dashboard audit checklist (all eight, in rotation order). */
const SQUARE_ONE_DASHBOARD_LABELS = SQUARE_ONE_AREAS.map((a) => a.dashboardLabel);

module.exports = {
    SQUARE_ONE_AREAS,
    SQUARE_ONE_DASHBOARD_LABELS,
    getAreaById,
    getAreaByDashboardLabel,
    getDueAreasForSlot,
    tileLabelFor,
};
