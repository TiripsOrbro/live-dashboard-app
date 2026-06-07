/**
 * Cooper-Atkins Bluetooth Thermometer (Blue2 20100-K) — Web Bluetooth integration.
 * Uses the temperature notify characteristic documented by Cooper-Atkins integrators.
 */
(function () {
    const TEMP_CHAR_UUID = '78544003-4394-4fc2-8cfd-be6a00aa701b';
    const OPTIONAL_SERVICE_UUIDS = [
        '78544002-4394-4fc2-8cfd-be6a00aa701b',
        '78544001-4394-4fc2-8cfd-be6a00aa701b',
        '0000180f-0000-1000-8000-00805f9b34fb',
        '00001809-0000-1000-8000-00805f9b34fb',
    ];

    let device = null;
    let characteristic = null;
    let lastReading = null;
    let listeners = new Set();
    let pendingCapture = null;

    function isSupported() {
        return typeof navigator !== 'undefined' && Boolean(navigator.bluetooth);
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
        return {
            supported: isSupported(),
            connected: Boolean(device?.gatt?.connected),
            deviceName: device?.name || '',
            lastReading,
        };
    }

    function onNotify(event) {
        const value = event.target?.value;
        if (!value) return;
        const parsed = parseTemperature(value);
        if (parsed == null) return;
        lastReading = {
            celsius: parsed,
            capturedAt: new Date().toISOString(),
        };
        notify();
        if (pendingCapture) {
            const resolve = pendingCapture;
            pendingCapture = null;
            resolve(lastReading.celsius);
        }
    }

    function parseTemperature(dataView) {
        const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
        if (!bytes.length) return null;

        try {
            const text = new TextDecoder('utf-8').decode(bytes).trim();
            const textMatch = text.match(/-?\d+(?:\.\d+)?/);
            if (textMatch) {
                let value = Number(textMatch[0]);
                if (!Number.isFinite(value)) return null;
                if (/f\b|°f/i.test(text)) value = ((value - 32) * 5) / 9;
                return round1(value);
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

    async function findTemperatureCharacteristic(server) {
        const services = await server.getPrimaryServices();
        for (const service of services) {
            try {
                const chars = await service.getCharacteristics();
                for (const char of chars) {
                    if (char.uuid === TEMP_CHAR_UUID) return char;
                }
            } catch {
                /* some services may not expose characteristics */
            }
        }
        throw new Error('Bluetooth Thermometer temperature characteristic not found on this device.');
    }

    async function connect() {
        if (!isSupported()) {
            throw new Error('Web Bluetooth is not available in this browser. Use Chrome or Edge on Android/tablet/desktop.');
        }

        if (device?.gatt?.connected && characteristic) return getState();

        const picked = await navigator.bluetooth.requestDevice({
            acceptAllDevices: true,
            optionalServices: OPTIONAL_SERVICE_UUIDS,
        });

        device = picked;
        device.addEventListener('gattserverdisconnected', () => {
            characteristic = null;
            notify();
        });

        const server = await device.gatt.connect();
        characteristic = await findTemperatureCharacteristic(server);
        await characteristic.startNotifications();
        characteristic.addEventListener('characteristicvaluechanged', onNotify);

        try {
            const initial = await characteristic.readValue();
            const parsed = parseTemperature(initial);
            if (parsed != null) {
                lastReading = { celsius: parsed, capturedAt: new Date().toISOString() };
            }
        } catch {
            /* notifications will populate reading */
        }

        notify();
        return getState();
    }

    async function disconnect() {
        pendingCapture = null;
        if (characteristic) {
            try {
                characteristic.removeEventListener('characteristicvaluechanged', onNotify);
                await characteristic.stopNotifications();
            } catch {
                /* ignore */
            }
        }
        characteristic = null;
        if (device?.gatt?.connected) {
            device.gatt.disconnect();
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
                reject(new Error('No reading from Bluetooth Thermometer yet — insert the probe and wait a moment.'));
            }, timeoutMs);
            pendingCapture = (value) => {
                window.clearTimeout(timer);
                resolve(value);
            };
        });
    }

    async function captureCelsius() {
        if (!device?.gatt?.connected || !characteristic) {
            throw new Error('Bluetooth Thermometer is not connected.');
        }
        try {
            const value = await characteristic.readValue();
            const parsed = parseTemperature(value);
            if (parsed != null) {
                lastReading = { celsius: parsed, capturedAt: new Date().toISOString() };
                notify();
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

    function onStateChange(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    window.DfscBlue2 = {
        isSupported,
        getState,
        connect,
        disconnect,
        captureCelsius,
        onStateChange,
    };
})();
