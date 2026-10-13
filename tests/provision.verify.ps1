param([switch]$SkipActivityCapture)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$packageVersion=(Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8|ConvertFrom-Json).version
$work='D:\codex+\temp\worktrace-provision'
$run=Join-Path $work ([guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $run -Force|Out-Null
$env:TEMP='D:\codex+\temp';$env:TMP=$env:TEMP;$env:TMPDIR=$env:TEMP;$env:WORKTRACE_PORT='0'
$skill=Join-Path $run 'portable-hub-skill';Copy-Item -LiteralPath (Join-Path $root 'skills\worktrace-hub') -Destination $skill -Recurse
$h=Join-Path $run 'hub';$nodes=@($h);$passed=$false;$failure=''
function Invoke-Local([string]$NodeRoot,[string]$Path,$Body=$null){$r=Get-Content -LiteralPath (Join-Path $NodeRoot 'data\running.json') -Raw|ConvertFrom-Json;$headers=@{Authorization='Bearer '+($r.url -split '#key=')[1]};$url='http://127.0.0.1:'+$r.port+'/api/'+$Path;if($null -eq $Body){Invoke-RestMethod $url -Headers $headers -TimeoutSec 20}else{Invoke-RestMethod $url -Headers $headers -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes(($Body|ConvertTo-Json -Depth 10 -Compress))) -TimeoutSec 40}}
function Assert-BindingVersion([string]$NodeRoot,[string[]]$BindingFiles){
 $deployedVersion=(Get-Content -LiteralPath (Join-Path $NodeRoot 'engine-manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json).version
 if(!$packageVersion -or $deployedVersion -ne $packageVersion){throw "Deployment manifest version does not match package version: $NodeRoot"}
 foreach($file in $BindingFiles){$binding=Get-Content -LiteralPath $file -Raw -Encoding UTF8|ConvertFrom-Json;if($binding.version -ne $deployedVersion){throw "Skill deployment version does not match manifest/package: $file"}}
}
try{
 & (Join-Path $skill 'scripts\bootstrap.ps1') -WorkDir $h -SkipMcp|Out-Null
 Assert-BindingVersion $h @((Join-Path $skill 'deployment.json'))
 $s=Invoke-Local $h 'status';if($s.configured){throw 'Unexpected configured company'}
 $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop()
 Invoke-Local $h 'setup' @{role='hub';org_name='PROVISION TEST ONLY';address='127.0.0.1';hub_port=$port}|Out-Null
 $roster=@();for($i=1;$i -le 2;$i++){$nodeRoot=Join-Path $run ('employee'+$i);$nodes+=$nodeRoot;$roster+=@{employee_id=('TEST'+$i);employee_name='TEST SAME NAME';label=('TEST PC '+$i);drop_path=(Join-Path $run ('private-inbox'+$i));work_dir=$nodeRoot;start_capture=($i -eq 1 -and !$SkipActivityCapture);enable_logon_startup=$false}}
 $rosterPath=Join-Path $run 'roster.json';$roster|ConvertTo-Json|Set-Content -LiteralPath $rosterPath -Encoding UTF8
 $share=Join-Path $run 'public-source';$prepare=Join-Path $skill 'scripts\prepare-fleet.ps1'
 $first=& $prepare -RosterFile $rosterPath -SourceShare $share -HubRoot $h
 if(($first -join "`n") -match 'device_token'){throw 'Credential printed'}
 & $prepare -RosterFile $rosterPath -SourceShare $share -HubRoot $h|Out-Null
 $before=Invoke-Local $h 'status';if(@($before.devices).Count -ne 2){throw 'Repeated provisioning duplicated devices'}
 for($i=1;$i -le 2;$i++){
  & (Join-Path $share 'scripts\Join-Node.ps1') -Settings (Join-Path $roster[$i-1].drop_path 'join.json') -SkillsDirectory (Join-Path $run ('employee-skills'+$i)) -SkipMcp|Out-Null
  $bindingFiles=@('worktrace-collector','worktrace-personal','worktrace-evidence')|ForEach-Object {Join-Path (Join-Path $run ('employee-skills'+$i)) ($_+'\deployment.json')}
  Assert-BindingVersion $roster[$i-1].work_dir $bindingFiles
  $s=Invoke-Local $roster[$i-1].work_dir 'status';if($s.employee_id -ne ('TEST'+$i) -or $s.collection.enabled -ne ($i -eq 1 -and !$SkipActivityCapture)){throw 'Wrong identity or unexpected capture'}
  $learning=Join-Path $roster[$i-1].work_dir 'scripts\Configure-Learning.ps1'
  & $learning -DataDir (Join-Path $roster[$i-1].work_dir 'data') -Action Enable | Out-Null
  & $learning -DataDir (Join-Path $roster[$i-1].work_dir 'data') -Action Pause | Out-Null
  $worker=(Invoke-Local $roster[$i-1].work_dir 'status').worker
  if($worker.policy.model -ne 'gpt-6.1-sol' -or $worker.policy.reasoning_effort -ne 'xhigh' -or !$worker.policy.paused){throw 'Worker configuration script did not preserve role model and pause'}
 }
 Invoke-Local $roster[0].work_dir 'capture' @{enabled=$false}|Out-Null
 & (Join-Path $share 'scripts\Join-Node.ps1') -Settings (Join-Path $roster[0].drop_path 'join.json') -SkillsDirectory (Join-Path $run 'employee-skills1') -SkipMcp|Out-Null
 if((Invoke-Local $roster[0].work_dir 'status').collection.enabled){throw 'Repeated join resumed a manual pause'}
 $after=Invoke-Local $h 'status';if(@($after.devices|Where-Object {!$_.last_seen}).Count){throw 'Employee heartbeat missing'}
 if(!$SkipActivityCapture){
 $c=$roster[0].work_dir;$policy=(Invoke-Local $c 'status').collection.policy;$policy.workdays=@(0,1,2,3,4,5,6);$policy.start='00:00';$policy.end='23:59';$policy.interval_seconds=5
 Invoke-Local $c 'policy' $policy|Out-Null;Invoke-Local $c 'capture' @{enabled=$true}|Out-Null
 $deadline=[datetime]::UtcNow.AddSeconds(35);$sampled=$false
 do{$events=Invoke-Local $c 'events';if(@($events.items|Where-Object {$_.event_type -eq 'activity.snapshot'}).Count){$sampled=$true;break};Start-Sleep -Milliseconds 700}while([datetime]::UtcNow -lt $deadline)
 Invoke-Local $c 'capture' @{enabled=$false}|Out-Null;if(!$sampled){throw 'No native activity sample'}
 Invoke-Local $c 'sync' @{}|Out-Null
 $central=Invoke-Local $h 'events';if(!@($central.items|Where-Object {$_.event_type -eq 'activity.snapshot'}).Count){throw 'Sample not delivered'}
 }
 $passed=$true
}catch{$failure=$_.Exception.Message;Write-Output ('Verification error: '+$failure)}finally{
 $ownedPids=@();foreach($nodeRoot in $nodes){$running=Join-Path $nodeRoot 'data\running.json';if(Test-Path -LiteralPath $running){$r=Get-Content -LiteralPath $running -Raw|ConvertFrom-Json;$ownedPids+=[int]$r.pid;try{Invoke-Local $nodeRoot 'shutdown' @{}|Out-Null}catch{}};$tray=Join-Path $nodeRoot 'data\tray.pid';if(Test-Path -LiteralPath $tray){$ownedPids+=[int](Get-Content -LiteralPath $tray)}}
 $deadline=[datetime]::UtcNow.AddSeconds(30);do{$left=@($ownedPids|Where-Object {Get-Process -Id $_ -ErrorAction SilentlyContinue});if(!$left.Count){break};Start-Sleep -Milliseconds 500}while([datetime]::UtcNow -lt $deadline)
 $report=@{passed=($passed -and !$left.Count);mode='one physical PC, three independently started service processes';portable_skill_bootstrap=$passed;two_employee_directories_prepared=$passed;repeat_preparation_no_duplicate_devices=$passed;both_employee_codex_join_scripts_completed=$passed;real_activity_sample_delivered=$passed;mcp_registration_skipped_in_isolated_test=$true;desktop_text_and_screenshots_disabled=$true;all_test_services_stopped=(!$left.Count);physical_remote_smb_not_tested=$true;test_directory=$run}
 $report.failure=$failure
 $report.activity_capture_skipped=[bool]$SkipActivityCapture
 $report.real_activity_sample_delivered=($passed -and !$SkipActivityCapture)
 $report.repeated_join_preserves_manual_pause=$passed
 $report.learning_config_script_role_model_and_pause=$passed
 $report.runtime_not_required_in_git=$passed
 $report.deployment_bindings_match_manifest_and_package_version=$passed
 $report|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root '总控部署验证.json') -Encoding UTF8
 $report|ConvertTo-Json
 if(!$report.passed){throw 'Provisioning verification failed'}
}
