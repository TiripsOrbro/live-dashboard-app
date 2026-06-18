/**
 * Cross-process MMX task queue - MIC (1) > Admin (2) > Scrape (3).
 * One browser slot on disk; in-process ref-count for nested MIC/admin holds.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('../../src/paths');
const {
    acquireMmxResource,
    releaseMmxResource,
    refreshScrapePauseTimeout,
    abortCompetingMmxWork,
} = require('./mmxResourceGate');

const DATA_DIR = paths.dashboard.data;
const QUEUE_FILE = path.join(DATA_DIR, 'mmx-task-queue.json');
const ACTIVE_FILE = path.join(DATA_DIR, 'mmx-task-active.json');
const LOCK_FILE = path.join(DATA_DIR, 'mmx-task-lock');
const PREEMPT_FILE = path.join(DATA_DIR, 'mmx-preempt-request.json');

const PRIORITY = Object.freeze({ MIC: 1, ADMIN: 2, SCRAPE: 3 });

const STALE_ACTIVE_MS = Number(process.env.MMX_TASK_STALE_MS || 2 * 60 * 60 * 1000);
const POLL_MS = Number(process.env.MMX_TASK_POLL_MS || 500);
const WAIT_TIMEOUT_MS = Number(process.env.MMX_TASK_WAIT_TIMEOUT_MS || 60 * 60 * 1000);

const localHoldCounts = new Map([
    [PRIORITY.MIC, 0],
    [PRIORITY.ADMIN, 0],
    [PRIORITY.SCRAPE, 0],
]);
let localSlotMeta = null;
let lastPreemptHandledAt = 0;

class MmxTaskQueueBusyError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'MmxTaskQueueBusyError';
        this.details = details;
    }
}

class MmxTaskQueueTimeoutError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'MmxTaskQueueTimeoutError';
        this.details = details;
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDataDir() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJsonAtomic(file, value) {
    ensureDataDir();
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
}

function readQueueDoc() {
    const doc = readJson(QUEUE_FILE, { pending: [] });
    if (!Array.isArray(doc.pending)) doc.pending = [];
    return doc;
}

function writeQueueDoc(doc) {
    writeJsonAtomic(QUEUE_FILE, doc);
}

function readActiveTask() {
    const active = readJson(ACTIVE_FILE, null);
    if (!active || typeof active !== 'object') return null;
    return active;
}

function writeActiveTask(active) {
    if (!active) {
        if (fs.existsSync(ACTIVE_FILE)) fs.unlinkSync(ACTIVE_FILE);
        return;
    }
    writeJsonAtomic(ACTIVE_FILE, active);
}

function readPreemptRequest() {
    return readJson(PREEMPT_FILE, null);
}

function writePreemptRequest(payload) {
    if (!payload) {
        if (fs.existsSync(PREEMPT_FILE)) fs.unlinkSync(PREEMPT_FILE);
        return;
    }
    writeJsonAtomic(PREEMPT_FILE, payload);
}

function isPidAlive(pid) {
    const n = Number(pid);
    if (!Number.isFinite(n) || n <= 0) return false;
    if (n === process.pid) return true;
    try {
        process.kill(n, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM';
    }
}

function isActiveStale(active) {
    if (!active?.startedAt) return true;
    return Date.now() - Number(active.startedAt) > STALE_ACTIVE_MS;
}

function clearStaleActiveIfNeeded() {
    const active = readActiveTask();
    if (!active) return null;
    if (isPidAlive(active.pid) && !isActiveStale(active)) return active;
    console.warn(
        `[MMX Queue] Clearing stale active task (${active.label || active.type || 'unknown'}, pid ${active.pid})`
    );
    writeActiveTask(null);
    try {
        if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
    } catch {
        /* ignore */
    }
    return null;
}

/** Drop pending rows whose owner process exited without acquiring or releasing the slot. */
function purgeStalePendingTasks() {
    const doc = readQueueDoc();
    const before = doc.pending.length;
    if (!before) return 0;
    doc.pending = doc.pending.filter((row) => isPidAlive(row.pid));
    const removed = before - doc.pending.length;
    if (removed > 0) {
        console.warn(`[MMX Queue] Removed ${removed} stale pending task(s) from dead process(es)`);
        writeQueueDoc(doc);
    }
    return removed;
}

function describeQueueWaitBlockers(taskId) {
    const doc = readQueueDoc();
    const pending = sortPending(doc.pending);
    const idx = pending.findIndex((row) => row.id === taskId);
    const ahead = idx > 0 ? pending.slice(0, idx) : [];
    const active = readActiveTask();
    const parts = [];
    if (active && isPidAlive(active.pid) && !isActiveStale(active)) {
        parts.push(`active: ${active.label || active.type} (pid ${active.pid})`);
    }
    for (const row of ahead) {
        const alive = isPidAlive(row.pid);
        parts.push(
            `ahead: ${row.label || row.type} (pid ${row.pid}${alive ? '' : ', dead'})`
        );
    }
    return parts.length ? parts.join('; ') : '';
}

function sortPending(pending) {
    return [...pending].sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return (a.enqueuedAt || 0) - (b.enqueuedAt || 0);
    });
}

function generateTaskId() {
    return `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function getLocalHoldCount(priority) {
    return localHoldCounts.get(priority) || 0;
}

function incrementLocalHold(priority) {
    localHoldCounts.set(priority, getLocalHoldCount(priority) + 1);
}

function decrementLocalHold(priority) {
    const next = Math.max(0, getLocalHoldCount(priority) - 1);
    localHoldCounts.set(priority, next);
    return next;
}

function tryAcquireLockFile(taskId) {
    ensureDataDir();
    try {
        const fd = fs.openSync(LOCK_FILE, 'wx');
        fs.writeSync(fd, `${taskId}\n`);
        fs.closeSync(fd);
        return true;
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        return false;
    }
}

function releaseLockFile() {
    try {
        if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
    } catch {
        /* ignore */
    }
}

function enqueueTask(meta) {
    purgeStalePendingTasks();
    const doc = readQueueDoc();
    doc.pending.push(meta);
    doc.pending = sortPending(doc.pending);
    writeQueueDoc(doc);
    return doc.pending.findIndex((row) => row.id === meta.id) + 1;
}

function removeTaskFromQueue(taskId) {
    const doc = readQueueDoc();
    doc.pending = doc.pending.filter((row) => row.id !== taskId);
    writeQueueDoc(doc);
}

function getQueueSnapshot() {
    clearStaleActiveIfNeeded();
    purgeStalePendingTasks();
    return {
        active: readActiveTask(),
        pending: sortPending(readQueueDoc().pending),
        preempt: readPreemptRequest(),
    };
}

function hasPendingHigherPriority(thanPriority) {
    const { pending, active } = getQueueSnapshot();
    if (active && Number(active.priority) < thanPriority && isPidAlive(active.pid) && !isActiveStale(active)) {
        return true;
    }
    return pending.some((row) => Number(row.priority) < thanPriority);
}

function hasBlockingWorkForPriority(priority) {
    const { pending, active } = getQueueSnapshot();
    if (active && isPidAlive(active.pid) && !isActiveStale(active)) {
        if (Number(active.priority) < priority) return true;
        if (Number(active.priority) === priority && Number(active.pid) !== process.pid) return true;
    }
    const head = sortPending(pending)[0];
    if (!head) return false;
    if (head.priority < priority) return true;
    return false;
}

function requestPreemptLowerPriority(fromPriority, reason) {
    // Scrape (lowest priority) must not abort its own browser work when acquiring a slot.
    if (fromPriority >= PRIORITY.SCRAPE) return;

    const payload = {
        priority: fromPriority,
        reason: String(reason || 'higher-priority MMX work').trim(),
        requestedAt: Date.now(),
        requestedByPid: process.pid,
    };
    writePreemptRequest(payload);
    abortCompetingMmxWork(payload.reason);
}

function clearPreemptIfMatches(priority) {
    const req = readPreemptRequest();
    if (req && Number(req.priority) === priority) {
        writePreemptRequest(null);
    }
}

function shouldAbortForPreempt(localPriority) {
    const req = readPreemptRequest();
    if (!req || !localPriority) return false;
    if (Number(req.requestedAt) <= lastPreemptHandledAt) return false;
    return Number(req.priority) < Number(localPriority);
}

function markPreemptHandled() {
    const req = readPreemptRequest();
    if (req?.requestedAt) lastPreemptHandledAt = Number(req.requestedAt);
}

function getLocalSlotPriority() {
    return localSlotMeta?.priority ?? null;
}

async function waitForQueueTurn(taskId, priority) {
    const started = Date.now();
    let lastWaitLogAt = 0;
    while (true) {
        if (Date.now() - started > WAIT_TIMEOUT_MS) {
            removeTaskFromQueue(taskId);
            throw new MmxTaskQueueTimeoutError('Timed out waiting for MMX task queue', {
                taskId,
                priority,
                queue: getQueueSnapshot(),
            });
        }

        clearStaleActiveIfNeeded();
        purgeStalePendingTasks();
        const doc = readQueueDoc();
        const pending = sortPending(doc.pending);
        const head = pending[0];
        const active = readActiveTask();

        if (head?.id !== taskId) {
            if (Date.now() - lastWaitLogAt > 15000) {
                const blockers = describeQueueWaitBlockers(taskId);
                if (blockers) {
                    console.log(`[MMX Queue] Still waiting (P${priority}) - ${blockers}`);
                }
                lastWaitLogAt = Date.now();
            }
            await sleep(POLL_MS);
            continue;
        }

        if (active && isPidAlive(active.pid) && !isActiveStale(active)) {
            if (Number(active.priority) > priority) {
                requestPreemptLowerPriority(priority, head.label || head.type || 'MMX queue');
                await sleep(POLL_MS);
                continue;
            }
            if (Number(active.priority) < priority || Number(active.pid) !== process.pid) {
                await sleep(POLL_MS);
                continue;
            }
        }

        if (!tryAcquireLockFile(taskId)) {
            await sleep(POLL_MS);
            continue;
        }

        removeTaskFromQueue(taskId);
        const activeMeta = {
            id: taskId,
            priority,
            type: head.type,
            label: head.label,
            pid: process.pid,
            startedAt: Date.now(),
        };
        writeActiveTask(activeMeta);
        localSlotMeta = activeMeta;
        requestPreemptLowerPriority(priority, head.label || head.type || 'MMX queue');
        return activeMeta;
    }
}

async function acquirePrioritySlot(priority, { type, label }) {
    if (getLocalHoldCount(priority) > 0) {
        incrementLocalHold(priority);
        if (priority === PRIORITY.MIC) refreshScrapePauseTimeout();
        return { nested: true, taskId: localSlotMeta?.id || null };
    }

    const taskId = generateTaskId();
    const meta = {
        id: taskId,
        priority,
        type: String(type || 'mmx-task'),
        label: String(label || type || 'MMX task'),
        pid: process.pid,
        enqueuedAt: Date.now(),
    };
    const position = enqueueTask(meta);
    if (position > 1) {
        console.log(`[MMX Queue] Waiting (P${priority} ${meta.label}) - position ${position}`);
    }

    await waitForQueueTurn(taskId, priority);
    incrementLocalHold(priority);
    acquireMmxResource(meta.label);
    if (priority === PRIORITY.MIC) refreshScrapePauseTimeout();
    return { nested: false, taskId, position };
}

async function releasePrioritySlot(priority, label) {
    const remaining = decrementLocalHold(priority);
    if (remaining > 0) {
        if (priority === PRIORITY.MIC) refreshScrapePauseTimeout();
        return;
    }

    releaseMmxResource(label);
    writeActiveTask(null);
    releaseLockFile();
    clearPreemptIfMatches(priority);
    localSlotMeta = null;
}

async function runWithPriority(priority, { type, label, run }) {
    await acquirePrioritySlot(priority, { type, label });
    try {
        return await run();
    } finally {
        await releasePrioritySlot(priority, label);
    }
}

function startPreemptPoller() {
    setInterval(() => {
        const localPriority = getLocalSlotPriority();
        if (!localPriority || getLocalHoldCount(localPriority) <= 0) return;
        if (!shouldAbortForPreempt(localPriority)) return;
        const req = readPreemptRequest();
        markPreemptHandled();
        abortCompetingMmxWork(req?.reason || 'higher-priority MMX work');
    }, POLL_MS).unref?.();
}

startPreemptPoller();

module.exports = {
    PRIORITY,
    MmxTaskQueueBusyError,
    MmxTaskQueueTimeoutError,
    runWithPriority,
    acquirePrioritySlot,
    releasePrioritySlot,
    getLocalHoldCount,
    hasPendingHigherPriority,
    hasBlockingWorkForPriority,
    requestPreemptLowerPriority,
    getQueueSnapshot,
    purgeStalePendingTasks,
    clearStaleActiveIfNeeded,
    getLocalSlotPriority,
    shouldAbortForPreempt,
    markPreemptHandled,
};
