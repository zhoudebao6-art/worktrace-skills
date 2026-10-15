param(
 [Parameter(Mandatory=$true)][string]$DeploymentRoot,
 [Parameter(Mandatory=$true)][string]$SourceEngine,
 [Parameter(Mandatory=$true)][string]$BackupDirectory,
 [switch]$DryRun,
 [ValidateRange(10,900)][int]$WaitSeconds=120
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$utf8=New-Object Text.UTF8Encoding($false)
function Hash-File([string]$Path){$s=[IO.File]::OpenRead($Path);$h=[Security.Cryptography.SHA256]::Create();try{[BitConverter]::ToString($h.ComputeHash($s)).Replace('-','').ToLowerInvariant()}finally{$s.Dispose();$h.Dispose()}}
function Plain-Path([string]$Path){
 $cursor=[IO.Path]::GetFullPath($Path)
 while($cursor){if((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw "Linked path is not allowed: $cursor"};$parent=Split-Path $cursor -Parent;if(!$parent -or $parent -eq $cursor){break};$cursor=$parent}
}
function Full-Directory([string]$Path){
 if(!$Path -or $Path -notmatch '^[A-Za-z]:[\\/]' -or $Path.Substring(2).Contains(':') -or $Path -match '(^|[\\/])\.\.?([\\/]|$)|[\x00-\x1f"<>|?*]|[. ]([\\/]|$)'){throw 'Use an explicit absolute ordinary local directory.'}
 $value=[IO.Path]::GetFullPath($Path).TrimEnd('\','/');if($value.Length -le 3){throw 'A drive root is not a deployment or backup directory.'};Plain-Path $value;return $value
}
function Within([string]$A,[string]$B){return $A.Equals($B,[StringComparison]::OrdinalIgnoreCase) -or $A.StartsWith($B+'\',[StringComparison]::OrdinalIgnoreCase)}
function Read-Json([string]$Path){Plain-Path $Path;return Get-Content -LiteralPath $Path -Raw -Encoding UTF8|ConvertFrom-Json}
function Save-Json([string]$Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 50),$utf8)}
function Inventory([string]$Root){
 $stack=New-Object 'Collections.Generic.Stack[string]';$stack.Push($Root);$result=@()
 while($stack.Count){
  foreach($item in Get-ChildItem -LiteralPath $stack.Pop() -Force){
   Plain-Path $item.FullName
   if($item.PSIsContainer){$stack.Push($item.FullName)}else{
    $relative=$item.FullName.Substring($Root.Length+1).Replace('\','/')
    # This disposable auxiliary lock must stay locked throughout maintenance.
    # It contains no evidence and is recreated by the existing runtime.
    if($relative -in @('data/runtime-lock.sqlite','data/runtime-lock.sqlite-journal','data/runtime-lock.sqlite-wal','data/runtime-lock.sqlite-shm')){continue}
    $result+=@{path=$relative;size=$item.Length;sha256=(Hash-File $item.FullName)}
   }
  }
 }
 return @($result|Sort-Object { $_.path })
}
function Verify-Engine([string]$Root){
 $m=Read-Json (Join-Path $Root 'engine-manifest.json');if($m.format -cne 'worktrace.source/1.0' -or $m.version -notmatch '^\d+\.\d+\.\d+$' -or !@($m.files).Count){throw 'Invalid engine manifest.'}
 $seen=@{}
 foreach($row in $m.files){$p=[string]$row.path
  if(!$p -or [IO.Path]::IsPathRooted($p) -or $p.Contains('\') -or $p.Contains(':') -or $p.Contains('//') -or $p -match '(^|/)\.\.?(/|$)|(^|/)[^/]*[. ](/|$)|[\x00-\x1f"<>|?*]' -or $seen.ContainsKey($p) -or $row.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $row.size -lt 0){throw 'Invalid or duplicate engine path/hash.'}
  if($p -match '^(data|private|runtime-temp|runtime-cache)(/|$)' -or ($p -match '^runtime/' -and $p -cnotin @('runtime/NODE-LICENSE.txt','runtime/wechat-reader-release.json')) -or $p -ceq 'engine-manifest.json'){throw "Manifest cannot manage deployment data/runtime: $p"}
  $seen[$p]=$true;$file=Join-Path $Root $p;Plain-Path $file
  if(!(Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -ne $row.size -or (Hash-File $file) -cne $row.sha256){throw "Managed file changed or missing: $file"}
 }
 foreach($p in @('Start.ps1','Tray.ps1','src/server.mjs','src/admin-cli.mjs','src/protocol.mjs','src/local-api.mjs','scripts/Ensure-Runtime.ps1')){if(!$seen.ContainsKey($p)){throw "Missing engine entry: $p"}}
 return $m
}
$deployment=Full-Directory $DeploymentRoot;$source=Full-Directory $SourceEngine;$backup=Full-Directory $BackupDirectory
foreach($pair in @(@($deployment,$source),@($deployment,$backup),@($source,$backup))){if((Within $pair[0] $pair[1]) -or (Within $pair[1] $pair[0])){throw 'Deployment, source and backup must be separate non-overlapping directories.'}}
if(Test-Path -LiteralPath $backup){throw 'BackupDirectory must not already exist; no prior backup is overwritten.'}
$old=Verify-Engine $deployment;$new=Verify-Engine $source
if([version]$new.version -lt [version]$old.version){throw 'Downgrades require explicit verified recovery; this entry does not downgrade.'}
if([version]$old.version -lt [version]'0.5.2' -or !(Test-Path -LiteralPath (Join-Path $deployment 'src\runtime-lifecycle.mjs'))){throw 'This safe automatic entry requires v0.5.2 or later maintenance locks; use the earlier verified manual upgrade first.'}
if(!@($new.files|Where-Object {$_.path -ceq 'src/upgrade-guard.mjs'}).Count){throw 'New source manifest lacks the maintenance guard.'}
$oldPaths=@{};foreach($row in $old.files){$oldPaths[$row.path]=$row}
foreach($row in $new.files){$dest=Join-Path $deployment $row.path;Plain-Path $dest;if((Test-Path -LiteralPath $dest) -and !$oldPaths.ContainsKey($row.path)){throw "New managed path conflicts with an unknown local file: $($row.path)"}}
$data=Join-Path $deployment 'data';$node=Join-Path $deployment 'runtime\node.exe';$cli=Join-Path $deployment 'src\admin-cli.mjs'
foreach($file in @($data,$node,(Join-Path $data 'worktrace.sqlite'))){Plain-Path $file}
if(!(Test-Path -LiteralPath $node -PathType Leaf) -or (Hash-File $node) -cne '0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4'){throw 'Existing Node v22.23.2 runtime did not pass its pinned hash. No runtime downloaded.'}
if(!(Test-Path -LiteralPath (Join-Path $data 'worktrace.sqlite') -PathType Leaf) -or (Test-Path -LiteralPath (Join-Path $data 'REVIEW-ONLY.json'))){throw 'An existing active-source collector database is required; never initialize or start a review copy.'}
$config=Read-Json (Join-Path $data 'config.json')
if($config.role -cne 'collector' -or $config.connection_mode -notin @($null,'hub','offline')){throw 'Only an existing collector can use this entry.'}
foreach($key in @('org_id','device_id','installation_id')){if($config.$key -notmatch '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'){throw "Invalid existing identity: $key"}}
if(Test-Path -LiteralPath 'D:\'){$taskTemp='D:\codex+\temp';$taskCache='D:\codex+\cache\worktrace\node'}else{$taskTemp=Join-Path ([IO.Path]::GetDirectoryName($deployment)) 'worktrace-upgrade-temp';$taskCache=Join-Path $taskTemp 'node-cache'}
New-Item -ItemType Directory -Path $taskTemp,$taskCache -Force|Out-Null
$env:TEMP=$taskTemp;$env:TMP=$taskTemp;$env:TMPDIR=$taskTemp;$env:NODE_COMPILE_CACHE=$taskCache
$helper=Join-Path $taskTemp ('worktrace-upgrade-'+[guid]::NewGuid().ToString('N')+'.mjs')
$helperCode=@'
import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';import {join} from 'node:path';import {hostname} from 'node:os';import {createHash} from 'node:crypto';
const [dir,previous]=process.argv.slice(2),c=JSON.parse(readFileSync(join(dir,'config.json'),'utf8').replace(/^\uFEFF/,'')),hash=x=>createHash('sha256').update(x).digest('hex'),canonical=v=>JSON.stringify(sort(v));
function sort(v){return Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;}
if(c.host_binding!==hash(c.org_id+':'+hostname()))throw Error('Existing host binding mismatch');
const db=new DatabaseSync(join(dir,'worktrace.sqlite'),{readOnly:true});db.exec('BEGIN');try{
const device=db.prepare('SELECT * FROM devices WHERE device_id=?').get(c.device_id);if(!device||['org_id','employee_id','employee_name','label'].some(k=>device[k]!==c[k])||(device.installation_id&&device.installation_id!==c.installation_id))throw Error('Existing database identity mismatch');
const get=k=>{const row=db.prepare('SELECT value FROM meta WHERE key=?').get(k);return row?JSON.parse(row.value):null;};
const prior=previous?JSON.parse(readFileSync(previous,'utf8').replace(/^\uFEFF/,'')):null,max=prior?.events.max_rowid??db.prepare('SELECT COALESCE(MAX(rowid),0) n FROM events').get().n;
const events=createHash('sha256');let count=0;for(const r of db.prepare('SELECT * FROM events WHERE rowid<=? ORDER BY rowid').iterate(max)){if(hash(canonical(JSON.parse(r.json)))!==r.hash)throw Error('Stored event digest mismatch');events.update(canonical(r)+'\n');count++;}
const blobs={};for(const name of ['assets','file_versions']){if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))continue;const h=createHash('sha256');let n=0;for(const r of db.prepare('SELECT * FROM '+name+' ORDER BY sha256').iterate()){if(hash(r.data)!==r.sha256||r.data.length!==r.size)throw Error('Original BLOB hash mismatch');h.update(canonical({sha256:r.sha256,mime:r.mime,size:r.size})+'\n');n++;}blobs[name]={count:n,sha256:h.digest('hex')};}
const out={config_sha256:hash(readFileSync(join(dir,'config.json'))),identity:Object.fromEntries(['org_id','employee_id','device_id','installation_id','connection_mode'].map(k=>[k,c[k]??null])),stream_id:get('stream_id'),capture_enabled:get('capture_enabled'),worker_policy:get('worker_policy'),policy:get('policy'),file_policy:get('file_policy'),wechat_policy:get('wechat_policy'),events:{max_rowid:max,count,sha256:events.digest('hex')},blobs};
if(prior){for(const k of ['config_sha256','identity','stream_id','events','blobs','policy','file_policy','wechat_policy'])if(canonical(out[k])!==canonical(prior[k]))throw Error('Preservation verification failed: '+k);}
console.log(JSON.stringify(out));}finally{db.exec('ROLLBACK');db.close();}
'@
[IO.File]::WriteAllText($helper,$helperCode,$utf8)
function Snapshot([string]$Prior=''){
 $nativeArgs=@('--no-warnings',$helper,$data);if($Prior){$nativeArgs+=$Prior}
 $oldPreference=$ErrorActionPreference;$ErrorActionPreference='Continue';try{$raw=& $node @nativeArgs 2>&1;$exitCode=$LASTEXITCODE}finally{$ErrorActionPreference=$oldPreference}
 if($exitCode -ne 0){throw ('Database identity/evidence check failed: '+($raw -join ' '))};return ($raw -join "`n")|ConvertFrom-Json
}
function Owned-Processes {
 $paths=@((Join-Path $deployment 'src\server.mjs'),(Join-Path $deployment 'Tray.ps1'),(Join-Path $deployment 'bridge\observe.ps1'),(Join-Path $deployment 'bridge\extract-document.ps1'))
 $all=@(Get-CimInstance Win32_Process);$found=@()
 foreach($p in $all){if(!$p.CommandLine){continue};foreach($path in $paths){if($p.CommandLine -match ('(?:^|\s)"?'+[regex]::Escape($path)+'"?(?=\s|$)')){$found+=$p;break}}}
 return $found
}
function Service-State {
 $path=Join-Path $data 'running.json';$servers=@(Owned-Processes|Where-Object {$_.CommandLine -match [regex]::Escape((Join-Path $deployment 'src\server.mjs'))})
 if(!$servers.Count){return $null};if($servers.Count -ne 1 -or !(Test-Path -LiteralPath $path)){throw 'Ambiguous existing service; no process was stopped.'}
 $r=Read-Json $path;$p=$servers[0]
 if($r.pid -ne $p.ProcessId -or ![string]::Equals([string]$p.ExecutablePath,$node,[StringComparison]::OrdinalIgnoreCase)){throw 'Existing service does not match the selected deployment/runtime.'}
 $u=New-Object Uri([string]$r.url);if($u.Scheme -cne 'http' -or $u.Host -cne '127.0.0.1' -or $u.Port -ne $r.port){throw 'Invalid existing loopback service address.'};return $r
}
function Admin([string]$Command,$Body=$null){
 if(!(Service-State)){throw 'Expected owned service is not running.'}
 $nativeArgs=@('--no-warnings',$cli,'--command',$Command,'--role','collector','--dir',$data)
 if($null -ne $Body){$inputFile=Join-Path $backup ('request-'+[guid]::NewGuid().ToString('N')+'.json');Save-Json $inputFile $Body;$nativeArgs+=@('--input',$inputFile)}
 $oldPreference=$ErrorActionPreference;$ErrorActionPreference='Continue';try{$raw=& $node @nativeArgs 2>&1;$exitCode=$LASTEXITCODE}finally{$ErrorActionPreference=$oldPreference}
 if($exitCode -ne 0){throw ('Management request failed: '+$Command)};return ($raw -join "`n")|ConvertFrom-Json
}
function Wait-Stopped {
 $deadline=[datetime]::UtcNow.AddSeconds($WaitSeconds)
 do{$left=@(Owned-Processes);if(!$left.Count){return};if([datetime]::UtcNow -gt $deadline){throw 'Owned processes have not exited; no forced process termination performed.'};Start-Sleep -Milliseconds 500}while($true)
}
function Check-Status($Status,[string]$Version){
 if(!$Status.configured -or $Status.role -cne 'collector' -or $Status.version -cne $Version){throw 'Actual service version/role does not match the selected engine.'}
 foreach($key in @('org_id','employee_id','device_id')){if($Status.$key -cne $config.$key){throw "Actual service identity differs: $key"}}
 if(($config.connection_mode -eq 'offline') -ne ($Status.connection_mode -eq 'offline')){throw 'Actual connection mode changed.'}
}
function Start-Guard {
 $info=New-Object Diagnostics.ProcessStartInfo;$info.FileName=$node;$info.Arguments='--no-warnings "'+(Join-Path $source 'src\upgrade-guard.mjs')+'" --deployment "'+$deployment+'" --parent-pid '+[Diagnostics.Process]::GetCurrentProcess().Id
 $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
 $process=New-Object Diagnostics.Process;$process.StartInfo=$info
 if(!$process.Start()){throw 'Cannot start maintenance guard.'}
 $ready=$process.StandardOutput.ReadLineAsync()
 if(!$ready.Wait(15000) -or $ready.Result -cne 'WORKTRACE_UPGRADE_GUARD_READY'){
  $process.StandardInput.Close();if(!$process.WaitForExit(15000)){throw 'Maintenance guard startup failed to settle; no program replaced.'}
  $message=$process.StandardError.ReadToEnd();$process.Dispose();throw ('Cannot acquire maintenance ownership: '+$message)
 }
 return $process
}
function Stop-Guard {
 if($null -eq $script:guard){return}
 if(!$script:guard.HasExited){$script:guard.StandardInput.Close();if(!$script:guard.WaitForExit(15000)){throw 'Maintenance guard has not released ownership; application not started.'}}
 if($script:guard.ExitCode -ne 0){throw 'Maintenance guard reported a failure; application not started.'}
 $script:guard.Dispose();$script:guard=$null
}
function Assert-Guard {if($null -eq $script:guard -or $script:guard.HasExited){throw 'Maintenance guard ownership was lost; program replacement stopped.'}}
$phase='preflight';$wasRunning=$false;$coldVerified=$false;$changed=$false;$upgradeMutex=$null;$ownsMutex=$false;$script:guard=$null
$report=[ordered]@{format='worktrace.upgrade/1.0';from_version=$old.version;to_version=$new.version;status='preflight';deployment=$deployment;backup=$backup;skills_updated=$false;mcp_reconnected=$false;wechat_channel_enabled_by_upgrade=$false;backup_excludes_recreated_runtime_locks=@('data/runtime-lock.sqlite','data/runtime-lock.sqlite-journal','data/runtime-lock.sqlite-wal','data/runtime-lock.sqlite-shm')}
try{
 $mutexHasher=[Security.Cryptography.SHA256]::Create();try{$mutexKey=[BitConverter]::ToString($mutexHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($deployment.ToLowerInvariant()))).Replace('-','')}finally{$mutexHasher.Dispose()}
 $upgradeMutex=New-Object Threading.Mutex($false,('Global\WorkTraceUpgrade-'+$mutexKey))
 try{$ownsMutex=$upgradeMutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$ownsMutex=$true}
 if(!$ownsMutex){throw 'Another upgrade owns this deployment; no concurrent maintenance allowed.'}
 $before=Snapshot;$running=Service-State;$wasRunning=($null -ne $running);$report.was_running=$wasRunning
 if(!$wasRunning -and @(Owned-Processes).Count){throw 'An orphaned owned tray/observer/parser remains; resolve its original lifecycle before upgrade.'}
 if($DryRun){$report.status='dry_run_passed';$report.no_runtime_or_policy_changes=$true;$report|ConvertTo-Json -Depth 8;return}
 New-Item -ItemType Directory -Path $backup -ErrorAction Stop|Out-Null;Save-Json (Join-Path $backup 'state-before.json') $before
 if($wasRunning){
  $phase='pause';$status=Admin 'status';Check-Status $status $old.version;$priorWorker=$status.worker.policy
  if($priorWorker.enabled -and !$priorWorker.paused){$pause=$priorWorker|ConvertTo-Json -Depth 30|ConvertFrom-Json;$pause.paused=$true;$null=Admin 'worker-configure' $pause}
  if($status.collection.enabled){$null=Admin 'capture' @{enabled=$false}}
  $deadline=[datetime]::UtcNow.AddSeconds($WaitSeconds)
  do{$state=Service-State;$u=New-Object Uri([string]$state.url);$brief=Invoke-RestMethod ($u.GetLeftPart([UriPartial]::Authority)+'/api/status/brief') -Headers @{Authorization='Bearer '+($u.Fragment -replace '^#key=','')} -TimeoutSec 10
   $busy=$brief.worker.busy -or $brief.files.busy -or @($brief.runtime.tasks.PSObject.Properties|Where-Object {$_.Value.running}).Count
   if(!$busy){break};if([datetime]::UtcNow -gt $deadline){throw 'Service did not become idle; retained paused state and original program.'};Start-Sleep -Milliseconds 500
  }while($true)
  $phase='shutdown';$null=Admin 'shutdown' @{};Wait-Stopped
 }
 $phase='acquire_maintenance_guard';$script:guard=Start-Guard
 $phase='cold_backup';$cold=Snapshot
 foreach($key in @('config_sha256','identity','stream_id','policy','file_policy','wechat_policy')){if(($before.$key|ConvertTo-Json -Depth 40 -Compress) -cne ($cold.$key|ConvertTo-Json -Depth 40 -Compress)){throw "Original state changed concurrently before backup: $key"}}
 Save-Json (Join-Path $backup 'cold-state.json') $cold
 $inventory=@(Inventory $deployment);$coldRoot=Join-Path $backup 'deployment';New-Item -ItemType Directory -Path $coldRoot|Out-Null
 foreach($row in $inventory){$to=Join-Path $coldRoot $row.path;New-Item -ItemType Directory -Path (Split-Path $to -Parent) -Force|Out-Null;Copy-Item -LiteralPath (Join-Path $deployment $row.path) -Destination $to;if((Get-Item -LiteralPath $to).Length -ne $row.size -or (Hash-File $to) -cne $row.sha256 -or (Hash-File (Join-Path $deployment $row.path)) -cne $row.sha256){throw "Cold backup mismatch: $($row.path)"}}
 $afterInventory=@(Inventory $deployment);if(($inventory|ConvertTo-Json -Depth 5 -Compress) -cne ($afterInventory|ConvertTo-Json -Depth 5 -Compress) -or @(Owned-Processes).Count){throw 'Original deployment changed during cold backup.'}
 Save-Json (Join-Path $backup 'cold-backup-files.json') $inventory;$coldVerified=$true;$null=Verify-Engine $deployment;$null=Verify-Engine $source
 $phase='replace_engine';Assert-Guard;if(@(Owned-Processes).Count){throw 'Original deployment restarted during maintenance; program not replaced.'}
 $newPaths=@{};foreach($row in $new.files){Assert-Guard;$newPaths[$row.path]=$true;$to=Join-Path $deployment $row.path;Plain-Path $to;New-Item -ItemType Directory -Path (Split-Path $to -Parent) -Force|Out-Null;$changed=$true;Copy-Item -LiteralPath (Join-Path $source $row.path) -Destination $to -Force}
 foreach($row in $old.files){if(!$newPaths.ContainsKey($row.path)){$to=Join-Path $deployment $row.path;Plain-Path $to;if(!(Within ([IO.Path]::GetFullPath($to)) $deployment)){throw 'Removal path escaped deployment.'};Remove-Item -LiteralPath $to}}
 Copy-Item -LiteralPath (Join-Path $source 'engine-manifest.json') -Destination (Join-Path $deployment 'engine-manifest.json') -Force;$null=Verify-Engine $deployment
 $phase='verify_preservation';Assert-Guard;$null=Snapshot (Join-Path $backup 'cold-state.json');Stop-Guard
 if($wasRunning){
  $phase='restart_paused';$savedData=$env:WORKTRACE_DATA
  try{Remove-Item Env:\WORKTRACE_DATA -ErrorAction SilentlyContinue;& (Join-Path $deployment 'Start.ps1') -NoBrowser|Out-Null}finally{if($null -eq $savedData){Remove-Item Env:\WORKTRACE_DATA -ErrorAction SilentlyContinue}else{$env:WORKTRACE_DATA=$savedData}}
  $status=Admin 'status';Check-Status $status $new.version
  if($status.collection.enabled -or ($status.worker.policy.enabled -and !$status.worker.policy.paused)){throw 'New service did not retain its maintenance pause.'}
  $null=Snapshot (Join-Path $backup 'cold-state.json');$null=Admin 'readiness'
  $phase='restore_original_switches';if($priorWorker.enabled -and !$priorWorker.paused){$null=Admin 'worker-configure' $priorWorker};if($before.capture_enabled){$null=Admin 'capture' @{enabled=$true}}
  $status=Admin 'status';Check-Status $status $new.version
  if([bool]$status.collection.enabled -ne [bool]$before.capture_enabled -or ($status.worker.policy|ConvertTo-Json -Depth 30 -Compress) -cne ($priorWorker|ConvertTo-Json -Depth 30 -Compress)){throw 'Original capture/learning state was not restored.'}
  $report.actual_api_version=$status.version;$report.status='upgraded_running'
 }else{$report.status='upgraded_stopped';$report.actual_api_version=$null;$report.startup_validation='not_started_to_preserve_previous_stopped_state'}
 $report.cold_backup_verified=$true;$report.original_evidence_verified=$true;$report.original_state_restored=$true;Save-Json (Join-Path $backup 'upgrade-result.json') $report;$report|ConvertTo-Json -Depth 8
}catch{
 $report.status='failed';$report.phase=$phase;$report.cold_backup_verified=$coldVerified;$report.program_replacement_started=$changed;$report.failure=$_.Exception.Message;$report.automatic_rollback=$false
 # Never restore an active state on failure, or overwrite new evidence with a backup.
 if($changed){try{if(Service-State){$null=Admin 'capture' @{enabled=$false};$st=Admin 'status';$p=$st.worker.policy;$p.paused=$true;$null=Admin 'worker-configure' $p;$null=Admin 'shutdown' @{};Wait-Stopped}}catch{$report.cleanup_error=$_.Exception.Message}}
 if(Test-Path -LiteralPath $backup){Save-Json (Join-Path $backup 'upgrade-result.json') $report};throw ('Upgrade stopped at '+$phase+'. '+$report.failure+' Backup and failure state are retained; no automatic rollback.')
}finally{try{Stop-Guard}finally{if($ownsMutex){$upgradeMutex.ReleaseMutex()};if($upgradeMutex){$upgradeMutex.Dispose()};if(Test-Path -LiteralPath $helper){Remove-Item -LiteralPath $helper}}}
