param(
 [Parameter(Mandatory=$true)][string]$DataDir,
 [ValidateSet('Status','Enable','Pause','Disable')][string]$Action='Status',
 [string]$CodexPath='',
 [ValidateRange(1,30)][int]$MaxCallsPerDay=6,
 [string]$Start='18:00', [string]$End='23:59',
 [switch]$AutoDispatch
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$root=Split-Path $PSScriptRoot -Parent
if(Test-Path -LiteralPath 'D:\'){$taskTemp='D:\codex+\temp';$taskCache='D:\codex+\cache\worktrace'}else{$taskTemp=Join-Path $root 'runtime-temp';$taskCache=Join-Path $root 'runtime-cache'}
New-Item -ItemType Directory -Path $taskTemp,$taskCache -Force | Out-Null
$env:TEMP=$taskTemp;$env:TMP=$taskTemp;$env:TMPDIR=$taskTemp;$env:NODE_COMPILE_CACHE=Join-Path $taskCache 'node'
& (Join-Path $PSScriptRoot 'Ensure-Runtime.ps1') -Root $root
$node=Join-Path $root 'runtime/node.exe'
$dataPath=[IO.Path]::GetFullPath($DataDir)
if(-not(Test-Path -LiteralPath (Join-Path $dataPath 'config.json'))){throw '目标数据目录尚未初始化；本脚本不会替你创建总控。'}
$role=(Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $dataPath 'config.json') | ConvertFrom-Json).role
$statusRaw=& $node (Join-Path $root 'src/admin-cli.mjs') --command status --role $role --dir $dataPath
if($LASTEXITCODE -ne 0){throw '无法访问目标本机服务'}
$status=$statusRaw | ConvertFrom-Json
if($Action -eq 'Status'){$status.worker | ConvertTo-Json -Depth 10;return}
$p=$status.worker.policy
if($Action -eq 'Enable'){
 if(-not $CodexPath){$CodexPath=(Get-Command codex.exe -ErrorAction Stop).Source}
 $CodexPath=[IO.Path]::GetFullPath($CodexPath)
 if(-not(Test-Path -LiteralPath $CodexPath) -or [IO.Path]::GetFileName($CodexPath) -ne 'codex.exe'){throw '请指定本机 Codex CLI 的 codex.exe'}
 $cliHelp=(& $CodexPath exec --help 2>&1) -join "`n"
 if($LASTEXITCODE -ne 0 -or $cliHelp -notmatch '--ignore-user-config' -or $cliHelp -notmatch '--ignore-rules'){throw '当前 Codex CLI 缺少隔离参数，请升级后再启用；不会降级到不隔离执行。'}
 $p.enabled=$true;$p.paused=$false;$p.codex_path=$CodexPath
 if($role -eq 'hub'){$p.model='gpt-6-astra'}else{$p.model='gpt-6.1-sol'}
 $p.reasoning_effort='xhigh';$p.max_calls_per_day=$MaxCallsPerDay;$p.start=$Start;$p.end=$End
 $p.auto_dispatch=($role -eq 'hub' -and $AutoDispatch.IsPresent)
}else{if($Action -eq 'Pause'){$p.paused=$true}else{$p.enabled=$false}}
$inputPath=Join-Path $dataPath ('worker-policy-request-'+[guid]::NewGuid().ToString()+'.json')
# Settings contain no login secrets. Keep this explicit request alongside the
# database for troubleshooting instead of performing cleanup across shells.
$p | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $inputPath -Encoding UTF8
& $node (Join-Path $root 'src/admin-cli.mjs') --command worker-configure --role $role --dir $dataPath --input $inputPath
if($LASTEXITCODE -ne 0){throw '学习设置被拒绝'}
