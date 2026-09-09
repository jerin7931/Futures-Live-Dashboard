param(
    [string]$StartScript = "C:\Users\jerin\Documents\TradyticsPredictiveLive\ops\start_predictive_live.ps1",
    [string]$TaskName = "Tradytics Options Dashboard"
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $StartScript)) { throw "Startup script missing: $StartScript" }
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument (
    "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$StartScript`""
)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Description "Options Dashboard frozen Direct-MFE inference and Telegram mirror; no broker execution." `
    -Force | Out-Null
Write-Output "Installed idempotent startup task: $TaskName"
