[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$stateRoot = Join-Path $repoRoot '.state'
$python = Join-Path $repoRoot '.venv-v2\Scripts\python.exe'
$service = Join-Path $repoRoot 'backend\tradytics_signal_service_v2.py'
$pidFile = Join-Path $stateRoot 'tradytics_v2.pid'
$stdout = Join-Path $stateRoot 'tradytics_v2.stdout.log'
$stderr = Join-Path $stateRoot 'tradytics_v2.stderr.log'

New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $python)) {
    throw "V2 virtual environment is unavailable at the configured repository path."
}

if (Test-Path -LiteralPath $pidFile) {
    $existingPid = [int](Get-Content -LiteralPath $pidFile -Raw)
    $existing = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Output "Tradytics V2 is already running (PID $existingPid)."
        exit 0
    }
}

$process = Start-Process -FilePath $python `
    -ArgumentList @($service) `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii
Write-Output "Tradytics V2 started (PID $($process.Id))."
