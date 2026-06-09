const app = document.getElementById('app');
const pathMatch = window.location.pathname.match(/\/(teststore|\d{3,6})\/stock-count\/([a-z0-9-]+)/i);
const STORE_NUMBER = pathMatch ? pathMatch[1].toLowerCase() : '';
const VENDOR_SLUG = pathMatch ? pathMatch[2] : '';
const IS_COMBINED = VENDOR_SLUG === 'combined';

let catalog = null;
let draft = null;
let combinedVendorSlugs = [];
let vendorDrafts = {};
let queueStatus = null;
let currentLocationIndex = 0;
let viewMode = 'entry';
let mmxSessionId = '';
let mmxVariances = [];
let mmxVendorSlugs = [];
let recountCatalog = null;
let recountDrafts = {};
let varianceDrafts = {};
let vendorCatalogsCache = new Map();
let statusMessage = '';
let statusKind = '';
let saving = false;
let autoSaveTimer = null;
let processing = false;
let processingStageLabel = 'Preparing MMX';
let mmxNotifyEnabled = false;
let mmxNotifyDenied = false;
let mmxProcessingError = null;
let mmxProcessingSuccess = null;
let mmxProcessingComplete = false;
let mmxProcessingStepId = 'save';
let mmxProcessingDetail = '';
let mmxLastPipelineStep = '';
let mmxPipelineManualOnly = false;
let mmxActivityLog = [];
let mmxLastKnownServerInProgress = false;
let mmxPollInFlight = null;

const MMX_UI_WATCH_KEY = 'stockCountMmxUiWatch';
const MMX_UI_WATCH_MAX_MS = 15 * 60 * 1000;
const MMX_PIPELINE_POLL_MS = 2000;
const MMX_PIPELINE_MAX_MS = 55 * 60 * 1000;
const MMX_PIPELINE_NETWORK_GRACE_POLLS = 200;
const MMX_IN_PROGRESS_STAGES = new Set([
    'preparing',
    'prepared',
    'applying',
    'applied-orders-pending',
    'downloading-reports',
    'filling-orders',
]);

const MMX_PIPELINE_STEPS = [
    { id: 'save', label: 'Saving your counts' },
    { id: 'open-kic', label: 'Opening Key Item Count' },
    { id: 'fill-locations', label: 'Entering counts by location' },
    { id: 'variances', label: 'Checking variances' },
    { id: 'apply', label: 'Applying count' },
    { id: 'reports', label: 'Downloading stock reports' },
    { id: 'orders', label: 'Placing scheduled orders' },
];

/** Build-to reports downloaded before scheduled orders (Macromatix Report Selection). */
const MMX_BUILD_TO_REPORTS = [
    { key: 'stock on hand', label: 'Stock On Hand', detail: 'SCM — Items On Hand (Flat), Excel' },
    { key: 'stock on order', label: 'Stock On Order', detail: 'SCM — Items On Order (Flat), Excel' },
    {
        key: 'inventory special',
        label: 'Inventory Special Event',
        detail: 'Store Reports — CSV (13-day usage)',
    },
];

function dashboardPath() {
    if (!STORE_NUMBER) return '/';
    return `/${STORE_NUMBER}`;
}

function apiQuery(base, vendorSlug = VENDOR_SLUG, options = {}) {
    const sep = base.includes('?') ? '&' : '?';
    const params = new URLSearchParams();
    params.set('store', STORE_NUMBER);
    params.set('vendor', vendorSlug);
    if (options.fullCatalog) params.set('full', '1');
    const qs = params.toString();
    return `${window.location.origin}${base}${base.includes('?') ? '&' : '?'}${qs}`;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    const res = await fetch(url, { ...options, headers, credentials: 'include' });
    const text = await res.text();
    if (!text) return { res, data: {} };
    try {
        return { res, data: JSON.parse(text) };
    } catch {
        if (/^<!DOCTYPE/i.test(text) || /^<html/i.test(text)) {
            if (res.status === 401 || res.status === 403) {
                throw new Error('Session expired — refresh the page and log in again.');
            }
            if (res.status === 404) {
                throw new Error('Dashboard API not found — restart the server (pm2 restart dashboard).');
            }
            throw new Error('Server returned a page instead of JSON — log in again or restart the dashboard.');
        }
        throw new Error(`Invalid server response (HTTP ${res.status}).`);
    }
}

function buildLocalQueueStatus() {
    if (isCombinedMode()) {
        const queue = combinedVendorSlugs.map((slug) => {
            const vendorDraft = vendorDrafts[slug] || {};
            const cat = vendorCatalogsCache.get(slug);
            return {
                slug,
                label: cat?.label || slug,
                submittedAt: vendorDraft.submittedAt || null,
                mmxSentAt: vendorDraft.mmxSentAt || null,
            };
        });
        const submitted = queue.filter((entry) => entry.submittedAt);
        return {
            success: true,
            queue,
            canSendToMmx: submitted.length > 0,
            allMmxSent: submitted.length > 0 && submitted.every((entry) => entry.mmxSentAt),
            readyToSend: submitted.filter((entry) => !entry.mmxSentAt).map((entry) => entry.label),
        };
    }
    const submitted = Boolean(draft?.submittedAt || draft?.mmxSentAt);
    return {
        success: true,
        queue: [
            {
                slug: VENDOR_SLUG,
                label: catalog?.label || VENDOR_SLUG,
                submittedAt: draft?.submittedAt || (draft?.mmxSentAt ? draft.updatedAt : null),
                mmxSentAt: draft?.mmxSentAt || null,
            },
        ],
        canSendToMmx: submitted,
        allMmxSent: Boolean(draft?.mmxSentAt),
        readyToSend: submitted ? [catalog?.label || VENDOR_SLUG] : [],
    };
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function isMmxSent() {
    if (isCombinedMode()) {
        const slugs = combinedVendorSlugs.length ? combinedVendorSlugs : Object.keys(vendorDrafts);
        return slugs.length > 0 && slugs.every((slug) => Boolean(vendorDrafts[slug]?.mmxSentAt));
    }
    return Boolean(draft?.mmxSentAt);
}

function isSubmitted() {
    if (isCombinedMode()) {
        const slugs = combinedVendorSlugs.length ? combinedVendorSlugs : Object.keys(vendorDrafts);
        return (
            slugs.some((slug) => Boolean(vendorDrafts[slug]?.submittedAt)) &&
            !isMmxSent()
        );
    }
    return Boolean(draft?.submittedAt) && !isMmxSent();
}

function isCombinedMode() {
    return IS_COMBINED;
}

function itemSourceSlug(item) {
    return item?.sourceVendorSlug || VENDOR_SLUG;
}

function itemCatalogKey(item) {
    return item?.catalogKey || item.key;
}

function draftForVendor(slug) {
    if (isCombinedMode()) return vendorDrafts[slug] || null;
    if (slug === VENDOR_SLUG) return draft;
    return recountDrafts[slug] || varianceDrafts[slug] || null;
}

function vendorHasCountableData() {
    if (isCombinedMode()) {
        return combinedVendorSlugs.some((slug) => {
            const vendorDraft = vendorDrafts[slug];
            if (!vendorDraft?.locations) return false;
            return Object.values(vendorDraft.locations).some(
                (items) =>
                    items &&
                    typeof items === 'object' &&
                    Object.values(items).some(
                        (counts) =>
                            counts &&
                            typeof counts === 'object' &&
                            Object.values(counts).some((n) => Number(n) > 0)
                    )
            );
        });
    }
    if (!catalog || !draft?.locations) return false;
    return Object.values(draft.locations).some(
        (items) =>
            items &&
            typeof items === 'object' &&
            Object.values(items).some(
                (counts) =>
                    counts &&
                    typeof counts === 'object' &&
                    Object.values(counts).some((n) => Number(n) > 0)
            )
    );
}

function currentLocationHasFormData() {
    return Object.keys(readFormValues()).length > 0;
}

function canShowSendToMmx() {
    if (vendorHasCountableData() || currentLocationHasFormData()) return true;
    return Boolean(queueStatus?.canSendToMmx);
}

async function loadQueueStatus() {
    try {
        const { res, data } = await fetchJson(apiQuery('/api/stock-count/queue-status'));
        if (res.status === 404) {
            queueStatus = buildLocalQueueStatus();
            return queueStatus;
        }
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Failed to load vendor queue.');
        }
        queueStatus = data;
        return data;
    } catch (error) {
        if (/Dashboard API not found|restart the server/i.test(error.message)) {
            queueStatus = buildLocalQueueStatus();
            return queueStatus;
        }
        throw error;
    }
}

function setStatus(message, kind = '') {
    statusMessage = message;
    statusKind = kind;
    render();
}

function getActiveCatalog() {
    if (viewMode === 'recount' && recountCatalog) return recountCatalog;
    return catalog;
}

function getItemsForLocation(locationName) {
    const cat = getActiveCatalog();
    if (!cat) return [];
    return cat.items.filter((item) => item.locations.includes(locationName));
}

/** Location tabs that have at least one item (excludes empty Schweppes Bottles/Cans/Other). */
function getVisibleLocationTabs(cat = getActiveCatalog()) {
    if (!cat?.locations?.length) return [];
    return cat.locations.filter((loc) =>
        cat.items.some((item) => (item.locations || []).includes(loc))
    );
}

function getCurrentLocationName(cat = getActiveCatalog()) {
    const visible = getVisibleLocationTabs(cat);
    if (visible.length) return visible[currentLocationIndex] || visible[0];
    return cat?.locations?.[currentLocationIndex] || '';
}

function normalizeItemCode(code) {
    return String(code || '')
        .trim()
        .toUpperCase()
        .replace(/^0+/, '');
}

function normalizeItemName(name) {
    return String(name || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

async function loadVendorCatalogsForSlugs(slugs, options = {}) {
    const unique = [...new Set(slugs.filter(Boolean))];
    await Promise.all(
        unique.map(async (slug) => {
            const cacheKey = options.fullCatalog ? `${slug}:full` : slug;
            if (vendorCatalogsCache.has(cacheKey)) {
                if (!vendorCatalogsCache.has(slug)) {
                    vendorCatalogsCache.set(slug, vendorCatalogsCache.get(cacheKey));
                }
                return;
            }
            const { res, data } = await fetchJson(
                apiQuery('/api/stock-count/catalog', slug, { fullCatalog: Boolean(options.fullCatalog) })
            );
            if (res.ok && data.success) {
                vendorCatalogsCache.set(cacheKey, data.catalog);
                vendorCatalogsCache.set(slug, data.catalog);
            }
        })
    );
}

function productNameWithoutSize(name) {
    return normalizeItemName(name)
        .replace(/\b(\d+(?:\.\d+)?)\s*(kg|g|l|ml|lb|oz|ltr|litres?|liters?)\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function getDraftsBySlugForMatching() {
    const out = {};
    for (const slug of [...new Set([VENDOR_SLUG, ...mmxVendorSlugs])]) {
        if (slug === VENDOR_SLUG && draft?.locations) out[slug] = draft;
        else if (varianceDrafts[slug]?.locations) out[slug] = varianceDrafts[slug];
        else if (recountDrafts[slug]?.locations) out[slug] = recountDrafts[slug];
    }
    return out;
}

function findCatalogItemInCatalog(catalogsBySlug, vendorSlug, catalogKey) {
    if (!vendorSlug || !catalogKey) return null;
    const vendorCatalog = catalogsBySlug.get(vendorSlug);
    return vendorCatalog?.items?.find((item) => item.key === catalogKey) || null;
}

function draftCountsToMmxSlotValues(catalogItem, counts) {
    const slots = resolveUnitSlots(catalogItem);
    const out = [null, null, null];
    let mmxIdx = 0;
    for (const slot of slots.slice(0, 3)) {
        if (mmxIdx >= 3) break;
        if (!slot.na && slot.key) {
            const val = counts?.[slot.key];
            if (val != null && val !== '' && Number.isFinite(Number(val))) {
                out[mmxIdx] = Number(val);
            }
        }
        mmxIdx++;
    }
    return out;
}

function scoreVarianceToDraftCounts(variance, catalogItem, draft) {
    if (!draft?.locations || !catalogItem) return 0;
    const vSlots = [
        parseClosingValue(variance.closingBox),
        parseClosingValue(variance.closingInner),
        parseClosingValue(variance.closingUnit),
    ];
    let best = 0;
    for (const loc of Object.values(draft.locations)) {
        const counts = loc?.[catalogItem.key];
        if (!counts) continue;
        const dSlots = draftCountsToMmxSlotValues(catalogItem, counts);
        let score = 0;
        let comparisons = 0;
        for (let i = 0; i < 3; i++) {
            const vVal = vSlots[i];
            const dVal = dSlots[i];
            if (vVal == null && dVal == null) continue;
            if (vVal != null && dVal != null) {
                comparisons++;
                if (Math.abs(Number(vVal) - Number(dVal)) < 0.015) score += 50;
                else score -= 20;
            }
        }
        if (comparisons && score > best) best = score;
    }
    const code = normalizeItemCode(variance.itemCode);
    if (code && normalizeItemCode(catalogItem.itemCode) === code) best += 30;
    return best;
}

function findBestCatalogMatchByClosingValues(variance, catalogsBySlug, draftsBySlug) {
    let best = null;
    let bestSlug = null;
    let bestScore = 0;

    for (const [slug, vendorCatalog] of catalogsBySlug) {
        const draft = draftsBySlug?.[slug];
        if (!draft?.locations) continue;
        for (const item of vendorCatalog.items || []) {
            if (!draftHasCountsForItem(draft, item.key)) continue;
            const score = scoreVarianceToDraftCounts(variance, item, draft);
            if (score > bestScore) {
                bestScore = score;
                best = item;
                bestSlug = slug;
            }
        }
    }

    return bestScore >= 45 ? { item: best, slug: bestSlug } : null;
}

function buildCatalogsBySlugForVarianceMatch() {
    const slugs = mmxVendorSlugs.length ? mmxVendorSlugs : [VENDOR_SLUG];
    const catalogsBySlug = new Map();
    for (const slug of [...new Set([VENDOR_SLUG, ...slugs])]) {
        const vendorCatalog = vendorCatalogsCache.get(slug) || (slug === VENDOR_SLUG ? catalog : null);
        if (vendorCatalog) catalogsBySlug.set(slug, vendorCatalog);
    }
    return catalogsBySlug;
}

function resolveVarianceCatalogMatch(variance) {
    const matcher = globalThis.VarianceCatalogMatch;
    if (!matcher) return null;
    return matcher.resolveVarianceCatalogMatch(variance, buildCatalogsBySlugForVarianceMatch());
}

function findCatalogItemForVarianceAcrossVendors(variance) {
    return resolveVarianceCatalogMatch(variance)?.item || null;
}

function extractProductSizeKey(name) {
    const n = normalizeItemName(name);
    const m = n.match(/(\d+(?:\.\d+)?)\s*(kg|g|l|ml|lb|oz|ltr|litres?|liters?)\b/);
    return m ? `${m[1]}${m[2]}` : '';
}

function nameMatchScore(varianceName, itemName) {
    const v = normalizeItemName(varianceName);
    const i = normalizeItemName(itemName);
    if (!v || !i) return 0;
    if (v === i) return 100;

    const vSize = extractProductSizeKey(varianceName);
    const iSize = extractProductSizeKey(itemName);
    if (vSize && iSize && vSize !== iSize) return 0;

    if (v.includes(i) || i.includes(v)) {
        return vSize && iSize ? 95 : 80;
    }

    const vTokens = v.split(/\s+/).filter((token) => token.length > 1);
    const iTokens = i.split(/\s+/).filter((token) => token.length > 1);
    let score = 0;
    for (const vt of vTokens) {
        for (const it of iTokens) {
            if (vt === it) score += 20;
            else if (vt.includes(it) || it.includes(vt)) score += 10;
        }
    }
    if (vSize && iSize && vSize === iSize) score += 40;
    return score;
}

function draftHasCountsForItem(draft, itemKey) {
    if (!draft?.locations) return false;
    for (const loc of Object.values(draft.locations)) {
        if (countsHaveValues(loc?.[itemKey])) return true;
    }
    return false;
}

function pickDraftWhenMmxCodeWrong(codeItem, itemsWithDraft) {
    const codeFamily = productNameWithoutSize(codeItem.name);
    const sameFamily = itemsWithDraft.filter((item) => productNameWithoutSize(item.name) === codeFamily);
    if (sameFamily.length === 1) return sameFamily[0];
    return null;
}

function findBestCatalogMatchFromDrafts(variance, catalogsBySlug, draftsBySlug) {
    let overallBest = null;
    let overallBestSlug = null;
    let overallBestScore = 0;
    const code = normalizeItemCode(variance.itemCode);

    for (const [slug, vendorCatalog] of catalogsBySlug) {
        const draft = draftsBySlug?.[slug];
        if (!draft?.locations) continue;

        const itemsWithDraft = (vendorCatalog.items || []).filter((item) =>
            draftHasCountsForItem(draft, item.key)
        );
        if (!itemsWithDraft.length) continue;

        if (code) {
            const codeWithDraft = itemsWithDraft.find((item) => normalizeItemCode(item.itemCode) === code);
            if (codeWithDraft) return { item: codeWithDraft, slug };
        }

        for (const item of itemsWithDraft) {
            const score = nameMatchScore(variance.itemName, item.name);
            if (score > overallBestScore) {
                overallBestScore = score;
                overallBest = item;
                overallBestSlug = slug;
            }
        }

        if (code) {
            const codeItem = vendorCatalog.items.find((item) => normalizeItemCode(item.itemCode) === code);
            const codeHasDraft = codeItem && draftHasCountsForItem(draft, codeItem.key);
            if (codeItem && !codeHasDraft) {
                const closingPick = findBestCatalogMatchByClosingValues(
                    variance,
                    new Map([[slug, vendorCatalog]]),
                    draftsBySlug
                );
                if (closingPick?.item) return closingPick;

                if (
                    itemsWithDraft.length === 1 &&
                    scoreVarianceToDraftCounts(variance, itemsWithDraft[0], draft) >= 45
                ) {
                    return { item: itemsWithDraft[0], slug };
                }
                const familyPick = pickDraftWhenMmxCodeWrong(codeItem, itemsWithDraft);
                if (familyPick) return { item: familyPick, slug };
            }
        }

        if (itemsWithDraft.length === 1 && overallBestScore < 30) {
            const only = itemsWithDraft[0];
            if (scoreVarianceToDraftCounts(variance, only, draft) >= 45) {
                return { item: only, slug };
            }
        }
    }

    return overallBestScore >= 30 ? { item: overallBest, slug: overallBestSlug } : null;
}

function findCatalogItemForVariance(variance, vendorCatalog) {
    if (!vendorCatalog?.items?.length) return null;
    const code = normalizeItemCode(variance.itemCode);
    if (code) {
        const byCode = vendorCatalog.items.find((item) => normalizeItemCode(item.itemCode) === code);
        if (byCode) return byCode;
    }
    const varianceName = normalizeItemName(variance.itemName);
    if (!varianceName) return null;

    let best = null;
    let bestScore = 0;
    for (const item of vendorCatalog.items) {
        const score = nameMatchScore(variance.itemName, item.name);
        if (score > bestScore) {
            bestScore = score;
            best = item;
        }
    }
    return bestScore >= 30 ? best : null;
}

function findBestCatalogMatchForVariance(variance, catalogsBySlug) {
    let best = null;
    let bestSlug = null;
    let bestScore = 0;
    for (const [slug, vendorCatalog] of catalogsBySlug) {
        const item = findCatalogItemForVariance(variance, vendorCatalog);
        if (!item) continue;
        const codeBoost =
            normalizeItemCode(variance.itemCode) &&
            normalizeItemCode(variance.itemCode) === normalizeItemCode(item.itemCode)
                ? 100
                : 0;
        const score = nameMatchScore(variance.itemName, item.name) + codeBoost;
        if (score > bestScore) {
            bestScore = score;
            best = item;
            bestSlug = slug;
        }
    }
    return best ? { item: best, slug: bestSlug } : null;
}

function recountLocationOrder() {
    const ordered = [];
    const seen = new Set();
    const push = (loc) => {
        const name = String(loc || '').trim();
        if (!name || seen.has(name)) return;
        seen.add(name);
        ordered.push(name);
    };

    const addCatalog = (cat) => {
        if (!cat) return;
        for (const loc of cat.locations || cat.locationOrder || []) push(loc);
    };

    addCatalog(catalog);
    for (const slug of mmxVendorSlugs.length ? mmxVendorSlugs : [VENDOR_SLUG]) {
        addCatalog(vendorCatalogsCache.get(slug));
    }
    const active = getActiveCatalog();
    addCatalog(active);
    for (const item of active?.items || []) {
        for (const loc of item.locations || []) push(loc);
    }

    return ordered.length ? ordered : ['Default'];
}

function defaultRecountLocations() {
    return recountLocationOrder();
}

function fallbackLocationForUnmatched() {
    return defaultRecountLocations()[0] || 'Default';
}

function parseClosingValue(raw) {
    if (raw == null || raw === '' || raw === '—' || raw === '-') return null;
    const n = Number(String(raw).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : null;
}

function inferUnitSlotsFromVariance(variance) {
    const box = parseClosingValue(variance.closingBox);
    const inner = parseClosingValue(variance.closingInner);
    const unit = parseClosingValue(variance.closingUnit);
    return [
        { key: box != null ? 'box' : null, label: 'Box', na: box == null },
        { key: inner != null ? 'bag' : null, label: 'Inner', na: inner == null },
        { key: unit != null ? 'kg' : null, label: 'Unit', na: unit == null },
    ];
}

function mapVarianceClosingToCounts(item, variance) {
    const counts = {};
    const slots = resolveUnitSlots(item);
    const values = [variance.closingBox, variance.closingInner, variance.closingUnit];
    slots.forEach((slot, idx) => {
        if (slot.na || !slot.key) return;
        const n = parseClosingValue(values[idx]);
        if (n != null && n >= 0) counts[slot.key] = n;
    });
    return counts;
}

function countsHaveValues(counts) {
    return (
        counts &&
        typeof counts === 'object' &&
        Object.values(counts).some((n) => Number(n) > 0 || n === 0)
    );
}

function getRecountItemCounts(item, locationName) {
    const slug = itemSourceSlug(item);
    const itemKey = itemCatalogKey(item);
    const vendorDraft = draftForVendor(slug);
    const draftCounts = vendorDraft?.locations?.[locationName]?.[itemKey];
    if (draftCounts && typeof draftCounts === 'object') return draftCounts;
    return {};
}

function readRecountFormValuesForLocation(locationName) {
    const grouped = {};
    for (const item of getItemsForLocation(locationName)) {
        const slug = item.sourceVendorSlug || VENDOR_SLUG;
        const row = {};
        for (const col of item.columns) {
            const input = document.querySelector(`input[data-item="${item.key}"][data-col="${col.key}"]`);
            if (!input) continue;
            const raw = String(input.value || '').trim();
            if (!raw) continue;
            const n = Number(raw);
            if (Number.isFinite(n) && n >= 0) row[col.key] = n;
        }
        if (!Object.keys(row).length) continue;
        if (!grouped[slug]) grouped[slug] = {};
        grouped[slug][item.key] = row;
    }
    return grouped;
}

function mergeRecountLocations(_items) {
    return recountLocationOrder();
}

async function loadVendorCatalogAndDraft(slug) {
    const [catResult, draftResult] = await Promise.all([
        fetchJson(apiQuery('/api/stock-count/catalog', slug)),
        fetchJson(apiQuery('/api/stock-count/draft', slug)),
    ]);
    if (!catResult.res.ok || !catResult.data.success) {
        throw new Error(catResult.data.error || `Catalog not found for ${slug}.`);
    }
    if (!draftResult.res.ok || !draftResult.data.success) {
        throw new Error(draftResult.data.error || `Draft not found for ${slug}.`);
    }
    return { catalog: catResult.data.catalog, draft: draftResult.data };
}

async function loadAllVendorCatalogsForRecount(slugs) {
    const unique = [...new Set([VENDOR_SLUG, ...slugs.filter(Boolean)])];
    const catalogsBySlug = new Map();
    recountDrafts = {};

    for (const slug of unique) {
        const loaded = await loadVendorCatalogAndDraft(slug);
        catalogsBySlug.set(slug, loaded.catalog);
        recountDrafts[slug] = loaded.draft;
        vendorCatalogsCache.set(slug, loaded.catalog);
    }

    return catalogsBySlug;
}

async function buildRecountCatalog() {
    const slugs = mmxVendorSlugs.length ? mmxVendorSlugs : [VENDOR_SLUG];
    const catalogsBySlug = await loadAllVendorCatalogsForRecount(slugs);
    const matchedItems = [];
    const seenVarianceKeys = new Set();

    for (const variance of mmxVariances) {
        const varianceKey =
            normalizeItemCode(variance.itemCode) || normalizeItemName(variance.itemName);
        if (varianceKey && seenVarianceKeys.has(varianceKey)) continue;
        if (varianceKey) seenVarianceKeys.add(varianceKey);

        const match = resolveVarianceCatalogMatch(variance);
        if (match) {
            matchedItems.push({
                ...match.item,
                variance,
                sourceVendorSlug: match.slug,
            });
            continue;
        }

        const unitSlots = inferUnitSlotsFromVariance(variance);
        const fallbackLocation = fallbackLocationForUnmatched();
        matchedItems.push({
            key: `var-${varianceKey || matchedItems.length}`,
            itemCode: variance.itemCode || '',
            name: variance.itemName || variance.itemCode || 'Unknown item',
            columns: unitSlots
                .filter((slot) => !slot.na && slot.key)
                .map((slot) => ({ key: slot.key, label: slot.label })),
            unitSlots,
            locations: [fallbackLocation],
            variance,
            sourceVendorSlug: VENDOR_SLUG,
            unmatched: true,
        });
    }

    recountCatalog = {
        label: 'Recount red variances',
        locations: mergeRecountLocations(matchedItems),
        items: matchedItems,
    };
    currentLocationIndex = 0;
}

function locationHasData(locationName) {
    if (viewMode === 'recount' || isCombinedMode()) {
        return getItemsForLocation(locationName).some((item) => {
            const counts = getRecountItemCounts(item, locationName);
            return countsHaveValues(counts);
        });
    }
    const loc = draft?.locations?.[locationName];
    if (!loc || typeof loc !== 'object') return false;
    const itemKeys = new Set(getItemsForLocation(locationName).map((i) => i.key));
    return Object.entries(loc).some(
        ([key, counts]) =>
            itemKeys.has(key) &&
            counts &&
            typeof counts === 'object' &&
            Object.values(counts).some((n) => Number(n) > 0)
    );
}

function readFormValuesGroupedByVendor(locationName) {
    const grouped = {};
    for (const item of getItemsForLocation(locationName)) {
        const slug = itemSourceSlug(item);
        const itemKey = itemCatalogKey(item);
        const row = {};
        for (const col of item.columns) {
            const input = document.querySelector(
                `input[data-item="${CSS.escape(item.key)}"][data-col="${CSS.escape(col.key)}"]`
            );
            if (!input) continue;
            const raw = String(input.value || '').trim();
            if (!raw) continue;
            const n = Number(raw);
            if (Number.isFinite(n) && n >= 0) row[col.key] = n;
        }
        if (!Object.keys(row).length) continue;
        if (!grouped[slug]) grouped[slug] = {};
        grouped[slug][itemKey] = row;
    }
    return grouped;
}

function readFormValues() {
    if (isCombinedMode() || viewMode === 'recount') {
        const cat = getActiveCatalog();
        if (!cat) return {};
        const grouped = readFormValuesGroupedByVendor(getCurrentLocationName(cat));
        return grouped[VENDOR_SLUG] || {};
    }
    const values = {};
    const cat = getActiveCatalog();
    if (!cat) return values;
    const locationName = getCurrentLocationName(cat);
    for (const item of getItemsForLocation(locationName)) {
        const row = {};
        for (const col of item.columns) {
            const input = document.querySelector(
                `input[data-item="${CSS.escape(item.key)}"][data-col="${CSS.escape(col.key)}"]`
            );
            if (!input) continue;
            const raw = String(input.value || '').trim();
            if (!raw) continue;
            const n = Number(raw);
            if (Number.isFinite(n) && n >= 0) row[col.key] = n;
        }
        if (Object.keys(row).length) values[item.key] = row;
    }
    return values;
}

function fillFormFromDraft(locationName) {
    const cat = getActiveCatalog();
    if (!cat) return;
    if (viewMode === 'recount' || isCombinedMode()) {
        for (const item of getItemsForLocation(locationName)) {
            const counts = getRecountItemCounts(item, locationName);
            for (const col of item.columns) {
                const input = document.querySelector(
                    `input[data-item="${CSS.escape(item.key)}"][data-col="${CSS.escape(col.key)}"]`
                );
                if (!input) continue;
                const v = counts[col.key];
                input.value = v != null && Number(v) >= 0 ? String(v) : '';
            }
        }
        return;
    }
    const loc = draft?.locations?.[locationName] || {};
    for (const item of getItemsForLocation(locationName)) {
        const counts = loc[item.key] || {};
        for (const col of item.columns) {
            const input = document.querySelector(`input[data-item="${item.key}"][data-col="${col.key}"]`);
            if (!input) continue;
            const v = counts[col.key];
            input.value = v != null && Number(v) >= 0 ? String(v) : '';
        }
    }
}

async function saveCurrentLocation(showFeedback = true, options = {}) {
    const cat = getActiveCatalog();
    if (!cat) return false;
    if (saving && !options.force) return false;
    const locationName = getCurrentLocationName(cat);
    const manageSavingFlag = !options.force;
    if (manageSavingFlag) saving = true;
    try {
        if (viewMode === 'recount' || isCombinedMode()) {
            const grouped = isCombinedMode()
                ? readFormValuesGroupedByVendor(locationName)
                : readRecountFormValuesForLocation(locationName);
            const slugs = Object.keys(grouped);
            if (!slugs.length) {
                return true;
            }
            for (const slug of slugs) {
                const { res, data } = await fetchJson(apiQuery('/api/stock-count/draft', slug), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        location: locationName,
                        items: grouped[slug],
                        merge: isCombinedMode(),
                    }),
                });
                if (!res.ok || !data.success) {
                    throw new Error(data.error || `Failed to save counts for ${slug}.`);
                }
                if (isCombinedMode()) vendorDrafts[slug] = data;
                else recountDrafts[slug] = data;
                if (slug === VENDOR_SLUG) draft = data;
            }
            if (showFeedback) setStatus(`Saved ${locationName}.`, 'success');
            return true;
        }

        const { res, data } = await fetchJson(apiQuery('/api/stock-count/draft'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ location: locationName, items: readFormValues() }),
        });
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Failed to save counts.');
        }
        draft = data;
        if (showFeedback) setStatus(`Saved ${locationName}.`, 'success');
        return true;
    } catch (error) {
        if (showFeedback || options.force) setStatus(error.message || 'Save failed.', 'error');
        return false;
    } finally {
        if (manageSavingFlag) saving = false;
    }
}

async function saveAllCombinedLocations() {
    const cat = getActiveCatalog();
    if (!cat || !isCombinedMode()) {
        return saveCurrentLocation(false, { force: true });
    }
    const prevIndex = currentLocationIndex;
    let ok = true;
    if (!(await saveCurrentLocation(false, { force: true }))) ok = false;
    const tabs = getVisibleLocationTabs(cat);
    for (let i = 0; i < tabs.length; i++) {
        if (i === prevIndex) continue;
        currentLocationIndex = i;
        render();
        if (!(await saveCurrentLocation(false, { force: true }))) ok = false;
    }
    currentLocationIndex = prevIndex;
    render();
    return ok;
}

function vendorSlugsAtLocation(locationName) {
    const cat = getActiveCatalog();
    if (!cat) return [VENDOR_SLUG];
    if (!isCombinedMode() && viewMode !== 'recount') return [VENDOR_SLUG];
    const slugs = new Set();
    for (const item of cat.items) {
        if (!item.locations.includes(locationName)) continue;
        slugs.add(itemSourceSlug(item));
    }
    return [...slugs];
}

function clearLocationInputsDom(locationName) {
    for (const item of getItemsForLocation(locationName)) {
        for (const col of item.columns) {
            const input = document.querySelector(
                `input[data-item="${CSS.escape(item.key)}"][data-col="${CSS.escape(col.key)}"]`
            );
            if (input) input.value = '';
        }
    }
}

async function persistClearLocationDraft(locationName) {
    for (const slug of vendorSlugsAtLocation(locationName)) {
        const { res, data } = await fetchJson(apiQuery('/api/stock-count/draft', slug), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ location: locationName, items: {} }),
        });
        if (!res.ok || !data.success) {
            throw new Error(data.error || `Failed to clear counts for ${locationName}.`);
        }
        if (isCombinedMode()) vendorDrafts[slug] = data;
        if (viewMode === 'recount') {
            recountDrafts[slug] = data;
            varianceDrafts[slug] = data;
        }
        if (slug === VENDOR_SLUG) draft = data;
    }
}

function scheduleAutoSave() {
    if (viewMode === 'variances' || processing || saving) return;
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
        autoSaveTimer = null;
        void saveCurrentLocation(false, { force: true });
    }, 700);
}

async function clearCurrentLocationPage() {
    if (saving || processing) return;
    const cat = getActiveCatalog();
    if (!cat) return;
    const locationName = getCurrentLocationName(cat);
    if (!locationHasData(locationName) && !currentLocationHasFormData()) {
        setStatus('Nothing to clear on this tab.', '');
        return;
    }
    if (!window.confirm(`Clear all counts on ${locationName}?`)) return;
    if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
    }
    saving = true;
    setStatus('', '');
    try {
        clearLocationInputsDom(locationName);
        await persistClearLocationDraft(locationName);
        setStatus(`Cleared ${locationName}.`, 'success');
    } catch (error) {
        setStatus(error.message || 'Clear failed.', 'error');
    } finally {
        saving = false;
        render();
    }
}

async function saveAllRecountLocations() {
    const cat = getActiveCatalog();
    if (!cat || viewMode !== 'recount') {
        return saveCurrentLocation(false, { force: true });
    }
    const prevIndex = currentLocationIndex;
    let ok = true;

    // Save the visible tab first — render() runs fillFormFromDraft and would wipe unsaved edits.
    if (!(await saveCurrentLocation(false, { force: true }))) ok = false;

    const tabs = getVisibleLocationTabs(cat);
    for (let i = 0; i < tabs.length; i++) {
        if (i === prevIndex) continue;
        currentLocationIndex = i;
        render();
        if (!(await saveCurrentLocation(false, { force: true }))) ok = false;
    }

    currentLocationIndex = prevIndex;
    render();
    varianceDrafts = { ...varianceDrafts, ...recountDrafts };
    return ok;
}

async function resubmitAllVendorsForMmx() {
    const slugs = mmxVendorSlugs.length ? [...new Set(mmxVendorSlugs)] : [VENDOR_SLUG];
    for (const slug of slugs) {
        const { res, data } = await fetchJson(apiQuery('/api/stock-count/submit', slug), { method: 'POST' });
        if (!res.ok || !data.success) {
            throw new Error(data.error || `Submit failed for ${slug}.`);
        }
        if (slug === VENDOR_SLUG) draft = data;
    }
    await loadQueueStatus();
}

async function saveAndSubmitVendor() {
    if (isCombinedMode()) {
        const ok = await saveAllCombinedLocations();
        if (!ok && currentLocationHasFormData()) {
            throw new Error('Could not save your counts — check the values and try again.');
        }
        if (!vendorHasCountableData() && !currentLocationHasFormData()) return false;
        if (isSubmitted()) {
            await loadQueueStatus();
            return true;
        }
        const { res, data } = await fetchJson(apiQuery('/api/stock-count/submit', 'combined'), {
            method: 'POST',
        });
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Save failed.');
        }
        for (const row of data.submitted || []) {
            const slug = row?.vendorSlug;
            if (!slug) continue;
            vendorDrafts[slug] = { ...vendorDrafts[slug], ...row };
        }
        await loadQueueStatus();
        return true;
    }

    const ok = await saveCurrentLocation(false, { force: true });
    if (!ok && currentLocationHasFormData()) {
        throw new Error('Could not save your counts — check the values and try again.');
    }
    if (!ok && !draft?.locations && !currentLocationHasFormData()) return false;
    if (!vendorHasCountableData() && !currentLocationHasFormData()) return false;

    if (draft?.submittedAt) {
        await loadQueueStatus();
        return true;
    }

    const { res, data } = await fetchJson(apiQuery('/api/stock-count/submit'), { method: 'POST' });
    if (!res.ok || !data.success) {
        throw new Error(data.error || 'Save failed.');
    }
    draft = data;
    await loadQueueStatus();
    return true;
}

function pushMmxActivity(label) {
    const text = String(label || '').trim();
    if (!text) return;
    const last = mmxActivityLog[mmxActivityLog.length - 1];
    if (last?.text === text) return;
    mmxActivityLog.push({ text, at: Date.now() });
    if (mmxActivityLog.length > 40) mmxActivityLog.shift();
}

function pushMmxActivityOnce(label) {
    const text = String(label || '').trim();
    if (!text || mmxActivityLog.some((entry) => entry.text === text)) return;
    pushMmxActivity(text);
}

function readMmxUiWatch() {
    try {
        const raw = sessionStorage.getItem(MMX_UI_WATCH_KEY);
        if (!raw) return null;
        const watch = JSON.parse(raw);
        if (String(watch.store) !== String(STORE_NUMBER)) return null;
        if (Date.now() - Number(watch.at || 0) > MMX_UI_WATCH_MAX_MS) return null;
        return watch;
    } catch {
        return null;
    }
}

function startMmxUiWatch() {
    try {
        sessionStorage.setItem(
            MMX_UI_WATCH_KEY,
            JSON.stringify({ store: STORE_NUMBER, vendor: VENDOR_SLUG, at: Date.now() })
        );
    } catch {
        /* ignore */
    }
    window.StockCountNotify?.setWatch?.(STORE_NUMBER, VENDOR_SLUG);
    window.StockCountNotify?.startPolling?.(STORE_NUMBER);
}

function clearMmxUiWatch() {
    try {
        sessionStorage.removeItem(MMX_UI_WATCH_KEY);
    } catch {
        /* ignore */
    }
    window.StockCountNotify?.clearWatch?.(STORE_NUMBER);
    window.StockCountNotify?.stopPolling?.();
}

function pipelineLooksInProgress(status) {
    if (!status) return false;
    if (typeof status.workLive === 'boolean') return status.workLive;
    if (status.inProgress) return true;
    return MMX_IN_PROGRESS_STAGES.has(status.stage);
}

async function fetchPipelineStatusOrNull() {
    try {
        const { res, data } = await fetchJson(apiQuery('/api/stock-count/pipeline-status'));
        if (!res.ok) return { ok: false, status: null };
        return { ok: true, status: data };
    } catch (error) {
        return { ok: false, status: null, error };
    }
}

function isRecoverableMmxError(message) {
    return (
        shouldRecoverGatewayError(message) ||
        /timed out waiting|could not reach|connection interrupted/i.test(String(message || ''))
    );
}

function finishMmxOrdersSuccess(data) {
    clearMmxUiWatch();
    mmxLastKnownServerInProgress = false;
    mmxSessionId = '';
    mmxProcessingComplete = true;
    mmxProcessingStepId = 'orders';
    mmxProcessingSuccess = {
        partial: Boolean(data?.orderFailures),
        orderFailures: data?.orderFailures || null,
    };
    processing = true;
    processingStageLabel = data?.orderFailures
        ? 'Finished — some scheduled orders need review in MMX'
        : 'All scheduled orders updated in Macromatix';
    pushMmxActivity(processingStageLabel);
    document.body.classList.add('stock-count-mmx-wait-active');
    window.StockCountNotify?.notifyOrdersReady?.(STORE_NUMBER, VENDOR_SLUG, {
        partial: Boolean(data?.orderFailures),
    });
    setStatus('', '');
    render();
}

function dismissMmxProcessingSuccess() {
    if (mmxProcessingSuccess?.partial) {
        setStatus(
            `Some scheduled orders could not be filled: ${mmxProcessingSuccess.orderFailures}`,
            'error'
        );
    } else {
        setStatus('Counts sent — scheduled orders updated in Macromatix.', 'success');
    }
    mmxProcessingSuccess = null;
    mmxProcessingComplete = false;
    endMmxProcessing();
    render();
}

async function showPreparedVariancesFromStatus(status) {
    mmxSessionId = status.sessionId || '';
    mmxVariances = Array.isArray(status.variances) ? status.variances : [];
    if (!mmxVariances.length) {
        return false;
    }
    mmxVendorSlugs =
        Array.isArray(status.vendorsSent) && status.vendorsSent.length ? status.vendorsSent : [VENDOR_SLUG];
    await loadVendorCatalogsForSlugs(mmxVendorSlugs, { fullCatalog: true });
    varianceDrafts = { ...recountDrafts, [VENDOR_SLUG]: draft };
    for (const slug of mmxVendorSlugs) {
        if (slug === VENDOR_SLUG || varianceDrafts[slug]?.locations) continue;
        const { res, data: draftData } = await fetchJson(apiQuery('/api/stock-count/draft', slug));
        if (res.ok && draftData?.locations) varianceDrafts[slug] = draftData;
    }
    if (viewMode === 'recount') {
        recountCatalog = null;
    }
    viewMode = 'variances';
    return true;
}

function pipelineNeedsVarianceReview(status) {
    const count = Number(status?.redVarianceCount);
    const variances = Array.isArray(status?.variances) ? status.variances : [];
    return Boolean(
        status?.sessionId &&
        status?.stage === 'prepared' &&
        (count > 0 || variances.length > 0)
    );
}

function pipelineStageLabel(stage) {
    switch (stage) {
        case 'preparing':
            return 'Opening Key Item Count in Macromatix…';
        case 'prepared':
            return 'Key Item Count ready — loading variances…';
        case 'applying':
            return 'Applying count in Macromatix…';
        case 'downloading-reports':
            return 'Downloading stock reports…';
        case 'filling-orders':
        case 'applied-orders-pending':
            return 'Placing scheduled orders…';
        case 'prepare-failed':
        case 'apply-failed':
            return 'Macromatix step failed';
        default:
            return 'Still sending to Macromatix…';
    }
}

function visibleMmxPipelineSteps() {
    if (mmxPipelineManualOnly) {
        return MMX_PIPELINE_STEPS.filter((s) => ['save', 'reports', 'orders'].includes(s.id));
    }
    return MMX_PIPELINE_STEPS;
}

function resolveMmxStepIdFromStatus(status) {
    const stage = status?.stage;
    const detail = String(status?.stepLabel || '').toLowerCase();
    const reportWork =
        stage === 'downloading-reports' ||
        /download|downloaded|inventory special|stock on hand|stock on order|scm - items|build-to reports|calculating order/i.test(
            detail
        );
    const orderWork =
        /placing order —|placing scheduled orders in macromatix/i.test(detail) ||
        (stage === 'filling-orders' && !reportWork);

    if (reportWork && !orderWork) {
        return 'reports';
    }
    if (orderWork || stage === 'filling-orders') {
        return 'orders';
    }
    if (stage === 'applied-orders-pending') {
        return 'reports';
    }
    if (stage === 'applying' || /applying count/i.test(detail)) return 'apply';
    if (stage === 'prepared' || /variance|confirm count/i.test(detail)) return 'variances';
    if (stage === 'preparing') {
        if (/entering counts|filling/i.test(detail)) return 'fill-locations';
        if (/variance|confirm|continue/i.test(detail)) return 'variances';
        return 'open-kic';
    }
    return 'save';
}

function resolveMmxStepIdFromLabel(label) {
    return resolveMmxStepIdFromStatus({ stage: 'preparing', stepLabel: label });
}

function applyPipelineStatusToUi(status) {
    if (!status) return;
    const label = status.stepLabel || pipelineStageLabel(status.stage);
    mmxProcessingDetail = status.stepLabel || '';
    mmxLastPipelineStep = label || mmxLastPipelineStep;
    mmxProcessingStepId = resolveMmxStepIdFromStatus(status);
    processingStageLabel = label;
    pushMmxActivity(label);
}

function pipelineFailureFromStatus(status) {
    if (!status?.lastError) return null;
    if (status.stage !== 'prepare-failed' && status.stage !== 'apply-failed') return null;
    return {
        message: status.lastError,
        failedAtStep: status.failedAtStep || status.stepLabel || pipelineStageLabel(status.stage),
    };
}

/** ordersComplete must not fire while apply / reports / orders are still running server-side. */
function pipelineOrdersActuallyComplete(status) {
    if (!status?.ordersComplete) return false;
    if (status.inProgress) return false;
    const stage = status.stage || 'idle';
    if (stage === 'completed' || stage === 'idle') return true;
    return false;
}

async function pollStockCountPipelineUntilDone() {
    let started = Date.now();
    let networkStreak = 0;
    let sawInProgress = false;
    let idlePolls = 0;
    let extendedDeadline = false;

    if (!processing && !mmxProcessingError) {
        beginMmxProcessing('Sending to Macromatix…');
    }
    startMmxUiWatch();
    setStatus('', '');
    render();

    while (true) {
        if (Date.now() - started >= MMX_PIPELINE_MAX_MS) {
            const deadlineCheck = await fetchPipelineStatusOrNull();
            if (
                !extendedDeadline &&
                deadlineCheck.ok &&
                pipelineLooksInProgress(deadlineCheck.status)
            ) {
                extendedDeadline = true;
                started = Date.now();
                mmxLastKnownServerInProgress = true;
                applyPipelineStatusToUi(deadlineCheck.status);
                pushMmxActivityOnce(
                    'Taking longer than usual — the Pi is still working. Keep this page open or wait for a notification.'
                );
                render();
                continue;
            }
            break;
        }
        await sleep(MMX_PIPELINE_POLL_MS);

        const result = await fetchPipelineStatusOrNull();
        if (!result.ok) {
            const recoverable =
                !result.error ||
                shouldRecoverGatewayError(result.error.message) ||
                mmxLastKnownServerInProgress ||
                sawInProgress;
            if (recoverable) {
                networkStreak++;
                if (mmxLastKnownServerInProgress || sawInProgress) {
                    pushMmxActivityOnce('Connection interrupted — still checking the Pi…');
                }
                const grace =
                    mmxLastKnownServerInProgress || sawInProgress
                        ? MMX_PIPELINE_NETWORK_GRACE_POLLS * 3
                        : MMX_PIPELINE_NETWORK_GRACE_POLLS;
                if (networkStreak < grace) continue;
            }

            const retry = await fetchPipelineStatusOrNull();
            if (retry.ok && pipelineLooksInProgress(retry.status)) {
                networkStreak = 0;
                sawInProgress = true;
                mmxLastKnownServerInProgress = true;
                applyPipelineStatusToUi(retry.status);
                pushMmxActivityOnce('Still running on the server — waiting…');
                render();
                continue;
            }
            throw (
                result.error ||
                new Error('Could not reach the dashboard — check your connection and try again.')
            );
        }

        networkStreak = 0;
        const status = result.status;

        if ((status.stage && status.stage !== 'idle') || status.stepLabel) {
            applyPipelineStatusToUi(status);
            render();
        }

        const pipelineFail = pipelineFailureFromStatus(status);
        if (pipelineFail) {
            clearMmxUiWatch();
            mmxLastKnownServerInProgress = false;
            showMmxProcessingError(pipelineFail.message, pipelineFail.failedAtStep);
            throw new Error(pipelineFail.message);
        }

        if (pipelineOrdersActuallyComplete(status)) {
            finishMmxOrdersSuccess({ orderFailures: status.lastError || null });
            return { autoApplied: true };
        }

        if (pipelineNeedsVarianceReview(status)) {
            clearMmxUiWatch();
            mmxLastKnownServerInProgress = false;
            return { prepared: true, status };
        }

        if (pipelineLooksInProgress(status)) {
            sawInProgress = true;
            mmxLastKnownServerInProgress = true;
            idlePolls = 0;
            continue;
        }

        if (sawInProgress && (status.stage === 'idle' || !status.inProgress)) {
            clearMmxUiWatch();
            mmxLastKnownServerInProgress = false;
            endMmxProcessing();
            viewMode = 'entry';
            setStatus('Previous Macromatix run ended — your counts are still saved. Send again when ready.', '');
            render();
            return { reset: true };
        }

        idlePolls++;
        if (!sawInProgress && idlePolls >= 20) break;
        if (sawInProgress && idlePolls >= 30) {
            const verify = await fetchPipelineStatusOrNull();
            if (verify.ok && pipelineLooksInProgress(verify.status)) {
                idlePolls = 0;
                mmxLastKnownServerInProgress = true;
                applyPipelineStatusToUi(verify.status);
                render();
                continue;
            }
            if (verify.ok && pipelineOrdersActuallyComplete(verify.status)) {
                finishMmxOrdersSuccess({ orderFailures: verify.status.lastError || null });
                return { autoApplied: true };
            }
            break;
        }
    }

    const final = await fetchPipelineStatusOrNull();
    if (final.ok && pipelineOrdersActuallyComplete(final.status)) {
        finishMmxOrdersSuccess({ orderFailures: final.status.lastError || null });
        return { autoApplied: true };
    }
    if (final.ok && pipelineNeedsVarianceReview(final.status)) {
        clearMmxUiWatch();
        mmxLastKnownServerInProgress = false;
        return { prepared: true, status: final.status };
    }

    throw new Error(
        'Timed out waiting for Macromatix. Check pm2 logs on the Pi — the count may still be running.'
    );
}

async function waitForPipelinePrepareComplete() {
    return pollStockCountPipelineUntilDone();
}

async function acceptSendToMmx() {
    try {
        const { res, data } = await fetchJson(apiQuery('/api/stock-count/send-to-mmx'), { method: 'POST' });
        if (!res.ok || !data.success) {
            const detail = String(data.error || '').trim();
            throw new Error(detail || `Send to Macromatix failed (HTTP ${res.status}).`);
        }
        return data;
    } catch (error) {
        if (shouldRecoverGatewayError(error.message)) {
            return { accepted: true, inProgress: true };
        }
        throw error;
    }
}

async function waitForPipelineApplyComplete() {
    if (!processing) {
        beginMmxProcessing('Placing scheduled orders…');
        mmxProcessingStepId = 'orders';
    }
    const outcome = await pollStockCountPipelineUntilDone();
    return outcome?.autoApplied === true;
}

async function handlePipelinePollOutcome(outcome) {
    if (outcome?.autoApplied || outcome?.reset) return;
    if (outcome?.prepared && (await showPreparedVariancesFromStatus(outcome.status))) {
        endMmxProcessing();
        window.StockCountNotify?.notifyVariancesReady?.(STORE_NUMBER, VENDOR_SLUG);
        setStatus('Review variances below, then confirm to place scheduled orders.', '');
        render();
    }
}

function attachMmxPipelineBackgroundPoll() {
    if (mmxPollInFlight) return;
    mmxPollInFlight = pollStockCountPipelineUntilDone()
        .then((outcome) => handlePipelinePollOutcome(outcome))
        .catch((error) => {
            if (!isRecoverableMmxError(error.message)) {
                showMmxProcessingError(error.message, mmxLastPipelineStep);
                setStatus(error.message, 'error');
            } else {
                showMmxProcessingError(error.message, mmxLastPipelineStep, { recoverable: true });
            }
            render();
        })
        .finally(() => {
            mmxPollInFlight = null;
        });
}

async function resumeMmxPipelineFromError() {
    mmxProcessingError = null;
    processing = true;
    document.body.classList.add('stock-count-mmx-wait-active');
    setStatus('', '');
    render();
    try {
        const outcome = await pollStockCountPipelineUntilDone();
        await handlePipelinePollOutcome(outcome);
    } catch (error) {
        showMmxProcessingError(error.message, mmxLastPipelineStep, {
            recoverable: isRecoverableMmxError(error.message),
        });
        setStatus(error.message, 'error');
        render();
    }
}

async function refreshMmxPipelineUi() {
    const result = await fetchPipelineStatusOrNull();
    if (!result.ok) return;
    const status = result.status;

    if (pipelineOrdersActuallyComplete(status)) {
        finishMmxOrdersSuccess({ orderFailures: status.lastError || null });
        return;
    }

    const pipelineFail = pipelineFailureFromStatus(status);
    if (pipelineFail) {
        showMmxProcessingError(pipelineFail.message, pipelineFail.failedAtStep);
        render();
        return;
    }

    if (pipelineNeedsVarianceReview(status)) {
        if (await showPreparedVariancesFromStatus(status)) {
            endMmxProcessing();
            window.StockCountNotify?.notifyVariancesReady?.(STORE_NUMBER, VENDOR_SLUG);
            setStatus('Review variances below, then confirm to place scheduled orders.', '');
            render();
        }
        return;
    }

    if (pipelineLooksInProgress(status)) {
        if (!processing && !mmxProcessingError) {
            beginMmxProcessing(status.stepLabel || pipelineStageLabel(status.stage));
        } else if (mmxProcessingError?.recoverable) {
            mmxProcessingError = null;
            processing = true;
            document.body.classList.add('stock-count-mmx-wait-active');
        }
        applyPipelineStatusToUi(status);
        render();
        attachMmxPipelineBackgroundPoll();
    }
}

async function tryResumePipelineOnLoad() {
    const result = await fetchPipelineStatusOrNull();
    let uiWatch = readMmxUiWatch();
    const status = result.ok ? result.status : null;

    if (status && !status.workLive && !status.inProgress) {
        clearMmxUiWatch();
        uiWatch = null;
    }

    if (!result.ok && !uiWatch) return false;

    if (status && pipelineNeedsVarianceReview(status)) {
        if (await showPreparedVariancesFromStatus(status)) {
            setStatus('Review variances below, then confirm to place scheduled orders.', '');
            return true;
        }
    }

    if (status && pipelineOrdersActuallyComplete(status)) {
        finishMmxOrdersSuccess({ orderFailures: status.lastError || null });
        return true;
    }

    if (status) {
        const pipelineFail = pipelineFailureFromStatus(status);
        if (pipelineFail) {
            showMmxProcessingError(pipelineFail.message, pipelineFail.failedAtStep);
            return true;
        }
    }

    if (status && pipelineLooksInProgress(status)) {
        beginMmxProcessing(status.stepLabel || pipelineStageLabel(status.stage));
        applyPipelineStatusToUi(status);
        render();
        attachMmxPipelineBackgroundPoll();
        return true;
    }

    if (!status && uiWatch) {
        beginMmxProcessing('Still sending to Macromatix…');
        pushMmxActivityOnce('Reconnecting to check progress on the Pi…');
        render();
        attachMmxPipelineBackgroundPoll();
        return true;
    }

    if (uiWatch) clearMmxUiWatch();
    return false;
}

function setupMmxPipelineVisibilityRecovery() {
    const onVisible = () => {
        if (document.visibilityState && document.visibilityState !== 'visible') return;
        if (!processing && !mmxProcessingError && !readMmxUiWatch()) return;
        void refreshMmxPipelineUi();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onVisible);
}

function shouldRecoverGatewayError(message) {
    return /524|502|503|504|gateway|cloudflare|failed to fetch|network|invalid server response|timed out|timeout/i.test(
        String(message || '')
    );
}

function shouldRecoverApplyError(message) {
    return /session expired|apply failed|apply button/i.test(String(message || '')) || shouldRecoverGatewayError(message);
}

async function sendToMmx() {
    if (!canShowSendToMmx() || saving || processing) return;
    let preparedAutoApplied = false;

    try {
        if (viewMode === 'recount') {
            const saved = await saveAllRecountLocations();
            if (!saved) {
                throw new Error('Could not save your recount — check the values and try again.');
            }
            if (mmxSessionId) {
                try {
                    await fetchJson(apiQuery('/api/stock-count/send-to-mmx/recount'), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sessionId: mmxSessionId }),
                    });
                } catch {
                    /* prepare replaces session */
                }
                mmxSessionId = '';
            }
            await resubmitAllVendorsForMmx();
        } else {
            const saved = await saveAndSubmitVendor();
            if (!saved || !canShowSendToMmx()) {
                throw new Error('Enter at least one count before sending to Macromatix.');
            }
        }
    } catch (error) {
        setStatus(error.message, 'error');
        render();
        return;
    }

    saving = true;
    mmxPipelineManualOnly = false;
    beginMmxProcessing('Saving your counts…');
    mmxProcessingStepId = 'save';
    pushMmxActivity('Saving your counts');
    setStatus('', '');
    render();
    try {
        const { res: planRes, data: plan } = await fetchJson(apiQuery('/api/stock-count/send-plan'));
        if (planRes.ok && plan.success && plan.manualOnly) {
            mmxPipelineManualOnly = true;
            mmxProcessingStepId = 'reports';
            processingStageLabel = 'Skipping Key Item Count — downloading reports…';
            render();
        } else if (planRes.ok && plan.success && plan.needsKeyItemCount) {
            mmxProcessingStepId = 'open-kic';
            processingStageLabel = 'Opening Key Item Count in Macromatix…';
            render();
        } else {
            mmxProcessingStepId = 'reports';
            processingStageLabel = 'Downloading reports and placing orders…';
            render();
        }

        const accepted = await acceptSendToMmx();
        if (accepted.accepted || accepted.inProgress) {
            const outcome = await waitForPipelinePrepareComplete();
            if (outcome?.autoApplied) {
                preparedAutoApplied = true;
                return;
            }
            if (outcome?.prepared && (await showPreparedVariancesFromStatus(outcome.status))) {
                endMmxProcessing();
                window.StockCountNotify?.notifyVariancesReady?.(STORE_NUMBER, VENDOR_SLUG);
                setStatus('Review variances below, then confirm to place scheduled orders.', '');
                return;
            }
        }
        if (accepted.keyItemCountSkipped || accepted.autoApplied) {
            const outcome = await waitForPipelinePrepareComplete();
            if (outcome?.autoApplied) {
                preparedAutoApplied = true;
                return;
            }
        }
        if (accepted.sessionId && pipelineNeedsVarianceReview(accepted)) {
            if (await showPreparedVariancesFromStatus(accepted)) {
                endMmxProcessing();
                window.StockCountNotify?.notifyVariancesReady?.(STORE_NUMBER, VENDOR_SLUG);
                setStatus('Review variances below, then confirm to place scheduled orders.', '');
                return;
            }
        }
        throw new Error('Send to Macromatix did not start. Try again.');
    } catch (error) {
        if (shouldRecoverGatewayError(error.message)) {
            try {
                const outcome = await waitForPipelinePrepareComplete();
                if (outcome?.autoApplied) {
                    preparedAutoApplied = true;
                    return;
                }
                if (outcome?.prepared && (await showPreparedVariancesFromStatus(outcome.status))) {
                    endMmxProcessing();
                    window.StockCountNotify?.notifyVariancesReady?.(STORE_NUMBER, VENDOR_SLUG);
                    setStatus('Review variances below, then confirm to place scheduled orders.', '');
                    return;
                }
            } catch (recoverError) {
                const retry = await fetchPipelineStatusOrNull();
                if (retry.ok && pipelineLooksInProgress(retry.status)) {
                    attachMmxPipelineBackgroundPoll();
                    return;
                }
                showMmxProcessingError(recoverError.message, mmxLastPipelineStep, {
                    recoverable: isRecoverableMmxError(recoverError.message),
                });
                setStatus(recoverError.message, 'error');
                render();
                return;
            }
        }
        if (shouldRecoverApplyError(error.message)) {
            try {
                const recovered = await waitForPipelineApplyComplete();
                if (recovered) {
                    preparedAutoApplied = true;
                    return;
                }
            } catch (recoverError) {
                const retry = await fetchPipelineStatusOrNull();
                if (retry.ok && pipelineLooksInProgress(retry.status)) {
                    attachMmxPipelineBackgroundPoll();
                    return;
                }
                showMmxProcessingError(recoverError.message, mmxLastPipelineStep, {
                    recoverable: isRecoverableMmxError(recoverError.message),
                });
                setStatus(recoverError.message, 'error');
                render();
                return;
            }
        }
        const retry = await fetchPipelineStatusOrNull();
        if (retry.ok && pipelineLooksInProgress(retry.status)) {
            attachMmxPipelineBackgroundPoll();
            return;
        }
        showMmxProcessingError(error.message, mmxLastPipelineStep, {
            recoverable: isRecoverableMmxError(error.message),
        });
        setStatus(error.message, 'error');
    } finally {
        saving = false;
        if (!preparedAutoApplied && !mmxProcessingSuccess && processing && !mmxProcessingError) {
            endMmxProcessing();
        }
        render();
    }
}

async function applyMmxCount() {
    if (!mmxSessionId || saving) return;
    saving = true;
    beginMmxProcessing('Placing scheduled orders…');
    mmxProcessingStepId = 'orders';
    setStatus('', '');
    render();
    try {
        const { res, data } = await fetchJson(apiQuery('/api/stock-count/send-to-mmx/apply'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: mmxSessionId }),
        });
        if (!res.ok || !data.success) {
            const msg = data.error || 'Apply failed.';
            if (/already applied|nothing to apply/i.test(msg)) {
                mmxSessionId = '';
                const recovered = await waitForPipelineApplyComplete();
                if (recovered) {
                    saving = false;
                    return;
                }
            }
            if (shouldRecoverApplyError(msg)) {
                const recovered = await waitForPipelineApplyComplete();
                if (recovered) {
                    saving = false;
                    render();
                    return;
                }
            }
            throw new Error(msg);
        }
        const live = await fetchPipelineStatusOrNull();
        if (live.ok && pipelineLooksInProgress(live.status)) {
            const recovered = await waitForPipelineApplyComplete();
            if (recovered) {
                saving = false;
                return;
            }
        }
        finishMmxOrdersSuccess({ orderFailures: data.orderFailures || null });
        saving = false;
        return;
    } catch (error) {
        const msg = error.message || '';
        if (/already applied|nothing to apply/i.test(msg)) {
            mmxSessionId = '';
            const recovered = await waitForPipelineApplyComplete();
            if (recovered) {
                saving = false;
                return;
            }
        }
        if (shouldRecoverApplyError(msg)) {
            try {
                const recovered = await waitForPipelineApplyComplete();
                if (recovered) {
                    saving = false;
                    render();
                    return;
                }
            } catch (recoverError) {
                const retry = await fetchPipelineStatusOrNull();
                if (retry.ok && pipelineLooksInProgress(retry.status)) {
                    attachMmxPipelineBackgroundPoll();
                    saving = false;
                    return;
                }
                showMmxProcessingError(recoverError.message, mmxLastPipelineStep, {
                    recoverable: isRecoverableMmxError(recoverError.message),
                });
                setStatus(recoverError.message, 'error');
                saving = false;
                render();
                return;
            }
        }
        const retry = await fetchPipelineStatusOrNull();
        if (retry.ok && pipelineLooksInProgress(retry.status)) {
            attachMmxPipelineBackgroundPoll();
            saving = false;
            return;
        }
        showMmxProcessingError(msg, mmxLastPipelineStep, {
            recoverable: isRecoverableMmxError(msg),
        });
        setStatus(msg, 'error');
        saving = false;
        render();
    } finally {
        if (!processing && !mmxProcessingError && !mmxProcessingSuccess) saving = false;
    }
}

async function recountMmx() {
    if (saving) return;
    saving = true;
    setStatus('', '');
    render();
    try {
        if (mmxSessionId) {
            try {
                await fetchJson(apiQuery('/api/stock-count/send-to-mmx/recount'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: mmxSessionId }),
                });
            } catch {
                /* still open recount editor */
            }
        }
        mmxSessionId = '';
        await buildRecountCatalog();
        viewMode = 'recount';
        setStatus('', '');
    } catch (error) {
        setStatus(error.message || 'Could not open recount.', 'error');
    } finally {
        saving = false;
        render();
    }
}

function formatQty(value) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    const n = Number(value);
    if (Number.isInteger(n)) return String(n);
    return n.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatMoney(value) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    const n = Number(value);
    const abs = Math.abs(n).toLocaleString('en-AU', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
    if (n < 0) return `-$${abs}`;
    return `$${abs}`;
}

function formatVarianceQty(value) {
    if (value == null || !Number.isFinite(Number(value))) return '0';
    return formatQty(value);
}

function formatVarianceMoney(value) {
    if (value == null || !Number.isFinite(Number(value))) return '$0.00';
    return formatMoney(value);
}

function formatUnitLabel(label) {
    const s = String(label || '').trim();
    if (!s || /^n\/a/i.test(s) || s === '—') return '';
    const lower = s.toLowerCase();
    if (/^kg/i.test(s)) return 'kg';
    if (/bottle/i.test(s)) return 'Bottles';
    if (/can/i.test(s)) return 'cans';
    if (/tub/i.test(s)) return 'tubs';
    if (/bag/i.test(s)) return 'bags';
    if (lower === 'ea' || lower === 'each') return 'each';
    if (/box(es)?/i.test(s)) return 'boxes';
    if (/carton/i.test(s)) return 'cartons';
    if (/tender/i.test(s)) return 'tenders';
    return s.toLowerCase();
}

function inferStockVarianceUnitLabel(row, item) {
    const mmxUnit = formatUnitLabel(row.unit);
    if (mmxUnit && mmxUnit !== 'each') return mmxUnit;

    const slots = resolveUnitSlots(item);
    for (const slot of slots) {
        if (!slot.na && /bottle|tub|can|carton/i.test(slot.label)) {
            return formatUnitLabel(slot.label);
        }
    }

    for (const slot of slots) {
        if (!slot.na && /kg/i.test(slot.label)) {
            return formatUnitLabel(slot.label);
        }
    }

    return mmxUnit || '';
}

function formatQtyWithUnit(value, unitLabel) {
    const qty = formatQty(value);
    if (qty === '—') return qty;
    return unitLabel ? `${qty} ${unitLabel}` : qty;
}

function mmxProcessingTitle() {
    if (/placing scheduled|downloading reports|filling orders|applying count/i.test(processingStageLabel)) {
        return 'Finishing in Macromatix';
    }
    return 'Sending to Macromatix';
}

function buildMmxStepListHtml() {
    const steps = visibleMmxPipelineSteps();
    const activeId = mmxProcessingStepId;
    const failedId = mmxProcessingError
        ? resolveMmxStepIdFromLabel(mmxProcessingError.failedAtStep)
        : null;
    const activeIdx = steps.findIndex((s) => s.id === activeId);
    const failedIdx = failedId != null ? steps.findIndex((s) => s.id === failedId) : -1;

    const items = steps
        .map((step, idx) => {
            let state = 'pending';
            if (mmxProcessingError && failedIdx >= 0) {
                if (idx < failedIdx) state = 'done';
                else if (idx === failedIdx) state = 'error';
            } else if (mmxProcessingComplete || mmxProcessingSuccess) {
                state = 'done';
            } else if (activeIdx >= 0) {
                if (idx < activeIdx) state = 'done';
                else if (idx === activeIdx) state = 'active';
            } else if (idx === 0) {
                state = 'active';
            }
            const detail =
                state === 'active' && mmxProcessingDetail && step.id === activeId
                    ? `<span class="stock-count-mmx-step-detail">${escapeHtml(mmxProcessingDetail)}</span>`
                    : '';
            return `<li class="stock-count-mmx-step stock-count-mmx-step--${state}">
                <span class="stock-count-mmx-step-marker" aria-hidden="true"></span>
                <span class="stock-count-mmx-step-text">${escapeHtml(step.label)}${detail}</span>
            </li>`;
        })
        .join('');

    return `<ol class="stock-count-mmx-steps" aria-label="Macromatix progress">${items}</ol>`;
}

function resolveMmxReportChecklist() {
    const logText = mmxActivityLog.map((e) => String(e.text || '').toLowerCase());
    return MMX_BUILD_TO_REPORTS.map((report) => {
        let state = 'pending';
        for (const line of logText) {
            const hit = line.includes(report.key);
            if (!hit) continue;
            if (/downloaded|→/.test(line)) state = 'done';
            else if (/downloading/.test(line)) state = state === 'done' ? 'done' : 'active';
        }
        return { ...report, state };
    });
}

function buildMmxReportsChecklistHtml() {
    const reports = resolveMmxReportChecklist();
    const allDone = reports.every((r) => r.state === 'done');
    const anyStarted = reports.some((r) => r.state !== 'pending');
    if (!anyStarted && mmxProcessingStepId !== 'reports') return '';
    if (mmxProcessingStepId === 'orders' && allDone) return '';

    const items = reports
        .map((report) => {
            const state = report.state;
            return `<li class="stock-count-mmx-report stock-count-mmx-report--${state}">
                <span class="stock-count-mmx-report-marker" aria-hidden="true"></span>
                <span class="stock-count-mmx-report-text">
                    <strong>${escapeHtml(report.label)}</strong>
                    <span class="stock-count-mmx-report-detail">${escapeHtml(report.detail)}</span>
                </span>
            </li>`;
        })
        .join('');

    return `
        <div class="stock-count-mmx-reports-wrap">
            <p class="stock-count-mmx-reports-heading">Reports for order quantities</p>
            <ol class="stock-count-mmx-reports" aria-label="Report downloads">${items}</ol>
        </div>`;
}

function buildMmxActivityLogHtml() {
    if (!mmxActivityLog.length) return '';
    const items = mmxActivityLog
        .map((entry, idx) => {
            const isLatest = idx === mmxActivityLog.length - 1 && !mmxProcessingSuccess;
            const cls = isLatest ? 'stock-count-mmx-activity-item--current' : 'stock-count-mmx-activity-item--done';
            return `<li class="stock-count-mmx-activity-item ${cls}">${escapeHtml(entry.text)}</li>`;
        })
        .join('');
    return `
        <div class="stock-count-mmx-activity-wrap">
            <p class="stock-count-mmx-activity-heading">Current progress</p>
            <ol class="stock-count-mmx-activity" aria-live="polite">${items}</ol>
        </div>`;
}

function buildMmxNotifySection() {
    if (mmxProcessingError || mmxProcessingSuccess) return '';
    const notify = window.StockCountNotify;
    if (mmxNotifyEnabled || notify?.permissionState?.() === 'granted') {
        return `<p class="stock-count-mmx-notify-hint stock-count-mmx-notify-hint--ok">Notifications on — we'll alert you when it's ready to review.</p>`;
    }
    if (mmxNotifyDenied || notify?.permissionState?.() === 'denied') {
        return `<p class="stock-count-mmx-notify-hint stock-count-mmx-notify-hint--denied">Notifications are blocked in your browser. Keep this page open, or enable alerts in site settings.</p>`;
    }
    if (notify?.permissionState?.() === 'unsupported') {
        return `<p class="stock-count-mmx-notify-hint">Keep this page open — your browser can't show background alerts.</p>`;
    }
    return `
        <p class="stock-count-mmx-notify-hint">Leaving? Tap below and allow notifications when prompted — we'll tell you when it's ready to review.</p>
        <button type="button" class="stock-count-btn stock-count-btn--notify" id="sc-mmx-notify-btn">Notify me when ready</button>`;
}

function buildMmxProcessingOverlay() {
    if (!processing && !mmxProcessingError && !mmxProcessingSuccess) return '';

    if (mmxProcessingSuccess) {
        const msg = mmxProcessingSuccess.partial
            ? `Counts were sent, but some scheduled orders could not be filled. Review them in Macromatix.${mmxProcessingSuccess.orderFailures ? ` (${mmxProcessingSuccess.orderFailures})` : ''}`
            : 'Counts sent — all scheduled orders have been updated in Macromatix.';
        return `
        <div class="stock-count-processing stock-count-processing--fullscreen" role="alertdialog" aria-modal="true" aria-labelledby="sc-mmx-success-title">
            <div class="stock-count-processing-card stock-count-processing-card--wait stock-count-processing-card--success stock-count-processing-card--fullscreen">
                <h2 id="sc-mmx-success-title" class="stock-count-processing-label stock-count-processing-label--success">${mmxProcessingSuccess.partial ? 'Finished with issues' : 'Complete'}</h2>
                <p class="stock-count-mmx-success-msg">${escapeHtml(msg)}</p>
                ${buildMmxStepListHtml()}
                ${buildMmxActivityLogHtml()}
                <button type="button" class="stock-count-btn stock-count-btn--primary stock-count-mmx-dismiss" id="sc-mmx-dismiss-success">Close</button>
            </div>
        </div>`;
    }

    if (mmxProcessingError) {
        return `
        <div class="stock-count-processing stock-count-processing--fullscreen" role="alertdialog" aria-modal="true" aria-labelledby="sc-mmx-error-title">
            <div class="stock-count-processing-card stock-count-processing-card--wait stock-count-processing-card--error stock-count-processing-card--fullscreen">
                <h2 id="sc-mmx-error-title" class="stock-count-processing-label stock-count-processing-label--error">Send to Macromatix failed</h2>
                <p class="stock-count-mmx-error-step">Failed at: <strong>${escapeHtml(mmxProcessingError.failedAtStep)}</strong></p>
                <p class="stock-count-mmx-error-msg">${escapeHtml(mmxProcessingError.message)}</p>
                ${mmxProcessingError.recoverable ? '<p class="stock-count-mmx-error-hint">The Pi may still be working — tap below to check again.</p>' : ''}
                ${buildMmxStepListHtml()}
                ${buildMmxActivityLogHtml()}
                ${mmxProcessingError.recoverable ? '<button type="button" class="stock-count-btn stock-count-btn--primary stock-count-mmx-dismiss" id="sc-mmx-retry-poll">Check server again</button>' : ''}
                <button type="button" class="stock-count-btn stock-count-btn--secondary stock-count-mmx-dismiss" id="sc-mmx-dismiss-error">Close</button>
            </div>
        </div>`;
    }

    const markSvg = window.TbaBrandMark?.svg?.('stock-count-mmx-wait') || '';
    return `
        <div class="stock-count-processing stock-count-processing--fullscreen" role="dialog" aria-modal="true" aria-labelledby="sc-mmx-wait-title">
            <div class="stock-count-processing-card stock-count-processing-card--wait stock-count-processing-card--fullscreen">
                ${markSvg ? `<div class="stock-count-processing-mark" aria-hidden="true">${markSvg}</div>` : ''}
                <h2 id="sc-mmx-wait-title" class="stock-count-processing-label">${escapeHtml(mmxProcessingTitle())}</h2>
                <p class="stock-count-mmx-wait-body">This usually takes several minutes. The list below updates as each Macromatix step runs — do not close until you see <strong>Complete</strong>.</p>
                ${buildMmxStepListHtml()}
                ${buildMmxReportsChecklistHtml()}
                ${buildMmxActivityLogHtml()}
                <p class="stock-count-processing-stage" role="status" aria-live="polite">${escapeHtml(processingStageLabel)}<span class="stock-count-processing-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span></p>
                <div class="stock-count-progress-shell" aria-hidden="true">
                    <div class="stock-count-progress-bar"></div>
                </div>
                ${buildMmxNotifySection()}
            </div>
        </div>`;
}

function beginMmxProcessing(stageLabel) {
    processing = true;
    mmxProcessingError = null;
    mmxProcessingSuccess = null;
    mmxProcessingComplete = false;
    processingStageLabel = stageLabel || 'Sending to Macromatix…';
    mmxLastPipelineStep = processingStageLabel;
    mmxProcessingDetail = '';
    mmxActivityLog = [];
    pushMmxActivity(processingStageLabel);
    mmxNotifyEnabled = Boolean(window.StockCountNotify?.isWatching?.(STORE_NUMBER));
    mmxNotifyDenied = false;
    startMmxUiWatch();
    document.body.classList.add('stock-count-mmx-wait-active');
}

function endMmxProcessing() {
    processing = false;
    mmxProcessingError = null;
    mmxProcessingSuccess = null;
    mmxProcessingComplete = false;
    mmxProcessingDetail = '';
    mmxActivityLog = [];
    mmxLastKnownServerInProgress = false;
    clearMmxUiWatch();
    document.body.classList.remove('stock-count-mmx-wait-active');
}

function showMmxProcessingError(message, failedAtStep, options = {}) {
    clearMmxUiWatch();
    mmxLastKnownServerInProgress = false;
    mmxProcessingError = {
        message: String(message || 'Something went wrong').trim(),
        failedAtStep: String(
            failedAtStep || mmxLastPipelineStep || processingStageLabel || 'Unknown step'
        ).trim(),
        recoverable:
            options.recoverable !== undefined
                ? Boolean(options.recoverable)
                : isRecoverableMmxError(message),
    };
    processing = false;
    document.body.classList.add('stock-count-mmx-wait-active');
}

function dismissMmxProcessingError() {
    mmxProcessingError = null;
    document.body.classList.remove('stock-count-mmx-wait-active');
    render();
}

async function enableMmxNotifications() {
    const notify = window.StockCountNotify;
    if (!notify) return;

    if (notify.permissionState?.() === 'unsupported') {
        mmxNotifyDenied = true;
        render();
        return;
    }

    const granted = await notify.requestPermission();
    if (granted) {
        mmxNotifyEnabled = true;
        mmxNotifyDenied = false;
        notify.setWatch(STORE_NUMBER, VENDOR_SLUG);
        notify.startPolling(STORE_NUMBER);
        render();
        return;
    }

    mmxNotifyDenied = true;
    render();
}

const VARIANCE_TABLE_HEADERS = [
    { key: 'name', label: 'Item' },
    { key: 'stockOnHand', label: 'Stock on Hand' },
    { key: 'varianceQty', label: 'Variance' },
    { key: 'varianceValue', label: 'Variance Value' },
    { key: 'box', label: 'Box' },
    { key: 'inner', label: 'Inner' },
    { key: 'unit', label: 'Unit' },
];

function buildVarianceHeaderRowHtml() {
    return `<tr class="stock-count-grid-row stock-count-variance-header-row">
        ${VARIANCE_TABLE_HEADERS.map((col) => {
            const nameClass =
                col.key === 'name' ? ' stock-count-variance-header--name' : '';
            return `<th scope="col" class="stock-count-variance-header${nameClass}">${escapeHtml(col.label)}</th>`;
        }).join('')}
    </tr>`;
}

function buildVarianceReadOnlyCellHtml(slot, counts) {
    const label = slot.label || 'N/a';
    let display = '0';
    if (!slot.na && slot.key) {
        const value = counts[slot.key];
        if (value != null && Number.isFinite(Number(value))) {
            display = formatQty(value);
        }
    }
    return `<td class="stock-count-grid-cell stock-count-grid-cell--variance-value">
        <div class="stock-count-unit-slot">
            <span class="stock-count-unit-label">${escapeHtml(label)}</span>
            <div class="stock-count-value-box stock-count-value-box--variance">${escapeHtml(display)}</div>
        </div>
    </td>`;
}

function buildVarianceStatCellHtml(label, display, extraClass = '') {
    return `<td class="stock-count-grid-cell stock-count-grid-cell--variance-value">
        <div class="stock-count-unit-slot">
            <span class="stock-count-unit-label">${escapeHtml(label)}</span>
            <div class="stock-count-value-box stock-count-value-box--variance${extraClass}">${escapeHtml(display)}</div>
        </div>
    </td>`;
}

function buildVarianceEntryRowHtml(row) {
    const match = resolveVarianceCatalogMatch(row);
    const matcher = globalThis.VarianceCatalogMatch;
    let item = match?.item || null;
    const mmxName = String(row.itemName || '').trim();
    if (!item) {
        item = {
            key: row.catalogKey || row.itemCode,
            itemCode: row.matchedItemCode || row.itemCode,
            name: mmxName || row.catalogName || row.itemCode || 'Unknown item',
            unitSlots: inferUnitSlotsFromVariance(row),
            columns: inferUnitSlotsFromVariance(row)
                .filter((slot) => !slot.na && slot.key)
                .map((slot) => ({ key: slot.key, label: slot.label })),
        };
    } else if (mmxName && matcher && matcher.nameMatchScore(mmxName, item.name) < 45) {
        item = {
            ...item,
            name: mmxName,
            unitSlots: inferUnitSlotsFromVariance(row),
            columns: inferUnitSlotsFromVariance(row)
                .filter((slot) => !slot.na && slot.key)
                .map((slot) => ({ key: slot.key, label: slot.label })),
        };
    }
    const catalogLabel = item.displayName || item.name;
    const displayName = mmxName || catalogLabel || row.catalogName || 'Unknown item';
    const counts = mapVarianceClosingToCounts(item, row);
    const slots = resolveUnitSlots(item).slice(0, 3);
    const closingCells = slots.map((slot) => buildVarianceReadOnlyCellHtml(slot, counts)).join('');
    const varianceQtyClass =
        Number(row.varianceQty) < 0 ? ' stock-count-value-box--variance-negative' : '';
    const varianceValueClass =
        Number(row.varianceValue) < 0 ? ' stock-count-value-box--variance-negative' : '';
    const statCells = [
        buildVarianceStatCellHtml('Stock on Hand', formatVarianceQty(row.stockCounted)),
        buildVarianceStatCellHtml('Variance', formatVarianceQty(row.varianceQty), varianceQtyClass),
        buildVarianceStatCellHtml(
            'Variance Value',
            formatVarianceMoney(row.varianceValue),
            ` stock-count-value-box--variance-money${varianceValueClass}`
        ),
    ].join('');
    return `<tr class="stock-count-grid-row stock-count-variance-row">
        <th scope="row" class="stock-count-grid-name">${escapeHtml(displayName)}</th>
        ${statCells}
        ${closingCells}
    </tr>`;
}

function buildVarianceView() {
    const rows = mmxVariances.map(buildVarianceEntryRowHtml).join('');
    const tableHtml = rows
        ? `<div class="stock-count-variance-scroll"><table class="stock-count-table stock-count-table--entry stock-count-table--connected stock-count-table--variances"><thead>${buildVarianceHeaderRowHtml()}</thead><tbody>${rows}</tbody></table></div>`
        : '<p class="stock-count-empty-location">No red variances found — review looks clear.</p>';

    const actionsHtml = rows
        ? `<div class="stock-count-actions stock-count-actions--variances">
            <button type="button" class="stock-count-btn stock-count-btn--secondary" id="sc-recount" ${saving ? 'disabled' : ''}>Recount</button>
            <button type="button" class="stock-count-btn stock-count-btn--mmx" id="sc-apply-mmx" ${saving ? 'disabled' : ''}>Apply</button>
        </div>`
        : '';

    return `
        <div class="stock-count-panel">
            <h2>Confirm count — red variances</h2>
            ${tableHtml}
            <div class="stock-count-review-note">Review variances before applying. Recount opens an editor with your counts pre-filled.</div>
        </div>
        ${actionsHtml}
    `;
}

function resolveUnitSlots(item) {
    if (Array.isArray(item.unitSlots) && item.unitSlots.length === 3) {
        return item.unitSlots;
    }
    const cols = Array.isArray(item.columns) ? item.columns : [];
    if (cols.length === 2) {
        return [
            { key: cols[0].key, label: cols[0].label, na: false },
            { key: null, label: 'N/a', na: true },
            { key: cols[1].key, label: cols[1].label, na: false },
        ];
    }
    if (cols.length === 1) {
        return [
            { key: null, label: 'N/a', na: true },
            { key: null, label: 'N/a', na: true },
            { key: cols[0].key, label: cols[0].label, na: false },
        ];
    }
    const slots = cols.map((col) => ({ key: col.key, label: col.label, na: false }));
    while (slots.length < 3) slots.push({ key: null, label: 'N/a', na: true });
    return slots.slice(0, 3);
}

function buildUnitSlotCellHtml(item, slot, ariaName) {
    const label = slot.label || 'N/a';
    if (slot.na) {
        return `<td class="stock-count-grid-cell stock-count-grid-cell--na" aria-hidden="true"></td>`;
    }
    return `<td class="stock-count-grid-cell">
        <label class="stock-count-unit-slot">
            <input type="text" class="stock-count-input" data-item="${escapeHtml(item.key)}" data-col="${escapeHtml(slot.key)}" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(label)}" aria-label="${escapeHtml(ariaName)} ${escapeHtml(label)}">
        </label>
    </td>`;
}

function stockCountItemLabel(item) {
    return item.displayName || item.name;
}

function buildEntryRowHtml(item) {
    const label = stockCountItemLabel(item);
    const ariaName = item.itemCode ? `${item.itemCode} ${item.name}` : item.name;
    const slots = resolveUnitSlots(item).slice(0, 3);
    const slotCells = slots.map((slot) => buildUnitSlotCellHtml(item, slot, ariaName)).join('');
    const showVendorLabel =
        isCombinedMode() && item.vendorLabel && combinedVendorSlugs.length > 1;
    const rowClass = showVendorLabel ? 'stock-count-grid-row stock-count-grid-row--split-vendor' : 'stock-count-grid-row';
    const nameCell = showVendorLabel
        ? `<th scope="row" class="stock-count-grid-name"><div class="stock-count-grid-name-bar"><span class="stock-count-grid-name-text">${escapeHtml(label)}</span><span class="stock-count-grid-vendor">${escapeHtml(item.vendorLabel)}</span></div></th>`
        : `<th scope="row" class="stock-count-grid-name"><span class="stock-count-grid-name-text">${escapeHtml(label)}</span></th>`;
    return `<tr class="${rowClass}">
        ${nameCell}
        ${slotCells}
    </tr>`;
}

function buildStatusNote() {
    if (viewMode === 'recount') {
        const tabName = getActiveCatalog()?.locations?.[currentLocationIndex] || '';
        return `<div class="stock-count-review-note">All location tabs are shown — update red variance lines (empty tabs need no changes), then send to Macromatix again.</div>`;
    }
    if (isMmxSent()) {
        return '<div class="stock-count-review-note">Sent to Macromatix — edit counts below and send again if needed.</div>';
    }
    if (isSubmitted()) {
        return '<div class="stock-count-review-note">Counts submitted — edit below anytime; changes save automatically.</div>';
    }
    if (canShowSendToMmx() && queueStatus?.readyToSend?.length) {
        return `<div class="stock-count-review-note">Ready to send: ${escapeHtml(queueStatus.readyToSend.join(', '))}</div>`;
    }
    if (isCombinedMode()) {
        return '<div class="stock-count-review-note">All vendors for today are on each location tab — walk the store once, then send to Macromatix.</div>';
    }
    return '<div class="stock-count-review-note">Use the location tabs to enter counts (saved as you type). Clear page resets the current tab.</div>';
}

function buildView() {
    const cat = getActiveCatalog();
    const visibleLocations = getVisibleLocationTabs(cat);
    if (currentLocationIndex >= visibleLocations.length) currentLocationIndex = 0;
    const locationName = getCurrentLocationName(cat);
    const itemsAtLocation = getItemsForLocation(locationName);
    const rows = itemsAtLocation.map((item) => buildEntryRowHtml(item)).join('');

    const emptyNote =
        itemsAtLocation.length === 0
            ? `<p class="stock-count-empty-location">${viewMode === 'recount' ? `No red variance items at ${escapeHtml(locationName)}.` : 'No items to count at this location.'}</p>`
            : '';

    const locButtons = visibleLocations
        .map((loc, idx) => {
            const classes = ['stock-count-loc-btn'];
            const isActive = idx === currentLocationIndex;
            if (isActive) classes.push('stock-count-loc-btn--active');
            if (locationHasData(loc)) classes.push('stock-count-loc-btn--done');
            return `<button type="button" role="tab" aria-selected="${isActive ? 'true' : 'false'}" id="sc-loc-tab-${idx}" class="${classes.join(' ')}" data-loc-index="${idx}">${escapeHtml(loc)}</button>`;
        })
        .join('');

    const clearDisabled = saving || processing;
    const sendMmxBtn =
        viewMode === 'recount' || canShowSendToMmx()
            ? `<button type="button" class="stock-count-btn stock-count-btn--mmx" id="sc-send-mmx" ${saving ? 'disabled' : ''}>Send to MMX</button>`
            : '';
    const panelTitle = locationName;
    const combinedTableClass =
        isCombinedMode() && combinedVendorSlugs.length > 1 ? ' stock-count-table--combined' : '';

    return `
        <div class="stock-count-locations" role="tablist" aria-label="Storage locations">${locButtons}</div>
        <div class="stock-count-panel" role="tabpanel" aria-labelledby="sc-loc-tab-${currentLocationIndex}">
            <h2>${escapeHtml(panelTitle)}</h2>
            <table class="stock-count-table stock-count-table--entry stock-count-table--connected${combinedTableClass}">
                <tbody>${rows}</tbody>
            </table>
            ${emptyNote}
            ${buildStatusNote()}
        </div>
        <div class="stock-count-actions">
            <div class="stock-count-actions-main">
                <button type="button" class="stock-count-btn stock-count-btn--secondary" id="sc-clear-page" ${clearDisabled ? 'disabled' : ''}>Clear page</button>
                <a class="stock-count-btn stock-count-btn--secondary stock-count-btn--link" href="${escapeHtml(dashboardPath())}">Back to dashboard</a>
            </div>
            ${sendMmxBtn}
        </div>
    `;
}

function render() {
    if (!catalog) return;
    const statusHtml = statusMessage
        ? `<div class="stock-count-status${statusKind ? ` stock-count-status--${statusKind}` : ''}" role="status">${escapeHtml(statusMessage)}</div>`
        : '';

    app.innerHTML = `
        <div class="stock-count">
            <header class="stock-count-header">
                <div class="nav-back-host" id="stock-nav-back"></div>
                <div>
                    <h1>Stock count</h1>
                    ${viewMode !== 'variances' ? `<p class="stock-count-subtitle">Store ${escapeHtml(STORE_NUMBER)} · ${escapeHtml(catalog.label)}</p>` : ''}
                </div>
            </header>
            ${statusHtml}
            ${viewMode === 'variances' ? buildVarianceView() : buildView()}
        </div>
        ${buildMmxProcessingOverlay()}
    `;

    window.DashboardNavBack?.mountBackButton(document.getElementById('stock-nav-back'), {
        fallback: dashboardPath(),
    });

    if (processing || mmxProcessingSuccess) {
        window.TbaBrandMark?.setBusy(true);
    } else {
        window.TbaBrandMark?.setBusy(false);
    }

    const activityEl = document.querySelector('.stock-count-mmx-activity');
    if (activityEl) {
        activityEl.scrollTop = activityEl.scrollHeight;
    }

    if (viewMode === 'entry' || viewMode === 'recount') {
        fillFormFromDraft(getCurrentLocationName());
    }

    bindEvents();
}

function bindEvents() {
    app.querySelectorAll('[data-loc-index]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const idx = Number(btn.getAttribute('data-loc-index'));
            if (!Number.isFinite(idx) || idx === currentLocationIndex) return;
            if (autoSaveTimer) {
                clearTimeout(autoSaveTimer);
                autoSaveTimer = null;
            }
            await saveCurrentLocation(false, { force: true });
            currentLocationIndex = idx;
            statusMessage = '';
            render();
        });
    });

    document.getElementById('sc-clear-page')?.addEventListener('click', () => void clearCurrentLocationPage());
    document.getElementById('sc-send-mmx')?.addEventListener('click', () => void sendToMmx());
    document.getElementById('sc-mmx-notify-btn')?.addEventListener('click', () => void enableMmxNotifications());
    document.getElementById('sc-mmx-dismiss-error')?.addEventListener('click', () => dismissMmxProcessingError());
    document.getElementById('sc-mmx-retry-poll')?.addEventListener('click', () => void resumeMmxPipelineFromError());
    document.getElementById('sc-mmx-dismiss-success')?.addEventListener('click', () => dismissMmxProcessingSuccess());
    app.querySelectorAll('.stock-count-input').forEach((input) => {
        input.addEventListener('input', scheduleAutoSave);
    });
    document.getElementById('sc-apply-mmx')?.addEventListener('click', () => void applyMmxCount());
    document.getElementById('sc-recount')?.addEventListener('click', () => void recountMmx());
}

let stockCountScrollHideTimer = null;

function setupStockCountScrollbars() {
    if (!window.matchMedia('(min-width: 901px)').matches) return;

    const root = document.documentElement;
    const reveal = () => root.classList.add('stock-count-scroll-active');
    const scheduleHide = () => {
        if (stockCountScrollHideTimer) clearTimeout(stockCountScrollHideTimer);
        stockCountScrollHideTimer = setTimeout(() => {
            root.classList.remove('stock-count-scroll-active');
            stockCountScrollHideTimer = null;
        }, 900);
    };

    window.addEventListener(
        'scroll',
        () => {
            reveal();
            scheduleHide();
        },
        { passive: true }
    );

    document.body.addEventListener('mouseenter', reveal);
    document.body.addEventListener('mouseleave', () => {
        if (!stockCountScrollHideTimer) {
            root.classList.remove('stock-count-scroll-active');
        }
    });
}

async function dismissStaleMmxSessionOnLoad() {
    endMmxProcessing();
    viewMode = 'entry';
    mmxSessionId = '';
    mmxVariances = [];
    mmxVendorSlugs = [];
    try {
        await fetchJson(apiQuery('/api/stock-count/send-to-mmx/recount'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
    } catch {
        /* ignore — always start on the count entry tab */
    }
}

async function init() {
    document.documentElement.classList.add('stock-count-page');
    document.body.classList.add('stock-count-page');
    setupStockCountScrollbars();
    setupMmxPipelineVisibilityRecovery();
    if (!STORE_NUMBER || !VENDOR_SLUG) {
        app.textContent = 'Invalid stock count URL.';
        return;
    }

    try {
        if (isCombinedMode()) {
            const { res: catRes, data: catData } = await fetchJson(
                apiQuery('/api/stock-count/catalog', 'combined')
            );
            if (!catRes.ok || !catData.success) {
                throw new Error(catData.error || 'No vendors need a stock count today.');
            }
            catalog = catData.catalog;
            combinedVendorSlugs = catData.vendorSlugs || catalog.vendorSlugs || [];
            vendorDrafts = {};
            vendorCatalogsCache.clear();
            await Promise.all(
                combinedVendorSlugs.map(async (slug) => {
                    const [catR, draftR] = await Promise.all([
                        fetchJson(apiQuery('/api/stock-count/catalog', slug)),
                        fetchJson(apiQuery('/api/stock-count/draft', slug)),
                    ]);
                    if (catR.res.ok && catR.data.success) {
                        vendorCatalogsCache.set(slug, catR.data.catalog);
                    }
                    if (draftR.res.ok && draftR.data.success) {
                        vendorDrafts[slug] = draftR.data;
                    }
                })
            );
            draft = combinedVendorSlugs.length ? vendorDrafts[combinedVendorSlugs[0]] : null;
            if (!(await tryResumePipelineOnLoad())) {
                await dismissStaleMmxSessionOnLoad();
            }
            await loadQueueStatus();
            document.title = `Stock Count — ${catalog.label}`;
            render();
            return;
        }

        const [catResult, draftResult] = await Promise.all([
            fetchJson(apiQuery('/api/stock-count/catalog')),
            fetchJson(apiQuery('/api/stock-count/draft')),
        ]);
        const { res: catRes, data: catData } = catResult;
        const { res: draftRes, data: draftData } = draftResult;
        if (!catRes.ok || !catData.success) throw new Error(catData.error || 'Catalog not found.');
        if (!draftRes.ok || !draftData.success) throw new Error(draftData.error || 'Draft not found.');
        catalog = catData.catalog;
        draft = draftData;
        if (!(await tryResumePipelineOnLoad())) {
            await dismissStaleMmxSessionOnLoad();
        }
        await loadQueueStatus();
        document.title = `Stock Count — ${catalog.label}`;
        render();
    } catch (error) {
        app.innerHTML = `<div class="stock-count"><p class="stock-count-status stock-count-status--error">${escapeHtml(error.message)}</p><p><a class="stock-count-back" href="${escapeHtml(dashboardPath())}">← Dashboard</a></p></div>`;
    }
}

void init();
