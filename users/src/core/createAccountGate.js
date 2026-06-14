const crypto = require('crypto');
const {
    timingSafeEqualString,
    canUserCreateAccounts,
    buildCreateAccountParentFromUser,
    readUsersFileSync,
    usernameMatches,
    normalizeUser,
    parseCookies,
    cookieClearOptions,
    authSecret,
} = require('./dashboardUsers');

const CREATE_ACCOUNT_GATE_COOKIE = 'account_create_gate';
const GATE_MAX_AGE_MS = 8 * 60 * 60 * 1000;

function signGatePayload(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', authSecret()).update(body).digest('base64url');
    return `${body}.${sig}`;
}

function parseGateToken(token) {
    const raw = String(token || '');
    const dot = raw.lastIndexOf('.');
    if (dot <= 0) return null;
    const body = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    const expected = crypto.createHmac('sha256', authSecret()).update(body).digest('base64url');
    if (!timingSafeEqualString(sig, expected)) return null;
    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (payload?.p !== 'acct-create' || !payload?.u || !payload?.exp) return null;
        if (Date.now() > Number(payload.exp)) return null;
        const stores =
            payload.s === '*'
                ? '*'
                : String(payload.s || '')
                      .split(',')
                      .filter(Boolean);
        return {
            parentUsername: payload.u,
            stores,
            addCbAlias: payload.c === 1,
            exp: payload.exp,
        };
    } catch {
        return null;
    }
}

function createAccountGateToken(user) {
    const stores = user.stores === '*' ? '*' : (user.stores || []).join(',');
    return signGatePayload({
        p: 'acct-create',
        u: user.username,
        s: stores,
        c: user.colorBlind ? 1 : 0,
        exp: Date.now() + GATE_MAX_AGE_MS,
    });
}

function gateCookieOptions() {
    const secureCookie = /^(1|true|yes|on)$/i.test(String(process.env.DASHBOARD_SECURE_COOKIE ?? '').trim());
    return {
        httpOnly: true,
        sameSite: 'lax',
        secure: secureCookie,
        maxAge: GATE_MAX_AGE_MS,
        path: '/',
    };
}

function readGateFromRequest(req) {
    const cookies = parseCookies(req.headers?.cookie);
    const token = cookies[CREATE_ACCOUNT_GATE_COOKIE];
    return parseGateToken(token);
}

function clearAccountGateCookie(res) {
    res.clearCookie(CREATE_ACCOUNT_GATE_COOKIE, cookieClearOptions(gateCookieOptions()));
}

function setAccountGateCookie(res, user) {
    res.cookie(CREATE_ACCOUNT_GATE_COOKIE, createAccountGateToken(user), gateCookieOptions());
}

function resolveGateParentUser(gate) {
    if (!gate?.parentUsername) return null;
    for (const row of readUsersFileSync()) {
        if (!usernameMatches(row.username, gate.parentUsername)) continue;
        const user = normalizeUser(row);
        if (!canUserCreateAccounts(user)) return null;
        return user;
    }
    return null;
}

function resolveCreateAccountActor(req) {
    const sessionUser = req.dashboardUser;
    if (sessionUser && canUserCreateAccounts(sessionUser)) {
        return sessionUser;
    }
    const gate = readGateFromRequest(req);
    if (!gate) return null;
    return resolveGateParentUser(gate);
}

function resolveCreateAccountParent(req) {
    const actor = resolveCreateAccountActor(req);
    if (!actor) return null;
    const via = req.dashboardUser && canUserCreateAccounts(req.dashboardUser) ? 'session' : 'gate';
    return buildCreateAccountParentFromUser(actor, via);
}

module.exports = {
    CREATE_ACCOUNT_GATE_COOKIE,
    createAccountGateToken,
    parseGateToken,
    gateCookieOptions,
    readGateFromRequest,
    setAccountGateCookie,
    clearAccountGateCookie,
    resolveCreateAccountActor,
    resolveCreateAccountParent,
};
