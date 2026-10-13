param(
 [Parameter(Mandatory=$true)][string]$ConnectionLink,
 [Parameter(Mandatory=$true)][string]$WorkDir,
 [Parameter(Mandatory=$true)][string]$EmployeeId,
 [Parameter(Mandatory=$true)][string]$EmployeeName,
 [Parameter(Mandatory=$true)][string]$ComputerLabel,
 [string]$SkillsDirectory,
 [switch]$SkipMcp,
 [switch]$StartCapture,
 [switch]$EnableLogonStartup
)
$ErrorActionPreference='Stop'
$package=Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'provision-common.ps1')
if(![Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0){throw '请在员工已经登录的交互桌面会话内执行。'}
if($WorkDir -notmatch '^[A-Za-z]:\\' -or $WorkDir -match '(^|\\)\.\.(\\|$)'){throw 'WorkDir 必须为本机绝对目录。'}
$root=[IO.Path]::GetFullPath($WorkDir).TrimEnd('\');$packagePath=[IO.Path]::GetFullPath($package).TrimEnd('\')
if($root.Length -le 3){throw '不能把磁盘根目录作为部署目录。'}
Assert-WorkTracePlainPath $root;Assert-WorkTracePlainPath $packagePath
if($root.Equals($packagePath,[StringComparison]::OrdinalIgnoreCase) -or $root.StartsWith($packagePath+'\',[StringComparison]::OrdinalIgnoreCase) -or $packagePath.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw '源码与运行目录必须分开，不能相互包含。'}

# Validate every release source entry before executing a bundled runtime/client.
$downloadManifest=Join-Path $package '.worktrace-source.json'
if(Test-Path -LiteralPath $downloadManifest){
 Assert-WorkTracePlainPath $downloadManifest
 $manifest=Get-Content -LiteralPath $downloadManifest -Raw -Encoding UTF8|ConvertFrom-Json
 if($manifest.format -ne 'worktrace.download/1.0' -or $manifest.repository -ne 'https://github.com/zhoudebao6-art/worktrace-skills' -or $manifest.commit -notmatch '^[a-f0-9]{40}$' -or !@($manifest.files).Count){throw '发布源码清单无效。'}
 $seen=@{}
 foreach($row in $manifest.files){
  $relative=[string]$row.path
  if(!$relative -or [IO.Path]::IsPathRooted($relative) -or $relative.Contains('\') -or $relative.Contains(':') -or $relative -match '(^|/)\.\.?(/|$)' -or $relative -match '(^|/)[^/]*[. ](/|$)' -or $seen.ContainsKey($relative) -or $row.sha256 -notmatch '^[a-f0-9]{64}$'){throw '发布源码清单含无效路径或校验值。'}
  $seen[$relative]=$true;$file=Join-Path $package $relative;Assert-WorkTracePlainPath $file
  if(!(Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -ne $row.size -or (Get-WorkTraceHash $file) -ne $row.sha256){throw "发布源码校验失败：$relative"}
 }
 foreach($required in @('scripts/Join-Lan.ps1','scripts/provision-common.ps1','src/lan-join-client.mjs','skills/worktrace-hub/assets/engine/engine-manifest.json')){if(!$seen.ContainsKey($required)){throw "发布源码清单缺少：$required"}}
 $source=Join-Path $package 'skills\worktrace-hub\assets\engine'
}elseif(Test-Path -LiteralPath (Join-Path $package '.git')){
 $source=Join-Path $package 'skills\worktrace-hub\assets\engine'
}elseif(Test-Path -LiteralPath (Join-Path $package 'engine-manifest.json')){
 $source=$package
}else{throw '请完整解压专用发布包，或使用带引擎清单的公司源码副本。'}
$engineManifest=Join-Path $source 'engine-manifest.json';Assert-WorkTracePlainPath $engineManifest
if(!(Test-Path -LiteralPath $engineManifest -PathType Leaf)){throw '缺少引擎校验清单。'}
$engine=Get-Content -LiteralPath $engineManifest -Raw -Encoding UTF8|ConvertFrom-Json
if($engine.format -ne 'worktrace.source/1.0' -or !@($engine.files).Count){throw '引擎清单格式无效。'}
$engineSeen=@{}
foreach($row in $engine.files){
 $relative=[string]$row.path
 if(!$relative -or [IO.Path]::IsPathRooted($relative) -or $relative.Contains('\') -or $relative.Contains(':') -or $relative -match '(^|/)\.\.?(/|$)' -or $relative -match '(^|/)[^/]*[. ](/|$)' -or $engineSeen.ContainsKey($relative) -or $row.sha256 -notmatch '^[a-f0-9]{64}$'){throw '引擎清单含无效路径或校验值。'}
 $engineSeen[$relative]=$true;$file=Join-Path $source $relative;Assert-WorkTracePlainPath $file
 if(!(Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -ne $row.size -or (Get-WorkTraceHash $file) -ne $row.sha256){throw "引擎校验失败：$relative"}
}
foreach($required in @('src/lan-join-client.mjs','scripts/Join-Lan.ps1','scripts/Join-Node.ps1','scripts/provision-common.ps1','scripts/Ensure-Runtime.ps1')){if(!$engineSeen.ContainsKey($required)){throw "引擎清单缺少：$required"}}

$prefix='https://github.com/zhoudebao6-art/worktrace-skills/tree/main#worktrace-join=v1.'
if($ConnectionLink.Length -gt 32768 -or !$ConnectionLink.StartsWith($prefix,[StringComparison]::Ordinal)){throw '请提供公司发出的完整技能连接链接，包含 #worktrace-join=v1. 部分。'}
$encoded=$ConnectionLink.Substring($prefix.Length)
if($encoded -notmatch '^[A-Za-z0-9_-]+$'){throw '公司连接链接编码无效。'}
try{
 $padded=$encoded.Replace('-','+').Replace('_','/');while($padded.Length % 4){$padded+='='}
 $bytes=[Convert]::FromBase64String($padded)
 if($bytes.Length -gt 24576 -or [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_') -cne $encoded){throw 'Invalid encoding'}
 $connection=(New-Object Text.UTF8Encoding($false,$true)).GetString($bytes)|ConvertFrom-Json
}catch{throw '公司连接链接不是有效的 UTF-8 JSON。'}
$fields=@('format','hub_url','org_id','org_name','ca_pem')
if(@($connection.PSObject.Properties).Count -ne $fields.Count -or @($fields|Where-Object {$null -eq $connection.$_}).Count -or $connection.format -cne 'worktrace.lan-link/1.0' -or $connection.org_id -notmatch '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'){throw '公司连接信息格式无效。'}
if($connection.org_name -isnot [string] -or !$connection.org_name.Trim() -or $connection.org_name.Length -gt 100 -or $connection.org_name -cne $connection.org_name.Trim()){throw '公司名称无效。'}
try{$address=New-Object Uri([string]$connection.hub_url)}catch{throw '总控地址无效。'}
if($address.Scheme -cne 'https' -or $address.UserInfo -or $address.Query -or $address.Fragment -or $address.AbsolutePath -ne '/' -or $connection.hub_url -cne $address.GetLeftPart([UriPartial]::Authority)){throw '总控地址必须是规范的 HTTPS origin。'}
$ip=$null
if(![Net.IPAddress]::TryParse($address.Host,[ref]$ip) -or $ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $ip.ToString() -cne $address.Host){throw '总控地址必须为规范的局域网 IPv4 地址。'}
$octets=$ip.GetAddressBytes()
if(!($octets[0] -eq 10 -or ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or ($octets[0] -eq 192 -and $octets[1] -eq 168))){throw '总控地址必须为 RFC1918 私有 IPv4 地址。'}
if($connection.ca_pem -isnot [string] -or $connection.ca_pem.Length -gt 20000 -or $connection.ca_pem.Contains('PRIVATE KEY') -or $connection.ca_pem.Trim() -notmatch '^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$' -or ([regex]::Matches($connection.ca_pem,'BEGIN CERTIFICATE')).Count -ne 1){throw '连接链接必须包含单个公司公开证书。'}
if($EmployeeId -notmatch '^[\p{L}\p{N}_.-]{1,80}$' -or !$EmployeeName.Trim() -or $EmployeeName.Length -gt 100 -or $EmployeeName -ne $EmployeeName.Trim() -or !$ComputerLabel.Trim() -or $ComputerLabel.Length -gt 100 -or $ComputerLabel -ne $ComputerLabel.Trim()){throw '员工编号、姓名或电脑名称无效。'}
$inbox=Join-Path $root 'setup\lan-enrollment';$data=Join-Path $root 'data'
$existingConfig=Join-Path $data 'config.json'
Assert-WorkTracePlainPath $inbox;Assert-WorkTracePlainPath $data;Assert-WorkTracePlainPath $existingConfig
if(Test-Path -LiteralPath $existingConfig){
 $existing=Get-Content -LiteralPath $existingConfig -Raw -Encoding UTF8|ConvertFrom-Json
 if($existing.role -ne 'collector' -or $existing.connection_mode -eq 'offline' -or $existing.org_id -ne $connection.org_id -or $existing.org_name -cne $connection.org_name -or $existing.hub_url -cne $connection.hub_url -or $existing.ca_pem -cne $connection.ca_pem -or $existing.employee_id -cne $EmployeeId -or $existing.employee_name -cne $EmployeeName -or $existing.label -cne $ComputerLabel){throw '目标已有不同角色、模式、公司或员工身份；未登记或覆盖数据。'}
 foreach($name in @('request.json','enrollment.json')){if(!(Test-Path -LiteralPath (Join-Path $inbox $name) -PathType Leaf)){throw '目标已初始化但缺少原接入状态；不能重新登记。'}}
}elseif((Test-Path -LiteralPath $data) -and @(Get-ChildItem -LiteralPath $data -Force).Count){throw '目标数据目录已有文件但缺少身份配置；保留原数据，请先由总控核对恢复。'}
if(!$SkillsDirectory){$SkillsDirectory=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.agents\skills'}
$SkillsDirectory=[IO.Path]::GetFullPath($SkillsDirectory);Assert-WorkTracePlainPath $SkillsDirectory
foreach($name in @('worktrace-collector','worktrace-personal','worktrace-evidence')){
 $dest=Join-Path $SkillsDirectory $name;Assert-WorkTracePlainPath $dest;$bindingFile=Join-Path $dest 'deployment.json';Assert-WorkTracePlainPath $bindingFile
 if(Test-Path -LiteralPath $bindingFile){$binding=Get-Content -LiteralPath $bindingFile -Raw -Encoding UTF8|ConvertFrom-Json;if($binding.role -ne 'collector' -or ![string]::Equals([string]$binding.root,$root,[StringComparison]::OrdinalIgnoreCase)){throw "技能已绑定其他运行目录，未覆盖：$name"}}
 elseif((Test-Path -LiteralPath $dest) -and !(Test-Path -LiteralPath (Join-Path $dest '.worktrace-install.json'))){throw "已有未知来源同名技能，未覆盖：$name"}
}
function Protect-WorkTraceDirectory([string]$Path){
 Assert-WorkTracePlainPath $Path;New-Item -ItemType Directory -Path $Path -Force|Out-Null
 $security=New-Object Security.AccessControl.DirectorySecurity
 $security.SetAccessRuleProtection($true,$false)
 $owner=[Security.Principal.WindowsIdentity]::GetCurrent().User
 foreach($sid in @($owner.Value,'S-1-5-18','S-1-5-32-544')){
  $identity=New-Object Security.Principal.SecurityIdentifier($sid)
  $rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit, ObjectInherit','None','Allow');$security.AddAccessRule($rule)
 }
 if($PSVersionTable.PSEdition -eq 'Core'){[IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]$Path,$security)}else{[IO.Directory]::SetAccessControl($Path,$security)}
}
function Protect-WorkTraceFile([string]$Path){
 Assert-WorkTracePlainPath $Path
 if(!(Test-Path -LiteralPath $Path -PathType Leaf)){return}
 $security=New-Object Security.AccessControl.FileSecurity
 $security.SetAccessRuleProtection($true,$false)
 $owner=[Security.Principal.WindowsIdentity]::GetCurrent().User
 foreach($sid in @($owner.Value,'S-1-5-18','S-1-5-32-544')){
  $identity=New-Object Security.Principal.SecurityIdentifier($sid)
  $rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','Allow');$security.AddAccessRule($rule)
 }
 if($PSVersionTable.PSEdition -eq 'Core'){[IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]$Path,$security)}else{[IO.File]::SetAccessControl($Path,$security)}
}
Protect-WorkTraceDirectory $inbox;Protect-WorkTraceDirectory $data
foreach($protectedFile in @((Join-Path $inbox 'request.json'),(Join-Path $inbox 'enrollment.json'),$existingConfig)){Protect-WorkTraceFile $protectedFile}
# A retry cannot silently change capture/startup choices after registration.
$settings=Join-Path $inbox 'join.json';Assert-WorkTracePlainPath $settings
if(Test-Path -LiteralPath $settings){
 $prior=Get-Content -LiteralPath $settings -Raw -Encoding UTF8|ConvertFrom-Json
 if($prior.format -cne 'worktrace.join/1.0' -or $prior.work_dir -cne $root -or $prior.employee_id -cne $EmployeeId -or $prior.start_capture -cne $StartCapture.IsPresent -or $prior.enable_logon_startup -cne $EnableLogonStartup.IsPresent){throw '已有接入设置不同，未覆盖；请使用原身份及原启停参数重试。'}
}
if(Test-Path -LiteralPath 'D:\'){$taskTemp='D:\codex+\temp';$taskCache='D:\codex+\cache\worktrace'}else{$taskTemp=Join-Path $root 'runtime-temp';$taskCache=Join-Path $root 'runtime-cache'}
New-Item -ItemType Directory -Path $taskTemp,$taskCache -Force|Out-Null
$env:TEMP=$taskTemp;$env:TMP=$taskTemp;$env:TMPDIR=$taskTemp;$env:NODE_COMPILE_CACHE=Join-Path $taskCache 'node'
# The existing Join entrypoint requires its own verified Node. Stage that public
# source under the private inbox; do not add machine files to the release source.
$joinSource=Join-Path $inbox 'source'
Copy-WorkTraceSource -Source $source -Destination $joinSource
$runtimeArgs=@{Root=$joinSource};$candidate=Join-Path $package 'runtime\node.exe';if(Test-Path -LiteralPath $candidate){$runtimeArgs.Candidate=$candidate}
& (Join-Path $joinSource 'scripts\Ensure-Runtime.ps1') @runtimeArgs
$node=Join-Path $joinSource 'runtime\node.exe'
# Fail before registration if the existing destination has a
# different source/runtime version. Existing files are never overwritten.
Copy-WorkTraceSource -Source $joinSource -Destination $root
& (Join-Path $root 'scripts\Ensure-Runtime.ps1') -Root $root -Candidate $node
# Validate the complete public link before permanently recording its company
# and certificate. No enrollment secrets exist yet on a fresh installation.
$ConnectionLink | & $node (Join-Path $joinSource 'src\lan-join-client.mjs') --validate-link | Out-Null
if($LASTEXITCODE -ne 0){throw '公司连接链接验证失败；尚未登记设备。'}
$connectionPath=Join-Path $inbox 'connection.json';Assert-WorkTracePlainPath $connectionPath
if(Test-Path -LiteralPath $connectionPath){
 $priorConnection=Get-Content -LiteralPath $connectionPath -Raw -Encoding UTF8|ConvertFrom-Json
 foreach($field in $fields){if($priorConnection.$field -cne $connection.$field){throw '已有公司连接信息不同，未覆盖；请使用原链接重试。'}}
}else{
 $publicBytes=(New-Object Text.UTF8Encoding($false)).GetBytes(($connection|ConvertTo-Json -Depth 5))
 $connectionStream=New-Object IO.FileStream($connectionPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$connectionStream.Write($publicBytes,0,$publicBytes.Length);$connectionStream.Flush($true)}finally{$connectionStream.Dispose()}
}
$clientArgs=@((Join-Path $joinSource 'src\lan-join-client.mjs'),'--connection',$connectionPath,'--state',(Join-Path $inbox 'request.json'),'--output',(Join-Path $inbox 'enrollment.json'),'--work-dir',$root,'--employee-id',$EmployeeId,'--employee-name',$EmployeeName,'--label',$ComputerLabel)
$result=& $node @clientArgs
if($LASTEXITCODE -ne 0){throw '局域网接入未完成；原请求及已有数据均保留。请按上方错误核对后原样重试。'}
foreach($protectedFile in @((Join-Path $inbox 'request.json'),(Join-Path $inbox 'enrollment.json'))){Protect-WorkTraceFile $protectedFile}
$joined=$result|ConvertFrom-Json
$enrollment=Get-Content -LiteralPath (Join-Path $inbox 'enrollment.json') -Raw -Encoding UTF8|ConvertFrom-Json
$settings=Join-Path $inbox 'join.json';Assert-WorkTracePlainPath $settings
$job=@{format='worktrace.join/1.0';work_dir=$root;employee_id=$joined.employee_id;device_id=$joined.device_id;start_capture=$StartCapture.IsPresent;enable_logon_startup=$EnableLogonStartup.IsPresent}
if(Test-Path -LiteralPath $settings){
 $prior=Get-Content -LiteralPath $settings -Raw -Encoding UTF8|ConvertFrom-Json
 foreach($key in $job.Keys){if($prior.$key -cne $job[$key]){throw '已有接入设置不同，未覆盖；请使用原身份及原启停参数重试。'}}
}else{
 $bytes=(New-Object Text.UTF8Encoding($false)).GetBytes(($job|ConvertTo-Json -Depth 5))
 $stream=New-Object IO.FileStream($settings,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
$joinArgs=@{Settings=$settings;SkillsDirectory=$SkillsDirectory;SkipMcp=$SkipMcp}
& (Join-Path $joinSource 'scripts\Join-Node.ps1') @joinArgs|Out-Null
if($LASTEXITCODE -ne 0){throw '分控部署尚未完成；保留原请求和登记文件供重试。'}
Protect-WorkTraceFile $existingConfig
$status=& (Join-Path $root 'runtime\node.exe') (Join-Path $root 'src\admin-cli.mjs') --command status --role collector --dir $data|ConvertFrom-Json
if($LASTEXITCODE -ne 0 -or !$status.configured -or $status.role -ne 'collector' -or $status.org_id -ne $enrollment.org_id -or $status.device_id -ne $enrollment.device_id -or $status.employee_id -cne $EmployeeId -or $status.employee_name -cne $EmployeeName -or $status.hub_url -cne $enrollment.hub_url){throw '分控公司、设备或员工身份验收失败；原数据已保留。'}
if(!$status.sync.last_success -or $status.sync.error){throw '身份已保存但心跳尚未确认；检查网络后使用原请求重试。'}
if($status.worker.policy.model -ne 'gpt-6.1-sol' -or $status.worker.policy.reasoning_effort -ne 'xhigh'){throw '分控模型未符合 GPT-6.1 Sol / xhigh 要求。'}
if(!$existing -and !$StartCapture -and $status.collection.enabled){throw '首次接入默认应保持采集关闭；请检查服务。'}
Write-Output ('分控身份及总控心跳验证通过；员工='+$EmployeeId+'；设备='+$status.device_id+'；模型=gpt-6.1-sol / xhigh。')
Write-Output '接入文件保存在本机受限目录；首次默认关闭采集。实际业务采样和个人总结需核对工作范围后单独验收。'
