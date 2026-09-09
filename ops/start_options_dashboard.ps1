param(
    [string]$RepoRoot = "C:\Users\jerin\Documents\TradyticsBot\site\site-git",
    [string]$LiveRoot = "C:\Users\jerin\Documents\TradyticsPredictiveLive",
    [string]$ConfigPath = "C:\Users\jerin\Documents\TradyticsPredictiveLive\config\predictive_live_v1.json",
    [string]$PythonPath = "C:\Users\jerin\Documents\TradyticsBot\.venv\Scripts\python.exe"
)

$ErrorActionPreference = "Stop"
$statePath = Join-Path $LiveRoot "state\service_state.json"
$pidPath = Join-Path $LiveRoot "state\predictive_live.pid"
$logPath = Join-Path $LiveRoot ("logs\options_dashboard_" + (Get-Date -Format "yyyyMMdd") + ".out.log")
$errorLogPath = Join-Path $LiveRoot ("logs\options_dashboard_" + (Get-Date -Format "yyyyMMdd") + ".err.log")

foreach ($path in @($RepoRoot, $LiveRoot, $ConfigPath, $PythonPath)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Required path is missing: $path" }
}
foreach ($folder in @("state", "logs", "forward_data")) {
    New-Item -ItemType Directory -Force -Path (Join-Path $LiveRoot $folder) | Out-Null
}

if (Test-Path -LiteralPath $pidPath) {
    $priorPid = [int](Get-Content -LiteralPath $pidPath -Raw)
    $prior = Get-Process -Id $priorPid -ErrorAction SilentlyContinue
    if ($prior -and $prior.ProcessName -match "python") {
        Write-Output "Options Dashboard is already running as PID $priorPid. No duplicate launched."
        exit 0
    }
}

$entry = Join-Path $RepoRoot "backend\tradytics_predictive_live_service.py"
& $PythonPath $entry --config $ConfigPath --verify-only | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Frozen-artifact/config verify-only startup failed" }

$process = Start-Process -FilePath $PythonPath -ArgumentList @(
    $entry, "--config", $ConfigPath, "--run-providers"
) -WorkingDirectory $RepoRoot -WindowStyle Hidden -RedirectStandardOutput $logPath `
  -RedirectStandardError $errorLogPath -PassThru
$process.Id | Set-Content -LiteralPath $pidPath -Encoding ascii
@{
    schema_version = 1
    product = "OPTIONS DASHBOARD"
    pid = $process.Id
    status = "STARTED"
    started_at = (Get-Date).ToUniversalTime().ToString("o")
    config_path = $ConfigPath
    log_path = $logPath
    error_log_path = $errorLogPath
    model_contract = "DIRECT_MFE_MODELS_FROZEN_V2"
    telegram = "ASYNC_MIRROR_ENABLED"
    broker_execution = $false
} | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
Write-Output "Options Dashboard started as PID $($process.Id)."
