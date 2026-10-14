param(
 [Parameter(Mandatory=$true)][ValidateSet('start','status','readiness','init','enroll','policy','capture','sync','report','worker-configure','worker-run','jobs','replies','candidates','enqueue','shutdown')][string]$Action,
 [string]$InputFile,[string]$OutputFile
)
$ErrorActionPreference='Stop'
$skillDir=Split-Path $PSScriptRoot -Parent
$bindingFile=Join-Path $skillDir 'deployment.json'
if(Test-Path -LiteralPath $bindingFile){$binding=Get-Content -LiteralPath $bindingFile -Raw -Encoding UTF8|ConvertFrom-Json;$root=$binding.root;$role=$binding.role}
else{throw '此技能缺少部署绑定。请用新版完整源码 scripts/Connect-Node.ps1 从其他分控技能绑定恢复；若有多处或没有有效绑定，只需确认原部署目录，不要重复索取公司链接或重新登记。'}
if(!(Test-Path -LiteralPath (Join-Path $root 'src\admin-cli.mjs'))){throw '原部署目录暂不可用，请先确认原磁盘及 deployment.json 中的目录。不要因此重新登记身份或覆盖原数据。'}
if(Test-Path -LiteralPath 'D:\'){$taskTemp='D:\codex+\temp';$taskCache='D:\codex+\cache\worktrace'}else{$taskTemp=Join-Path $root 'runtime-temp';$taskCache=Join-Path $root 'runtime-cache'}
New-Item -ItemType Directory -Path $taskTemp,$taskCache -Force|Out-Null
$env:TEMP=$taskTemp;$env:TMP=$taskTemp;$env:TMPDIR=$taskTemp;$env:NODE_COMPILE_CACHE=Join-Path $taskCache 'node'
if($Action -eq 'start'){& (Join-Path $root 'Start.ps1') -NoBrowser;return}
$argsList=@((Join-Path $root 'src\admin-cli.mjs'),'--command',$Action,'--role',$role,'--dir',(Join-Path $root 'data'))
if($InputFile){$argsList+=@('--input',[IO.Path]::GetFullPath($InputFile))}
if($OutputFile){$argsList+=@('--output',[IO.Path]::GetFullPath($OutputFile))}
& (Join-Path $root 'runtime\node.exe') @argsList
if($LASTEXITCODE -ne 0){throw 'WorkTrace 操作失败，原因见上方 JSON；没有自动扩大权限或丢弃数据。'}
