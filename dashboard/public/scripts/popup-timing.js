/* ============================================================
   POPUP TIMING — durations, daily schedule, boilout calendar

   NOTIFICATION_DURATIONS — how long each card stays on screen
     • seconds — display time (3600 = 1 hour, 600 = 10 min)
     • duration — alternative: milliseconds
     • _defaultSeconds — used when a key has no entry (15 sec)

   SCHEDULE — when to show cards (Melbourne 24h "H:MM" or "HH:MM")
     • show — up to 3 keys from NOTIFICATION_CONTENT in popup-content.js

   BOILOUT_RULE — fryer boilout reminders (Melbourne dates/times)
   ============================================================ */

window.POPUP_CONFIG = window.POPUP_CONFIG || {
    transitionDuration: 350,
    easing: 'cubic-bezier(0.22,1,0.36,1)',
    soundUrl: '/assets/sounds/8_bit.mp3',
    soundVolume: 0.9,
    cardMinHeight: 160,
    defaultSinglePopupMs: 10000,
};

window.NOTIFICATION_DURATIONS = {
    _defaultSeconds: 15,

    boiloutOilDump: { seconds: 3600 },
    boiloutComplete: { seconds: 3600 },

    '845AM': { seconds: 600 },
    '1030AM': { seconds: 600 },
    '2PM': { seconds: 600 },
    '330PM': { seconds: 600 },
    '8PM': { seconds: 600 },

    stockUpUnderlineFridge: { seconds: 3600 },
    stockUpDeserts: { seconds: 3600 },

    safeCount: { seconds: 7200 },
    AMStockCount: { seconds: 7200 },
    recieveOrders: { seconds: 7200 },
    completeFryPrep: { seconds: 7200 },
    completeSaladPrep: { seconds: 7200 },
    checkToilets: { seconds: 7200 },
    stockUpPaperStockOnLine: { seconds: 7200 },
    thawing: { seconds: 7200 },

    changeUtensils: { seconds: 600 },
    changeoverSafeCount: { seconds: 600 },
    changeoverTills: { seconds: 600 },
    changeSink: { seconds: 600 },
    changeBuckets: { seconds: 600 },
    changeoverStockCount: { seconds: 600 },

    cleanToilets: { seconds: 600 },
    diningBins: { seconds: 600 },
    patioBins: { seconds: 600 },
    removeBins: { seconds: 600 },
    smallVats: { seconds: 600 },
    hotLine: { seconds: 600 },
    filterPan: { seconds: 600 },
    removeExtras: { seconds: 600 },
    DTBench: { seconds: 600 },
    prepBench: { seconds: 600 },
    fryBench: { seconds: 600 },
    cleanFloors: { seconds: 600 },
    drains: { seconds: 600 },
    setupCarryover: { seconds: 600 },
    cleanRetherm: { seconds: 600 },
    removeStickers: { seconds: 600 },
    wipePrepGuide: { seconds: 600 },
    wipeTREDPoster: { seconds: 600 },
    mopDining: { seconds: 600 },
    carryoverPan: { seconds: 600 },
    carryoverFirstRound: { seconds: 600 },
    chipDump: { seconds: 600 },
    coldLine: { seconds: 600 },
    remainingFloors: { seconds: 600 },
    stockCount: { seconds: 600 },
    countSafe: { seconds: 600 },
    bigGrillFirstAlert: { seconds: 600 },
    bigGrillSecondAlert: { seconds: 600 },
    drinkNozzles: { seconds: 3600 },
    remainingBins: { seconds: 3600 },
    carryover: { seconds: 3600 },
    cleanOutSpotSweeps: { seconds: 3600 },
    checkThawing: { seconds: 600 },
    organiseFreezer: { seconds: 600 },
    printReports: { seconds: 600 },
    shutDownTills: { seconds: 3600 },
};

window.SCHEDULE = [
    // COOKS
    { time: '8:45', show: ['845AM'] },
    { time: '10:30', show: ['1030AM'] },
    { time: '2:00', show: ['2PM'] },
    { time: '3:30', show: ['330PM'] },
    { time: '8:00', show: ['8PM'] },

    // OPEN
    {
        time: '8:00',
        show: [
            'safeCount',
            'AMStockCount',
            'recieveOrders',
            'completeFryPrep',
            'completeSaladPrep',
            'checkToilets',
            'stockUpPaperStockOnLine',
            'stockUpDeserts',
            'thawing',
        ],
    },

    // Before 9:30 PM
    { time: '20:00', show: ['smallVats', 'prepBench', 'fryBench'] },
    { time: '20:10', show: ['DTBench', 'setupCarryover', 'removeExtras'] },
    { time: '20:20', show: ['cleanFloors', 'drains', 'cleanRetherm'] },
    { time: '20:30', show: ['cleanToilets', 'patioBins', 'diningBins'] },
    { time: '20:40', show: ['removeBins', 'wipeTREDPoster', 'filterPan'] },
    { time: '20:50', show: ['wipePrepGuide', 'carryoverPan', 'removeStickers'] },
    { time: '21:00', show: ['countSafe', 'printReports', 'carryoverFirstRound'] },

    // After 9:30 PM
    { time: '21:10', show: ['bigGrillFirstAlert', 'checkThawing', 'hotLine'] },
    { time: '21:20', show: ['stockCount', 'organiseFreezer', 'chipDump'] },
    { time: '21:30', show: ['mopDining', 'coldLine', 'bigGrillSecondAlert'] },
    { time: '21:40', show: ['remainingFloors'] },

    // After close
    { time: '22:00', show: ['drinkNozzles'] },
    { time: '22:00', show: ['remainingBins'] },
    { time: '22:00', show: ['carryover'] },
    { time: '22:00', show: ['cleanOutSpotSweeps'] },
    { time: '22:00', show: ['shutDownTills'] },
];

window.BOILOUT_RULE = {
    anchor: '2026-06-01',
    periodDays: 28,
    oilDump: { time: '21:30', show: ['boiloutOilDump'] },
    boilout: { time: '07:00', show: ['boiloutComplete'] },
};
