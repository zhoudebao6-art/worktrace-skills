$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
if(Test-Path -LiteralPath (Join-Path $root 'data\config.json')){throw 'Only run this check against an unconfigured installation.'}
$env:TEMP='D:\codex+\temp';$env:TMP=$env:TEMP;$env:TMPDIR=$env:TEMP
& (Join-Path $root 'Start.ps1') -NoBrowser
$state=Get-Content -LiteralPath (Join-Path $root 'data\running.json') -Raw|ConvertFrom-Json
$serviceAlive=!!(Get-Process -Id $state.pid -ErrorAction SilentlyContinue)
& (Join-Path $root 'Start.ps1') -NoBrowser
$again=Get-Content -LiteralPath (Join-Path $root 'data\running.json') -Raw|ConvertFrom-Json
$trayId=[int](Get-Content -LiteralPath (Join-Path $root 'data\tray.pid'))
$trayAlive=!!(Get-Process -Id $trayId -ErrorAction SilentlyContinue)
$current=& (Join-Path $root 'runtime\node.exe') (Join-Path $root 'src\admin-cli.mjs') --command status --role hub --dir (Join-Path $root 'data')|ConvertFrom-Json
& (Join-Path $root 'runtime\node.exe') (Join-Path $root 'src\admin-cli.mjs') --command shutdown --role hub --dir (Join-Path $root 'data')|Out-Null
if($LASTEXITCODE -ne 0){throw 'Unconfigured service shutdown failed.'}
$deadline=[datetime]::UtcNow.AddSeconds(30)
do{$serviceStopped=!(Get-Process -Id $state.pid -ErrorAction SilentlyContinue);$trayStopped=!(Get-Process -Id $trayId -ErrorAction SilentlyContinue);if($serviceStopped -and $trayStopped){break};Start-Sleep -Milliseconds 500}while([datetime]::UtcNow -lt $deadline)
$r=@{service_started=$serviceAlive;initially_unconfigured=(!$current.configured);repeat_launch_same_pid=($state.pid -eq $again.pid);tray_started=$trayAlive;service_stopped=$serviceStopped;tray_stopped=$trayStopped;capture_enabled=$current.collection.enabled}
$r.passed=$serviceAlive -and $trayAlive -and $serviceStopped -and $trayStopped -and ($state.pid -eq $again.pid) -and (!$current.configured) -and (!$current.collection.enabled)
$r|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root '启动器验证记录.json') -Encoding UTF8
$r|ConvertTo-Json
if(!$r.passed){throw 'Launcher verification failed.'}
