param(
 [Parameter(Mandatory=$true)][string]$DataDir,
 [string]$Output,
 [ValidateRange(10,60)][int]$DurationSeconds=20
)
$ErrorActionPreference='Stop'
$data=[IO.Path]::GetFullPath($DataDir).TrimEnd('\')
$root=Split-Path $data -Parent
if(Test-Path -LiteralPath 'D:\'){$taskTemp='D:\codex+\temp'}else{$taskTemp=Join-Path $root 'runtime-temp'}
New-Item -ItemType Directory -Path $taskTemp -Force|Out-Null
$env:TEMP=$taskTemp;$env:TMP=$taskTemp;$env:TMPDIR=$taskTemp
if(!$Output){$Output=Join-Path $taskTemp ('worktrace-performance-'+[guid]::NewGuid().ToString('N')+'.json')}
$outputPath=[IO.Path]::GetFullPath($Output)
if(Test-Path -LiteralPath $outputPath){throw '诊断输出已存在，未覆盖。'}
$running=Get-Content -LiteralPath (Join-Path $data 'running.json') -Raw -Encoding UTF8|ConvertFrom-Json
$config=Get-Content -LiteralPath (Join-Path $data 'config.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($config.role -ne 'collector'){throw '此诊断入口只用于已部署的分控。'}
if($running.pid -isnot [int] -and $running.pid -isnot [long]){throw '运行 PID 无效。'}
$serviceId=[int]$running.pid
function Get-ProcessInfo([int]$ProcessId){
 Get-CimInstance Win32_Process -Filter ('ProcessId='+$ProcessId) -OperationTimeoutSec 4 -ErrorAction Stop
}
function Test-CommandPath([string]$CommandLine,[string]$Path){
 if(!$CommandLine){return $false}
 $escaped=[regex]::Escape([IO.Path]::GetFullPath($Path))
 return [regex]::IsMatch($CommandLine,'(?:^|\s)(?:"'+$escaped+'"|'+$escaped+')(?=\s|$)',[Text.RegularExpressions.RegexOptions]::IgnoreCase)
}
$service=Get-ProcessInfo $serviceId
if(!$service -or ![string]::Equals([string]$service.ExecutablePath,(Join-Path $root 'runtime\node.exe'),[StringComparison]::OrdinalIgnoreCase) -or !(Test-CommandPath $service.CommandLine (Join-Path $root 'src\server.mjs'))){throw '运行 PID 与此数据目录的服务路径不匹配；未探测接口或其他进程。'}
$created=$service.CreationDate
$uri=[uri]$running.url
if($uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1' -or $uri.Port -ne [int]$running.port -or $uri.Fragment -notmatch '^#key=([A-Za-z0-9_-]{43})$'){throw '本机运行地址格式无效。'}
$headers=@{Authorization='Bearer '+$Matches[1]}
$base='http://127.0.0.1:'+$uri.Port
$status=$null;$endpoint='status/brief';$probe=[Diagnostics.Stopwatch]::StartNew();$probeError=$null
try{$status=Invoke-RestMethod ($base+'/api/status/brief') -Headers $headers -TimeoutSec 4}catch{
 $code=0;try{$code=[int]$_.Exception.Response.StatusCode}catch{}
 # Released 0.4.0 rejects unknown GET paths with this exact 400 body.
 # Other 400 responses (including expired authorization) must not cause fallback.
 $legacyUnknown=$false
 if($code -eq 400){
  $failure=$_;$responseText=[string]$failure.ErrorDetails.Message
  # Windows PowerShell 5.1 may only expose the JSON on the response stream.
  if(!$responseText){try{$reader=New-Object IO.StreamReader($failure.Exception.Response.GetResponseStream(),[Text.Encoding]::UTF8);try{$responseText=$reader.ReadToEnd()}finally{$reader.Dispose()}}catch{}}
  try{$legacyBody=$responseText|ConvertFrom-Json;$legacyUnknown=$legacyBody.error -ceq '不支持的请求'}catch{}
 }
 if($code -eq 404 -or $legacyUnknown){$endpoint='status';try{$status=Invoke-RestMethod ($base+'/api/status') -Headers $headers -TimeoutSec 4}catch{$probeError='legacy_status_unavailable'}}
 else{$probeError='brief_status_unavailable'}
}
$probe.Stop()
$summary=[ordered]@{role='collector';connection_mode=$config.connection_mode;api_endpoint=$endpoint;api_probe_count=1;api_probe_ms=[Math]::Round($probe.Elapsed.TotalMilliseconds,1);api_error=$probeError}
if($endpoint -eq 'status'){$summary.api_probe_count=2}
if($status){
 $summary.version=$status.version
 $summary.capture_enabled=$status.collection.enabled
 $summary.learning_busy=$status.worker.busy
 $summary.file_scan_busy=$status.files.busy
 $summary.wechat_read_busy=$status.wechat.busy
 $summary.wechat_source_enabled=if($endpoint -eq 'status'){$status.wechat.policy.enabled}else{$status.wechat.enabled}
 if($endpoint -eq 'status'){
  $summary.counts=@{events=$status.stats.events;assets=$status.stats.assets;asset_bytes=$status.stats.asset_bytes;pending=$status.stats.pending;file_versions=$status.files.versions}
  $summary.file_policy=@{enabled=$status.files.policy.enabled;root_count=@($status.files.policy.roots).Count;extension_count=@($status.files.policy.extensions).Count;interval_seconds=$status.files.policy.interval_seconds;max_files_per_scan=$status.files.policy.max_files_per_scan;max_versions_per_scan=$status.files.policy.max_versions_per_scan}
 }
}
$policy=if($status -and $status.collection.policy){$status.collection.policy}else{$null}
$policySource=if($policy){'legacy_status'}else{'unavailable'}
$policyPath=Join-Path $data 'observer-policy.json'
if(!$policy -and (Test-Path -LiteralPath $policyPath -PathType Leaf)){
 try{$policy=Get-Content -LiteralPath $policyPath -Raw -Encoding UTF8|ConvertFrom-Json;$policySource='observer_policy_snapshot_may_be_stale'}catch{}
}
if($policy){$summary.capture_policy=@{source=$policySource;interval_seconds=$policy.interval_seconds;screenshots=$policy.screenshots;record_titles=$policy.record_titles;content_process_count=@($policy.content_processes).Count;excluded_process_count=@($policy.excluded_processes).Count;workday_count=@($policy.workdays).Count}}
$sizes=@{}
foreach($name in @('worktrace.sqlite','worktrace.sqlite-wal','worktrace.sqlite-shm')){
 $file=Join-Path $data $name
 if(Test-Path -LiteralPath $file -PathType Leaf){$sizes[$name]=(Get-Item -LiteralPath $file).Length}
}
$records=@{};$samples=New-Object 'Collections.Generic.List[object]';$watch=[Diagnostics.Stopwatch]::StartNew();$serviceExited=$false
$wechatReader=$null;$wechatProfile=$null
$wechatSource=Join-Path $data 'wechat-source.json'
if(Test-Path -LiteralPath $wechatSource -PathType Leaf){
 try{
  $wechatBinding=Get-Content -LiteralPath $wechatSource -Raw -Encoding UTF8|ConvertFrom-Json
  if($wechatBinding.format -eq 'worktrace.wechat-source/1.0' -and [IO.Path]::IsPathRooted($wechatBinding.reader_path) -and [IO.Path]::IsPathRooted($wechatBinding.profile_path)){
   $wechatReader=[IO.Path]::GetFullPath($wechatBinding.reader_path);$wechatProfile=[IO.Path]::GetFullPath($wechatBinding.profile_path)
  }
 }catch{}
}
function Record-Sample($Process,[string]$Kind,[double]$Elapsed){
 $key=[string]$Process.ProcessId+':'+$Process.CreationDate.ToUniversalTime().Ticks
 $cpu=([double]$Process.KernelModeTime+[double]$Process.UserModeTime)/10000000
 $sample=[ordered]@{elapsed_seconds=[Math]::Round($Elapsed,3);pid=[int]$Process.ProcessId;kind=$Kind;cpu_seconds=$cpu;working_set_bytes=[long]$Process.WorkingSetSize;private_bytes=[long]$Process.PrivatePageCount;read_bytes=[double]$Process.ReadTransferCount;write_bytes=[double]$Process.WriteTransferCount}
 if(!$records.ContainsKey($key)){$records[$key]=@{first=$sample;last=$sample;peak_working_set_bytes=$sample.working_set_bytes;peak_private_bytes=$sample.private_bytes}}
 $record=$records[$key];$record.last=$sample
 $record.peak_working_set_bytes=[Math]::Max($record.peak_working_set_bytes,$sample.working_set_bytes)
 $record.peak_private_bytes=[Math]::Max($record.peak_private_bytes,$sample.private_bytes)
 $samples.Add([pscustomobject]$sample)
}
do{
 $current=Get-ProcessInfo $serviceId
 if(!$current -or $current.CreationDate -ne $created -or !(Test-CommandPath $current.CommandLine (Join-Path $root 'src\server.mjs'))){$serviceExited=$true;break}
 Record-Sample $current 'service' $watch.Elapsed.TotalSeconds
 foreach($child in @(Get-CimInstance Win32_Process -Filter ('ParentProcessId='+$serviceId) -OperationTimeoutSec 4)){
  if($child.CreationDate -lt $created){continue}
  if($wechatReader -and [string]::Equals([string]$child.ExecutablePath,$wechatReader,[StringComparison]::OrdinalIgnoreCase) -and (Test-CommandPath $child.CommandLine $wechatReader) -and (Test-CommandPath $child.CommandLine $wechatProfile)){
   Record-Sample $child 'wechat_reader' $watch.Elapsed.TotalSeconds;continue
  }
  if($child.Name -notin @('powershell.exe','pwsh.exe')){continue}
  if(Test-CommandPath $child.CommandLine (Join-Path $root 'bridge\observe.ps1')){Record-Sample $child 'observer' $watch.Elapsed.TotalSeconds}
  elseif(Test-CommandPath $child.CommandLine (Join-Path $root 'bridge\extract-document.ps1')){Record-Sample $child 'document_parser' $watch.Elapsed.TotalSeconds}
 }
 $remaining=$DurationSeconds-$watch.Elapsed.TotalSeconds
 if($remaining -gt 0){Start-Sleep -Milliseconds ([int][Math]::Min(2000,$remaining*1000))}
}while($watch.Elapsed.TotalSeconds -lt $DurationSeconds)
$watch.Stop()
$processes=@()
foreach($record in $records.Values){
 $first=$record.first;$last=$record.last;$seconds=$last.elapsed_seconds-$first.elapsed_seconds
 $cpu=[Math]::Max(0,$last.cpu_seconds-$first.cpu_seconds)
 $processes+=@{pid=$first.pid;kind=$first.kind;observed_seconds=[Math]::Round($seconds,3);cpu_seconds=[Math]::Round($cpu,4);average_cpu_percent_one_core=if($seconds -gt 0){[Math]::Round(100*$cpu/$seconds,2)}else{$null};peak_working_set_bytes=$record.peak_working_set_bytes;peak_private_bytes=$record.peak_private_bytes;read_bytes=[Math]::Max(0,$last.read_bytes-$first.read_bytes);write_bytes=[Math]::Max(0,$last.write_bytes-$first.write_bytes)}
}
$report=[ordered]@{format='worktrace.performance/1.0';at_utc=[datetime]::UtcNow.ToString('o');duration_requested_seconds=$DurationSeconds;duration_observed_seconds=[Math]::Round($watch.Elapsed.TotalSeconds,2);logical_processors=[Environment]::ProcessorCount;summary=$summary;database_file_sizes=$sizes;service_exited_during_measurement=$serviceExited;processes=$processes;samples=@($samples.ToArray());read_only=$true;limits=@('CPU percentages use one logical core as 100%; not whole-machine CPU','I/O counters include all process I/O, not proof of physical disk traffic','Two-second samples can miss short-lived parsers; absent does not prove no parsing','No evidence text, employee identity, document paths, process command lines or credentials are included','One local API probe; a single fallback only for 404 or the exact legacy unknown-GET 400; no full-status polling loop','This script neither starts/stops processes nor changes capture, learning, process priority or policy')}
New-Item -ItemType Directory -Path (Split-Path $outputPath -Parent) -Force|Out-Null
$bytes=[Text.Encoding]::UTF8.GetBytes(($report|ConvertTo-Json -Depth 20))
$file=[IO.File]::Open($outputPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try{$file.Write($bytes,0,$bytes.Length)}finally{$file.Dispose()}
Write-Output ('诊断完成：'+$outputPath)
Write-Output ('仅观测本服务及已核验的 observer/parser/wechat_reader；'+$processes.Count+' 个进程，未改变记录或学习状态。')
