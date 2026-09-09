[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$stateRoot = Join-Path $repoRoot '.state'
$tradyticsRoot = Split-Path -Parent (Split-Path -Parent $repoRoot)
$pythonCandidates = @(
    (Join-Path $repoRoot '.venv-v2\Scripts\python.exe'),
    (Join-Path $tradyticsRoot '.venv\Scripts\python.exe')
)
$python = $pythonCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$service = Join-Path $repoRoot 'backend\tradytics_signal_service_v2.py'
$pidFile = Join-Path $stateRoot 'tradytics_v2.pid'
$stdout = Join-Path $stateRoot 'tradytics_v2.stdout.log'
$stderr = Join-Path $stateRoot 'tradytics_v2.stderr.log'

New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
if (-not $python) {
    throw "V2 virtual environment is unavailable at the supported repository or shared Tradytics paths."
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
