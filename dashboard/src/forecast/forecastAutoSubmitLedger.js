const fs = require('fs');
const path = require('path');

const paths = require('../../../src/paths');
const { scheduleHour, TIME_ZONE, msUntilNextScheduleRun } = require('./forecastSchedule');

const SETTINGS_FILE = path.join(paths.dashboard.data, 'forecast-auto-submit.json');

function defaultSettings() {
    return {
        enabled: false,
        updatedAt: null,
        updatedBy: null,
        scheduleHour: scheduleHour(),
        timeZone: TIME_ZONE,
    };
}

function readAutoSubmitSettings() {
    if (!fs.existsSync(SETTINGS_FILE)) return defaultSettings();
    try {
        const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        const base = defaultSettings();
        return {
            ...base,
            ...raw,
            enabled: Boolean(raw.enabled),
            scheduleHour: Number.isFinite(Number(raw.scheduleHour)) ? Number(raw.scheduleHour) : base.scheduleHour,
        };
    } catch {
        return defaultSettings();
    }
}

function writeAutoSubmitSettings(patch = {}, updatedBy = null) {
    const prev = readAutoSubmitSettings();
    const doc = {
        ...prev,
        ...patch,
        enabled: patch.enabled != null ? Boolean(patch.enabled) : prev.enabled,
        scheduleHour: patch.scheduleHour != null ? Number(patch.scheduleHour) : prev.scheduleHour,
        timeZone: String(patch.timeZone || prev.timeZone || TIME_ZONE).trim(),
        updatedAt: new Date().toISOString(),
        updatedBy: updatedBy ? String(updatedBy).trim() : prev.updatedBy,
    };
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    return doc;
}

function isAutoSubmitEnabled() {
    return Boolean(readAutoSubmitSettings().enabled);
}

function buildAutoSubmitStatus() {
    const settings = readAutoSubmitSettings();
    return {
        ...settings,
        nextRunInMs: msUntilNextScheduleRun(),
    };
}

module.exports = {
    SETTINGS_FILE,
    readAutoSubmitSettings,
    writeAutoSubmitSettings,
    isAutoSubmitEnabled,
    buildAutoSubmitStatus,
};
