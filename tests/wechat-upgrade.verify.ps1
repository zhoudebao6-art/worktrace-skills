$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
$env:TEMP='D:\codex+\temp';$env:TMP=$env:TEMP;$env:TMPDIR=$env:TEMP;$env:NODE_COMPILE_CACHE='D:\codex+\cache\worktrace\node';$env:WORKTRACE_PORT='0'
$run=Join-Path $env:TEMP ('worktrace-upgrade-test-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $run|Out-Null
. (Join-Path $repo 'scripts\provision-common.ps1')
$utf8=New-Object Text.UTF8Encoding($false)
function Save([string]$Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 40),$utf8)}
function Must-Reject([scriptblock]$Action){$rejected=$false;try{& $Action|Out-Null}catch{$rejected=$true};if(!$rejected){throw 'Expected rejected upgrade.'}}
function Manifest([string]$Root,[string]$Version){$files=@();foreach($f in Get-ChildItem -LiteralPath $Root -File -Recurse){$p=$f.FullName.Substring($Root.Length+1).Replace('\','/');if($p -eq 'engine-manifest.json' -or $p.StartsWith('data/') -or $p -eq 'runtime/node.exe'){continue};$files+=@{path=$p;size=$f.Length;sha256=(Get-WorkTraceHash $f.FullName)}};Save (Join-Path $Root 'engine-manifest.json') @{format='worktrace.source/1.0';version=$Version;files=$files}}
function Api([string]$Root,[string]$Path,$Body=$null){$r=Get-Content -LiteralPath (Join-Path $Root 'data\running.json') -Raw|ConvertFrom-Json;$headers=@{Authorization='Bearer '+($r.url -split '#key=')[1]};$url='http://127.0.0.1:'+$r.port+'/api/'+$Path;if($null -eq $Body){Invoke-RestMethod $url -Headers $headers -TimeoutSec 15}else{Invoke-RestMethod $url -Headers $headers -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes(($Body|ConvertTo-Json -Depth 30 -Compress))) -TimeoutSec 30}}
$seed=@'
import {pathToFileURL} from 'node:url';import {join} from 'node:path';
const [root,active]=process.argv.slice(2),{startApp}=await import(pathToFileURL(join(root,'src/server.mjs'))),{localApi}=await import(pathToFileURL(join(root,'src/local-api.mjs'))),{nextPersonal}=await import(pathToFileURL(join(root,'src/learning.mjs'))),{hash,uuid}=await import(pathToFileURL(join(root,'src/protocol.mjs'))),dir=join(root,'data');
const app=await startApp({dir,port:0,workerRunner:async()=>{throw Error('No model may be called in this test');}});
try{await localApi(dir,'setup',{role:'collector',offline:{format:'worktrace.offline-identity/1.0',org_name:'SYNTHETIC UPGRADE',employee_id:'SYNTHETIC_EMPLOYEE',employee_name:'TEST EMPLOYEE',label:'TEST PC'}});
const p={...app.collector.policy,timezone:'UTC',workdays:[(new Date().getUTCDay()+1)%7],start:'01:00',end:'02:00'};app.collector.update(p);
const event=app.collector.record('activity.snapshot',{text:'SYNTHETIC customer question',capture_status:'uia'},{process_name:'synthetic.exe',window_title:'SYNTHETIC ONLY'});
const bytes=Buffer.from('SYNTHETIC ORIGINAL FILE'),digest=hash(bytes);app.store.db.prepare('INSERT INTO file_versions VALUES(?,?,?,?)').run(digest,'text/plain',bytes.length,bytes);
app.store.append({...event,schema_version:'1.2',event_id:uuid(),event_type:'document.version',app:{process_name:'worktrace-file-reader',window_title:''},payload:{file_sha256:digest,path:join(root,'synthetic-original.txt'),extension:'.txt',mime:'text/plain',size:bytes.length,modified_at:new Date().toISOString(),previous_event_id:null,text:bytes.toString(),parser:'builtin-text',parser_version:'1.0',capture_status:'text_extracted',gaps:[]}});nextPersonal(app.store,app.config,{});
app.worker.configure({...app.worker.policy,enabled:true,paused:active!=='running',workdays:p.workdays,timezone:p.timezone,start:p.start,end:p.end,reasoning_effort:'high'});
app.store.set('capture_enabled',active==='running');app.store.set('synthetic_preserve_marker',{value:'untouched'});
}finally{await app.close();}
'@
$seedFile=Join-Path $run 'seed.mjs';[IO.File]::WriteAllText($seedFile,$seed,$utf8)
$deployed=@();$passed=$false;$failure='';$checks=@{}
try{
 $base=Join-Path $repo 'skills\worktrace-hub\assets\engine'
 $source=Join-Path $run 'new-engine';Copy-Item -LiteralPath $base -Destination $source -Recurse
 Copy-Item -LiteralPath (Join-Path $repo 'src\upgrade-guard.mjs') -Destination (Join-Path $source 'src\upgrade-guard.mjs') -Force
 # A versioned synthetic engine isolates updater behaviour from ongoing edits.
 $protocol=Join-Path $source 'src\protocol.mjs';$content=Get-Content -LiteralPath $protocol -Raw -Encoding UTF8;$content=$content -replace "SOFTWARE_VERSION='[^']+'","SOFTWARE_VERSION='0.6.0'";[IO.File]::WriteAllText($protocol,$content,$utf8)
 [IO.File]::WriteAllText((Join-Path $source 'bridge\observe.ps1'),"throw 'TEST: observer must never start'",$utf8)
 [IO.File]::WriteAllText((Join-Path $source 'src\upgrade-test-added.txt'),'managed new fixture',$utf8);Manifest $source '0.6.0'
 foreach($mode in @('running','stopped')){
  $root=Join-Path $run $mode;Copy-Item -LiteralPath $base -Destination $root -Recurse;$deployed+=$root
  $oldProtocol=Join-Path $root 'src\protocol.mjs';$oldText=(Get-Content -LiteralPath $oldProtocol -Raw -Encoding UTF8) -replace "SOFTWARE_VERSION='[^']+'","SOFTWARE_VERSION='0.5.2'";[IO.File]::WriteAllText($oldProtocol,$oldText,$utf8)
  [IO.File]::WriteAllText((Join-Path $root 'bridge\observe.ps1'),"throw 'TEST: observer must never start'",$utf8);Manifest $root '0.5.2'
  New-Item -ItemType Directory -Path (Join-Path $root 'runtime') -Force|Out-Null;Copy-Item -LiteralPath (Join-Path $repo 'runtime\node.exe') -Destination (Join-Path $root 'runtime\node.exe')
  [IO.File]::WriteAllText((Join-Path $root 'local-note.txt'),'unknown local file must stay',$utf8)
  & (Join-Path $root 'runtime\node.exe') --no-warnings $seedFile $root $mode;if($LASTEXITCODE -ne 0){throw 'Synthetic seed failed'}
  if($mode -eq 'stopped'){
   # The real maintenance guard must deny another original-path server start.
   $guardInfo=New-Object Diagnostics.ProcessStartInfo;$guardInfo.FileName=Join-Path $root 'runtime\node.exe';$guardInfo.Arguments='--no-warnings "'+(Join-Path $source 'src\upgrade-guard.mjs')+'" --deployment "'+$root+'" --parent-pid '+[Diagnostics.Process]::GetCurrentProcess().Id;$guardInfo.UseShellExecute=$false;$guardInfo.CreateNoWindow=$true;$guardInfo.RedirectStandardInput=$true;$guardInfo.RedirectStandardOutput=$true;$guardInfo.RedirectStandardError=$true
   $guard=New-Object Diagnostics.Process;$guard.StartInfo=$guardInfo;$null=$guard.Start()
   try{
    $ready=$guard.StandardOutput.ReadLineAsync();if(!$ready.Wait(15000) -or $ready.Result -ne 'WORKTRACE_UPGRADE_GUARD_READY'){throw 'Guard did not take maintenance ownership'}
    $probeInfo=New-Object Diagnostics.ProcessStartInfo;$probeInfo.FileName=Join-Path $root 'runtime\node.exe';$probeInfo.Arguments='--no-warnings "'+(Join-Path $root 'src\server.mjs')+'"';$probeInfo.UseShellExecute=$false;$probeInfo.CreateNoWindow=$true;$probeInfo.RedirectStandardError=$true;$probe=New-Object Diagnostics.Process;$probe.StartInfo=$probeInfo;$null=$probe.Start()
    if(!$probe.WaitForExit(15000) -or $probe.ExitCode -eq 0 -or $probe.StandardError.ReadToEnd() -notmatch 'runtime_already_owned'){throw 'Concurrent original service start was not blocked by maintenance ownership'};$probe.Dispose()
   }finally{$guard.StandardInput.Close();if(!$guard.WaitForExit(15000)){throw 'Guard survived stdin closure'};$guard.Dispose()}
   $checks.maintenance_guard_blocks_concurrent_start_and_releases=$true
  }
  $configHash=Get-WorkTraceHash (Join-Path $root 'data\config.json')
  if($mode -eq 'running'){& (Join-Path $root 'Start.ps1') -NoBrowser|Out-Null}
  $script=Join-Path $repo 'scripts\Upgrade-ExistingNode.ps1';$backup=Join-Path $run ($mode+'-backup')
  $dry=(& $script -DeploymentRoot $root -SourceEngine $source -BackupDirectory $backup -DryRun)|ConvertFrom-Json
  if($dry.status -ne 'dry_run_passed' -or (Test-Path -LiteralPath $backup)){throw 'DryRun mutated the backup/deployment'}
  if($mode -eq 'running'){
   $ownedBefore=(Get-Content -LiteralPath (Join-Path $root 'data\running.json') -Raw|ConvertFrom-Json).pid
   $changed=Join-Path $root 'src\protocol.mjs';$bytes=[IO.File]::ReadAllBytes($changed);[IO.File]::AppendAllText($changed,'// local modification')
   Must-Reject {& $script -DeploymentRoot $root -SourceEngine $source -BackupDirectory $backup}
   [IO.File]::WriteAllBytes($changed,$bytes)
   $sourceFile=Join-Path $source 'src\upgrade-test-added.txt';$sourceBytes=[IO.File]::ReadAllBytes($sourceFile);[IO.File]::AppendAllText($sourceFile,'tampered source')
   Must-Reject {& $script -DeploymentRoot $root -SourceEngine $source -BackupDirectory $backup}
   [IO.File]::WriteAllBytes($sourceFile,$sourceBytes)
   Must-Reject {& $script -DeploymentRoot $root -SourceEngine $source -BackupDirectory (Join-Path $root 'unsafe-backup')}
   $checks.tampered_source_and_nested_backup_refused=$true
   [IO.File]::WriteAllText((Join-Path $root 'src\upgrade-test-added.txt'),'local conflicting content',$utf8)
   Must-Reject {& $script -DeploymentRoot $root -SourceEngine $source -BackupDirectory $backup}
   Remove-Item -LiteralPath (Join-Path $root 'src\upgrade-test-added.txt')
   if((Api $root 'status').collection.enabled -ne $true -or !(Get-Process -Id $ownedBefore -ErrorAction SilentlyContinue)){throw 'Preflight conflict stopped or paused existing service'}
   $checks.conflicts_preserve_running_service=$true
  }
  $result=(& $script -DeploymentRoot $root -SourceEngine $source -BackupDirectory $backup)|ConvertFrom-Json
  if(!$result.cold_backup_verified -or !$result.original_evidence_verified -or !$result.original_state_restored -or (Get-WorkTraceHash (Join-Path $root 'data\config.json')) -ne $configHash -or (Get-Content -LiteralPath (Join-Path $root 'local-note.txt') -Raw) -ne 'unknown local file must stay'){throw 'Upgrade failed preservation checks'}
  $cold=Get-Content -LiteralPath (Join-Path $backup 'cold-state.json') -Raw|ConvertFrom-Json;if($cold.blobs.file_versions.count -ne 1){throw 'Nonempty original BLOB preservation was not exercised'};$checks.nonempty_original_blob_verified=$true
  if($mode -eq 'running'){$status=Api $root 'status';if($status.version -ne '0.6.0' -or !$status.collection.enabled -or $status.worker.policy.paused -or $status.worker.policy.reasoning_effort -ne 'high' -or $status.connection_mode -ne 'offline' -or $status.collection.last_sample){throw 'Running state/policy changed, or desktop sampling occurred'};$checks.running_state_restored=$true}
  else{if($result.status -ne 'upgraded_stopped' -or (Test-Path -LiteralPath (Join-Path $root 'data\running.json'))){throw 'Stopped deployment was started by the upgrade'};$checks.stopped_remains_stopped=$true}
  $verify="const d=new(require('node:sqlite').DatabaseSync)(process.argv[1],{readOnly:true});if(d.prepare('SELECT COUNT(*) n FROM personal_batches WHERE status=?').get('open').n!==1||JSON.parse(d.prepare('SELECT value FROM meta WHERE key=?').get('synthetic_preserve_marker').value).value!=='untouched')throw Error('checkpoint lost');d.close();"
  & (Join-Path $root 'runtime\node.exe') --no-warnings -e $verify (Join-Path $root 'data\worktrace.sqlite');if($LASTEXITCODE -ne 0){throw 'Open batch/local metadata not retained'}
  Must-Reject {& $script -DeploymentRoot $root -SourceEngine $source -BackupDirectory $backup}
 }
 $checks.dry_run_no_service_or_data_change=$true;$checks.open_batch_and_unknown_files_preserved=$true;$checks.backup_reuse_refused=$true;$passed=$true
}catch{$failure=$_.Exception.Message}finally{
 $owned=@()
 foreach($root in $deployed){$runFile=Join-Path $root 'data\running.json';if(Test-Path -LiteralPath $runFile){$r=Get-Content -LiteralPath $runFile -Raw|ConvertFrom-Json;$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$r.pid) -ErrorAction SilentlyContinue;if($p -and $p.CommandLine.Contains((Join-Path $root 'src\server.mjs'))){$owned+=$r.pid;try{Api $root 'shutdown' @{}|Out-Null}catch{}}};$trayFile=Join-Path $root 'data\tray.pid';if(Test-Path -LiteralPath $trayFile){$id=[int](Get-Content -LiteralPath $trayFile);$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$id) -ErrorAction SilentlyContinue;if($p -and $p.CommandLine.Contains((Join-Path $root 'Tray.ps1'))){$owned+=$id}}}
 $deadline=[datetime]::UtcNow.AddSeconds(30);do{$left=@($owned|Where-Object {Get-Process -Id $_ -ErrorAction SilentlyContinue});if(!$left.Count){break};Start-Sleep -Milliseconds 500}while([datetime]::UtcNow -lt $deadline)
 $report=@{passed=($passed -and !$left.Count);failure=$failure;directory=$run;checks=$checks;synthetic_engine_only=$true;real_desktop_or_wechat_not_read=$true;real_model_not_called=$true;mcp_not_registered=$true;owned_processes_exited=(!$left.Count)};Save (Join-Path $run 'verification.json') $report;$report|ConvertTo-Json -Depth 10;if(!$report.passed){throw 'Upgrade verification failed'}
}
