param([string]$Root=(Split-Path $PSScriptRoot -Parent),[string]$Candidate)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'provision-common.ps1')
$expected='0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4'
$node=Join-Path $Root 'runtime\node.exe'
if(Test-Path -LiteralPath $node){if((Get-WorkTraceHash $node) -ne $expected){throw '已有运行时与固定版本不一致，未覆盖。'};return}
if(Test-Path -LiteralPath 'D:\'){$taskTemp='D:\codex+\temp';$cache='D:\codex+\cache\worktrace\runtime'}else{$taskTemp=Join-Path $Root 'runtime-temp';$cache=Join-Path $Root 'runtime-cache'}
New-Item -ItemType Directory -Path $taskTemp,$cache,(Split-Path $node -Parent) -Force|Out-Null
$env:TEMP=$taskTemp;$env:TMP=$taskTemp;$env:TMPDIR=$taskTemp
$cached=Join-Path $cache 'node-v22.23.2-win-x64.exe'
if($Candidate){if(!(Test-Path -LiteralPath $Candidate) -or (Get-WorkTraceHash $Candidate) -ne $expected){throw '指定运行时未通过官方 SHA256 校验。'};Copy-Item -LiteralPath $Candidate -Destination $cached -Force}
if(!(Test-Path -LiteralPath $cached)){
 [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
 $partial=Join-Path $cache ([guid]::NewGuid().ToString('N')+'.download')
 Invoke-WebRequest -UseBasicParsing 'https://nodejs.org/dist/v22.23.2/win-x64/node.exe' -OutFile $partial -TimeoutSec 180
 if((Get-WorkTraceHash $partial) -ne $expected){throw '官方下载校验失败，临时文件保留供检查。'}
 Move-Item -LiteralPath $partial -Destination $cached
}
if((Get-WorkTraceHash $cached) -ne $expected){throw '运行时缓存校验失败；请管理员检查缓存文件。'}
Copy-Item -LiteralPath $cached -Destination $node
if((Get-WorkTraceHash $node) -ne $expected){throw '运行时复制校验失败。'}
Write-Output 'Node v22.23.2 x64 verified and prepared.'
