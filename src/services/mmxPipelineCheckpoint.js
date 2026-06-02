const fs = require('fs').promises;
const path = require('path');

const CHECKPOINT_FILE =
    process.env.MMX_PIPELINE_CHECKPOINT_FILE ||
    path.join(__dirname, '../../data/mmx-pipeline-checkpoints.json');

let cache = null;

function emptyState() {
    return { stores: {} };
}

async function readFileState() {
    try {
        const raw = await fs.readFile(CHECKPOINT_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.stores && typeof parsed.stores === 'object') {
            return parsed;
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn('[MMX Checkpoint] Failed to read checkpoint file:', error.message);
        }
    }
    return emptyState();
}

async function writeFileState(state) {
    await fs.mkdir(path.dirname(CHECKPOINT_FILE), { recursive: true });
    await fs.writeFile(CHECKPOINT_FILE, JSON.stringify(state, null, 2), 'utf8');
}

async function getState() {
    if (!cache) cache = await readFileState();
    return cache;
}

function keyForStore(storeNumber) {
    return String(storeNumber || '').trim();
}

async function setCheckpoint(storeNumber, patch) {
    const all = await getState();
    const key = keyForStore(storeNumber);
    const prev = all.stores[key] && typeof all.stores[key] === 'object' ? all.stores[key] : {};
    all.stores[key] = {
        ...prev,
        ...patch,
        storeNumber: key,
        updatedAt: new Date().toISOString(),
    };
    cache = all;
    await writeFileState(all);
    return all.stores[key];
}

async function getCheckpoint(storeNumber) {
    const all = await getState();
    return all.stores[keyForStore(storeNumber)] || null;
}

async function clearCheckpoint(storeNumber) {
    const all = await getState();
    const key = keyForStore(storeNumber);
    if (!all.stores[key]) return false;
    delete all.stores[key];
    cache = all;
    await writeFileState(all);
    return true;
}

module.exports = {
    CHECKPOINT_FILE,
    setCheckpoint,
    getCheckpoint,
    clearCheckpoint,
};
