const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { readUsersFileSync, usernameMatches, normalizeUser, lookupDisplayName } = require('./dashboardUsers');

const paths = require('../../../src/paths');
const WEBAUTHN_DIR = path.join(paths.users.data, 'webauthn');
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const pendingChallenges = new Map();

function rpId() {
    return String(process.env.WEBAUTHN_RP_ID || process.env.DASHBOARD_HOST || 'localhost').trim();
}

function rpOrigin() {
    const explicit = String(process.env.WEBAUTHN_ORIGIN || '').trim();
    if (explicit) return explicit;
    const host = rpId();
    if (host === 'localhost') return 'http://localhost:3000';
    return `https://${host}`;
}

function credentialsPath(username) {
    const safe = String(username || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_');
    return path.join(WEBAUTHN_DIR, `${safe}.json`);
}

function readCredentials(username) {
    const file = credentialsPath(username);
    if (!fs.existsSync(file)) return [];
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(raw.credentials) ? raw.credentials : [];
    } catch {
        return [];
    }
}

function writeCredentials(username, credentials) {
    fs.mkdirSync(WEBAUTHN_DIR, { recursive: true });
    fs.writeFileSync(
        credentialsPath(username),
        JSON.stringify({ username, credentials, updatedAt: new Date().toISOString() }, null, 2),
        'utf8'
    );
}

function stashChallenge(key, payload) {
    pendingChallenges.set(key, { ...payload, exp: Date.now() + CHALLENGE_TTL_MS });
}

function takeChallenge(key) {
    const entry = pendingChallenges.get(key);
    pendingChallenges.delete(key);
    if (!entry || Date.now() > entry.exp) return null;
    return entry;
}

function findAdminUser(username) {
    const name = String(username || '').trim();
    for (const row of readUsersFileSync()) {
        if (!usernameMatches(row.username, name)) continue;
        const user = normalizeUser(row);
        if (user.role !== 'admin' && user.stores !== '*') continue;
        return user;
    }
    return null;
}

async function createRegistrationOptions(user) {
    if (!user?.username || user.role !== 'admin') {
        throw new Error('Only admin accounts can register passkeys.');
    }
    const existing = readCredentials(user.username);
    const options = await generateRegistrationOptions({
        rpName: 'TBA Dashboard',
        rpID: rpId(),
        userID: Buffer.from(user.username),
        userName: user.username,
        userDisplayName: user.displayName || lookupDisplayName(user.username) || user.username,
        attestationType: 'none',
        authenticatorSelection: {
            residentKey: 'preferred',
            userVerification: 'preferred',
            authenticatorAttachment: 'platform',
        },
        excludeCredentials: existing.map((cred) => ({
            id: cred.id,
            type: 'public-key',
        })),
    });
    stashChallenge(`reg:${user.username}`, { challenge: options.challenge, username: user.username });
    return options;
}

async function verifyRegistration(user, body) {
    const expected = takeChallenge(`reg:${user.username}`);
    if (!expected) throw new Error('Registration challenge expired. Try again.');
    const verification = await verifyRegistrationResponse({
        response: body,
        expectedChallenge: expected.challenge,
        expectedOrigin: rpOrigin(),
        expectedRPID: rpId(),
    });
    if (!verification.verified || !verification.registrationInfo) {
        throw new Error('Passkey registration failed.');
    }
    const { credential } = verification.registrationInfo;
    const existing = readCredentials(user.username);
    existing.push({
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports || [],
        createdAt: new Date().toISOString(),
    });
    writeCredentials(user.username, existing);
    return { verified: true };
}

async function createLoginOptions(usernameHint = '') {
    const hint = String(usernameHint || '').trim();
    let user = hint ? findAdminUser(hint) : null;
    let credentials = [];
    if (user) {
        credentials = readCredentials(user.username);
    } else if (!hint) {
        for (const row of readUsersFileSync()) {
            const u = normalizeUser(row);
            if (u.role !== 'admin') continue;
            credentials = credentials.concat(
                readCredentials(u.username).map((c) => ({ ...c, username: u.username }))
            );
        }
    }
    const allowCredentials = credentials.map((cred) => ({
        id: cred.id,
        type: 'public-key',
        transports: cred.transports,
    }));
    const options = await generateAuthenticationOptions({
        rpID: rpId(),
        allowCredentials: allowCredentials.length ? allowCredentials : undefined,
        userVerification: 'preferred',
    });
    stashChallenge(`auth:${options.challenge}`, { challenge: options.challenge, usernameHint: hint });
    return options;
}

async function verifyLogin(body) {
    let challengeEntry = null;
    let challengeKey = null;
    for (const [key, val] of pendingChallenges.entries()) {
        if (!key.startsWith('auth:')) continue;
        challengeEntry = val;
        challengeKey = key;
        pendingChallenges.delete(key);
        break;
    }
    if (!challengeEntry) throw new Error('Login challenge expired. Try again.');

    let credUser = null;
    let storedCred = null;
    for (const row of readUsersFileSync()) {
        const u = normalizeUser(row);
        if (u.role !== 'admin') continue;
        for (const cred of readCredentials(u.username)) {
            if (cred.id === body.id) {
                credUser = u;
                storedCred = cred;
                break;
            }
        }
        if (credUser) break;
    }
    if (!credUser || !storedCred) throw new Error('Unknown passkey.');

    const verification = await verifyAuthenticationResponse({
        response: body,
        expectedChallenge: challengeEntry.challenge,
        expectedOrigin: rpOrigin(),
        expectedRPID: rpId(),
        credential: {
            id: storedCred.id,
            publicKey: Buffer.from(storedCred.publicKey, 'base64url'),
            counter: storedCred.counter,
            transports: storedCred.transports,
        },
    });
    if (!verification.verified) throw new Error('Passkey verification failed.');
    storedCred.counter = verification.authenticationInfo.newCounter;
    const all = readCredentials(credUser.username);
    const idx = all.findIndex((c) => c.id === storedCred.id);
    if (idx >= 0) all[idx] = storedCred;
    writeCredentials(credUser.username, all);
    return credUser;
}

module.exports = {
    createRegistrationOptions,
    verifyRegistration,
    createLoginOptions,
    verifyLogin,
    findAdminUser,
    rpOrigin,
};
