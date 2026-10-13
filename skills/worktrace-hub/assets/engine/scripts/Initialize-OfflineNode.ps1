param(
 [Parameter(Mandatory=$true)][string]$IdentityFile,
 [Parameter(Mandatory=$true)][string]$WorkDir,
 [string]$SkillsDirectory,
 [switch]$SkipMcp,
 [switch]$EnableLogonStartup
)
$ErrorActionPreference='Stop'
$package=Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'provision-common.ps1')
if(![Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0){throw '请在员工已经登录的交互桌面会话内执行。'}
if($WorkDir -notmatch '^[A-Za-z]:\\' -or $WorkDir -match '(^|\\)\.\.(\\|$)'){throw 'WorkDir 必须为本机绝对目录。'}
$root=[IO.Path]::GetFullPath($WorkDir).TrimEnd('\')
if($root.Length -le 3){throw '不能把磁盘根目录作为部署目录。'}
Assert-WorkTracePlainPath $root
$packagePath=[IO.Path]::GetFullPath($package).TrimEnd('\')
if($root.Equals($packagePath,[StringComparison]::OrdinalIgnoreCase) -or $root.StartsWith($packagePath+'\',[StringComparison]::OrdinalIgnoreCase) -or $packagePath.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw '源码与运行目录必须分开，不能相互包含。'}

# Dedicated release ZIPs carry the full source manifest. Git is not required.
$downloadManifest=Join-Path $package '.worktrace-source.json'
if(Test-Path -LiteralPath $downloadManifest){
 $manifest=Get-Content -LiteralPath $downloadManifest -Raw -Encoding UTF8|ConvertFrom-Json
 if($manifest.format -ne 'worktrace.download/1.0' -or $manifest.repository -ne 'https://github.com/zhoudebao6-art/worktrace-skills' -or $manifest.commit -notmatch '^[a-f0-9]{40}$' -or !@($manifest.files).Count){throw '发布源码清单无效。'}
 $seen=@{}
 foreach($row in $manifest.files){
  $relative=[string]$row.path
  if(!$relative -or [IO.Path]::IsPathRooted($relative) -or $relative.Contains('\') -or $relative.Contains(':') -or $relative -match '(^|/)\.\.?(/|$)' -or $relative -match '(^|/)[^/]*[. ](/|$)' -or $seen.ContainsKey($relative) -or $row.sha256 -notmatch '^[a-f0-9]{64}$'){throw '发布源码清单含无效路径或校验值。'}
  $seen[$relative]=$true;$file=Join-Path $package $relative;Assert-WorkTracePlainPath $file
  if(!(Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -ne $row.size -or (Get-WorkTraceHash $file) -ne $row.sha256){throw "发布源码校验失败：$relative"}
 }
 foreach($required in @('scripts/Initialize-OfflineNode.ps1','scripts/provision-common.ps1','skills/worktrace-hub/assets/engine/engine-manifest.json')){if(!$seen.ContainsKey($required)){throw "发布源码清单缺少：$required"}}
}elseif(!(Test-Path -LiteralPath (Join-Path $package '.git'))){throw '请使用带 .worktrace-source.json 的专用发布 ZIP；GitHub 自动 Source code ZIP 不能代替。'}
$source=Join-Path $package 'skills\worktrace-hub\assets\engine'
if(!(Test-Path -LiteralPath (Join-Path $source 'engine-manifest.json'))){throw '缺少随包引擎清单；请完整解压发布包。'}

$identityPath=[IO.Path]::GetFullPath($IdentityFile);Assert-WorkTracePlainPath $identityPath
if(!(Test-Path -LiteralPath $identityPath -PathType Leaf) -or (Get-Item -LiteralPath $identityPath).Length -gt 16384){throw '身份文件必须是至多 16 KiB 的 JSON 文件。'}
$identity=Get-Content -LiteralPath $identityPath -Raw -Encoding UTF8|ConvertFrom-Json
$fields=@('format','org_id','org_name','employee_id','employee_name','label')
if($identity.format -ne 'worktrace.offline-identity/1.0' -or @($identity.PSObject.Properties.Name|Where-Object {$_ -notin $fields}).Count){throw '离线身份格式或字段无效。'}
foreach($field in @('org_name','employee_name','label')){if($identity.$field -isnot [string] -or !$identity.$field.Trim() -or $identity.$field.Length -gt 100 -or $identity.$field -ne $identity.$field.Trim()){throw "离线身份字段无效：$field"}}
if($identity.employee_id -isnot [string] -or $identity.employee_id.Length -gt 80 -or $identity.employee_id -notmatch '^[\p{L}\p{N}_.-]+$'){throw '员工编号无效。'}
if($identity.PSObject.Properties.Name -contains 'org_id' -and $identity.org_id -notmatch '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'){throw '可选 org_id 必须是 UUID。'}
$existingConfig=Join-Path $root 'data\config.json'
if(Test-Path -LiteralPath $existingConfig){
 $existing=Get-Content -LiteralPath $existingConfig -Raw -Encoding UTF8|ConvertFrom-Json
 if($existing.role -ne 'collector' -or $existing.connection_mode -ne 'offline'){throw '目标已有其他模式或角色，未覆盖或转换。'}
 foreach($field in @('org_name','employee_id','employee_name','label')){if(![string]::Equals([string]$existing.$field,[string]$identity.$field,[StringComparison]::Ordinal)){throw "目标已有不同身份（$field），未启动或变更。"}}
 if($identity.org_id -and $existing.org_id -ne $identity.org_id){throw '目标已有不同公司编号，未启动或变更。'}
}
if(!$SkillsDirectory){$SkillsDirectory=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.agents\skills'}
$SkillsDirectory=[IO.Path]::GetFullPath($SkillsDirectory);Assert-WorkTracePlainPath $SkillsDirectory
foreach($name in @('worktrace-collector','worktrace-personal','worktrace-evidence')){
 $dest=Join-Path $SkillsDirectory $name;Assert-WorkTracePlainPath $dest
 $bindingFile=Join-Path $dest 'deployment.json'
 if(Test-Path -LiteralPath $bindingFile){$binding=Get-Content -LiteralPath $bindingFile -Raw -Encoding UTF8|ConvertFrom-Json;if($binding.role -ne 'collector' -or ![string]::Equals([string]$binding.root,$root,[StringComparison]::OrdinalIgnoreCase)){throw "技能已绑定其他运行目录，未覆盖：$name"}}
 elseif((Test-Path -LiteralPath $dest) -and !(Test-Path -LiteralPath (Join-Path $dest '.worktrace-install.json'))){throw "已有未知来源同名技能，未覆盖：$name"}
}
if(Test-Path -LiteralPath 'D:\'){$taskTemp='D:\codex+\temp';$taskCache='D:\codex+\cache\worktrace'}else{$taskTemp=Join-Path $root 'runtime-temp';$taskCache=Join-Path $root 'runtime-cache'}
New-Item -ItemType Directory -Path $taskTemp,$taskCache -Force|Out-Null
$env:TEMP=$taskTemp;$env:TMP=$taskTemp;$env:TMPDIR=$taskTemp;$env:NODE_COMPILE_CACHE=Join-Path $taskCache 'node'
Copy-WorkTraceSource -Source $source -Destination $root
$runtimeArgs=@{Root=$root};$candidate=Join-Path $package 'runtime\node.exe';if(Test-Path -LiteralPath $candidate){$runtimeArgs.Candidate=$candidate}
& (Join-Path $root 'scripts\Ensure-Runtime.ps1') @runtimeArgs
$node=Join-Path $root 'runtime\node.exe';$cli=Join-Path $root 'src\admin-cli.mjs';$data=Join-Path $root 'data'
& (Join-Path $root 'Start.ps1') -NoBrowser
$before=& $node $cli --command status --role collector --dir $data|ConvertFrom-Json
if($LASTEXITCODE -ne 0){throw '无法读取本机状态。'}
if($before.configured -and ($before.connection_mode -ne 'offline' -or $before.employee_id -ne $identity.employee_id)){throw '已运行服务与离线身份不一致，未变更。'}
& $node $cli --command init --role collector --dir $data --input $identityPath|Out-Null
if($LASTEXITCODE -ne 0){throw '离线分控初始化失败；保留现有目录供检查。'}
$install=@{Role='collector';SkillsDirectory=$SkillsDirectory;SkipMcp=$SkipMcp}
& (Join-Path $root 'Install-Skills.ps1') @install
if($EnableLogonStartup){& (Join-Path $root '设置登录启动.ps1')}
$after=& $node $cli --command status --role collector --dir $data|ConvertFrom-Json
if($LASTEXITCODE -ne 0 -or !$after.configured -or $after.connection_mode -ne 'offline' -or $after.employee_id -ne $identity.employee_id){throw '离线状态验收失败。'}
if(!$before.configured -and ($after.collection.enabled -or $after.worker.policy.enabled)){throw '首次部署应保持采集和自动学习未启用；请检查服务。'}
Write-Output ('离线分控已初始化；员工='+$after.employee_id+'；设备='+$after.device_id+'；数据='+$data)
Write-Output '尚未连接总控。首次部署保持采集与自动学习暂停；核对业务范围并完成样本验收后分别启用。重复运行保留已有身份与暂停状态。'
