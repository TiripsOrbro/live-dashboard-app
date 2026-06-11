const DATA_URL_RE = /^data:image\/([\w+.-]+);base64,(.+)$/i;

const ARCHIVE_MAX_WIDTH = 480;
const ARCHIVE_JPEG_QUALITY = 55;

let sharp;
try {
    sharp = require('sharp');
} catch {
    sharp = null;
}

function deepClone(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(deepClone);
    const out = {};
    for (const [key, child] of Object.entries(value)) {
        out[key] = deepClone(child);
    }
    return out;
}

async function downscaleDataUrl(dataUrl) {
    const match = String(dataUrl || '').match(DATA_URL_RE);
    if (!match) return dataUrl;

    if (!sharp) return dataUrl;

    try {
        const input = Buffer.from(match[2], 'base64');
        const pipeline = sharp(input).rotate().resize({
            width: ARCHIVE_MAX_WIDTH,
            height: ARCHIVE_MAX_WIDTH,
            fit: 'inside',
            withoutEnlargement: true,
        });
        const output = await pipeline.jpeg({ quality: ARCHIVE_JPEG_QUALITY, mozjpeg: true }).toBuffer();
        return `data:image/jpeg;base64,${output.toString('base64')}`;
    } catch {
        return dataUrl;
    }
}

async function downscaleValue(value) {
    if (typeof value === 'string' && DATA_URL_RE.test(value)) {
        return downscaleDataUrl(value);
    }
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
        return Promise.all(value.map((item) => downscaleValue(item)));
    }
    const out = {};
    for (const [key, child] of Object.entries(value)) {
        out[key] = await downscaleValue(child);
    }
    return out;
}

async function downscaleSessionImages(session) {
    const cloned = deepClone(session);
    return downscaleValue(cloned);
}

module.exports = {
    ARCHIVE_MAX_WIDTH,
    ARCHIVE_JPEG_QUALITY,
    downscaleSessionImages,
};
