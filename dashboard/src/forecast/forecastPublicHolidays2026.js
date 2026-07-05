/**
 * 2026 Australian public holidays by forecast area (state-wide dates).
 * Sources: business.vic.gov.au, wa.gov.au, fairwork.gov.au (2026 lists).
 */
const PUBLIC_HOLIDAYS_2026 = {
    'VIC-1': [
        { date: '2026-01-01', label: "New Year's Day" },
        { date: '2026-01-26', label: 'Australia Day' },
        { date: '2026-03-09', label: 'Labour Day' },
        { date: '2026-04-03', label: 'Good Friday' },
        { date: '2026-04-04', label: 'Saturday before Easter Sunday' },
        { date: '2026-04-05', label: 'Easter Sunday' },
        { date: '2026-04-06', label: 'Easter Monday' },
        { date: '2026-04-25', label: 'Anzac Day' },
        { date: '2026-06-08', label: "King's Birthday" },
        { date: '2026-09-25', label: 'Friday before AFL Grand Final' },
        { date: '2026-11-03', label: 'Melbourne Cup' },
        { date: '2026-12-25', label: 'Christmas Day' },
        { date: '2026-12-26', label: 'Boxing Day' },
        { date: '2026-12-28', label: 'Boxing Day (additional)' },
    ],
    'WA-1': [
        { date: '2026-01-01', label: "New Year's Day" },
        { date: '2026-01-26', label: 'Australia Day' },
        { date: '2026-03-02', label: 'Labour Day' },
        { date: '2026-04-03', label: 'Good Friday' },
        { date: '2026-04-05', label: 'Easter Sunday' },
        { date: '2026-04-06', label: 'Easter Monday' },
        { date: '2026-04-25', label: 'Anzac Day' },
        { date: '2026-04-27', label: 'Anzac Day (additional)' },
        { date: '2026-06-01', label: 'Western Australia Day' },
        { date: '2026-09-28', label: "King's Birthday" },
        { date: '2026-12-25', label: 'Christmas Day' },
        { date: '2026-12-26', label: 'Boxing Day' },
        { date: '2026-12-28', label: 'Boxing Day (additional)' },
    ],
    'QLD-1': [
        { date: '2026-01-01', label: "New Year's Day" },
        { date: '2026-01-26', label: 'Australia Day' },
        { date: '2026-04-03', label: 'Good Friday' },
        { date: '2026-04-04', label: 'The day after Good Friday' },
        { date: '2026-04-05', label: 'Easter Sunday' },
        { date: '2026-04-06', label: 'Easter Monday' },
        { date: '2026-04-25', label: 'Anzac Day' },
        { date: '2026-05-04', label: 'Labour Day' },
        { date: '2026-08-12', label: 'Royal Queensland Show (Brisbane)' },
        { date: '2026-10-05', label: "King's Birthday" },
        { date: '2026-12-25', label: 'Christmas Day' },
        { date: '2026-12-26', label: 'Boxing Day' },
        { date: '2026-12-28', label: 'Boxing Day (additional)' },
    ],
};

function defaultPublicHolidaysByArea() {
    const byArea = {};
    for (const [area, entries] of Object.entries(PUBLIC_HOLIDAYS_2026)) {
        byArea[area] = entries.map((row) => ({ ...row }));
    }
    return byArea;
}

module.exports = {
    PUBLIC_HOLIDAYS_2026,
    defaultPublicHolidaysByArea,
};
