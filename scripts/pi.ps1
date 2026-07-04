# Pi SSH helpers - deploy code, restart PM2, stream logs.
# Usage:  .\scripts\pi.ps1 <command>
#         npm run pi:deploy
#
# First-time setup (copies your SSH public key; enter Pi password once):
#   .\scripts\pi.ps1 setup-key

param(
    [Parameter(Position = 0)]
    [ValidateSet('setup-key', 'ssh', 'deploy', 'deploy-git', 'restart', 'status', 'logs', 'logs-scheduler', 'logs-forecast', 'tail')]
    [string]$Command = 'help'
)

$PiHost = 'pi'
$PiAppDir = '~/live-dashboard-app'
$RepoRoot = Split-Path $PSScriptRoot -Parent

function Show-Help {
    @"
Pi commands (SSH host: $PiHost, app: $PiAppDir)

  setup-key       Copy your SSH public key to the Pi (password once)
  ssh             Open an interactive shell on the Pi
  deploy          Sync local code to the Pi (tar over SSH, skips node_modules/.env)
  deploy-git      git pull + npm install + pm2 restart on the Pi
  restart         pm2 restart dashboard (+ schedulers)
  status          pm2 status
  logs            Stream dashboard logs (Ctrl+C to stop)
  logs-scheduler  Stream report-download-scheduler logs
  logs-forecast   Stream forecast-scheduler logs
  tail            Last 80 dashboard log lines (no follow)
"@
}

function Invoke-Pi {
    param([string]$RemoteCmd)
    & ssh $PiHost $RemoteCmd
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Copy-SshKey {
    $pub = Join-Path $env:USERPROFILE '.ssh\id_ed25519.pub'
    if (-not (Test-Path $pub)) {
        Write-Error "No public key at $pub - run: ssh-keygen -t ed25519"
        exit 1
    }
    Write-Host "Copying SSH key to $PiHost (enter Pi password when prompted)..." -ForegroundColor Cyan
    $remoteKeyCmd = 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo Key installed OK'
    Get-Content $pub -Raw | ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no $PiHost $remoteKeyCmd
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host "Testing key login..." -ForegroundColor Cyan
    ssh -o BatchMode=yes $PiHost 'echo SSH key auth works.'
}

function Sync-Deploy {
    Push-Location $RepoRoot
    try {
        $excludes = @(
            'node_modules',
            '.git',
            '.env',
            '.env.*',
            'tmp',
            'cookies.txt',
            'vendors/reports',
            'dashboard/data/sales-snapshots',
            'dashboard/data/forecast-history',
            'dashboard/data/forecast-status',
            'dashboard/data/forecast-updates',
            'dashboard/data/forecast-manual',
            'dashboard/data/forecast-adjustments',
            'dashboard/data/forecast-schedule-log',
            'dashboard/data/bug-reports/photos',
            'dashboard/data/sssg-weekly',
            'dashboard/data/sssg-lastyear',
            'tacaudit/data',
            'stores/data',
            'vendors/data',
            'users/data',
            'mmx/data'
        )
        $excludeArgs = $excludes | ForEach-Object { "--exclude=$_" }

        Write-Host "Syncing $RepoRoot -> ${PiHost}:${PiAppDir} ..." -ForegroundColor Cyan
        $remoteTarCmd = 'mkdir -p ~/live-dashboard-app && cd ~/live-dashboard-app && tar -xzf -'
        & tar -czf - @excludeArgs -C $RepoRoot . | ssh $PiHost $remoteTarCmd
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

        Write-Host "Installing deps and restarting PM2..." -ForegroundColor Cyan
        $remoteInstallCmd = 'cd ~/live-dashboard-app && npm install --omit=dev && pm2 restart dashboard report-download-scheduler forecast-scheduler'
        Invoke-Pi $remoteInstallCmd
        Write-Host "Deploy complete." -ForegroundColor Green
    }
    finally {
        Pop-Location
    }
}

$RemoteGitDeploy = 'cd ~/live-dashboard-app && git pull && npm install --omit=dev && pm2 restart dashboard report-download-scheduler forecast-scheduler'
$RemoteRestart = 'cd ~/live-dashboard-app && pm2 restart dashboard report-download-scheduler forecast-scheduler'

switch ($Command) {
    'setup-key' { Copy-SshKey }
    'ssh'       { & ssh $PiHost }
    'deploy'    { Sync-Deploy }
    'deploy-git' { Invoke-Pi $RemoteGitDeploy }
    'restart'   { Invoke-Pi $RemoteRestart }
    'status'    { Invoke-Pi 'pm2 status' }
    'logs'      { Invoke-Pi 'pm2 logs dashboard --lines 100' }
    'logs-scheduler' { Invoke-Pi 'pm2 logs report-download-scheduler --lines 100' }
    'logs-forecast'  { Invoke-Pi 'pm2 logs forecast-scheduler --lines 100' }
    'tail'      { Invoke-Pi 'pm2 logs dashboard --lines 80 --nostream' }
    default     { Show-Help }
}
