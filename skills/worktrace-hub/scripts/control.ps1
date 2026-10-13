param(
 [Parameter(Mandatory=$true)][ValidateSet('start','status','init','enroll','policy','capture','sync','report','worker-configure','worker-run','jobs','replies','candidates','enqueue','shutdown')][string]$Action,
 [string]$InputFile,[string]$OutputFile
)
$ErrorActionPreference='Stop'
$skillDir=Split-Path $PSScriptRoot -Parent
$bindingFile=Join-Path $skillDir 'deployment.json'
if(Test-Path -LiteralPath $bindingFile){$binding=Get-Content -LiteralPath $bindingFile -Raw -Encoding UTF8|ConvertFrom-Json;$root=$binding.root;$role=$binding.role}
else{throw '请先运行总控 Skill 的 scripts/bootstrap.ps1 -WorkDir 指定目录。'}
if(!(Test-Path -LiteralPath (Join-Path $root 'src\admin-cli.mjs'))){throw 'WorkTrace 工作目录失效，请核对总控 Skill 的部署绑定。'}
if(Test-Path -LiteralPath 'D:\'){$taskTemp='D:\codex+\temp';$taskCache='D:\codex+\cache\worktrace'}else{$taskTemp=Join-Path $root 'runtime-temp';$taskCache=Join-Path $root 'runtime-cache'}
New-Item -ItemType Directory -Path $taskTemp,$taskCache -Force|Out-Null
$env:TEMP=$taskTemp;$env:TMP=$taskTemp;$env:TMPDIR=$taskTemp;$env:NODE_COMPILE_CACHE=Join-Path $taskCache 'node'
if($Action -eq 'start'){& (Join-Path $root 'Start.ps1') -NoBrowser;return}
$argsList=@((Join-Path $root 'src\admin-cli.mjs'),'--command',$Action,'--role',$role,'--dir',(Join-Path $root 'data'))
if($InputFile){$argsList+=@('--input',[IO.Path]::GetFullPath($InputFile))}
if($OutputFile){$argsList+=@('--output',[IO.Path]::GetFullPath($OutputFile))}
& (Join-Path $root 'runtime\node.exe') @argsList
if($LASTEXITCODE -ne 0){throw 'WorkTrace 操作失败，原因见上方 JSON；没有自动扩大权限或丢弃数据。'}
