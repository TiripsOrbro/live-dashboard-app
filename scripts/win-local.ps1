# Local Windows production helpers for branch `16gb` (run ON this PC - no SSH).
# Usage:  .\scripts\win-local.ps1 <command>
#         npm run win:start
#
# For remote Linux EliteDesk deploys, use scripts/server.ps1 instead.

param(
    [Parameter(Position = 0)]
    [ValidateSet('help', 'setup-env', 'install', 'start', 'restart', 'stop', 'status', 'logs', 'logs-scheduler', 'logs-forecast', 'tail', 'startup')]
    [string]$Command = 'help'
)

$RepoRoot = Split-Path $PSScriptRoot -Parent
$EnvExample = Join-Path $RepoRoot '.env.server16gb.example'
$EnvFile = Join-Path $RepoRoot '.env'

function Show-WinHelp {
    Write-Host @"
Windows local commands (app: $RepoRoot)

  setup-env       Copy .env.server16gb.example -> .env if missing
  install         npm install --omit=dev
  start           pm2 start ecosystem.config.cjs
  restart         pm2 restart dashboard (+ schedulers)
  stop            pm2 stop dashboard (+ schedulers)
  status          pm2 status
  logs            Stream dashboard logs (Ctrl+C to stop)
  logs-scheduler  Stream report-download-scheduler logs
  logs-forecast   Stream forecast-scheduler logs
  tail            Last 80 dashboard log lines (no follow)
  startup         Print/run pm2 startup for Windows (survives reboot)
"@
}

function Assert-Pm2Present {
    if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
        Write-Error "pm2 not found. Install with: npm install -g pm2"
        exit 1
    }
}

function Invoke-SetupEnv {
    if (Test-Path $EnvFile) {
        Write-Host ".env already exists - not overwriting." -ForegroundColor Yellow
        return
    }
    if (-not (Test-Path $EnvExample)) {
        Write-Error "Missing $EnvExample"
        exit 1
    }
    Copy-Item $EnvExample $EnvFile
    Write-Host "Created .env from .env.server16gb.example" -ForegroundColor Green
    Write-Host "Edit .env and set STORE_CREDENTIALS_KEY, DASHBOARD_AUTH_SECRET, and other secrets." -ForegroundColor Cyan
}

function Invoke-InstallDeps {
    Push-Location $RepoRoot
    try {
        npm install --omit=dev
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    finally {
        Pop-Location
    }
}

function Invoke-StartPm2 {
    Assert-Pm2Present
    Push-Location $RepoRoot
    try {
        if (-not (Test-Path $EnvFile)) {
            Write-Host "No .env found - running setup-env first." -ForegroundColor Yellow
            Invoke-SetupEnv
        }
        pm2 start ecosystem.config.cjs
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        pm2 save
        Write-Host "Started. Open http://localhost:3000" -ForegroundColor Green
    }
    finally {
        Pop-Location
    }
}

function Invoke-RestartPm2 {
    Assert-Pm2Present
    Push-Location $RepoRoot
    try {
        pm2 restart dashboard report-download-scheduler forecast-scheduler morning-restart
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    finally {
        Pop-Location
    }
}

function Invoke-StopPm2 {
    Assert-Pm2Present
    Push-Location $RepoRoot
    try {
        pm2 stop dashboard report-download-scheduler forecast-scheduler morning-restart
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    finally {
        Pop-Location
    }
}

switch ($Command) {
    'setup-env' { Invoke-SetupEnv }
    'install' { Invoke-InstallDeps }
    'start' { Invoke-StartPm2 }
    'restart' { Invoke-RestartPm2 }
    'stop' { Invoke-StopPm2 }
    'status' {
        Assert-Pm2Present
        pm2 status
    }
    'logs' {
        Assert-Pm2Present
        pm2 logs dashboard --lines 100
    }
    'logs-scheduler' {
        Assert-Pm2Present
        pm2 logs report-download-scheduler --lines 100
    }
    'logs-forecast' {
        Assert-Pm2Present
        pm2 logs forecast-scheduler --lines 100
    }
    'tail' {
        Assert-Pm2Present
        pm2 logs dashboard --lines 80 --nostream
    }
    'startup' {
        Assert-Pm2Present
        Write-Host "Run the command pm2 prints (Windows uses pm2-windows-startup or pm2 startup)." -ForegroundColor Cyan
        pm2 startup
        pm2 save
    }
    default { Show-WinHelp }
}
