/* ============================================================
   POPUP CONTENT - names, instructions, icons

   Each entry:
   • key - short id used in popup-timing.js schedule (e.g. fryCheck)
   • name - big heading on the card
   • instruction - smaller text under it
   • icon - must match a name in window.iconMap below
   ============================================================ */

window.iconMap = window.iconMap || {
    Clean: '/assets/Sprites/Clean.png',
    Close: '/assets/Sprites/Close.png',
    'Front Counter': '/assets/Sprites/Front%20Counter.png',
    Fry: '/assets/Sprites/Fry2.png',
    Toilets: '/assets/Sprites/Toilets.png',
};

window.NOTIFICATION_CONTENT = {
    // BOILOUTS (see BOILOUT_RULE in popup-timing.js)
    boiloutOilDump: {
        name: 'Dump the oil (boilout prep)',
        instruction: 'Dump the oil tonightfor boilout, tomorrow is the scheduled boilout.',
        icon: 'Fry',
    },
    boiloutComplete: {
        name: 'Complete a boilout',
        instruction: 'Complete the scheduled fryer boilout for this period.',
        icon: 'Fry',
    },

    // COOKS
    '845AM': { name: 'Cook', instruction: 'Put down cook, and set the timer for 45 minutes', icon: 'Clean' },
    '1030AM': { name: 'Cook', instruction: 'Put down cook, and set the timer for 45 minutes', icon: 'Clean' },
    '2PM': { name: 'Cook', instruction: 'Put down cook, and set the timer for 45 minutes', icon: 'Clean' },
    '330PM': { name: 'Cook', instruction: 'Put down cook, and set the timer for 45 minutes', icon: 'Clean' },
    '8PM': { name: 'Cook', instruction: 'Put down cook, and set the timer for 45 minutes', icon: 'Clean' },

    // RESTOCK
    stockUpUnderlineFridge: {
        name: 'Stock Up Underline Fridge',
        instruction: 'Stock up the underline fridge with enough products to last the shift following the ubild to',
        icon: 'Clean',
    },
    stockUpDeserts: {
        name: 'Stock Up Deserts',
        instruction: 'Build to enough Choc and Caramel Sauce for the shift',
        icon: 'Clean',
    },

    // OPEN
    safeCount: { name: 'Safe Count', instruction: 'Count the safe and ensure the count is correct', icon: 'Clean' },
    AMStockCount: { name: 'Morning Stock Count', instruction: 'Count the stock and share count in group chat', icon: 'Clean' },
    recieveOrders: { name: 'Recieve Orders', instruction: 'Recieve orders in MMX', icon: 'Clean' },
    completeFryPrep: {
        name: 'Complete Fry Prep',
        instruction: 'Complete fry prep for the day, ensuring all ingredients are ready for the day',
        icon: 'Clean',
    },
    completeSaladPrep: {
        name: 'Complete Salad Prep',
        instruction: 'Complete salad prep for the day, ensuring all ingredients are ready for the day',
        icon: 'Clean',
    },
    checkToilets: { name: 'Check Toilets', instruction: 'Check the toilets and ensure they are clean and stocked', icon: 'Clean' },
    stockUpPaperStockOnLine: {
        name: 'Stock Up Paper Stock On Line',
        instruction: 'Stock up the paper stock on the line, ensuring there is enough takeaway bags, chip bags, cups, lids, wraps and boxes for the day',
        icon: 'Clean',
    },
    thawing: { name: 'Thawing', instruction: 'Check the thawing guide and confirm if more thawing is needed', icon: 'Clean' },

    // CHANGEOVER
    changeUtensils: {
        name: 'Change Utensils',
        instruction: 'Gather up the clean utensiles and then change over and remove the in use utensils from the line, replacing them as you go with the new clean ones',
        icon: 'Clean',
    },
    changeoverSafeCount: { name: 'Changeover Safe Count', instruction: 'Count the safe with the closing MIC and ensure the count is correct', icon: 'Clean' },
    changeoverTills: { name: 'Change Over Tills', instruction: 'Change over tills and deposit money into safe', icon: 'Close' },
    changeSink: {
        name: 'Change Sink',
        instruction: 'Check with MIC first, then clear all dishes from the sink, drain it and refill using 2 packets of powersoak detergent and sanitiser powder',
        icon: 'Clean',
    },
    changeBuckets: {
        name: 'Changeover Buckets',
        instruction: 'Change buckets, ensuring the sink has been drained and refilled with fersh sanitiser water',
        icon: 'Clean',
    },
    changeoverStockCount: { name: 'Changeover Stock Count', instruction: 'Count the stock and share count in group chat', icon: 'Clean' },

    // CLOSE
    cleanToilets: { name: 'Clean and stock Toilets', instruction: 'Clean and stock Toilets', icon: 'Toilets' },
    diningBins: { name: 'Dining room bins', instruction: 'Empty, clean and reline dining room bins', icon: 'Clean' },
    patioBins: { name: 'Patio bins', instruction: 'Empty, clean and reline patio bins', icon: 'Clean' },
    removeBins: {
        name: 'Remove and clean bins',
        instruction: 'Remove and clean inside and outside of bins, then allow them to air dry. Leave 1 bin for the line and one 1 for washup, bins should be relined once they are dry',
        icon: 'Clean',
    },
    smallVats: {
        name: 'Begin shutting down 2 small fry vats',
        instruction: 'Complete a full daily filter on all 3 vats and shut fown the 2 smaller vats, leaving the largest vat running. make sure a full scrub vat, wash, rinse and full polish is completed before moving on to the next vat. While waiting for the vats to filter, use degreaser to clean the front of the fryer',
        icon: 'Fry',
    },
    hotLine: {
        name: 'Clean Hot Line (KEEPING PRODUCTS HOT!!!)',
        instruction: 'Clean the hot line well by well by shifting the pans back on row and then replacing them once complete, pans should NEVER be left on the bench!!!',
        icon: 'Clean',
    },
    filterPan: {
        name: 'Last fry filter',
        instruction: 'Ensure there are enough chips to make orders for 5 minutes before completing an express filter on the large vat, once that is complete, allow filter pan to cool before carefully removing the filter pan and taking it to washup to be cleaned and left to dry',
        icon: 'Fry',
    },
    removeExtras: {
        name: 'Remove any EXTRAs from line',
        instruction: 'Nothing that impacts speed should be removed, only holders for cantina bowls, dipping cups and lids, wrappers, chip bag holders, scale insert, underline fridge and containers',
        icon: 'Clean',
    },
    DTBench: {
        name: 'Clean DT bench',
        instruction: 'Remove tray and items from bench to clean underneath them and then put back, if tray is dirty consider replacing it with a new clean one and leaving the old one at washup',
        icon: 'Clean',
    },
    prepBench: {
        name: 'Clean Prep Bench',
        instruction: 'Unplug and move the rice cooker to clean under it, check if the seasoning, sugar and rice tub are clean, if not clean them and leave to air dry',
        icon: 'Clean',
    },
    fryBench: {
        name: 'Clean Fry Bench',
        instruction: "Use degreaser to clean the fry bench, don't neglect the rails that hold the baskets or the shelf that holds nacho chips",
        icon: 'Fry',
    },
    cleanFloors: {
        name: 'Begin cleaning floors',
        instruction: 'Clean all floors except in use line, make sure to clean under shelves, benches, equipement (Drink machines, Fryer, Retherm) and the line',
        icon: 'Clean',
    },
    drains: { name: 'Clean drains', instruction: 'Remove drains from wherever you have mopped, remove any buildup from underneath the catchers', icon: 'Clean' },
    setupCarryover: {
        name: 'Setup Carryover Sink',
        instruction: 'Sink should be filled 3/4 of the way with just ice, water will be added to it later in the night',
        icon: 'Clean',
    },
    cleanRetherm: {
        name: 'Clean Retherm',
        instruction: 'Drain and clean inside the retherm following the standard card, once the inside has been cleaned, close the lids and valves and clean the outside of the retherm',
        icon: 'Clean',
    },
    removeStickers: {
        name: 'MIC - Remove Stickers',
        instruction: 'Remove Stickers of anything that is going to before open tomorrow, typically stickers that have hold times of 24 hours or less',
        icon: 'Close',
    },
    wipePrepGuide: {
        name: 'MIC - Wipe off Prep Guide',
        instruction: 'Use Grafitti cleaner to remove sharpie, then use either degreaser, glass cleaner or hand sanitizer to remove residue',
        icon: 'Close',
    },
    wipeTREDPoster: {
        name: 'MIC - Wipe off TRED Poster',
        instruction: 'Use Grafitti cleaner to remove sharpie, then use either degreaser, glass cleaner or hand sanitizer to remove residue',
        icon: 'Close',
    },
    mopDining: {
        name: 'Mop dining room',
        instruction: 'Clean dining room using the green mop and bucket, use multiple bucket loads if your water is turning grey. REMINDER: make sure the mop is properly wrung out before using it to avoid flooding the floor',
        icon: 'Clean',
    },
    carryoverPan: {
        name: 'Setup Carryover pan',
        instruction: 'Setup Carryover pan, line it with enough bags for your expected carryover, a full pan of chicken= 2 bags, beef = 3, nacho = 2',
        icon: 'Clean',
    },
    carryoverFirstRound: {
        name: 'First Round of Carryover',
        instruction: 'Check with MIC if there are any ingredients that can be carried over, ensuring there is enough product to last the night, if there are any issues, inform MIC and they will handle it',
        icon: 'Clean',
    },
    chipDump: {
        name: 'Clean Chip Dump',
        instruction: 'Remove all chips and peices from the inside chip dump, inclusing the grill on the top of the dump',
        icon: 'Clean',
    },
    coldLine: {
        name: 'Clean cold line',
        instruction: 'Clean cold line, items should only be removed from the cold line for a short period of time to avoid them warming up and becoming unsafe to eat',
        icon: 'Clean',
    },
    remainingFloors: {
        name: 'Clean floors',
        instruction: 'Clean remaining floors that were missed during the night',
        icon: 'Clean',
    },
    stockCount: {
        name: 'MIC -Complete Stock Count',
        instruction: 'While completing your count remove any half opened boxes, after completing count, investigate any red variances',
        icon: 'Close',
    },
    countSafe: {
        name: 'MIC - Count safe',
        instruction: "MIC - Stock up tills to ensure you don't need to swap around any money at the end of the night and then Count safe",
        icon: 'Close',
    },
    bigGrillFirstAlert: {
        name: 'MIC - Switch off Big Grill',
        instruction: 'Turn off the big grill, and allow to cool for 20 minutes',
        icon: 'Close',
    },
    bigGrillSecondAlert: {
        name: 'MIC - Clean Big Grill',
        instruction: 'Put on PPE and begin cleaning the big grill, ensuring that you are pouring chemicals on the scrubber not directly on the grill. remember clean the entire grill,the chemical is heat activated and takes time to heat up and remove build up.',
        icon: 'Close',
    },
    drinkNozzles: {
        name: 'Drink Nozzles',
        instruction: 'Get a bucket of clean sanitiser water, collect all the drink nozzles and place them in the bucket, then clean the nozzles with the sanitiser water before laying them out on cloths',
        icon: 'Close',
    },
    remainingBins: {
        name: 'Remove Bins',
        instruction: 'Remove remaining bins cleaned them and allow them to airdry and relined dry bins',
        icon: 'Clean',
    },
    carryover: {
        name: 'Carryover',
        instruction: 'Complete remaining carryover, keeping products hot in the hotline until they are being carried over',
        icon: 'Clean',
    },
    cleanOutSpotSweeps: {
        name: 'Clean spot sweeps',
        instruction: 'Disassemble and clean out spot sweeps and leave them to air dry',
        icon: 'Clean',
    },
    checkThawing: {
        name: 'Check if more thawing is needed',
        instruction: 'Check thwaing guide and confirm if more thawing is needed',
        icon: 'Clean',
    },
    organiseFreezer: {
        name: 'Organise Freezer',
        instruction: 'Organise freezer stock, removing any expired products and organising the stock correctly',
        icon: 'Clean',
    },
    printReports: { name: 'MIC- print reports', instruction: 'Print Daily Roster and Prep Guide', icon: 'Clean' },
    shutDownTills: { name: 'MIC - Shut down tills', instruction: 'Close tills and deposit money into safe for the night', icon: 'Clean' },
};
