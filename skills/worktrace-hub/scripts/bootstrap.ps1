param([Parameter(Mandatory=$true)][string]$WorkDir,[switch]$SkipMcp)
$ErrorActionPreference='Stop'
$skill=Split-Path $PSScriptRoot -Parent;$source=Join-Path $skill 'assets\engine'
. (Join-Path $source 'scripts\provision-common.ps1')
$root=[IO.Path]::GetFullPath($WorkDir)
$bindingFile=Join-Path $skill 'deployment.json'
if(Test-Path -LiteralPath $bindingFile){$old=Get-Content -LiteralPath $bindingFile -Raw -Encoding UTF8|ConvertFrom-Json;if($old.root -ne $root){throw '此总控技能已绑定其他工作目录，未改变原绑定。'}}
Copy-WorkTraceSource -Source $source -Destination $root
& (Join-Path $root 'scripts\Ensure-Runtime.ps1') -Root $root
$existingConfig=Join-Path $root 'data\config.json'
if(Test-Path -LiteralPath $existingConfig){$existing=Get-Content -LiteralPath $existingConfig -Raw -Encoding UTF8|ConvertFrom-Json;if($existing.role -ne 'hub'){throw '目标已有分控身份，未启动或变更。'}}
& (Join-Path $root 'Start.ps1') -NoBrowser
& (Join-Path $root 'runtime\node.exe') (Join-Path $root 'src\admin-cli.mjs') --command status --role hub --dir (Join-Path $root 'data')
if($LASTEXITCODE -ne 0){throw '本机角色检查失败。'}
if(!$SkipMcp){& (Join-Path $root '连接Codex.ps1')}
@{root=$root;role='hub';version='0.2.0'}|ConvertTo-Json|Set-Content -LiteralPath $bindingFile -Encoding UTF8
Write-Output '总控环境已准备。尚未配置公司时，下一步用 control.ps1 -Action init 初始化真实公司与局域网地址。'
