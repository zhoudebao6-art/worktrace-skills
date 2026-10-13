param([switch]$NoBrowser)
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
if(Test-Path -LiteralPath 'D:\'){$taskTemp='D:\codex+\temp';$taskCache='D:\codex+\cache\worktrace'}else{$taskTemp=Join-Path $root 'runtime-temp';$taskCache=Join-Path $root 'runtime-cache'}
New-Item -ItemType Directory -Path $taskTemp,$taskCache,(Join-Path $root 'data') -Force | Out-Null
$env:TEMP=$taskTemp;$env:TMP=$taskTemp;$env:TMPDIR=$taskTemp;$env:NODE_COMPILE_CACHE=Join-Path $taskCache 'node'
& (Join-Path $root 'scripts\Ensure-Runtime.ps1') -Root $root
$node=Join-Path $root 'runtime\node.exe'
if(!(Test-Path -LiteralPath $node)){$node=(Get-Command node.exe -ErrorAction Stop).Source}
$state=Join-Path $root 'data\running.json'
$alive=$false
if(Test-Path -LiteralPath $state){
 try{$info=Get-Content -LiteralPath $state -Raw -Encoding UTF8|ConvertFrom-Json;$health=Invoke-RestMethod ('http://127.0.0.1:'+$info.port+'/health') -TimeoutSec 2;if($health.service -eq 'worktrace'){$owner=Get-CimInstance Win32_Process -Filter ('ProcessId='+$info.pid) -ErrorAction SilentlyContinue;if($owner -and $owner.CommandLine -and $owner.CommandLine.Contains((Join-Path $root 'src\server.mjs'))){$alive=$true}} }catch{}
}
if(!$alive){
 $startArgs=@('"'+(Join-Path $root 'src\server.mjs')+'"')
 $proc=Start-Process -FilePath $node -ArgumentList $startArgs -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root 'data\service-output.log') -RedirectStandardError (Join-Path $root 'data\service-error.log') -PassThru
 $ready=$false
 for($i=0;$i -lt 50;$i++){Start-Sleep -Milliseconds 200;if(Test-Path -LiteralPath $state){try{$info=Get-Content -LiteralPath $state -Raw -Encoding UTF8|ConvertFrom-Json;if($info.pid -eq $proc.Id){$ready=$true;break}}catch{}}if($proc.HasExited){break}}
 if(!$ready){throw '启动失败，请查看 data\service-error.log。若 19220 端口被占用，请先退出原服务。'}
}
if(!$NoBrowser){Start-Process $info.url}
$trayState=Join-Path $root 'data\tray.pid'
$trayAlive=$false
if($alive -and (Test-Path -LiteralPath $trayState)){try{$trayProcessId=[int](Get-Content -LiteralPath $trayState);$owned=Get-CimInstance Win32_Process -Filter "ProcessId=$trayProcessId" -ErrorAction SilentlyContinue;if($owned -and $owned.CommandLine -and $owned.CommandLine.Contains((Join-Path $root 'Tray.ps1'))){$trayAlive=$true}}catch{}}
if(!$trayAlive){$trayProc=Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','"'+(Join-Path $root 'Tray.ps1')+'"') -WindowStyle Hidden -PassThru;$trayProc.Id | Set-Content -LiteralPath $trayState -Encoding ASCII}
Write-Output 'WorkTrace is running. Open the local panel to configure this computer.'
