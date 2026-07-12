const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_HOSTNAME = 'tbadashboard.com';
/** Prefer the existing production tunnel (DNS + public hostname already configured). */
const PREFERRED_TUNNEL_NAME = 'dashboard';
const FALLBACK_TUNNEL_NAME = 'live-dashboard';
const LOCAL_ORIGIN = 'http://127.0.0.1:3000';
const PID_FILE = path.join(os.homedir(), '.cloudflared', 'live-dashboard-tunnel.pid');

function cloudflaredCandidates() {
    return [
        process.env.CLOUDFLARED_PATH,
        'C:\\Program Files\\cloudflared\\cloudflared.exe',
        'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
        path.join(process.env.LOCALAPPDATA || '', 'cloudflared', 'cloudflared.exe'),
    ].filter(Boolean);
}

function resolveCloudflared() {
    for (const p of cloudflaredCandidates()) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function run(bin, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, {
            cwd: os.homedir(),
            env: process.env,
            shell: false,
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d) => {
            stdout += d.toString();
        });
        child.stderr?.on('data', (d) => {
            stderr += d.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => {
            resolve({ code, stdout, stderr, ok: code === 0 });
        });
    });
}

function cloudflaredDir() {
    return path.join(os.homedir(), '.cloudflared');
}

function hasCert() {
    return fs.existsSync(path.join(cloudflaredDir(), 'cert.pem'));
}

async function ensureLoggedIn(bin, { onProgress, confirm } = {}) {
    if (hasCert()) {
        onProgress?.('Already signed in to Cloudflare on this PC');
        return { ok: true, already: true };
    }

    if (typeof confirm === 'function') {
        const choice = await confirm({
            type: 'info',
            title: 'Step: Cloudflare login',
            message: 'Connect this PC to Cloudflare',
            detail: [
                'tbadashboard.com is published through a Cloudflare Tunnel.',
                '',
                '1. Click Continue — a browser window will open',
                '2. Sign in with the Cloudflare account that owns tbadashboard.com',
                '3. Click Authorize / Allow when Cloudflare asks',
                '4. Return here when the browser says success',
                '',
                'Use the same Cloudflare account as the previous Host.',
            ].join('\n'),
            buttons: ['Continue — open Cloudflare login', 'Skip Cloudflare for now'],
            defaultId: 0,
            cancelId: 1,
        });
        if (choice !== 0) {
            return { ok: false, skipped: true };
        }
    }

    onProgress?.('Opening Cloudflare login in your browser — finish signing in there…');
    const result = await run(bin, ['tunnel', 'login']);
    if (!hasCert()) {
        if (typeof confirm === 'function') {
            const retry = await confirm({
                type: 'warning',
                title: 'Cloudflare login incomplete',
                message: 'Login did not finish',
                detail:
                    (result.stderr || result.stdout || '').trim().slice(0, 400) ||
                    'No Cloudflare certificate was saved. Try again, or skip and set up the tunnel later from the tray.',
                buttons: ['Try login again', 'Skip for now'],
                defaultId: 0,
                cancelId: 1,
            });
            if (retry === 0) {
                return ensureLoggedIn(bin, { onProgress, confirm });
            }
            return { ok: false, skipped: true };
        }
        throw new Error(
            result.stderr ||
                'Cloudflare login did not finish. Complete the browser login, then retry Setup Cloudflare.'
        );
    }
    onProgress?.('Cloudflare login complete');
    return { ok: true, loggedIn: true };
}

async function listTunnels(bin) {
    const result = await run(bin, ['tunnel', 'list']);
    const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/);
    const tunnels = [];
    for (const line of lines) {
        const m = line.match(
            /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(\S+)/i
        );
        if (m) tunnels.push({ id: m[1], name: m[2] });
    }
    return tunnels;
}

async function getTunnelToken(bin, tunnelNameOrId) {
    const result = await run(bin, ['tunnel', 'token', String(tunnelNameOrId)]);
    const token = `${result.stdout}`
        .trim()
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 40 && !/\s/.test(s))
        .pop();
    if (!token) throw new Error(result.stderr || 'Could not read tunnel token');
    return token;
}

function queryService() {
    return new Promise((resolve) => {
        execFile('sc.exe', ['query', 'cloudflared'], { windowsHide: true }, (err, stdout) => {
            const text = String(stdout || '');
            resolve({
                installed: !err && /SERVICE_NAME:\s*cloudflared/i.test(text),
                running: /STATE\s*:\s*\d+\s+RUNNING/i.test(text),
                raw: text,
            });
        });
    });
}

function startService() {
    return new Promise((resolve) => {
        execFile('sc.exe', ['start', 'cloudflared'], { windowsHide: true }, (err, stdout, stderr) => {
            const text = `${stdout || ''}\n${stderr || ''}`;
            resolve({ ok: !err || /already|RUNNING/i.test(text), text: text.trim() });
        });
    });
}

function stopService() {
    return new Promise((resolve) => {
        execFile('sc.exe', ['stop', 'cloudflared'], { windowsHide: true }, (err, stdout, stderr) => {
            const text = `${stdout || ''}\n${stderr || ''}`;
            resolve({ ok: !err || /STOPPED|not been started|does not exist/i.test(text), text: text.trim() });
        });
    });
}

async function uninstallService(bin) {
    await run(bin, ['service', 'uninstall']);
}

async function installServiceWithToken(bin, token) {
    await uninstallService(bin);
    const result = await run(bin, ['service', 'install', token]);
    if (!result.ok) {
        throw new Error(
            (result.stderr || result.stdout || '').trim() ||
                'cloudflared service install failed (needs Administrator once).'
        );
    }
}

/**
 * Install + start cloudflared Windows service via a UAC-elevated PowerShell script.
 * Required because the tray app is usually not running as Administrator.
 */
async function installServiceElevated(bin, token, { onProgress } = {}) {
    const dir = path.join(os.tmpdir(), 'live-dashboard-cloudflared');
    fs.mkdirSync(dir, { recursive: true });
    const tokenFile = path.join(dir, 'tunnel.token');
    const scriptFile = path.join(dir, 'install-service.ps1');
    const resultFile = path.join(dir, 'install-result.txt');

    fs.writeFileSync(tokenFile, String(token).trim(), 'utf8');
    try {
        fs.unlinkSync(resultFile);
    } catch {
        /* ignore */
    }

    const ps = [
        "$ErrorActionPreference = 'Stop'",
        `Set-Content -Path '${resultFile.replace(/'/g, "''")}' -Value 'started'`,
        `$bin = '${String(bin).replace(/'/g, "''")}'`,
        `$token = (Get-Content -Raw '${tokenFile.replace(/'/g, "''")}').Trim()`,
        'try {',
        '  & $bin service uninstall 2>$null | Out-Null',
        '} catch {}',
        'Start-Sleep -Milliseconds 500',
        '& $bin service install $token',
        'if ($LASTEXITCODE -ne 0) { throw "cloudflared service install exit $LASTEXITCODE" }',
        'Start-Sleep -Milliseconds 800',
        'try { Start-Service -Name cloudflared -ErrorAction Stop } catch {',
        '  & sc.exe start cloudflared | Out-Null',
        '}',
        `Set-Content -Path '${resultFile.replace(/'/g, "''")}' -Value 'ok'`,
        `Remove-Item -Force '${tokenFile.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`,
    ].join('\r\n');
    fs.writeFileSync(scriptFile, ps, 'utf8');

    onProgress?.('Windows will ask for Administrator permission — click Yes…');

    const elevate = await new Promise((resolve) => {
        const child = spawn(
            'powershell.exe',
            [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-Command',
                `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${scriptFile.replace(
                    /'/g,
                    "''"
                )}')`,
            ],
            { windowsHide: true }
        );
        let stderr = '';
        child.stderr?.on('data', (d) => {
            stderr += d.toString();
        });
        child.on('error', (err) => resolve({ ok: false, error: String(err.message || err) }));
        child.on('close', (code) => {
            resolve({ ok: code === 0, code, stderr: stderr.trim() });
        });
    });

    let resultText = '';
    try {
        resultText = fs.readFileSync(resultFile, 'utf8').trim();
    } catch {
        resultText = '';
    }

    // Clean token file even if elevate failed
    try {
        fs.unlinkSync(tokenFile);
    } catch {
        /* ignore */
    }

    if (!elevate.ok || resultText !== 'ok') {
        const service = await queryService();
        if (service.installed && service.running) {
            return { ok: true, elevated: true, service };
        }
        throw new Error(
            elevate.stderr ||
                (resultText === 'started'
                    ? 'Administrator approval was cancelled or the elevated install did not finish.'
                    : 'Could not install Cloudflare Windows service as Administrator.')
        );
    }

    await new Promise((r) => setTimeout(r, 1000));
    const service = await queryService();
    if (!service.running) {
        await startService();
    }
    return { ok: true, elevated: true, service: await queryService() };
}

function stopPidFileProcess() {
    try {
        if (!fs.existsSync(PID_FILE)) return;
        const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
        if (pid) {
            try {
                process.kill(pid);
            } catch {
                /* ignore */
            }
        }
        fs.unlinkSync(PID_FILE);
    } catch {
        /* ignore */
    }
}

function startTokenProcess(bin, token) {
    stopPidFileProcess();
    // Avoid duplicate connectors fighting each other
    try {
        execFile('taskkill', ['/IM', 'cloudflared.exe', '/F'], { windowsHide: true });
    } catch {
        /* ignore */
    }
    const child = spawn(bin, ['tunnel', 'run', '--token', token], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
    });
    child.unref();
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');
    return child.pid;
}

function writeHelperConfig(tunnel, hostname) {
    const dir = cloudflaredDir();
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, 'config.yml');
    const body = [
        `# Managed by Live Dashboard Host setup`,
        `# Primary connector uses tunnel token for "${tunnel.name}".`,
        `tunnel: ${tunnel.id}`,
        `ingress:`,
        `  - hostname: ${hostname}`,
        `    service: ${LOCAL_ORIGIN}`,
        `  - service: http_status:404`,
        '',
    ].join('\n');
    fs.writeFileSync(configPath, body, 'utf8');
    return configPath;
}

async function pickTunnel(bin) {
    const tunnels = await listTunnels(bin);
    return (
        tunnels.find((t) => t.name === PREFERRED_TUNNEL_NAME) ||
        tunnels.find((t) => t.name === FALLBACK_TUNNEL_NAME) ||
        tunnels[0] ||
        null
    );
}

/**
 * Host Cloudflare cutover using the existing production tunnel token when possible
 * (keeps tbadashboard.com DNS working). Falls back to background process if the
 * Windows service cannot be installed without elevation.
 *
 * @param {{ hostname?: string, onProgress?: Function, confirm?: Function, guided?: boolean }} opts
 *   confirm(opts) → Promise<number> button index (Electron dialog response)
 */
async function setupCloudflareTunnel({
    hostname = DEFAULT_HOSTNAME,
    onProgress,
    confirm,
    guided = false,
} = {}) {
    const progress = (msg) => onProgress?.(String(msg || ''));
    const ask = async (opts) => {
        if (typeof confirm !== 'function') return 0;
        return confirm(opts);
    };

    const bin = resolveCloudflared();
    if (!bin) {
        throw new Error(
            'cloudflared is not installed. Install Cloudflare Tunnel, then use tray → Setup Cloudflare tunnel.'
        );
    }
    const steps = [];

    if (guided) {
        const start = await ask({
            type: 'info',
            title: 'Cloudflare tunnel setup',
            message: 'Publish tbadashboard.com from this PC',
            detail: [
                'This walkthrough will:',
                '• Sign you into Cloudflare (browser)',
                '• Attach the existing “dashboard” tunnel to this PC',
                '• Ask Windows for Admin once so the tunnel restarts after reboot',
                '',
                'When it finishes, Admin Settings will open on this PC.',
            ].join('\n'),
            buttons: ['Start Cloudflare setup', 'Skip for now'],
            defaultId: 0,
            cancelId: 1,
        });
        if (start !== 0) {
            progress('Cloudflare setup skipped — you can run it later from the tray');
            return { ok: false, skipped: true, hostname };
        }
    }

    const ver = await run(bin, ['--version']);
    steps.push({ step: 'detect', ok: true, detail: (ver.stdout || ver.stderr).trim() });
    progress(`Found cloudflared: ${(ver.stdout || ver.stderr).trim().slice(0, 80)}`);

    const login = await ensureLoggedIn(bin, {
        onProgress: progress,
        confirm: guided ? confirm : undefined,
    });
    if (login.skipped) {
        return { ok: false, skipped: true, hostname, steps };
    }
    steps.push({ step: 'login', ok: true, detail: login.already ? 'already' : 'fresh' });

    progress('Looking up your Cloudflare tunnels…');
    const tunnel = await pickTunnel(bin);
    if (!tunnel) {
        throw new Error(
            'No Cloudflare tunnels found on this account. Create one named "dashboard" in Zero Trust, or run: cloudflared tunnel create dashboard'
        );
    }
    steps.push({ step: 'tunnel', ok: true, detail: `${tunnel.name} (${tunnel.id})` });
    progress(`Using tunnel “${tunnel.name}”`);

    if (guided) {
        await ask({
            type: 'info',
            title: 'Step: Connect tunnel',
            message: `Connect “${tunnel.name}” to this PC`,
            detail: [
                `${hostname} will point at http://127.0.0.1:3000 on this computer.`,
                '',
                'Only one PC should run this tunnel at a time.',
            ].join('\n'),
            buttons: ['Connect tunnel'],
            defaultId: 0,
        });
    }

    progress('Fetching tunnel token…');
    const token = await getTunnelToken(bin, tunnel.name);
    steps.push({ step: 'token', ok: true });

    writeHelperConfig(tunnel, hostname);
    steps.push({ step: 'config', ok: true });

    let elevated = false;
    let preferService = true;
    if (guided && typeof confirm === 'function') {
        const serviceChoice = await ask({
            type: 'info',
            title: 'Step: Windows service (recommended)',
            message: 'Install Cloudflare as a Windows service?',
            detail: [
                'Next, Windows will show a blue/yellow User Account Control (UAC) window.',
                'Click Yes — that installs Cloudflare so tbadashboard.com stays up after reboot.',
                '',
                'If you click No, the tunnel only lasts until you sign out.',
            ].join('\n'),
            buttons: ['Install service (click Yes on UAC)', 'Start without service'],
            defaultId: 0,
            cancelId: 1,
        });
        preferService = serviceChoice === 0;
    }

    if (preferService) {
        let serviceInstalled = false;
        for (let attempt = 1; attempt <= 3 && !serviceInstalled; attempt += 1) {
            try {
                progress(
                    attempt === 1
                        ? 'Installing Cloudflare Windows service (approve Admin / Yes)…'
                        : `Retrying Admin service install (attempt ${attempt})…`
                );
                // Prefer UAC elevation — tray app is rarely already Administrator.
                try {
                    await installServiceElevated(bin, token, { onProgress: progress });
                } catch (elevErr) {
                    progress(`Elevated install: ${elevErr.message || elevErr} — trying direct install…`);
                    await installServiceWithToken(bin, token);
                    await startService();
                }
                const serviceNow = await queryService();
                if (!serviceNow.running) {
                    await startService();
                }
                steps.push({ step: 'service-install', ok: true, attempt });
                elevated = true;
                serviceInstalled = true;
                progress('Cloudflare Windows service is running');
            } catch (err) {
                steps.push({
                    step: 'service-install',
                    ok: false,
                    attempt,
                    detail: String(err.message || err),
                });
                if (guided && typeof confirm === 'function' && attempt < 3) {
                    const retry = await ask({
                        type: 'warning',
                        title: 'Admin approval needed',
                        message: 'Cloudflare Windows service was not installed',
                        detail: [
                            String(err.message || err),
                            '',
                            'Click Yes on the Windows UAC prompt when it appears.',
                            'Without the service, the public site stops after reboot/sign-out.',
                        ].join('\n'),
                        buttons: ['Try Admin install again', 'Continue without service'],
                        defaultId: 0,
                        cancelId: 1,
                    });
                    if (retry !== 0) break;
                } else {
                    break;
                }
            }
        }

        if (!serviceInstalled) {
            progress('Starting tunnel in the background for this session…');
            const pid = startTokenProcess(bin, token);
            steps.push({ step: 'tunnel-run-fallback', ok: true, detail: `pid ${pid}` });
            if (guided) {
                await ask({
                    type: 'warning',
                    title: 'Tunnel started without Windows service',
                    message: 'Cloudflare is running for this session only',
                    detail: [
                        'The Windows service still needs Administrator approval.',
                        '',
                        'Site can work until you reboot. Then use tray → Setup Cloudflare tunnel… and click Yes on UAC.',
                    ].join('\n'),
                    buttons: ['Continue'],
                    defaultId: 0,
                });
            }
        }
    } else {
        progress('Starting Cloudflare tunnel without Windows service…');
        const pid = startTokenProcess(bin, token);
        steps.push({ step: 'tunnel-run-fallback', ok: true, detail: `pid ${pid}` });
    }

    progress('Waiting for Cloudflare connector…');
    await new Promise((r) => setTimeout(r, 2500));
    const service = await queryService();

    if (guided) {
        await ask({
            type: elevated || service.running ? 'info' : 'warning',
            title: 'Cloudflare setup finished',
            message: elevated || service.running ? 'Tunnel is connected' : 'Tunnel started',
            detail: [
                `${hostname} → ${LOCAL_ORIGIN}`,
                `Tunnel: ${tunnel.name}`,
                elevated || service.running
                    ? 'Windows service: running (survives reboot)'
                    : 'Background connector: running until sign-out/reboot',
                '',
                'Next: Admin Settings will open on this PC so you can sign in.',
            ].join('\n'),
            buttons: ['Open Admin Settings'],
            defaultId: 0,
        });
    }

    return {
        ok: true,
        hostname,
        tunnel,
        localOrigin: LOCAL_ORIGIN,
        service,
        steps,
        bin,
        elevated,
    };
}

async function getCloudflareStatus() {
    const service = await queryService();
    let pidRunning = false;
    try {
        if (fs.existsSync(PID_FILE)) {
            const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
            if (pid) {
                try {
                    process.kill(pid, 0);
                    pidRunning = true;
                } catch {
                    /* not running */
                }
            }
        }
    } catch {
        /* ignore */
    }
    return {
        cloudflaredPath: resolveCloudflared(),
        hasCert: hasCert(),
        service,
        pidRunning,
        running: Boolean(service.running || pidRunning),
        configPath: path.join(cloudflaredDir(), 'config.yml'),
        pidFile: PID_FILE,
    };
}

/**
 * Stop local Cloudflare connector so another Host can own the tunnel.
 * Best-effort: stops service, uninstalls service, kills pid-file process.
 */
async function stopCloudflareTunnel() {
    const steps = [];
    stopPidFileProcess();
    steps.push({ step: 'pid-file', ok: true });

    const stopped = await stopService();
    steps.push({ step: 'service-stop', ok: stopped.ok, detail: stopped.text });

    const bin = resolveCloudflared();
    if (bin) {
        try {
            await uninstallService(bin);
            steps.push({ step: 'service-uninstall', ok: true });
        } catch (err) {
            steps.push({
                step: 'service-uninstall',
                ok: false,
                detail: String(err && err.message ? err.message : err),
            });
        }
    }

    try {
        await new Promise((resolve) => {
            execFile('taskkill', ['/IM', 'cloudflared.exe', '/F'], { windowsHide: true }, () => resolve());
        });
        steps.push({ step: 'taskkill', ok: true });
    } catch {
        steps.push({ step: 'taskkill', ok: false });
    }

    return { ok: true, steps };
}

module.exports = {
    DEFAULT_HOSTNAME,
    PREFERRED_TUNNEL_NAME,
    FALLBACK_TUNNEL_NAME,
    LOCAL_ORIGIN,
    resolveCloudflared,
    setupCloudflareTunnel,
    stopCloudflareTunnel,
    getCloudflareStatus,
    queryService,
};
