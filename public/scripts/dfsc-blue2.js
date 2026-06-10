/**
 * Cooper-Atkins Blue2 (20100-K) — Web Bluetooth, aligned with SafetyCulture / iAuditor flow:
 * connect → live readings → capture when stable (< 0.3° change, same as Mobile Auditor).
 */
(function () {
    const TEMP_SERVICE_UUID = '78544002-4394-4fc2-8cfd-be6a00aa701b';
    const TEMP_SERVICE_ALT_UUID = '78544001-4394-4fc2-8cfd-be6a00aa701b';
    const TEMP_CHAR_UUID = '78544003-4394-4fc2-8cfd-be6a00aa701b';
    const BATTERY_SERVICE_UUID = '0000180f-0000-1000-8000-00805f9b34fb';
    const BATTERY_CHAR_UUID = '00002a19-0000-1000-8000-00805f9b34fb';

    const OPTIONAL_SERVICE_UUIDS = [
        TEMP_SERVICE_UUID,
        TEMP_SERVICE_ALT_UUID,
        TEMP_CHAR_UUID,
        BATTERY_SERVICE_UUID,
        '00001809-0000-1000-8000-00805f9b34fb',
        '0000180a-0000-1000-8000-00805f9b34fb',
    ];

    const STABILITY_DELTA = 0.3;
    const CAPTURE_TIMEOUT_MS = 10000;

    let device = null;
    let characteristic = null;
    let ready = false;
    let connecting = false;
    let lastReading = null;
    let listeners = new Set();
    let pendingCapture = null;
    let stableCaptureSession = null;

    function isSupported() {
        return !getSupportBlockReason();
    }

    /** Plain-language reason Web Bluetooth cannot run (empty string = OK). */
    function getSupportBlockReason() {
        if (typeof navigator === 'undefined') {
            return 'Bluetooth connect is not available in this browser.';
        }
        if (typeof window !== 'undefined' && !window.isSecureContext) {
            return 'Open DFSC via HTTPS (https://…), not http://. Web Bluetooth requires a secure connection.';
        }
        if (!navigator.bluetooth) {
            return 'Use Chrome or Edge on Android, tablet, or PC. Safari, Firefox, and Samsung Internet do not support in-browser Bluetooth connect.';
        }
        return '';
    }

    function canonicalUuid(uuid) {
        try {
            return BluetoothUUID.canonicalUUID(uuid);
        } catch {
            return String(uuid || '').toLowerCase();
        }
    }

    function uuidMatches(a, b) {
        return canonicalUuid(a) === canonicalUuid(b);
    }

    function notify() {
        const state = getState();
        for (const fn of listeners) {
            try {
                fn(state);
            } catch (_) {
                /* ignore listener errors */
            }
        }
    }

    function getState() {
        const gattConnected = Boolean(device?.gatt?.connected);
        return {
            supported: isSupported(),
            connecting,
            connected: ready && gattConnected,
            gattConnected,
            ready,
            deviceName: device?.name || '',
            lastReading,
        };
    }

    function publishReading(celsius) {
        if (celsius == null || !Number.isFinite(celsius)) return;
        lastReading = {
            celsius,
            capturedAt: new Date().toISOString(),
        };
        notify();
        if (pendingCapture) {
            const resolve = pendingCapture;
            pendingCapture = null;
            resolve(celsius);
        }
        if (stableCaptureSession) {
            stableCaptureSession.onReading(celsius);
        }
    }

    function onNotify(event) {
        const value = event.target?.value;
        if (!value) return;
        const parsed = parseTemperature(value);
        if (parsed == null) return;
        publishReading(parsed);
    }

    function parseTemperature(dataView) {
        const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
        if (!bytes.length) return null;

        try {
            const text = new TextDecoder('utf-8').decode(bytes).replace(/\0/g, '').trim();
            if (text) {
                const fMatch = text.match(/(-?\d+(?:\.\d+)?)\s*°?\s*F\b/i);
                if (fMatch) return round1(((Number(fMatch[1]) - 32) * 5) / 9);
                const cMatch = text.match(/(-?\d+(?:\.\d+)?)\s*°?\s*C\b/i);
                if (cMatch) return round1(Number(cMatch[1]));
                const numMatch = text.match(/-?\d+(?:\.\d+)?/);
                if (numMatch) {
                    let value = Number(numMatch[0]);
                    if (!Number.isFinite(value)) return null;
                    if (/f\b|°f/i.test(text)) value = ((value - 32) * 5) / 9;
                    return round1(value);
                }
            }
        } catch {
            /* fall through */
        }

        if (bytes.length >= 4) {
            const ieee = parseIeee11073Float(bytes[0], bytes[1], bytes[2], bytes[3]);
            if (ieee != null) return round1(ieee);
        }

        if (bytes.length >= 2) {
            const raw = bytes[0] + bytes[1] * 256;
            const signed = raw > 0x7fff ? raw - 0x10000 : raw;
            if (Math.abs(signed) < 5000) return round1(signed / 10);
        }

        if (bytes.length === 1 && bytes[0] !== 0xff) return round1(bytes[0]);

        return null;
    }

    function parseIeee11073Float(b0, b1, b2, b3) {
        let exponent = b3;
        if (exponent > 127) exponent -= 256;
        let mantissa = b0 | (b1 << 8) | (b2 << 16);
        if (mantissa > 0x7fffff) mantissa -= 0x1000000;
        if (mantissa === 0x7fffff || mantissa === -0x800000) return null;
        return mantissa * 10 ** exponent;
    }

    function round1(n) {
        return Math.round(n * 10) / 10;
    }

    async function readBatteryLevel(server) {
        try {
            const batteryService = await server.getPrimaryService(BATTERY_SERVICE_UUID);
            const batteryChar = await batteryService.getCharacteristic(BATTERY_CHAR_UUID);
            await batteryChar.readValue();
        } catch {
            /* Cooper-Atkins firmware often still works without this */
        }
    }

    async function getTemperatureCharacteristic(server) {
        for (const serviceUuid of [TEMP_SERVICE_UUID, TEMP_SERVICE_ALT_UUID]) {
            try {
                const service = await server.getPrimaryService(serviceUuid);
                return await service.getCharacteristic(TEMP_CHAR_UUID);
            } catch {
                /* try next */
            }
        }

        const services = await server.getPrimaryServices();
        for (const service of services) {
            try {
                const chars = await service.getCharacteristics();
                for (const char of chars) {
                    if (uuidMatches(char.uuid, TEMP_CHAR_UUID)) return char;
                }
            } catch {
                /* some services may not expose characteristics */
            }
        }
        throw new Error('Bluetooth thermometer temperature service not found. Choose the Cooper-Atkins Blue2.');
    }

    async function requestBlue2Device() {
        const requestOptions = {
            optionalServices: OPTIONAL_SERVICE_UUIDS,
        };

        // OR filters — pairing mode often advertises the name only, not the temp service UUID.
        const filters = [
            { name: 'Blue2' },
            { namePrefix: 'Blue' },
            { namePrefix: 'Cooper' },
            { namePrefix: 'MFT' },
            { services: [TEMP_SERVICE_UUID] },
            { services: [TEMP_SERVICE_ALT_UUID] },
        ];

        try {
            return await navigator.bluetooth.requestDevice({
                ...requestOptions,
                filters,
            });
        } catch (err) {
            if (err?.name !== 'NotFoundError') throw err;
        }

        return navigator.bluetooth.requestDevice({
            ...requestOptions,
            acceptAllDevices: true,
        });
    }

    async function setupTemperatureStream(server) {
        await readBatteryLevel(server);
        const char = await getTemperatureCharacteristic(server);
        await char.startNotifications();
        char.addEventListener('characteristicvaluechanged', onNotify);
        try {
            const initial = await char.readValue();
            const parsed = parseTemperature(initial);
            if (parsed != null) publishReading(parsed);
        } catch {
            /* notifications will populate reading */
        }
        return char;
    }

    function markDisconnected() {
        characteristic = null;
        ready = false;
        notify();
    }

    async function connect() {
        if (!isSupported()) {
            throw new Error('Web Bluetooth is not available in this browser. Use Chrome or Edge on Android/tablet/desktop.');
        }

        if (ready && device?.gatt?.connected && characteristic) return getState();

        connecting = true;
        notify();

        try {
            if (!device || !device.gatt?.connected) {
                const picked = await requestBlue2Device();
                if (device && device !== picked) {
                    try {
                        if (device.gatt?.connected) device.gatt.disconnect();
                    } catch {
                        /* ignore */
                    }
                }
                device = picked;
                device.addEventListener('gattserverdisconnected', markDisconnected);
                const server = await device.gatt.connect();
                characteristic = await setupTemperatureStream(server);
            } else if (!characteristic) {
                characteristic = await setupTemperatureStream(device.gatt);
            }

            ready = true;
            notify();
            return getState();
        } catch (err) {
            markDisconnected();
            throw err;
        } finally {
            connecting = false;
            notify();
        }
    }

    async function disconnect() {
        pendingCapture = null;
        stableCaptureSession = null;
        connecting = false;
        if (characteristic) {
            try {
                characteristic.removeEventListener('characteristicvaluechanged', onNotify);
                await characteristic.stopNotifications();
            } catch {
                /* ignore */
            }
        }
        characteristic = null;
        ready = false;
        if (device?.gatt?.connected) {
            try {
                device.gatt.disconnect();
            } catch {
                /* ignore */
            }
        }
        device = null;
        lastReading = null;
        notify();
    }

    function waitForReading(timeoutMs = 8000) {
        if (lastReading?.celsius != null) return Promise.resolve(lastReading.celsius);
        return new Promise((resolve, reject) => {
            const timer = window.setTimeout(() => {
                pendingCapture = null;
                reject(new Error('No reading from Bluetooth thermometer yet — insert the probe and wait a moment.'));
            }, timeoutMs);
            pendingCapture = (value) => {
                window.clearTimeout(timer);
                resolve(value);
            };
        });
    }

    async function readCurrentCelsius() {
        if (!device?.gatt?.connected || !characteristic || !ready) {
            throw new Error('Bluetooth thermometer is not connected.');
        }
        try {
            const value = await characteristic.readValue();
            const parsed = parseTemperature(value);
            if (parsed != null) {
                publishReading(parsed);
                return parsed;
            }
        } catch {
            /* wait for notify or use recent cached reading */
        }
        if (lastReading?.celsius != null) {
            const ageMs = Date.now() - Date.parse(lastReading.capturedAt || '');
            if (!Number.isFinite(ageMs) || ageMs < 15000) return lastReading.celsius;
        }
        return waitForReading();
    }

    /**
     * SafetyCulture / Mobile Auditor stability: lock when two readings are within 0.3°.
     * Calls onProgress(celsius) as live values arrive (about once per second).
     */
    async function captureStableCelsius(onProgress, { timeoutMs = CAPTURE_TIMEOUT_MS } = {}) {
        if (!device?.gatt?.connected || !characteristic || !ready) {
            throw new Error('Bluetooth thermometer is not connected.');
        }

        await readCurrentCelsius().catch(() => {});

        return new Promise((resolve, reject) => {
            let previous = null;
            let settled = false;
            const timer = window.setTimeout(() => {
                if (settled) return;
                settled = true;
                stableCaptureSession = null;
                reject(new Error('Temperature did not stabilize in time — check the probe and try again.'));
            }, timeoutMs);

            stableCaptureSession = {
                onReading(celsius) {
                    if (settled) return;
                    if (onProgress) onProgress(celsius);
                    if (previous != null && Math.abs(celsius - previous) < STABILITY_DELTA) {
                        settled = true;
                        window.clearTimeout(timer);
                        stableCaptureSession = null;
                        resolve(celsius);
                        return;
                    }
                    previous = celsius;
                },
            };

            if (lastReading?.celsius != null) {
                stableCaptureSession.onReading(lastReading.celsius);
            }
        });
    }

    async function captureCelsius() {
        return captureStableCelsius();
    }

    function onStateChange(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    window.DfscBlue2 = {
        isSupported,
        getSupportBlockReason,
        getState,
        connect,
        disconnect,
        readCurrentCelsius,
        captureCelsius,
        captureStableCelsius,
        onStateChange,
    };
})();
