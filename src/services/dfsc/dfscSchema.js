/** Daily Food Safety Checklist — question schema (Manual DFSC 2025). */

const DFSC_SECTIONS = [
    { id: 'initialChecks', label: 'Initial Checks', order: 1 },
    { id: 'freezerColdrooms', label: 'Fridge & Freezer', order: 2 },
    { id: 'prepFry', label: 'Cook Temps & Fry', order: 3 },
    { id: 'productionLines', label: 'Production Lines', order: 4 },
    { id: 'other', label: 'Other', order: 5 },
    { id: 'deliveriesTransfers', label: 'Deliveries & Transfers', order: 6 },
    { id: 'actions', label: 'Actions', order: 7 },
    { id: 'signOff', label: 'Sign Off', order: 8 },
];

const SECTION_SKIP_GROUPS = [];

function q(id, section, type, label, opts = {}) {
    return { id, section, type, label, required: opts.required !== false, ...opts };
}

function showWhenAnswerMatches(actual, expected) {
    const options = Array.isArray(expected) ? expected : [expected];
    return options.some((e) => String(actual ?? '').toLowerCase() === String(e).toLowerCase());
}

const FREEZER_INGREDIENT_CHOICES = [
    { value: 'beans', label: 'Beans' },
    { value: 'beef', label: 'Beef' },
    { value: 'chicken', label: 'Chicken' },
    { value: 'chips', label: 'Chips' },
    { value: 'churros', label: 'Churros' },
    { value: 'crispy_chicken', label: 'Crispy Chicken' },
    { value: 'guac', label: 'Guac' },
    { value: 'nacho_chips', label: 'Nacho Chips' },
    { value: 'tortillas', label: 'Tortillas' },
    { value: 'tostadas', label: 'Tostadas' },
];

const COLDROOM_INGREDIENT_CHOICES = [
    { value: 'beef', label: 'Beef' },
    { value: 'coriander', label: 'Coriander' },
    { value: 'guac', label: 'Guac' },
    { value: 'lettuce', label: 'Lettuce' },
    { value: 'onion', label: 'Onion' },
    { value: 'tomato', label: 'Tomato' },
];

const COLDROOM_COUNT_CHOICES = [
    { value: '1', label: '1' },
    { value: '2', label: '2' },
];

const COLDROOM2_VISIBLE = { freezer_twoColdrooms: ['2', 'yes'] };

const HOT_CABINET_INGREDIENT_CHOICES = [
    { value: 'beef', label: 'Beef' },
    { value: 'chicken', label: 'Chicken' },
    { value: 'rice', label: 'Rice' },
    { value: 'nacho_cheese', label: 'Nacho Cheese' },
];

const OIL_TMP_BAND_CHOICES = [
    { value: '0_19.9', label: '0–19.9%', tone: 'green', nc: false },
    { value: '20_22.9', label: '20–22.9%', tone: 'yellow', nc: false },
    { value: '23_plus', label: '23%+', tone: 'red', nc: true },
];

const LINE_COUNT_CHOICES = [
    { value: '1_line', label: '1 line' },
    { value: '2_line_split', label: '2 line (split)' },
    { value: '2_line_shared', label: '2 line (shared)' },
];

const TWO_LINES_VISIBLE = { prodLines_lineCount: ['2_line_split', '2_line_shared'] };
const TWO_LINE_SPLIT_VISIBLE = { prodLines_lineCount: '2_line_split' };

const CRISPY_CHICKEN_LOCATION_CHOICES = [
    { value: 'on_line', label: 'On the Line' },
    { value: 'taco_tower', label: 'Taco Tower' },
];

const UNDERLINE_ING1_CHOICES = [
    { value: 'lettuce', label: 'Lettuce' },
    { value: 'cheese', label: 'Cheese' },
    { value: 'tomatoes', label: 'Tomatoes' },
];

const UNDERLINE_ING2_CHOICES = [
    { value: 'tomato', label: 'Tomato' },
    { value: 'lettuce', label: 'Lettuce' },
    { value: 'cheese', label: 'Cheese' },
];

const UNDERLINE_FRIDGE_VISIBLE = { prodLine1_underlineFridgeInUse: 'yes' };
const UNDERLINE_FRIDGE_LINE2_VISIBLE = { prodLine2_underlineFridgeInUse: 'yes' };
const PREP_FRIDGE_VISIBLE = { prodLine1_prepFridgeInUse: 'yes' };

const FREEZER_TEMP_MAX = -18;
const FRIDGE_TEMP_MAX = 5;
const COOK_TEMP_MIN = 74;
const RICE_COOK_TEMP_MIN = 71;

const FREEZER_TEMP_OPTS = { hint: 'Must be −18°C or colder', tempMax: FREEZER_TEMP_MAX };
const FRIDGE_TEMP_OPTS = { hint: 'Must be 5°C or below', tempMax: FRIDGE_TEMP_MAX };
const HOT_HOLD_TEMP_OPTS = { hint: 'Minimum 74°C', tempMin: COOK_TEMP_MIN };
const RICE_HOT_TEMP_OPTS = { hint: 'Minimum 71°C', tempMin: RICE_COOK_TEMP_MIN };
const CABINET_INGREDIENT_TEMP_HINT = 'Minimum 74°C (71°C for rice)';

const DFSC_QUESTIONS = [
    // ── Initial Checks — Thermometer Calibration ──
    q(
        'init_bluetoothThermo',
        'initialChecks',
        'compliant',
        'Bluetooth thermometer available, in good working order?',
        {
            group: 'Thermometer Calibration',
            iosLabel: 'Do you have 2 thermometers available?',
        }
    ),
    q('init_bluetoothThermoTemp', 'initialChecks', 'temperature', 'Bluetooth Thermometer Calibration Temp to 0°C ( +/-1°C )', {
        group: 'Thermometer Calibration',
        hint: 'Temperature should be between -1°C and 1°C',
        tempMin: -1,
        tempMax: 1,
        hideOnIos: true,
    }),
    q('init_prepThermo', 'initialChecks', 'compliant', 'Prep thermometer available, in good working order?', { group: 'Thermometer Calibration' }),
    q('init_prepThermoTemp', 'initialChecks', 'temperature', 'Prep Thermometer Calibration Temp', {
        group: 'Thermometer Calibration',
        hint: 'Temperature should be between -1°C and 1°C',
        tempMin: -1,
        tempMax: 1,
    }),

    // ── Initial Checks — Carryover ──
    q(
        'init_settingUpBanner',
        'initialChecks',
        'banner',
        '',
        {
            group: 'Carryover',
            required: false,
            bannerTitle: 'CHECK CARRYOVER BEFORE ANYTHING ELSE',
            bannerSubtitle: 'Procedures followed, marked with correct hold times, and temperatures ≤ 5°C?',
        }
    ),
    q('init_beefCarryover', 'initialChecks', 'carryover_temp', 'Is there carryover Beef?', { group: 'Carryover', tempMax: 5 }),
    q('init_chickenCarryover', 'initialChecks', 'carryover_temp', 'Is there carryover Chicken?', { group: 'Carryover', tempMax: 5 }),
    q('init_nachoCarryover', 'initialChecks', 'carryover_temp', 'Is there carryover Nacho Cheese?', { group: 'Carryover', tempMax: 5 }),

    // ── Initial Checks — Washup Sink ──
    q('init_sinkHotWaterTemp', 'initialChecks', 'temperature', '3-compartment sink hot water is a minimum of 49°C. Record the temp.', {
        group: 'Washup Sink',
        hint: 'Min 49°C',
        tempMin: 49,
    }),
    q(
        'init_sinkSetup',
        'initialChecks',
        'ppm_band',
        '3-compartment sink is fully set up, water level clearly marked and sanitiser is at correct concentration (50ppm–100ppm)?',
        {
            group: 'Washup Sink',
            choices: [
                { value: 'lt50', label: '<50', tone: 'red', nc: true },
                { value: '50_100', label: '>50', tone: 'yellow', nc: false },
                { value: '100', label: '100', tone: 'green', nc: false },
                { value: 'gt200', label: '200>', tone: 'red', nc: true },
            ],
        }
    ),
    q(
        'init_sanitiserBuckets',
        'initialChecks',
        'compliant',
        'Sanitiser buckets (and bottles if applicable) are set up at all required stations and held between 50ppm–100ppm and are timed with a 4 hour hold sticker?',
        { group: 'Washup Sink' }
    ),
    q(
        'init_dryingRack',
        'initialChecks',
        'compliant',
        'Does the drying rack meet food safety standards? (wet and dry smallwares and utensils are stored separately)',
        { group: 'Washup Sink' }
    ),

    // ── Initial Checks — Hand Washing Sinks ──
    q(
        'init_handwashAccessible',
        'initialChecks',
        'compliant',
        'Hand washing sinks are accessible and fully stocked (gloves, hand sanitiser, antibacterial soap, paper towels, rubbish bin)?',
        { group: 'Hand Washing Sinks' }
    ),
    q('init_handwashWaterTemp', 'initialChecks', 'temperature', 'Water at hand washing sinks reach a minimum of 30°C? Record the temp.', {
        group: 'Hand Washing Sinks',
        hint: 'Min 30°C',
        tempMin: 30,
    }),
    q(
        'init_handwashClean',
        'initialChecks',
        'compliant',
        'Hand washing sinks are clean, free from build up/mould (check around silicone and drain cover), and are not being used for anything other than handwashing?',
        { group: 'Hand Washing Sinks' }
    ),

    // ── Initial Checks — Setting Up ──
    q(
        'init_pestActivity',
        'initialChecks',
        'compliant',
        'Restaurant is free from pest activity (no evidence of live or dead rodents, insects, droppings, chew marks or nesting)?',
        { group: 'Setting Up' }
    ),
    q(
        'init_tacoTowerHotWaterCup',
        'initialChecks',
        'temperature',
        'Cup of hot water set up in taco tower to be temped at a later stage',
        {
            group: 'Setting Up',
            hint: 'Minimum 49°C',
            tempMin: 49,
        }
    ),
    q(
        'init_walkwaysClear',
        'initialChecks',
        'compliant',
        'There are no obstructions in walkways or in front of emergency exits/back door?',
        { group: 'Setting Up' }
    ),
    q(
        'init_drainsClear',
        'initialChecks',
        'compliant',
        'No sewage back up or build up of any waste in sink and floor drains?',
        { group: 'Setting Up' }
    ),
    q(
        'init_mopBuckets',
        'initialChecks',
        'compliant',
        'When not in use, mop buckets are emptied and cleaned, and mops are hung to dry?',
        { group: 'Setting Up' }
    ),
    q(
        'init_chemicalsStored',
        'initialChecks',
        'compliant',
        'No food is contaminated by chemicals. Chemicals and sanitiser buckets are stored 30cm away from food and packaging and not stored on shelves above food or packaging?',
        { group: 'Setting Up' }
    ),
    q(
        'init_crossContamination',
        'initialChecks',
        'compliant',
        'Food, equipment, smallwares and utensils are free from cross contamination?',
        { group: 'Setting Up' }
    ),
    q(
        'init_gasketsClean',
        'initialChecks',
        'compliant',
        'Gaskets (seals) on fridges/freezers and heated cabinet/s are clean and in good repair?',
        { group: 'Setting Up' }
    ),
    q(
        'init_rubbishBins',
        'initialChecks',
        'compliant',
        'Are rubbish bins & dumpster area clean, well maintained and in good repair?',
        { group: 'Setting Up' }
    ),
    q(
        'init_floorsClean',
        'initialChecks',
        'compliant',
        'Are floors, walls, ceilings and non-food contact surfaces clean and in good repair?',
        { group: 'Setting Up' }
    ),

    // ── Initial Checks — FOH ──
    q(
        'init_bathroomSinksClean',
        'initialChecks',
        'compliant',
        'Bathroom sinks are clean, free from build up/mould (check around silicone and drain cover), and are not being used for anything other than handwashing?',
        { group: 'FOH' }
    ),
    q(
        'init_janitorCupboard',
        'initialChecks',
        'compliant',
        'Janitor cupboard — is all cleaning equipment hanging and stored correctly?',
        { group: 'FOH' }
    ),
    q('init_drinkNozzles', 'initialChecks', 'compliant', 'Drink machine nozzles are cleaned daily and free from mould?', { group: 'FOH' }),

    // ── Fridge & Freezer — Walk-in freezer ──
    q('freezer_walkInTemp', 'freezerColdrooms', 'temperature', 'Walk-in freezer — internal air temp', {
        group: 'Walk-in Freezer',
        ...FREEZER_TEMP_OPTS,
    }),
    q('freezer_ingredient1Item', 'freezerColdrooms', 'select', 'Ingredient 1', {
        group: 'Walk-in Freezer',
        choices: FREEZER_INGREDIENT_CHOICES,
        defaultValue: 'chicken',
    }),
    q('freezer_ingredient1Temp', 'freezerColdrooms', 'temperature', 'Ingredient 1 — temperature', {
        group: 'Walk-in Freezer',
        ...FREEZER_TEMP_OPTS,
    }),
    q('freezer_ingredient2Item', 'freezerColdrooms', 'select', 'Ingredient 2', {
        group: 'Walk-in Freezer',
        choices: FREEZER_INGREDIENT_CHOICES,
        defaultValue: 'beef',
    }),
    q('freezer_ingredient2Temp', 'freezerColdrooms', 'temperature', 'Ingredient 2 — temperature', {
        group: 'Walk-in Freezer',
        ...FREEZER_TEMP_OPTS,
    }),

    q('freezer_twoColdrooms', 'freezerColdrooms', 'yes_no', 'How many cool rooms do you have?', {
        group: 'Walk-in Cold Rooms',
        choices: COLDROOM_COUNT_CHOICES,
    }),

    // ── Fridge & Freezer — Coldroom 1 ──
    q('coldroom1_airTemp', 'freezerColdrooms', 'temperature', 'Coldroom 1 — internal air temp', {
        group: 'Coldroom 1',
        ...FRIDGE_TEMP_OPTS,
    }),
    q('coldroom1_ingredient1Item', 'freezerColdrooms', 'select', 'Ingredient 1', {
        group: 'Coldroom 1',
        choices: COLDROOM_INGREDIENT_CHOICES,
        defaultValue: 'lettuce',
    }),
    q('coldroom1_ingredient1Temp', 'freezerColdrooms', 'temperature', 'Ingredient 1 — temperature', {
        group: 'Coldroom 1',
        ...FRIDGE_TEMP_OPTS,
    }),
    q('coldroom1_ingredient2Item', 'freezerColdrooms', 'select', 'Ingredient 2', {
        group: 'Coldroom 1',
        choices: COLDROOM_INGREDIENT_CHOICES,
        defaultValue: 'tomato',
    }),
    q('coldroom1_ingredient2Temp', 'freezerColdrooms', 'temperature', 'Ingredient 2 — temperature', {
        group: 'Coldroom 1',
        ...FRIDGE_TEMP_OPTS,
    }),
    q(
        'coldroom1_thawedLabelled',
        'freezerColdrooms',
        'compliant',
        'Thawed ingredients are labelled correctly, within hold time and rotated?',
        { group: 'Coldroom 1' }
    ),
    q(
        'coldroom1_preppedLabelled',
        'freezerColdrooms',
        'compliant',
        'Prepped ingredients in the coldroom (fiesta, guac, sauces etc.) are labelled correctly, within hold time and rotated?',
        { group: 'Coldroom 1' }
    ),
    q(
        'coldroom1_openBagsSealed',
        'freezerColdrooms',
        'compliant',
        'Open bags of ingredients are sealed with a clip and marked with an open bag hold time?',
        { group: 'Coldroom 1' }
    ),
    q('coldroom1_lettuceUbd', 'freezerColdrooms', 'date', 'Lettuce — earliest use by / best before', { group: 'Coldroom 1 — dates' }),
    q('coldroom1_tomatoUbd', 'freezerColdrooms', 'date', 'Tomato — earliest use by / best before', { group: 'Coldroom 1 — dates' }),
    q('coldroom1_onionUbd', 'freezerColdrooms', 'date', 'Onion — earliest use by / best before', { group: 'Coldroom 1 — dates' }),
    q('coldroom1_corianderUbd', 'freezerColdrooms', 'date', 'Coriander — earliest use by / best before', { group: 'Coldroom 1 — dates' }),
    q('coldroom1_sourCreamUbd', 'freezerColdrooms', 'datetime', 'Sour Cream — earliest use by / best before', { group: 'Coldroom 1 — dates' }),

    // ── Fridge & Freezer — Coldroom 2 (when 2 coldrooms) ──
    q('coldroom2_airTemp', 'freezerColdrooms', 'temperature', 'Coldroom 2 — internal air temp', {
        group: 'Coldroom 2',
        ...FRIDGE_TEMP_OPTS,
        showWhenAnswer: COLDROOM2_VISIBLE,
    }),
    q('coldroom2_ingredient1Item', 'freezerColdrooms', 'select', 'Ingredient 1', {
        group: 'Coldroom 2',
        choices: COLDROOM_INGREDIENT_CHOICES,
        defaultValue: 'lettuce',
        showWhenAnswer: COLDROOM2_VISIBLE,
    }),
    q('coldroom2_ingredient1Temp', 'freezerColdrooms', 'temperature', 'Ingredient 1 — temperature', {
        group: 'Coldroom 2',
        ...FRIDGE_TEMP_OPTS,
        showWhenAnswer: COLDROOM2_VISIBLE,
    }),
    q('coldroom2_ingredient2Item', 'freezerColdrooms', 'select', 'Ingredient 2', {
        group: 'Coldroom 2',
        choices: COLDROOM_INGREDIENT_CHOICES,
        defaultValue: 'tomato',
        showWhenAnswer: COLDROOM2_VISIBLE,
    }),
    q('coldroom2_ingredient2Temp', 'freezerColdrooms', 'temperature', 'Ingredient 2 — temperature', {
        group: 'Coldroom 2',
        ...FRIDGE_TEMP_OPTS,
        showWhenAnswer: COLDROOM2_VISIBLE,
    }),
    q(
        'coldroom2_thawedLabelled',
        'freezerColdrooms',
        'compliant',
        'Thawed ingredients are labelled correctly, within hold time and rotated?',
        { group: 'Coldroom 2', showWhenAnswer: COLDROOM2_VISIBLE }
    ),

    // ── Cook Temps & Fry — Cook temps ──
    q('prepFry_beefTemp', 'prepFry', 'temperature', 'Beef', { group: 'Cook Temps', ...HOT_HOLD_TEMP_OPTS }),
    q('prepFry_chickenTemp', 'prepFry', 'temperature', 'Chicken', { group: 'Cook Temps', ...HOT_HOLD_TEMP_OPTS }),
    q('prepFry_blackBeansTemp', 'prepFry', 'temperature', 'Black Beans', { group: 'Cook Temps', ...HOT_HOLD_TEMP_OPTS }),
    q('prepFry_nachoCheeseTemp', 'prepFry', 'temperature', 'Nacho Cheese', { group: 'Cook Temps', ...HOT_HOLD_TEMP_OPTS }),
    q('prepFry_riceSeasonedTemp', 'prepFry', 'temperature', 'Rice once seasoned', { group: 'Cook Temps', ...RICE_HOT_TEMP_OPTS }),
    q('prepFry_carryoverBeefTemp', 'prepFry', 'temperature_na', '(If temped cold earlier) Carryover Beef', {
        group: 'Carryover Cook Temps',
        ...HOT_HOLD_TEMP_OPTS,
        hideWhenAnswer: { init_beefCarryover: 'no' },
    }),
    q('prepFry_carryoverChickenTemp', 'prepFry', 'temperature_na', '(If temped cold earlier) Carryover Chicken', {
        group: 'Carryover Cook Temps',
        ...HOT_HOLD_TEMP_OPTS,
        hideWhenAnswer: { init_chickenCarryover: 'no' },
    }),
    q('prepFry_carryoverNachoCheeseTemp', 'prepFry', 'temperature_na', '(If temped cold earlier) Carryover Nacho Cheese', {
        group: 'Carryover Cook Temps',
        ...HOT_HOLD_TEMP_OPTS,
        hideWhenAnswer: { init_nachoCarryover: 'no' },
    }),
    q('prepFry_heatedCabinetTemp', 'prepFry', 'temperature', 'Heated Cabinet', {
        group: 'Heated Cabinet',
        ...RICE_HOT_TEMP_OPTS,
    }),
    q('prepFry_cabinetIngredientsBanner', 'prepFry', 'banner', '', {
        group: 'Heated Cabinet',
        bannerTitle: 'Heated cabinet ingredients',
        bannerSubtitle:
            'Check and record the temperatures of 2 hot ingredients held in the heated cabinet (beef, chicken, rice or nacho cheese)',
    }),
    q('prepFry_proteinInCabinet', 'prepFry', 'yes_no', 'Do you have protein in the cabinet after your first cook?', {
        group: 'Heated Cabinet',
        remindWhenAnswer: 'no',
        remindAfterMinutes: 60,
        remindTitle: 'Heated cabinet — check protein',
        remindBody: 'Reminder: check whether protein should be in the heated cabinet after your first cook.',
    }),
    q('prepFry_cabinetIngredient1Item', 'prepFry', 'select', 'Ingredient 1', {
        group: 'Heated Cabinet',
        choices: HOT_CABINET_INGREDIENT_CHOICES,
        defaultValue: 'beef',
    }),
    q('prepFry_cabinetIngredient1Temp', 'prepFry', 'temperature', 'Ingredient 1 — temperature', {
        group: 'Heated Cabinet',
        hint: CABINET_INGREDIENT_TEMP_HINT,
        tempMinFromSelect: {
            questionId: 'prepFry_cabinetIngredient1Item',
            map: { rice: RICE_COOK_TEMP_MIN },
            defaultMin: COOK_TEMP_MIN,
        },
    }),
    q('prepFry_cabinetIngredient2Item', 'prepFry', 'select', 'Ingredient 2', {
        group: 'Heated Cabinet',
        choices: HOT_CABINET_INGREDIENT_CHOICES,
        defaultValue: 'chicken',
    }),
    q('prepFry_cabinetIngredient2Temp', 'prepFry', 'temperature', 'Ingredient 2 — temperature', {
        group: 'Heated Cabinet',
        hint: CABINET_INGREDIENT_TEMP_HINT,
        tempMinFromSelect: {
            questionId: 'prepFry_cabinetIngredient2Item',
            map: { rice: RICE_COOK_TEMP_MIN },
            defaultMin: COOK_TEMP_MIN,
        },
    }),

    // ── Cook Temps & Fry — Fry station ──
    q('prepFry_oilAmBanner', 'prepFry', 'banner', '', {
        group: 'Fry Station',
        amOnly: true,
        bannerTitle: 'AM Checklist Only',
        bannerSubtitle:
            'Complete oil quality checks with the oil quality tester and record the TMP% for each vat',
    }),
    q('prepFry_oilVat1', 'prepFry', 'ppm_band', 'Vat 1 — TMP%', {
        group: 'Fry Station',
        amOnly: true,
        choices: OIL_TMP_BAND_CHOICES,
    }),
    q('prepFry_oilVat2', 'prepFry', 'ppm_band', 'Vat 2 — TMP%', {
        group: 'Fry Station',
        amOnly: true,
        choices: OIL_TMP_BAND_CHOICES,
    }),
    q('prepFry_oilVat3', 'prepFry', 'ppm_band', 'Vat 3 — TMP%', {
        group: 'Fry Station',
        amOnly: true,
        choices: OIL_TMP_BAND_CHOICES,
    }),
    q('prepFry_fryerTemp', 'prepFry', 'compliant', 'Fryers have a temp reading of 177°C or above?', { group: 'Fry Station' }),
    q('prepFry_fryerClean', 'prepFry', 'compliant', 'Fryers are visibly clean, not smoking, and have been filtered?', {
        group: 'Fry Station',
    }),
    q(
        'prepFry_reachInFreezer',
        'prepFry',
        'compliant',
        'Reach-in freezer is in good working order, free from build up, and the gasket is clean and in good repair?',
        { group: 'Fry Station' }
    ),
    q('prepFry_holdExpiriesBanner', 'prepFry', 'banner', '', {
        group: 'Fry Station — hold times',
        bannerSubtitle: 'Check and record the earliest hold time expiries on the following prepped ingredients:',
    }),
    q('prepFry_tacoShellsExpiry', 'prepFry', 'datetime', 'Taco Shells', { group: 'Fry Station — hold times' }),
    q('prepFry_tostadaExpiry', 'prepFry', 'datetime', 'Tostadas', { group: 'Fry Station — hold times' }),
    q('prepFry_tortillaChipsExpiry', 'prepFry', 'datetime', 'Tortilla Chips', { group: 'Fry Station — hold times' }),
    q('prepFry_cinnyTwistsExpiry', 'prepFry', 'datetime', 'Cinnamon Twists', { group: 'Fry Station — hold times' }),

    // ── Production Lines ──
    q('prodLines_lineCount', 'productionLines', 'segmented', 'How many lines do you have operating today?', {
        choices: LINE_COUNT_CHOICES,
    }),

    // Line 1 — Hot Line
    q('prodLine1_tacoTowerTemp', 'productionLines', 'temperature', 'Taco Tower Temp', {
        group: 'Line 1 — Hot Line',
        hint: 'Minimum 49°C',
        tempMin: 49,
        unlockAfterAnswer: { questionId: 'init_tacoTowerHotWaterCup', minutes: 30 },
    }),
    q('prodLine1_beefTemp', 'productionLines', 'temperature', 'Beef Temp', { group: 'Line 1 — Hot Line', ...HOT_HOLD_TEMP_OPTS }),
    q('prodLine1_chickenTemp', 'productionLines', 'temperature', 'Chicken Temp', { group: 'Line 1 — Hot Line', ...HOT_HOLD_TEMP_OPTS }),
    q('prodLine1_beansTemp', 'productionLines', 'temperature', 'Bean Temp', { group: 'Line 1 — Hot Line', ...HOT_HOLD_TEMP_OPTS }),
    q('prodLine1_riceTemp', 'productionLines', 'temperature', 'Rice Temp', { group: 'Line 1 — Hot Line', ...RICE_HOT_TEMP_OPTS }),
    q('prodLine1_nachoCheeseTemp', 'productionLines', 'temperature', 'Nacho Cheese Temp', { group: 'Line 1 — Hot Line', ...HOT_HOLD_TEMP_OPTS }),
    q('prodLine1_crispyChickenLocation', 'productionLines', 'select', 'Where are you holding crispy chicken strips?', {
        group: 'Line 1 — Hot Line',
        choices: CRISPY_CHICKEN_LOCATION_CHOICES,
        selectPlaceholder: 'Select location',
    }),
    q('prodLine1_crispyChickenLineTemp', 'productionLines', 'temperature', 'Crispy chicken strips — temperature', {
        group: 'Line 1 — Hot Line',
        ...HOT_HOLD_TEMP_OPTS,
        showWhenAnswer: { prodLine1_crispyChickenLocation: 'on_line' },
    }),
    q(
        'prodLine1_crispyChickenTowerInTime',
        'productionLines',
        'compliant',
        'Crispy chicken strips in taco tower — in hold time?',
        { group: 'Line 1 — Hot Line', showWhenAnswer: { prodLine1_crispyChickenLocation: 'taco_tower' } }
    ),
    q(
        'prodLine1_hotHoldChart',
        'productionLines',
        'compliant',
        'Check the hot line hold time chart — there are no expired hold times?',
        { group: 'Line 1 — Hot Line' }
    ),

    // Line 1 — Cold Line
    q('prodLine1_guacTemp', 'productionLines', 'temperature', 'Guac Temp', { group: 'Line 1 — Cold Line', ...FRIDGE_TEMP_OPTS }),
    q('prodLine1_lettuceTemp', 'productionLines', 'temperature', 'Lettuce Temp', { group: 'Line 1 — Cold Line', ...FRIDGE_TEMP_OPTS }),
    q('prodLine1_tomatoesTemp', 'productionLines', 'temperature', 'Tomatoes Temp', { group: 'Line 1 — Cold Line', ...FRIDGE_TEMP_OPTS }),
    q('prodLine1_fiestaTemp', 'productionLines', 'temperature', 'Fiesta Temp', { group: 'Line 1 — Cold Line', ...FRIDGE_TEMP_OPTS }),
    q('prodLine1_cheeseTemp', 'productionLines', 'temperature', 'Cheese Temp', { group: 'Line 1 — Cold Line', ...FRIDGE_TEMP_OPTS }),
    q(
        'prodLine1_coldHoldChart',
        'productionLines',
        'compliant',
        'Check the cold line hold time chart — there are no expired hold times?',
        { group: 'Line 1 — Cold Line' }
    ),
    q(
        'prodLine1_prepHoldStickers',
        'productionLines',
        'compliant',
        'Check the prep hold time stickers of each pan on the line — there are no expired hold times?',
        { group: 'Line 1 — Cold Line' }
    ),

    // Line 1 — Underline fridge
    q('prodLine1_underlineFridgeInUse', 'productionLines', 'yes_no', 'Is the underline fridge in use?', {
        group: 'Line 1 — Underline fridge',
    }),
    q('prodLine1_underlineIngredient1Item', 'productionLines', 'select', 'Ingredient 1', {
        group: 'Line 1 — Underline fridge',
        choices: UNDERLINE_ING1_CHOICES,
        defaultValue: 'lettuce',
        showWhenAnswer: UNDERLINE_FRIDGE_VISIBLE,
    }),
    q('prodLine1_underlineIngredient1Temp', 'productionLines', 'temperature', 'Ingredient 1 — temperature', {
        group: 'Line 1 — Underline fridge',
        ...FRIDGE_TEMP_OPTS,
        showWhenAnswer: UNDERLINE_FRIDGE_VISIBLE,
    }),
    q('prodLine1_underlineIngredient2Item', 'productionLines', 'select', 'Ingredient 2', {
        group: 'Line 1 — Underline fridge',
        choices: UNDERLINE_ING2_CHOICES,
        defaultValue: 'tomato',
        showWhenAnswer: UNDERLINE_FRIDGE_VISIBLE,
    }),
    q('prodLine1_underlineIngredient2Temp', 'productionLines', 'temperature', 'Ingredient 2 — temperature', {
        group: 'Line 1 — Underline fridge',
        ...FRIDGE_TEMP_OPTS,
        showWhenAnswer: UNDERLINE_FRIDGE_VISIBLE,
    }),

    // Line 1 — Free-standing prep fridge
    q('prodLine1_prepFridgeInUse', 'productionLines', 'yes_no', 'Do you have a free standing prep fridge in use?', {
        group: 'Line 1 — Prep fridge',
    }),
    q('prodLine1_prepFridgeGuacTemp', 'productionLines', 'temperature', 'Guac', {
        group: 'Line 1 — Prep fridge',
        ...FRIDGE_TEMP_OPTS,
        showWhenAnswer: PREP_FRIDGE_VISIBLE,
    }),
    q('prodLine1_prepFridgeFiestaTemp', 'productionLines', 'temperature', 'Fiesta', {
        group: 'Line 1 — Prep fridge',
        ...FRIDGE_TEMP_OPTS,
        showWhenAnswer: PREP_FRIDGE_VISIBLE,
    }),
    q(
        'prodLine1_prepFridgeLabelled',
        'productionLines',
        'compliant',
        'Prepped ingredients and open bags are labelled correctly, within hold time and rotated? Open bags are sealed with a clip?',
        { group: 'Line 1 — Prep fridge', showWhenAnswer: PREP_FRIDGE_VISIBLE }
    ),

    // Line 2 — Hot Line (split layout: includes taco tower; shared layout: hot/cold only)
    q('prodLine2_tacoTowerTemp', 'productionLines', 'temperature', 'Taco Tower Temp', {
        group: 'Line 2 — Hot Line',
        hint: 'Minimum 49°C',
        tempMin: 49,
        unlockAfterAnswer: { questionId: 'init_tacoTowerHotWaterCup', minutes: 30 },
        showWhenAnswer: TWO_LINE_SPLIT_VISIBLE,
    }),
    q('prodLine2_beefTemp', 'productionLines', 'temperature', 'Beef Temp', {
        group: 'Line 2 — Hot Line',
        ...HOT_HOLD_TEMP_OPTS,
        showWhenAnswer: TWO_LINES_VISIBLE,
    }),
    q('prodLine2_chickenTemp', 'productionLines', 'temperature', 'Chicken Temp', {
        group: 'Line 2 — Hot Line',
        ...HOT_HOLD_TEMP_OPTS,
        showWhenAnswer: TWO_LINES_VISIBLE,
    }),
    q('prodLine2_beansTemp', 'productionLines', 'temperature', 'Bean Temp', {
        group: 'Line 2 — Hot Line',
        ...HOT_HOLD_TEMP_OPTS,
        showWhenAnswer: TWO_LINES_VISIBLE,
    }),
    q('prodLine2_riceTemp', 'productionLines', 'temperature', 'Rice Temp', {
        group: 'Line 2 — Hot Line',
        ...RICE_HOT_TEMP_OPTS,
        showWhenAnswer: TWO_LINES_VISIBLE,
    }),
    q('prodLine2_nachoCheeseTemp', 'productionLines', 'temperature', 'Nacho Cheese Temp', {
        group: 'Line 2 — Hot Line',
        ...HOT_HOLD_TEMP_OPTS,
        showWhenAnswer: TWO_LINES_VISIBLE,
    }),
    q('prodLine2_crispyChickenLocation', 'productionLines', 'select', 'Where are you holding crispy chicken strips?', {
        group: 'Line 2 — Hot Line',
        choices: CRISPY_CHICKEN_LOCATION_CHOICES,
        selectPlaceholder: 'Select location',
        showWhenAnswer: TWO_LINES_VISIBLE,
    }),
    q('prodLine2_crispyChickenLineTemp', 'productionLines', 'temperature', 'Crispy chicken strips — temperature', {
        group: 'Line 2 — Hot Line',
        ...HOT_HOLD_TEMP_OPTS,
        showWhenAnswer: { prodLine2_crispyChickenLocation: 'on_line', ...TWO_LINES_VISIBLE },
    }),
    q(
        'prodLine2_crispyChickenTowerInTime',
        'productionLines',
        'compliant',
        'Crispy chicken strips in taco tower — in hold time?',
        {
            group: 'Line 2 — Hot Line',
            showWhenAnswer: { prodLine2_crispyChickenLocation: 'taco_tower', ...TWO_LINES_VISIBLE },
        }
    ),
    q(
        'prodLine2_hotHoldChart',
        'productionLines',
        'compliant',
        'Check the hot line hold time chart — there are no expired hold times?',
        { group: 'Line 2 — Hot Line', showWhenAnswer: TWO_LINES_VISIBLE }
    ),

    // Line 2 — Cold Line
    q('prodLine2_guacTemp', 'productionLines', 'temperature', 'Guac Temp', {
        group: 'Line 2 — Cold Line',
        ...FRIDGE_TEMP_OPTS,
        showWhenAnswer: TWO_LINES_VISIBLE,
    }),
    q('prodLine2_lettuceTemp', 'productionLines', 'temperature', 'Lettuce Temp', {
        group: 'Line 2 — Cold Line',
        ...FRIDGE_TEMP_OPTS,
        showWhenAnswer: TWO_LINES_VISIBLE,
    }),
    q('prodLine2_tomatoesTemp', 'productionLines', 'temperature', 'Tomatoes Temp', {
        group: 'Line 2 — Cold Line',
        ...FRIDGE_TEMP_OPTS,
        showWhenAnswer: TWO_LINES_VISIBLE,
    }),
    q('prodLine2_fiestaTemp', 'productionLines', 'temperature', 'Fiesta Temp', {
        group: 'Line 2 — Cold Line',
        ...FRIDGE_TEMP_OPTS,
        showWhenAnswer: TWO_LINES_VISIBLE,
    }),
    q('prodLine2_cheeseTemp', 'productionLines', 'temperature', 'Cheese Temp', {
        group: 'Line 2 — Cold Line',
        ...FRIDGE_TEMP_OPTS,
        showWhenAnswer: TWO_LINES_VISIBLE,
    }),
    q(
        'prodLine2_coldHoldChart',
        'productionLines',
        'compliant',
        'Check the cold line hold time chart — there are no expired hold times?',
        { group: 'Line 2 — Cold Line', showWhenAnswer: TWO_LINES_VISIBLE }
    ),
    q(
        'prodLine2_prepHoldStickers',
        'productionLines',
        'compliant',
        'Check the prep hold time stickers of each pan on the line — there are no expired hold times?',
        { group: 'Line 2 — Cold Line', showWhenAnswer: TWO_LINES_VISIBLE }
    ),

    // Line 2 — Underline fridge (split layout only)
    q('prodLine2_underlineFridgeInUse', 'productionLines', 'yes_no', 'Is the underline fridge in use?', {
        group: 'Line 2 — Underline fridge',
        showWhenAnswer: TWO_LINE_SPLIT_VISIBLE,
    }),
    q('prodLine2_underlineIngredient1Item', 'productionLines', 'select', 'Ingredient 1', {
        group: 'Line 2 — Underline fridge',
        choices: UNDERLINE_ING1_CHOICES,
        defaultValue: 'lettuce',
        showWhenAnswer: { ...TWO_LINE_SPLIT_VISIBLE, ...UNDERLINE_FRIDGE_LINE2_VISIBLE },
    }),
    q('prodLine2_underlineIngredient1Temp', 'productionLines', 'temperature', 'Ingredient 1 — temperature', {
        group: 'Line 2 — Underline fridge',
        ...FRIDGE_TEMP_OPTS,
        showWhenAnswer: { ...TWO_LINE_SPLIT_VISIBLE, ...UNDERLINE_FRIDGE_LINE2_VISIBLE },
    }),
    q('prodLine2_underlineIngredient2Item', 'productionLines', 'select', 'Ingredient 2', {
        group: 'Line 2 — Underline fridge',
        choices: UNDERLINE_ING2_CHOICES,
        defaultValue: 'tomato',
        showWhenAnswer: { ...TWO_LINE_SPLIT_VISIBLE, ...UNDERLINE_FRIDGE_LINE2_VISIBLE },
    }),
    q('prodLine2_underlineIngredient2Temp', 'productionLines', 'temperature', 'Ingredient 2 — temperature', {
        group: 'Line 2 — Underline fridge',
        ...FRIDGE_TEMP_OPTS,
        showWhenAnswer: { ...TWO_LINE_SPLIT_VISIBLE, ...UNDERLINE_FRIDGE_LINE2_VISIBLE },
    }),

    // ── Other ──
    q(
        'other_chocSauce',
        'other',
        'compliant',
        'Prepped chocolate sauce dipping cups and opened bottle/s of chocolate sauce are marked correctly and within hold time?'
    ),
    q(
        'other_mexSeasoning',
        'other',
        'compliant',
        'Containers and opened bags of mex seasoning, cinnamon sugar and cinny twists are marked correctly and within hold time?'
    ),
    q(
        'other_tortillas',
        'other',
        'compliant',
        'Thawed tortillas and flatbreads are labelled correctly, within hold time and rotated?'
    ),
    q(
        'other_drinksFridge',
        'other',
        'compliant',
        'All drinks stored in the display fridge/reach-in drinks fridge are in date?',
        { hint: 'Double check iced coffees' }
    ),
    q(
        'other_fcbSyrupExpiry',
        'other',
        'compliant',
        'Check the FCB syrup expiry dates on each box — are they within date?'
    ),
    q(
        'other_postMixSyrupExpiry',
        'other',
        'compliant',
        'Check the Post Mix syrup expiry dates on each box — are they within date?'
    ),

    // ── Deliveries & Transfers ──
    q('deliveries_cutFresh', 'deliveriesTransfers', 'received', 'Cut Fresh/PM Fresh'),
    q('deliveries_bega', 'deliveriesTransfers', 'received', 'Bega'),
    q('deliveries_americoldChilled', 'deliveriesTransfers', 'received', 'Americold/Sands'),
    q('deliveries_americoldFrozen', 'deliveriesTransfers', 'received', 'Americold/Sands Frozen'),
    q('deliveries_transfersReceived', 'deliveriesTransfers', 'yes_no', 'Did you receive any refrigerated transfers?'),
    q('deliveries_transferFreezerTemp', 'deliveriesTransfers', 'temperature', 'Stock Transfers — Freezer', {
        group: 'Stock Transfers',
        ...FREEZER_TEMP_OPTS,
        showWhenAnswer: { deliveries_transfersReceived: 'yes' },
    }),
    q('deliveries_transferFridgeTemp', 'deliveriesTransfers', 'temperature', 'Stock Transfers — Fridge', {
        group: 'Stock Transfers',
        ...FRIDGE_TEMP_OPTS,
        showWhenAnswer: { deliveries_transfersReceived: 'yes' },
    }),
];

const QUESTION_BY_ID = new Map(DFSC_QUESTIONS.map((item) => [item.id, item]));

function getSections() {
    return DFSC_SECTIONS.slice();
}

function getSectionSkipGroups() {
    return SECTION_SKIP_GROUPS.slice();
}

function getQuestions() {
    return DFSC_QUESTIONS.slice();
}

function getQuestionById(id) {
    return QUESTION_BY_ID.get(id) || null;
}

function getQuestionsForSection(sectionId) {
    return DFSC_QUESTIONS.filter((item) => item.section === sectionId);
}

function isCompliantType(type) {
    return type === 'compliant' || type === 'compliant_na';
}

function parseTempAnswer(value) {
    const raw = String(value ?? '').trim();
    if (!raw || raw.toLowerCase() === 'na') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

function getEffectiveTempMin(question, session) {
    if (!question) return null;
    if (question.tempMinFromSelect) {
        const cfg = question.tempMinFromSelect;
        const item = String(session?.answers?.[cfg.questionId] ?? '').toLowerCase();
        if (item && cfg.map?.[item] != null) return cfg.map[item];
        if (cfg.defaultMin != null) return cfg.defaultMin;
    }
    return question.tempMin ?? null;
}

function isTempRangeNonCompliant(question, value, session = null) {
    if (!question) return false;
    if (question.type === 'carryover_temp') {
        if (String(value).toLowerCase() === 'no') return false;
        const temp = parseTempAnswer(value);
        if (temp === null) return false;
        const max = question.tempMax ?? FRIDGE_TEMP_MAX;
        if (temp > max) return true;
        const tempMin = getEffectiveTempMin(question, session);
        if (tempMin != null && temp < tempMin) return true;
        return false;
    }
    if (question.type !== 'temperature' && question.type !== 'temperature_na') return false;
    const tempMin = getEffectiveTempMin(question, session);
    const tempMax = question.tempMax ?? null;
    if (tempMin == null && tempMax == null) return false;
    const temp = parseTempAnswer(value);
    if (temp === null) return false;
    if (tempMin != null && temp < tempMin) return true;
    if (tempMax != null && temp > tempMax) return true;
    return false;
}

function isNotCompliantValue(value, question = null, session = null) {
    if (question?.type === 'ppm_band') {
        const choice = (question.choices || []).find((c) => c.value === String(value));
        return Boolean(choice?.nc);
    }
    if (isTempRangeNonCompliant(question, value, session)) return true;
    return String(value || '').toLowerCase() === 'not_compliant';
}

function effectiveChoiceValue(question, value) {
    let effective = String(value ?? '').trim();
    if (effective === '' && (question.type === 'select' || question.type === 'segmented')) {
        effective = String(question.defaultValue ?? '').trim();
    }
    return effective;
}

function isAnswerEmpty(question, value) {
    if (question.type === 'banner') return false;
    if (value === null || value === undefined) return true;
    if (question.type === 'yes_no') {
        if (question.choices?.length) {
            return !(question.choices || []).some((c) => c.value === String(value));
        }
        return value !== 'yes' && value !== 'no';
    }
    if (question.type === 'received') return value !== 'received' && value !== 'not_received';
    if (question.type === 'carryover_temp') {
        if (String(value).toLowerCase() === 'no') return false;
        return String(value).trim() === '';
    }
    if (question.type === 'ppm_band') {
        return !(question.choices || []).some((c) => c.value === String(value));
    }
    if (isCompliantType(question.type)) {
        const v = String(value).toLowerCase();
        return v !== 'compliant' && v !== 'not_compliant' && v !== 'na';
    }
    if (question.type === 'temperature_na' || question.type === 'text_na') {
        if (String(value).toLowerCase() === 'na') return false;
    }
    if (question.type === 'select' || question.type === 'segmented') {
        const effective = effectiveChoiceValue(question, value);
        if (effective === '') return true;
        return !(question.choices || []).some((c) => c.value === effective);
    }
    if (typeof value === 'string') return value.trim() === '';
    return false;
}

function isIosClient(session) {
    const ua = String(session?.clientMeta?.userAgent || '');
    if (/iPhone|iPad|iPod/i.test(ua)) return true;
    return session?.clientMeta?.platform === 'ios';
}

function isQuestionVisible(question, session) {
    if (question.hideOnIos && isIosClient(session)) return false;
    if (question.amOnly && session.shift !== 'AM') return false;
    if (question.skipGroup && (session.sectionSkips || []).includes(question.skipGroup)) return false;
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
    if (question.unlockAfterAnswer && !isTimeGateOpen(question, session)) return false;
    return true;
}

function isAnswerTimestampTrigger(question, value) {
    if (value === '' || value == null || value === undefined) return false;
    if (question.type === 'carryover_temp' && String(value).toLowerCase() === 'no') return false;
    if (question.type === 'temperature' || question.type === 'temperature_na' || question.type === 'carryover_temp') {
        return parseTempAnswer(value) != null;
    }
    return !isAnswerEmpty(question, value);
}

function getTimeGateDelayMinutes(question) {
    if (question.unlockAfterAnswer?.minutes != null) return question.unlockAfterAnswer.minutes;
    if (question.unlockAfterMinutes != null) return question.unlockAfterMinutes;
    return null;
}

function getTimeGateAnchorMs(question, session) {
    if (question.unlockAfterAnswer) {
        const { questionId } = question.unlockAfterAnswer;
        const triggerQ = getQuestionById(questionId);
        const triggerVal = session.answers?.[questionId];
        if (!triggerQ || !isAnswerTimestampTrigger(triggerQ, triggerVal)) return null;
        const stamped = Date.parse(session.answerTimestamps?.[questionId] || '');
        if (Number.isFinite(stamped)) return stamped;
        const fallback = Date.parse(session.updatedAt || session.startedAt || '');
        return Number.isFinite(fallback) ? fallback : null;
    }
    if (question.unlockAfterMinutes != null) {
        const started = Date.parse(session.startedAt || '');
        return Number.isFinite(started) ? started : null;
    }
    return null;
}

function applyAnswerTimestamp(session, questionId, value, now = Date.now()) {
    if (!session) return;
    session.answerTimestamps = session.answerTimestamps || {};
    const question = getQuestionById(questionId);
    if (!question) return;
    if (isAnswerTimestampTrigger(question, value)) {
        if (!session.answerTimestamps[questionId]) {
            session.answerTimestamps[questionId] = new Date(now).toISOString();
        }
        return;
    }
    delete session.answerTimestamps[questionId];
}

function isTimeGateOpen(question, session, now = Date.now()) {
    const delayMinutes = getTimeGateDelayMinutes(question);
    if (delayMinutes == null) return true;
    const anchor = getTimeGateAnchorMs(question, session);
    if (!Number.isFinite(anchor)) return false;
    return now >= anchor + delayMinutes * 60 * 1000;
}

function getVisibleQuestions(session, sectionId) {
    return getQuestionsForSection(sectionId).filter((q) => isQuestionVisible(q, session));
}

function getActionEntry(session, questionId) {
    const raw = session?.actions?.[questionId];
    if (!raw) return { text: '', submittedAt: null };
    if (typeof raw === 'string') return { text: raw.trim(), submittedAt: null };
    return {
        text: String(raw.text || '').trim(),
        submittedAt: raw.submittedAt || null,
    };
}

function isActionSubmitted(session, questionId) {
    const entry = getActionEntry(session, questionId);
    return Boolean(entry.submittedAt && entry.text);
}

function normalizeActionUpdate(incoming, existingRaw) {
    let prev = { text: '', submittedAt: null };
    if (typeof existingRaw === 'string') {
        prev = { text: existingRaw.trim(), submittedAt: null };
    } else if (existingRaw && typeof existingRaw === 'object') {
        prev = {
            text: String(existingRaw.text || '').trim(),
            submittedAt: existingRaw.submittedAt || null,
        };
    }
    if (typeof incoming === 'string') {
        return { text: incoming.trim(), submittedAt: prev.submittedAt };
    }
    if (!incoming || typeof incoming !== 'object') {
        return prev;
    }
    const text = String(incoming.text ?? prev.text ?? '').trim();
    const submittedAt = incoming.submittedAt !== undefined ? incoming.submittedAt || null : prev.submittedAt;
    return { text, submittedAt };
}

function collectNonCompliant(session) {
    const out = [];
    for (const question of DFSC_QUESTIONS) {
        if (!isQuestionVisible(question, session)) continue;
        const value = session.answers?.[question.id];
        if (!isNotCompliantValue(value, question, session)) continue;
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

function validateSection(session, sectionId, now = Date.now()) {
    if (sectionId === 'actions') {
        const nc = collectNonCompliant(session);
        for (const row of nc) {
            if (!row.actionSubmitted) {
                return { ok: false, error: `Submit an action for: ${row.label}` };
            }
        }
        return { ok: true };
    }
    if (sectionId === 'signOff') {
        if (!String(session.signOff?.name || '').trim()) {
            return { ok: false, error: 'Manager name is required.' };
        }
        if (!String(session.signOff?.signatureDataUrl || '').trim()) {
            return { ok: false, error: 'Sign-off signature is required.' };
        }
        return { ok: true };
    }

    const questions = getVisibleQuestions(session, sectionId);
    for (const question of questions) {
        const value = session.answers?.[question.id];
        if (question.required && isAnswerEmpty(question, value)) {
            return { ok: false, error: `Answer required: ${question.label}` };
        }
        if (!isTimeGateOpen(question, session, now) && !isAnswerEmpty(question, value)) {
            return { ok: false, error: `${question.label} is not yet available.` };
        }
    }
    return { ok: true };
}

function validateSessionComplete(session, now = Date.now()) {
    for (const section of DFSC_SECTIONS) {
        if (section.id === 'actions' || section.id === 'signOff') continue;
        const result = validateSection(session, section.id, now);
        if (!result.ok) return result;
    }
    const actionsResult = validateSection(session, 'actions', now);
    if (!actionsResult.ok) return actionsResult;
    return validateSection(session, 'signOff', now);
}

function buildSchemaPayload() {
    return {
        sections: getSections(),
        sectionSkipGroups: getSectionSkipGroups(),
        questions: getQuestions(),
    };
}

module.exports = {
    DFSC_SECTIONS,
    SECTION_SKIP_GROUPS,
    DFSC_QUESTIONS,
    getSections,
    getSectionSkipGroups,
    getQuestions,
    getQuestionById,
    getQuestionsForSection,
    getVisibleQuestions,
    isCompliantType,
    isNotCompliantValue,
    isTempRangeNonCompliant,
    getEffectiveTempMin,
    parseTempAnswer,
    isAnswerEmpty,
    isQuestionVisible,
    isTimeGateOpen,
    getTimeGateAnchorMs,
    getTimeGateDelayMinutes,
    isAnswerTimestampTrigger,
    applyAnswerTimestamp,
    getActionEntry,
    isActionSubmitted,
    normalizeActionUpdate,
    collectNonCompliant,
    validateSection,
    validateSessionComplete,
    buildSchemaPayload,
};
