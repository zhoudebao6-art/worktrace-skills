param(
 [string]$WorkDir,
 [string]$SkillsDirectory,
 [switch]$SkipMcp,
 [switch]$SkipLogonStartup,
 [switch]$Inspect
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'provision-common.ps1')
$names=@('worktrace-collector','worktrace-personal','worktrace-evidence')
function Resolve-ConnectionPath([string]$Path,[string]$Label){
 if(!$Path -or $Path -notmatch '^[A-Za-z]:[\\/]' -or $Path.Substring(2).Contains(':') -or $Path -match '(^|[\\/])\.\.?([\\/]|$)' -or $Path -match '[\x00-\x1f"<>|?*]' -or $Path -match '[. ]([\\/]|$)'){throw "$Label 必须为本机绝对普通目录。"}
 $full=[IO.Path]::GetFullPath($Path).TrimEnd('\','/');if($full.Length -le 3){throw "$Label 不能是磁盘根目录。"}
 Assert-WorkTracePlainPath $full;return $full
}
function Read-ConnectionJson([string]$Path,[string]$Label){
 Assert-WorkTracePlainPath $Path
 if(!(Test-Path -LiteralPath $Path -PathType Leaf)){throw "缺少$Label；保留原数据，请指定或恢复原运行目录。"}
 try{return Get-Content -LiteralPath $Path -Raw -Encoding UTF8|ConvertFrom-Json}catch{throw "$Label 不是有效 JSON；原文件未变更。"}
}
function Assert-ConnectionEngine([string]$Root){
 $manifest=Read-ConnectionJson (Join-Path $Root 'engine-manifest.json') '引擎清单'
 if($manifest.format -cne 'worktrace.source/1.0' -or !@($manifest.files).Count){throw '引擎清单格式无效。'}
 $seen=@{}
 foreach($row in $manifest.files){
  $relative=[string]$row.path
  if(!$relative -or [IO.Path]::IsPathRooted($relative) -or $relative.Contains('\') -or $relative.Contains(':') -or $relative -match '(^|/)\.\.?(/|$)' -or $relative -match '(^|/)[^/]*[. ](/|$)' -or $relative -match '[\x00-\x1f"<>|?*]' -or $relative.Contains('//') -or $seen.ContainsKey($relative) -or $row.sha256 -notmatch '^[a-f0-9]{64}$'){throw '引擎清单含无效路径或校验值。'}
  $seen[$relative]=$true;$file=Join-Path $Root $relative;Assert-WorkTracePlainPath $file
  if(!(Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -ne $row.size -or (Get-WorkTraceHash $file) -ne $row.sha256){throw "引擎校验失败：$relative；请恢复匹配版本，原身份未变更。"}
 }
 foreach($required in @('Start.ps1','Tray.ps1','Install-Skills.ps1','连接Codex.ps1','设置登录启动.ps1','scripts/Ensure-Runtime.ps1','scripts/provision-common.ps1','src/server.mjs','src/admin-cli.mjs','src/local-api.mjs','src/worker.mjs','src/collector.mjs')){if(!$seen.ContainsKey($required)){throw "引擎清单缺少：$required"}}
 foreach($name in $names){if(!$seen.ContainsKey('skills/'+$name+'/SKILL.md')){throw "引擎清单缺少分控技能：$name"}}
 $runtime=Join-Path $Root 'runtime\node.exe';Assert-WorkTracePlainPath $runtime
 if(!(Test-Path -LiteralPath $runtime -PathType Leaf) -or (Get-WorkTraceHash $runtime) -cne '0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4'){throw '原运行目录的 Node v22.23.2 x64 未通过固定 SHA256 校验；未下载或替换运行时。'}
 return $manifest
}
function Assert-ConnectionIdentity($Config){
 if($Config.role -cne 'collector'){throw '该运行目录不是已登记分控；未初始化或改写身份。'}
 foreach($key in @('org_id','device_id','installation_id')){if($Config.$key -notmatch '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'){throw "原分控身份缺少有效 $key；请恢复原配置，不能重新登记代替恢复。"}}
 if($Config.employee_id -isnot [string] -or $Config.employee_id -notmatch '^[\p{L}\p{N}_.-]{1,80}$' -or $Config.host_binding -notmatch '^[a-f0-9]{64}$'){throw '原分控员工或主机绑定无效；原身份未变更。'}
 foreach($key in @('org_name','employee_name','label')){if($Config.$key -isnot [string] -or !$Config.$key.Trim() -or $Config.$key.Length -gt 100){throw "原分控身份字段无效：$key"}}
 if($Config.connection_mode -ceq 'offline'){return 'offline'}
 if($Config.connection_mode -and $Config.connection_mode -cne 'hub'){throw '原分控连接模式无效；未改变模式。'}
 if($Config.device_token -isnot [string] -or $Config.device_token -cnotmatch '^[A-Za-z0-9_-]{43}$'){throw '原设备认证配置不完整；请恢复原配置，未重新登记。'}
 try{$url=New-Object Uri([string]$Config.hub_url)}catch{throw '已保存总控地址无效；保留原身份，请核对地址配置。'}
 if(!$url.IsAbsoluteUri -or $url.Scheme -cne 'https' -or $url.UserInfo -or $url.Query -or $url.Fragment -or $url.AbsolutePath -ne '/'){throw '已保存总控地址必须为 HTTPS origin；保留原身份，请核对地址配置。'}
 if($Config.ca_pem -isnot [string] -or $Config.ca_pem.Length -gt 20000 -or $Config.ca_pem.Contains('PRIVATE KEY') -or $Config.ca_pem.Trim() -notmatch '^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$'){throw '已保存公司证书无效；保留原身份，请核对证书配置。'}
 try{$der=[Convert]::FromBase64String(($Config.ca_pem -replace '-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s',''));$certificate=New-Object Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList (,$der);$certificate.Dispose()}catch{throw '已保存公司证书无法解析；保留原身份，请核对证书配置。'}
 return 'hub'
}
if(!$SkillsDirectory){$SkillsDirectory=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.agents\skills'}
$SkillsDirectory=Resolve-ConnectionPath $SkillsDirectory 'SkillsDirectory'
$bindings=@();$roots=@{}
foreach($name in $names){
 $folder=Join-Path $SkillsDirectory $name;Assert-WorkTracePlainPath $folder
 $file=Join-Path $folder 'deployment.json';Assert-WorkTracePlainPath $file
 if(Test-Path -LiteralPath $file){
  $binding=Read-ConnectionJson $file '技能部署绑定'
  if($binding.role -cne 'collector'){throw "技能部署绑定不是分控：$name"}
  $bound=Resolve-ConnectionPath ([string]$binding.root) 'deployment.root'
  $bindings+=@{name=$name;root=$bound};$roots[$bound]=$true
 }
}
if($WorkDir){$root=Resolve-ConnectionPath $WorkDir 'WorkDir'}else{
 if(!$roots.Count){throw '未找到分控 deployment.json。请用 -WorkDir 指定已有运行目录；恢复连接不需要总控链接，也不会重新登记。'}
 if($roots.Count -gt 1){throw ('发现多个已绑定运行目录，请用 -WorkDir 明确选择原分控目录：'+(($roots.Keys|Sort-Object) -join '；'))}
 $root=[string]@($roots.Keys)[0]
}
$manifest=Assert-ConnectionEngine $root
$data=Join-Path $root 'data';Assert-WorkTracePlainPath $data
$configPath=Join-Path $data 'config.json';$config=Read-ConnectionJson $configPath '原分控身份配置';$configHash=Get-WorkTraceHash $configPath
$mode=Assert-ConnectionIdentity $config
if(Test-Path -LiteralPath (Join-Path $data 'REVIEW-ONLY.json')){throw '此目录仅供审阅，不能作为活跃分控恢复；请使用原主机的显式恢复入口。'}
foreach($file in @('worktrace.sqlite','worktrace.sqlite-wal','worktrace.sqlite-shm','running.json','tray.pid','service-output.log','service-error.log','observer-policy.json')){Assert-WorkTracePlainPath (Join-Path $data $file)}
$conflicts=@($bindings|Where-Object {![string]::Equals($_.root,$root,[StringComparison]::OrdinalIgnoreCase)})
$bindingReady=($bindings.Count -eq 3 -and !$conflicts.Count)
$result=[ordered]@{format='worktrace.connection/1.0';status='inspected';root=$root;role='collector';employee_id=$config.employee_id;device_id=$config.device_id;connection_mode=$mode;bindings_complete=$bindingReady;logon_startup='unchanged';service_running=$false;mcp=@{status='not_checked'};sync=@{state='not_checked';retry_seconds=30}}
if($Inspect){$result|ConvertTo-Json -Depth 6 -Compress;return}
if($mode -eq 'offline'){$result.status='offline';$result.sync=@{state='offline';retry_seconds=$null};$result.message='此分控保持独立离线；未启动联网、重登记或改变采集学习策略。';$result|ConvertTo-Json -Depth 6 -Compress;return}
if($conflicts.Count){throw ('所选运行目录与现有技能绑定不同；未覆盖其他分控。请为所选目录使用对应 -SkillsDirectory：'+(($conflicts|ForEach-Object {$_.root}|Sort-Object -Unique) -join '；'))}
if(![Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0){throw '请在原员工已经登录的交互桌面会话内恢复分控。'}
$node=Join-Path $root 'runtime\node.exe';$cli=Join-Path $root 'src\admin-cli.mjs'
# Open SQLite read-only: no Store constructor, migrations, initialization or account copying.
$snapshotCode=@'
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {hostname} from 'node:os';
const dir=process.argv[2], c=JSON.parse(readFileSync(join(dir,'config.json'),'utf8').replace(/^\uFEFF/,''));
if(c.host_binding!==createHash('sha256').update(c.org_id+':'+hostname()).digest('hex'))throw Error('Host binding mismatch');
const db=new DatabaseSync(join(dir,'worktrace.sqlite'),{readOnly:true});
try{
 const d=db.prepare('SELECT org_id,device_id,employee_id,employee_name,label FROM devices WHERE device_id=?').get(c.device_id);
 if(!d||Object.keys(d).some(k=>d[k]!==c[k]))throw Error('Database identity mismatch');
 const out={};for(const key of ['capture_enabled','policy','worker_policy','file_policy']){const row=db.prepare('SELECT value FROM meta WHERE key=?').get(key);out[key]=row?JSON.parse(row.value):null;}
 console.log(JSON.stringify(out));
}finally{db.close();}
'@
function Get-ConnectionSnapshot {
 if(!(Test-Path -LiteralPath (Join-Path $data 'worktrace.sqlite') -PathType Leaf)){throw '原分控数据库缺失；未创建空库或重新初始化。'}
 $previous=$ErrorActionPreference;$ErrorActionPreference='Continue'
 try{$raw=$snapshotCode|& $node --no-warnings --input-type=module - $data 2>&1;$code=$LASTEXITCODE}finally{$ErrorActionPreference=$previous}
 if($code -ne 0){throw '原数据库、员工设备或主机身份核验失败；未重新初始化，请恢复原运行目录。'}
 try{return ($raw -join "`n")|ConvertFrom-Json}catch{throw '原数据库策略读取失败。'}
}
function Read-ConnectionStatus {
 $previous=$ErrorActionPreference;$ErrorActionPreference='Continue'
 try{$raw=& $node --no-warnings $cli --command status --role collector --dir $data 2>&1;$code=$LASTEXITCODE}finally{$ErrorActionPreference=$previous}
 if($code -ne 0){throw '不能读取原分控本机服务状态；原身份保留。'}
 try{$status=($raw -join "`n")|ConvertFrom-Json}catch{throw '本机分控服务返回无效状态。'}
 if(!$status.configured -or $status.role -cne 'collector' -or $status.connection_mode -cne 'hub'){throw '本机服务角色或连接模式与原配置不同；未初始化。'}
 foreach($key in @('org_id','org_name','device_id','employee_id','employee_name','hub_url')){if($status.$key -cne $config.$key){throw "本机服务身份与原配置不同：$key；原文件未覆盖。"}}
 return $status
}
function Assert-ConnectionService {
 $running=Read-ConnectionJson (Join-Path $data 'running.json') '本机服务状态'
 try{$address=New-Object Uri([string]$running.url)}catch{throw '本机服务状态地址无效。'}
 if(!$address.IsAbsoluteUri -or $address.Scheme -cne 'http' -or $address.Host -cne '127.0.0.1' -or $address.Port -ne $running.port -or $running.pid -notmatch '^\d+$'){throw '本机服务状态不是有效回环服务。'}
 $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$running.pid) -ErrorAction SilentlyContinue
 if(!$process -or ![string]::Equals($process.ExecutablePath,$node,[StringComparison]::OrdinalIgnoreCase) -or !$process.CommandLine -or $process.CommandLine -notmatch ('(?:^|\s)"?'+[regex]::Escape((Join-Path $root 'src\server.mjs'))+'"?(?=\s|$)')){throw '运行中服务不属于原分控目录；未连接其他服务或覆盖状态。'}
}
$before=Get-ConnectionSnapshot
$beforeJson=$before|ConvertTo-Json -Depth 30 -Compress
# Preflight binding restoration before starting or changing login startup.
$restoreBindings=@()
if(!$bindingReady){
 foreach($name in $names){
  $dest=Join-Path $SkillsDirectory $name
  if(Test-Path -LiteralPath $dest){
   foreach($item in Get-ChildItem -LiteralPath $dest -Force -Recurse){Assert-WorkTracePlainPath $item.FullName}
   if(!(Test-Path -LiteralPath (Join-Path $dest 'deployment.json')) -and !(Test-Path -LiteralPath (Join-Path $dest '.worktrace-install.json'))){
    if(!$WorkDir){throw "原技能绑定缺失：$name；请用 -WorkDir 明确原运行目录后恢复，不需要总控链接。"}
    $source=Join-Path (Join-Path $root 'skills') $name
    foreach($sourceFile in Get-ChildItem -LiteralPath $source -File -Recurse){
     $relative=$sourceFile.FullName.Substring($source.Length+1);$installed=Join-Path $dest $relative;Assert-WorkTracePlainPath $installed
     if(!(Test-Path -LiteralPath $installed -PathType Leaf) -or (Get-WorkTraceHash $sourceFile.FullName) -cne (Get-WorkTraceHash $installed)){throw "原技能缺少绑定且内容与原运行版本不同，未覆盖：$name；请恢复原技能版本或选择正确 SkillsDirectory。"}
    }
    $restoreBindings+=Join-Path $dest 'deployment.json'
   }
  }
 }
}
$runFile=Join-Path $data 'running.json'
if(Test-Path -LiteralPath $runFile){$run=Read-ConnectionJson $runFile '本机服务状态';if($run.pid -match '^\d+$' -and (Get-Process -Id $run.pid -ErrorAction SilentlyContinue)){Assert-ConnectionService;$null=Read-ConnectionStatus}}
$savedData=$env:WORKTRACE_DATA
try{Remove-Item Env:\WORKTRACE_DATA -ErrorAction SilentlyContinue;& (Join-Path $root 'Start.ps1') -NoBrowser|Out-Null}finally{if($null -eq $savedData){Remove-Item Env:\WORKTRACE_DATA -ErrorAction SilentlyContinue}else{$env:WORKTRACE_DATA=$savedData}}
Assert-ConnectionService
$status=Read-ConnectionStatus
$savedEffort=[string]$before.worker_policy.reasoning_effort
if($status.worker.policy.model -ne 'gpt-6.1-sol' -or $status.worker.policy.reasoning_effort -notin @('high','xhigh') -or ($savedEffort -in @('high','xhigh') -and $status.worker.policy.reasoning_effort -cne $savedEffort)){throw '恢复连接未保留原分控推理强度；已有 high 或 xhigh 不应被静默更改。'}
if([bool]$status.collection.enabled -ne [bool]$before.capture_enabled -or [bool]$status.worker.policy.enabled -ne [bool]$before.worker_policy.enabled -or [bool]$status.worker.policy.paused -ne [bool]$before.worker_policy.paused){throw '启动前后采集或学习开关不同，请检查原服务；未发送策略变更。'}
if(!$bindingReady){
 foreach($bindingPath in $restoreBindings){
  $bytes=(New-Object Text.UTF8Encoding($false)).GetBytes((@{root=$root;role='collector';version=$manifest.version}|ConvertTo-Json))
  $stream=New-Object IO.FileStream($bindingPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
 }
 & (Join-Path $root 'Install-Skills.ps1') -Role collector -SkillsDirectory $SkillsDirectory -SkipMcp|Out-Null
}
foreach($name in $names){$binding=Read-ConnectionJson (Join-Path (Join-Path $SkillsDirectory $name) 'deployment.json') '技能部署绑定';if($binding.role -cne 'collector' -or ![string]::Equals([string]$binding.root,$root,[StringComparison]::OrdinalIgnoreCase)){throw '恢复后的分控技能绑定核验失败。'}}
if($SkipMcp){$result.mcp=@{status='skipped'}}else{
 try{
  $codex=Get-Command codex.exe,codex.cmd,codex -ErrorAction SilentlyContinue|Select-Object -First 1
  if(!$codex){throw 'Codex CLI unavailable'}
  $mcpRaw=& $codex.Source mcp list --json 2>$null
  if($LASTEXITCODE -ne 0){throw 'MCP configuration unavailable'}
  $entries=$mcpRaw|ConvertFrom-Json;$entry=@($entries)|Where-Object {$_.name -eq 'worktrace'}|Select-Object -First 1
  if($entry){
   $arguments=@($entry.transport.args);$dataFlags=@($arguments|Where-Object {$_ -ceq '--data'})
   if($dataFlags.Count -gt 1){throw 'Ambiguous MCP data directory'}
   if($dataFlags.Count){$index=[Array]::IndexOf($arguments,'--data');if($index+1 -ge $arguments.Count -or ![string]::Equals((Resolve-ConnectionPath ([string]$arguments[$index+1]) 'MCP data'),$data,[StringComparison]::OrdinalIgnoreCase)){throw 'MCP belongs to another data directory'}}
  }
  & (Join-Path $root '连接Codex.ps1') 2>$null|Out-Null
  $result.mcp=@{status='ready'}
 }catch{$result.mcp=@{status='action_required';message='分控连接继续运行；Codex MCP 尚未恢复，请检查本员工已登录的 Codex 命令行和原 worktrace 配置。未复制账号或覆盖其他绑定。'}}
}
if(!$SkipLogonStartup){
 # Older verified deployments do not create this parent key themselves.
 if(!(Test-Path -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run')){New-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Force|Out-Null}
 & (Join-Path $root '设置登录启动.ps1')|Out-Null
 $sha=[Security.Cryptography.SHA256]::Create();try{$startupName='WorkTrace-'+([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($root))).Replace('-','')).Substring(0,12)}finally{$sha.Dispose()}
 $expectedStartup='powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $root 'Start.ps1')+'" -NoBrowser'
 $startup=Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $startupName
 if($startup.$startupName -cne $expectedStartup){throw '当前用户登录启动核验失败。'}
 $result.logon_startup='enabled'
}
$previous=$ErrorActionPreference;$ErrorActionPreference='Continue'
try{$syncOutput=& $node --no-warnings $cli --command sync --role collector --dir $data 2>&1;$syncCode=$LASTEXITCODE}finally{$ErrorActionPreference=$previous}
$syncResult=$null;if($syncCode -eq 0){try{$syncResult=($syncOutput -join "`n")|ConvertFrom-Json}catch{}}
Assert-ConnectionService
$status=Read-ConnectionStatus
$after=Get-ConnectionSnapshot
if((Get-WorkTraceHash $configPath) -cne $configHash -or ($after|ConvertTo-Json -Depth 30 -Compress) -cne $beforeJson){throw '连接检查期间原配置或采集学习策略发生变化；未覆盖原状态，请核对并发操作。'}
$result.bindings_complete=$true;$result.service_running=$true;$result.capture_enabled=[bool]$status.collection.enabled
$result.worker=@{enabled=[bool]$status.worker.policy.enabled;paused=[bool]$status.worker.policy.paused;model=$status.worker.policy.model;reasoning_effort=$status.worker.policy.reasoning_effort}
if($syncCode -eq 0 -and $null -ne $syncResult.sent -and !$syncResult.skipped -and $status.sync.last_success -and !$status.sync.error -and !$status.sync.running){
 $result.status='connected';$result.sync=@{state='connected';last_success=$status.sync.last_success;retry_seconds=30};$result.message='已使用原员工和设备身份连接总控；后台每 30 秒同步，断网后自动重试。'
}else{
 $reason='network';$errorText=([string]$status.sync.error)+' '+($syncOutput -join ' ')
 if($errorText -match '认证|授权|撤销|已用于另一安装|设备信息不匹配|401|403|unauthori|forbidden'){$reason='authentication'}elseif($errorText -match 'cert|certificate|TLS|SSL|证书|hostname|altname|ENOTFOUND|EAI_AGAIN|Invalid URL'){$reason='address_or_certificate'}elseif($status.sync.running -or $syncResult.skipped){$reason='sync_in_progress'}
 $result.status=if($reason -in @('authentication','address_or_certificate')){'action_required'}else{'retrying'};$result.sync=@{state='deferred';reason=$reason;last_success=$status.sync.last_success;retry_seconds=30}
 $result.message=if($reason -eq 'authentication'){'本机服务已运行，但总控未接受原设备认证；保留原身份并后台重试，请总控核对原设备授权，不要重新登记。'}elseif($reason -eq 'address_or_certificate'){'本机服务已运行，但地址或证书尚未通过；保留原身份并后台重试，请核对原总控地址与证书。'}else{'本机服务已运行，当前心跳尚未确认；后台每 30 秒自动重试，网络或总控恢复后沿用原身份连接，无需再次提供链接。'}
}
$result|ConvertTo-Json -Depth 6 -Compress
