# EliteDesk / 16GB server SSH helpers - deploy code, restart PM2, stream logs.
# Usage:  .\scripts\server.ps1 <command>
#         npm run server:deploy
#
# SSH host `dashboard` must be configured in ~/.ssh/config (see README EliteDesk setup).
# First-time setup (copies your SSH public key; enter server password once):
#   .\scripts\server.ps1 setup-key

param(
    [Parameter(Position = 0)]
    [ValidateSet('setup-key', 'ssh', 'deploy', 'deploy-git', 'restart', 'status', 'logs', 'logs-scheduler', 'logs-forecast', 'tail')]
    [string]$Command = 'help'
)

$ServerHost = 'dashboard'
$ServerAppDir = '~/live-dashboard-app'
$RepoRoot = Split-Path $PSScriptRoot -Parent

function Show-Help {
    @"
Server commands (SSH host: $ServerHost, app: $ServerAppDir)

  setup-key       Copy your SSH public key to the server (password once)
  ssh             Open an interactive shell on the server
  deploy          Sync local code to the server (tar over SSH, skips node_modules/.env)
  deploy-git      git pull + npm install + pm2 restart on the server
  restart         pm2 restart dashboard (+ schedulers)
  status          pm2 status
  logs            Stream dashboard logs (Ctrl+C to stop)
  logs-scheduler  Stream report-download-scheduler logs
  logs-forecast   Stream forecast-scheduler logs
  tail            Last 80 dashboard log lines (no follow)
"@
}

function Invoke-Server {
    param([string]$RemoteCmd)
    & ssh $ServerHost $RemoteCmd
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Copy-SshKey {
    $pub = Join-Path $env:USERPROFILE '.ssh\id_ed25519.pub'
    if (-not (Test-Path $pub)) {
        Write-Error "No public key at $pub - run: ssh-keygen -t ed25519"
        exit 1
    }
    Write-Host "Copying SSH key to $ServerHost (enter server password when prompted)..." -ForegroundColor Cyan
    $remoteKeyCmd = 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo Key installed OK'
    Get-Content $pub -Raw | ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no $ServerHost $remoteKeyCmd
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host "Testing key login..." -ForegroundColor Cyan
    ssh -o BatchMode=yes $ServerHost 'echo SSH key auth works.'
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
            'vendors/catalogs/.Americold',
            'vendors/catalogs/.Bega',
            'vendors/catalogs/.CutFresh',
            'vendors/catalogs/.Schweppes',
            'vendors/catalogs/.Sands',
            'vendors/catalogs/.display-names',
            'vendors/catalogs/.item-codes',
            'vendors/catalogs/.ConvertToBox',
            'vendors/config/existing-vendors.json',
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

        Write-Host "Syncing $RepoRoot -> ${ServerHost}:${ServerAppDir} ..." -ForegroundColor Cyan
        $remoteTarCmd = 'mkdir -p ~/live-dashboard-app && cd ~/live-dashboard-app && tar -xzf -'
        & tar -czf - @excludeArgs -C $RepoRoot . | ssh $ServerHost $remoteTarCmd
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

        Write-Host "Installing deps and restarting PM2..." -ForegroundColor Cyan
        $remoteInstallCmd = 'cd ~/live-dashboard-app && npm install --omit=dev && pm2 restart dashboard report-download-scheduler forecast-scheduler'
        Invoke-Server $remoteInstallCmd
        Write-Host "Deploy complete." -ForegroundColor Green
    }
    finally {
        Pop-Location
    }
}

$RemoteGitDeploy = 'cd ~/live-dashboard-app && git pull && node scripts/patch-americold-dry-carryover.js --write && npm install --omit=dev && pm2 restart dashboard report-download-scheduler forecast-scheduler'
$RemoteRestart = 'cd ~/live-dashboard-app && pm2 restart dashboard report-download-scheduler forecast-scheduler'

switch ($Command) {
    'setup-key' { Copy-SshKey }
    'ssh'       { & ssh $ServerHost }
    'deploy'    { Sync-Deploy }
    'deploy-git' { Invoke-Server $RemoteGitDeploy }
    'restart'   { Invoke-Server $RemoteRestart }
    'status'    { Invoke-Server 'pm2 status' }
    'logs'      { Invoke-Server 'pm2 logs dashboard --lines 100' }
    'logs-scheduler' { Invoke-Server 'pm2 logs report-download-scheduler --lines 100' }
    'logs-forecast'  { Invoke-Server 'pm2 logs forecast-scheduler --lines 100' }
    'tail'      { Invoke-Server 'pm2 logs dashboard --lines 80 --nostream' }
    default     { Show-Help }
}
