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
    const HEALTH_THERMOMETER_SERVICE = '00001809-0000-1000-8000-00805f9b34fb';
    const HEALTH_THERMOMETER_CHAR = '00002a1c-0000-1000-8000-00805f9b34fb';
    const GATT_CONNECT_SETTLE_MS = 400;
    const GATT_CONNECT_ATTEMPTS = 3;
    const COOPER_WAKE_DELAY_MS = 350;
    const TEMP_DISCOVERY_ATTEMPTS = 3;

    const COOPER_VENDOR_SERVICES = Array.from({ length: 12 }, (_, index) => {
        const slot = String(index + 1).padStart(2, '0');
        return `785440${slot}-4394-4fc2-8cfd-be6a00aa701b`;
    });

    const OPTIONAL_SERVICE_UUIDS = [
        ...COOPER_VENDOR_SERVICES,
        BATTERY_SERVICE_UUID,
        HEALTH_THERMOMETER_SERVICE,
        '0000180a-0000-1000-8000-00805f9b34fb',
        '00001800-0000-1000-8000-00805f9b34fb',
        '00001801-0000-1000-8000-00805f9b34fb',
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

    function sleep(ms) {
        return new Promise((resolve) => window.setTimeout(resolve, ms));
    }

    function charHasLiveUpdates(char) {
        const props = char?.properties || {};
        return Boolean(props.notify || props.indicate);
    }

    function isCooperServiceUuid(uuid) {
        return canonicalUuid(uuid).includes('785440');
    }

    function isGattDisconnectedError(err) {
        const msg = String(err?.message || err || '').toLowerCase();
        return (
            err?.name === 'NetworkError' ||
            msg.includes('gatt server is disconnected') ||
            msg.includes('reconnect first') ||
            msg.includes('gatt server is not connected') ||
            msg.includes('device is disconnected')
        );
    }

    function bindDisconnectHandler(bleDevice) {
        if (!bleDevice || bleDevice._dfscDisconnectBound) return;
        bleDevice.addEventListener('gattserverdisconnected', markDisconnected);
        bleDevice._dfscDisconnectBound = true;
    }

    async function waitForGattConnected(bleDevice) {
        let server = bleDevice.gatt;
        if (!server) throw new Error('Bluetooth GATT is not available on this device.');
        if (!server.connected) {
            server = await server.connect();
        }
        const deadline = Date.now() + 6000;
        while (!server.connected && Date.now() < deadline) {
            await sleep(100);
        }
        if (!server.connected) {
            throw new Error('GATT Server is disconnected. Cannot retrieve services. (Re)connect first with device.gatt.connect');
        }
        await sleep(GATT_CONNECT_SETTLE_MS);
        return server;
    }

    async function connectGattWithRetry(bleDevice) {
        let lastErr = null;
        for (let attempt = 0; attempt < GATT_CONNECT_ATTEMPTS; attempt += 1) {
            try {
                return await waitForGattConnected(bleDevice);
            } catch (err) {
                lastErr = err;
                if (!isGattDisconnectedError(err) || attempt + 1 >= GATT_CONNECT_ATTEMPTS) break;
                try {
                    if (bleDevice.gatt?.connected) bleDevice.gatt.disconnect();
                } catch {
                    /* ignore */
                }
                await sleep(500);
            }
        }
        throw lastErr || new Error('Could not connect to Bluetooth thermometer.');
    }

    async function runWithGatt(bleDevice, fn) {
        let lastErr = null;
        for (let attempt = 0; attempt < GATT_CONNECT_ATTEMPTS; attempt += 1) {
            try {
                const server = await connectGattWithRetry(bleDevice);
                return await fn(server);
            } catch (err) {
                lastErr = err;
                if (!isGattDisconnectedError(err) || attempt + 1 >= GATT_CONNECT_ATTEMPTS) throw err;
                try {
                    if (bleDevice.gatt?.connected) bleDevice.gatt.disconnect();
                } catch {
                    /* ignore */
                }
                await sleep(500);
            }
        }
        throw lastErr || new Error('Could not connect to Bluetooth thermometer.');
    }

    function normalizeConnectError(err) {
        const msg = String(err?.message || err || 'Could not connect to Bluetooth thermometer.');
        if (err?.name === 'NotFoundError') {
            return new Error(
                'No Bluetooth device found — put Blue2 in pairing mode, enable Chrome “Nearby devices”, and try again.'
            );
        }
        if (err?.name === 'SecurityError' || /not allowed to access the service/i.test(msg)) {
            return new Error(
                'Chrome blocked thermometer access — close this tab, reopen DFSC, and tap Connect again.'
            );
        }
        if (err?.name === 'NetworkError' || /gatt|op in progress|connection/i.test(msg)) {
            return new Error(
                'Bluetooth connection failed — keep Blue2 in pairing mode (flashing icon). If it is paired in Android Settings → Bluetooth, tap Forget device, then connect only through DFSC.'
            );
        }
        if (/temperature service not found/i.test(msg)) {
            return new Error(
                'Connected to Blue2 but the temperature channel is not available yet — keep the probe switched on and tap Connect again. If this repeats, forget Blue2 in Android Settings → Bluetooth, then connect only through DFSC.'
            );
        }
        if (isGattDisconnectedError(err)) {
            return new Error(
                'Bluetooth disconnected while connecting — keep Blue2 in pairing mode (flashing icon) until connected. If Blue2 appears in Android Settings → Bluetooth, tap Forget device, then connect only through DFSC.'
            );
        }
        return err instanceof Error ? err : new Error(msg);
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

    async function listGrantedServices(server) {
        try {
            return await server.getPrimaryServices();
        } catch (err) {
            if (isGattDisconnectedError(err)) throw err;
            return [];
        }
    }

    async function findCharacteristicByUuid(server, targetUuid) {
        const target = canonicalUuid(targetUuid);
        const services = await listGrantedServices(server);
        for (const service of services) {
            try {
                const direct = await service.getCharacteristic(targetUuid);
                if (direct) return direct;
            } catch {
                /* scan all characteristics on this service */
            }
            try {
                const chars = await service.getCharacteristics();
                for (const char of chars) {
                    if (canonicalUuid(char.uuid) === target) return char;
                }
            } catch {
                /* ignore inaccessible service */
            }
        }
        return null;
    }

    async function pickLiveCharacteristic(service) {
        try {
            return await service.getCharacteristic(TEMP_CHAR_UUID);
        } catch {
            /* try notify/indicate characteristics on this service */
        }
        try {
            return await service.getCharacteristic(HEALTH_THERMOMETER_CHAR);
        } catch {
            /* not standard health thermometer */
        }
        const chars = await service.getCharacteristics();
        for (const char of chars) {
            if (uuidMatches(char.uuid, TEMP_CHAR_UUID)) return char;
        }
        for (const char of chars) {
            if (charHasLiveUpdates(char)) return char;
        }
        return null;
    }

    async function getTemperatureCharacteristic(server) {
        if (!server?.connected) {
            throw new Error('GATT Server is disconnected. Cannot retrieve services. (Re)connect first with device.gatt.connect');
        }

        const directChar = await findCharacteristicByUuid(server, TEMP_CHAR_UUID);
        if (directChar) return directChar;

        const serviceCandidates = [
            TEMP_SERVICE_UUID,
            TEMP_SERVICE_ALT_UUID,
            HEALTH_THERMOMETER_SERVICE,
            ...COOPER_VENDOR_SERVICES,
        ];

        for (const serviceUuid of serviceCandidates) {
            try {
                const service = await server.getPrimaryService(serviceUuid);
                const char = await pickLiveCharacteristic(service);
                if (char) return char;
            } catch (err) {
                if (isGattDisconnectedError(err)) throw err;
                /* try next */
            }
        }

        const services = await listGrantedServices(server);

        for (const service of services) {
            if (!isCooperServiceUuid(service.uuid)) continue;
            try {
                const char = await pickLiveCharacteristic(service);
                if (char) return char;
            } catch (err) {
                if (isGattDisconnectedError(err)) throw err;
                /* try next service */
            }
        }

        for (const service of services) {
            try {
                const char = await pickLiveCharacteristic(service);
                if (char) return char;
            } catch (err) {
                if (isGattDisconnectedError(err)) throw err;
                /* try next service */
            }
        }

        const granted = services.map((service) => canonicalUuid(service.uuid)).join(', ');
        throw new Error(
            `Bluetooth thermometer temperature service not found.${granted ? ` Granted services: ${granted}.` : ''}`
        );
    }

    async function requestBlue2Device({ serviceOnly = false } = {}) {
        const requestOptions = {
            optionalServices: OPTIONAL_SERVICE_UUIDS,
        };

        if (serviceOnly) {
            return navigator.bluetooth.requestDevice({
                ...requestOptions,
                filters: [
                    { services: [TEMP_SERVICE_UUID] },
                    { services: [TEMP_SERVICE_ALT_UUID] },
                ],
            });
        }

        // OR filters — pairing mode often advertises the name only, not the temp service UUID.
        const filters = [
            { name: 'Blue2' },
            { name: 'Blue2-D' },
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

    async function discoverTemperatureCharacteristic(server) {
        let lastErr = null;
        for (let attempt = 0; attempt < TEMP_DISCOVERY_ATTEMPTS; attempt += 1) {
            try {
                await readBatteryLevel(server);
                await sleep(COOPER_WAKE_DELAY_MS);
                return await getTemperatureCharacteristic(server);
            } catch (err) {
                lastErr = err;
                if (isGattDisconnectedError(err)) throw err;
                if (!/temperature service not found/i.test(String(err?.message || err))) throw err;
                if (attempt + 1 >= TEMP_DISCOVERY_ATTEMPTS) break;
                await sleep(400);
            }
        }
        throw lastErr || new Error('Bluetooth thermometer temperature service not found.');
    }

    async function setupTemperatureStream(server) {
        const char = await discoverTemperatureCharacteristic(server);
        if (charHasLiveUpdates(char)) {
            await char.startNotifications();
            char.addEventListener('characteristicvaluechanged', onNotify);
        }
        try {
            const initial = await char.readValue();
            const parsed = parseTemperature(initial);
            if (parsed != null) publishReading(parsed);
        } catch {
            /* notifications will populate reading */
        }
        return char;
    }

    async function connectDeviceStream(bleDevice, { allowServicePickerFallback = true } = {}) {
        try {
            return await runWithGatt(bleDevice, (server) => setupTemperatureStream(server));
        } catch (err) {
            const msg = String(err?.message || err || '');
            if (!allowServicePickerFallback || !/temperature service not found/i.test(msg)) throw err;

            const repicked = await requestBlue2Device({ serviceOnly: true });
            if (bleDevice?.gatt?.connected) {
                try {
                    bleDevice.gatt.disconnect();
                } catch {
                    /* ignore */
                }
            }
            device = repicked;
            bindDisconnectHandler(device);
            return runWithGatt(repicked, (server) => setupTemperatureStream(server));
        }
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
                bindDisconnectHandler(device);
                characteristic = await connectDeviceStream(device);
            } else if (!characteristic) {
                bindDisconnectHandler(device);
                characteristic = await connectDeviceStream(device, { allowServicePickerFallback: false });
            }

            ready = true;
            notify();
            return getState();
        } catch (err) {
            markDisconnected();
            throw normalizeConnectError(err);
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
