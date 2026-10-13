$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$env:TEMP='D:\codex+\temp';$env:TMP=$env:TEMP;$env:TMPDIR=$env:TEMP;$env:NODE_COMPILE_CACHE='D:\codex+\cache\worktrace\node'
$run=Join-Path $env:TEMP ('worktrace-performance-tools\'+[guid]::NewGuid().ToString('N'))
$utf8=New-Object Text.UTF8Encoding($true)
New-Item -ItemType Directory -Path $run -Force|Out-Null
$owned=@();$passed=$false;$failure=''
function Save-Json([string]$Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 12),$utf8)}
function Reject([scriptblock]$Action){$rejected=$false;try{& $Action|Out-Null}catch{$rejected=$true};if(!$rejected){throw 'Expected ownership or overwrite rejection'}}
$serverCode=@'
import http from 'node:http';import {writeFileSync,readFileSync,existsSync} from 'node:fs';import {join,dirname} from 'node:path';import {fileURLToPath} from 'node:url';import {spawn} from 'node:child_process';
const root=join(dirname(fileURLToPath(import.meta.url)),'..'),data=join(root,'data'),mode=process.argv[2],requests=[];
const token='P'.repeat(43),child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'bridge/observe.ps1')],{windowsHide:true,stdio:'ignore'});
writeFileSync(join(data,'child.pid'),String(child.pid));
const server=http.createServer((req,res)=>{requests.push(req.url);writeFileSync(join(data,'requests.json'),JSON.stringify(requests));if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);return res.end('{}');}res.setHeader('Content-Type','application/json; charset=utf-8');if(req.url==='/api/shutdown'){writeFileSync(join(data,'stop'),'1');res.end('{}');return server.close();}if(req.url==='/api/status/brief'&&mode!=='brief'){res.writeHead(mode==='notfound'?404:400);return res.end(JSON.stringify({error:mode==='legacy'?'不支持的请求':'管理授权失效，请从启动程序重新打开面板'}));}res.end(JSON.stringify({configured:true,role:'collector',version:mode==='brief'?'0.4.1':'0.4.0',employee_name:'DO_NOT_EXPORT_NAME',org_name:'DO_NOT_EXPORT_ORG',stats:{events:10,assets:0,asset_bytes:0,pending:10},collection:{enabled:false,state:'已暂停',policy:{content_processes:['DO_NOT_EXPORT_PROCESS'],excluded_processes:[],workdays:[1,2,3,4,5],interval_seconds:30,screenshots:false,record_titles:true}},worker:{busy:false},files:{busy:false,versions:3,policy:{enabled:true,roots:['D:\\DO_NOT_EXPORT_ROOT'],extensions:['.txt'],interval_seconds:60,max_files_per_scan:100,max_versions_per_scan:3}}}));});
server.listen(0,'127.0.0.1',()=>writeFileSync(join(data,'running.json'),JSON.stringify({pid:process.pid,port:server.address().port,url:'http://127.0.0.1:'+server.address().port+'/#key='+token})));
'@
$observerCode=@'
$root=Split-Path $PSScriptRoot -Parent
while(!(Test-Path -LiteralPath (Join-Path $root 'data\stop'))){$sum=0;for($i=0;$i -lt 10000;$i++){$sum+=$i};Start-Sleep -Milliseconds 100}
'@
try{
 foreach($mode in @('brief','legacy','notfound','auth')){
  $deployment=Join-Path $run $mode
  New-Item -ItemType Directory -Path (Join-Path $deployment 'data'),(Join-Path $deployment 'src'),(Join-Path $deployment 'bridge'),(Join-Path $deployment 'runtime') -Force|Out-Null
  Copy-Item -LiteralPath (Join-Path $root 'runtime\node.exe') -Destination (Join-Path $deployment 'runtime\node.exe')
  [IO.File]::WriteAllText((Join-Path $deployment 'src\server.mjs'),$serverCode,(New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $deployment 'bridge\observe.ps1'),$observerCode,$utf8)
  Save-Json (Join-Path $deployment 'data\config.json') @{role='collector';connection_mode='offline';employee_name='DO_NOT_EXPORT_NAME';employee_id='DO_NOT_EXPORT_ID'}
  $process=Start-Process -FilePath (Join-Path $deployment 'runtime\node.exe') -ArgumentList @('"'+(Join-Path $deployment 'src\server.mjs')+'"',$mode) -WorkingDirectory $deployment -WindowStyle Hidden -PassThru
  $owned+=@{root=$deployment;pid=$process.Id}
  $deadline=[datetime]::UtcNow.AddSeconds(10)
  while(!(Test-Path -LiteralPath (Join-Path $deployment 'data\running.json'))){if($process.HasExited -or [datetime]::UtcNow -gt $deadline){throw 'Synthetic service failed to start'};Start-Sleep -Milliseconds 100}
  $output=Join-Path $run ($mode+'-report.json')
  & (Join-Path $root 'scripts\Measure-CollectorPerformance.ps1') -DataDir (Join-Path $deployment 'data') -Output $output -DurationSeconds 10|Out-Null
  $raw=Get-Content -LiteralPath $output -Raw -Encoding UTF8;$report=$raw|ConvertFrom-Json
  if(!$report.read_only -or $report.duration_observed_seconds -lt 9 -or !@($report.processes|Where-Object {$_.kind -eq 'service'}).Count -or !@($report.processes|Where-Object {$_.kind -eq 'observer'}).Count){throw 'Diagnostic omitted owned processes or duration'}
  if($raw.Contains('DO_NOT_EXPORT') -or $raw.Contains(('P'*43)) -or $raw.Contains($deployment.Replace('\','\\'))){throw 'Diagnostic leaked private identity, paths or credentials'}
  $requests=Get-Content -LiteralPath (Join-Path $deployment 'data\requests.json') -Raw|ConvertFrom-Json
  $requests=@($requests)
  $fallback=$mode -in @('legacy','notfound')
  if(($fallback -and ($requests.Count -ne 2 -or $requests[1] -ne '/api/status' -or $report.summary.version -ne '0.4.0' -or $report.summary.api_error)) -or (!$fallback -and ($requests.Count -ne 1 -or $requests[0] -ne '/api/status/brief'))){throw 'Unexpected full-status polling or missing fallback status'}
  if($mode -eq 'auth' -and ($report.summary.api_error -ne 'brief_status_unavailable' -or $report.summary.version)){throw 'Authorization 400 must not fall back or return a version'}
  Reject {& (Join-Path $root 'scripts\Measure-CollectorPerformance.ps1') -DataDir (Join-Path $deployment 'data') -Output $output -DurationSeconds 10}
  $runningPath=Join-Path $deployment 'data\running.json';$running=Get-Content -LiteralPath $runningPath -Raw|ConvertFrom-Json;$truePid=$running.pid
  $running.pid=[Diagnostics.Process]::GetCurrentProcess().Id;Save-Json $runningPath $running
  Reject {& (Join-Path $root 'scripts\Measure-CollectorPerformance.ps1') -DataDir (Join-Path $deployment 'data') -Output (Join-Path $run 'rejected.json') -DurationSeconds 10}
  $running.pid=$truePid;Save-Json $runningPath $running
  $afterRequests=Get-Content -LiteralPath (Join-Path $deployment 'data\requests.json') -Raw|ConvertFrom-Json
  if(@($afterRequests).Count -ne $requests.Count){throw 'Ownership rejection still called the API'}
 }
 $passed=$true
}catch{$failure=$_.Exception.Message;Write-Output ('Verification error: '+$failure)}finally{
 $pids=@()
 foreach($item in $owned){
  $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$item.pid) -ErrorAction SilentlyContinue
  if($process -and $process.CommandLine.Contains((Join-Path $item.root 'src\server.mjs'))){
   $pids+=$item.pid;$childFile=Join-Path $item.root 'data\child.pid';if(Test-Path -LiteralPath $childFile){$pids+=[int](Get-Content -LiteralPath $childFile)}
   $state=Get-Content -LiteralPath (Join-Path $item.root 'data\running.json') -Raw|ConvertFrom-Json
   try{Invoke-RestMethod ('http://127.0.0.1:'+$state.port+'/api/shutdown') -Headers @{Authorization='Bearer '+('P'*43)} -Method Post -Body '{}' -ContentType 'application/json' -TimeoutSec 5|Out-Null}catch{}
  }
 }
 $deadline=[datetime]::UtcNow.AddSeconds(15)
 do{$left=@($pids|Where-Object {Get-Process -Id $_ -ErrorAction SilentlyContinue});if(!$left.Count){break};Start-Sleep -Milliseconds 200}while([datetime]::UtcNow -lt $deadline)
 $result=@{passed=($passed -and !$left.Count);failure=$failure;synthetic_directory=$run;brief_once_and_legacy_400_or_404_once_fallback=$passed;authorization_400_no_fallback=$passed;ownership_rejection_before_api=$passed;private_fields_not_exported=$passed;service_and_observer_metrics=$passed;existing_report_not_overwritten=$passed;real_desktop_or_model_used=$false;all_owned_test_processes_exited=(!$left.Count)}
 Save-Json (Join-Path $run 'verification.json') $result
 $result|ConvertTo-Json
 if(!$result.passed){throw 'Performance tools verification failed'}
}
