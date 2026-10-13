$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$env:TEMP='D:\codex+\temp';$env:TMP=$env:TEMP;$env:TMPDIR=$env:TEMP;$env:NODE_COMPILE_CACHE='D:\codex+\cache\worktrace\node';$env:WORKTRACE_PORT='0'
$run=Join-Path $env:TEMP ('worktrace-offline-provision\'+[guid]::NewGuid().ToString('N'))
$package=Join-Path $run 'synthetic-download';$engine=Join-Path $package 'skills\worktrace-hub\assets\engine';$nodeRoot=Join-Path $run 'employee';$skills=Join-Path $run 'employee-skills'
New-Item -ItemType Directory -Path $engine,(Join-Path $package 'scripts') -Force|Out-Null
. (Join-Path $root 'scripts\provision-common.ps1')
$utf8=New-Object Text.UTF8Encoding($true)
function Save-Json([string]$Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 30),$utf8)}
function Invoke-Local([string]$Path,$Body=$null){
 $r=Get-Content -LiteralPath (Join-Path $nodeRoot 'data\running.json') -Raw|ConvertFrom-Json
 $headers=@{Authorization='Bearer '+($r.url -split '#key=')[1]};$url='http://127.0.0.1:'+$r.port+'/api/'+$Path
 if($null -eq $Body){Invoke-RestMethod $url -Headers $headers -TimeoutSec 15}else{Invoke-RestMethod $url -Headers $headers -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes(($Body|ConvertTo-Json -Depth 10 -Compress))) -TimeoutSec 30}
}
function Must-Reject([scriptblock]$Operation,[string]$Label){
 $rejected=$false;try{& $Operation|Out-Null}catch{$rejected=$true}
 if(!$rejected){throw "Expected rejection: $Label"}
}
function Read-DatabaseIdentity {
 $code="const d=new (require('node:sqlite').DatabaseSync)(process.argv[1],{readOnly:true});console.log(JSON.stringify({stream:d.prepare('SELECT value FROM meta WHERE key=?').get('stream_id').value,devices:d.prepare('SELECT COUNT(*) n FROM devices').get().n,events:d.prepare('SELECT COUNT(*) n FROM events').get().n}));d.close();"
 $raw=& (Join-Path $nodeRoot 'runtime\node.exe') -e $code (Join-Path $nodeRoot 'data\worktrace.sqlite')
 if($LASTEXITCODE -ne 0){throw 'Cannot inspect synthetic database'}
 $raw|ConvertFrom-Json
}
$passed=$false;$failure='';$owned=@();$left=@()
try{
 # A test-only fixture from current sources; does not refresh the engine mirror.
 $files=@()
 foreach($relative in @('src','bridge','public','skills\worktrace-collector','skills\worktrace-personal','skills\worktrace-evidence')){$files+=@(Get-ChildItem -LiteralPath (Join-Path $root $relative) -File -Recurse)}
 foreach($relative in @('Start.ps1','Tray.ps1','Install-Skills.ps1','连接Codex.ps1','设置登录启动.ps1','runtime\NODE-LICENSE.txt','scripts\provision-common.ps1','scripts\Ensure-Runtime.ps1','scripts\Configure-Learning.ps1','scripts\Join-Node.ps1','scripts\Initialize-OfflineNode.ps1','scripts\skill-control.ps1')){$files+=Get-Item -LiteralPath (Join-Path $root $relative)}
 $entries=@();foreach($file in $files){$rel=$file.FullName.Substring($root.Length+1).Replace('\','/');$dest=Join-Path $engine $rel;New-Item -ItemType Directory -Path (Split-Path $dest -Parent) -Force|Out-Null;Copy-Item -LiteralPath $file.FullName -Destination $dest;$entries+=@{path=$rel;sha256=(Get-WorkTraceHash $dest);size=$file.Length}}
 Save-Json (Join-Path $engine 'engine-manifest.json') @{format='worktrace.source/1.0';version='0.4.0';files=$entries}
 foreach($script in @('Initialize-OfflineNode.ps1','provision-common.ps1')){Copy-Item -LiteralPath (Join-Path $root ('scripts\'+$script)) -Destination (Join-Path $package ('scripts\'+$script))}
 $downloadFiles=@();foreach($file in Get-ChildItem -LiteralPath $package -File -Recurse){$downloadFiles+=@{path=$file.FullName.Substring($package.Length+1).Replace('\','/');sha256=(Get-WorkTraceHash $file.FullName);size=$file.Length}}
 Save-Json (Join-Path $package '.worktrace-source.json') @{format='worktrace.download/1.0';repository='https://github.com/zhoudebao6-art/worktrace-skills';commit=('0'*40);version='0.4.0';files=$downloadFiles}
 & (Join-Path $root 'scripts\Ensure-Runtime.ps1') -Root $package -Candidate (Join-Path $root 'runtime\node.exe')|Out-Null
 $identity=@{format='worktrace.offline-identity/1.0';org_name='OFFLINE SYNTHETIC TEST';employee_id='OFFLINE_TEST';employee_name='SYNTHETIC EMPLOYEE';label='SYNTHETIC PC'}
 $identityFile=Join-Path $run 'identity.json';Save-Json $identityFile $identity
 $initializer=Join-Path $package 'scripts\Initialize-OfflineNode.ps1'
 $arguments=@{IdentityFile=$identityFile;WorkDir=$nodeRoot;SkillsDirectory=$skills;SkipMcp=$true}
 & $initializer @arguments|Out-Null
 $first=Invoke-Local 'status';$configFile=Join-Path $nodeRoot 'data\config.json';$config=Get-Content -LiteralPath $configFile -Raw|ConvertFrom-Json
 if(!$first.configured -or $first.role -ne 'collector' -or $first.connection_mode -ne 'offline' -or $first.collection.enabled -or $first.worker.policy.enabled){throw 'Offline first deployment did not remain paused'}
 foreach($name in @('hub_url','device_token','ca_pem','cert_password','hub_port')){if($config.$name){throw "Unexpected hub configuration: $name"}}
 if(@(Get-ChildItem -LiteralPath (Join-Path $nodeRoot 'data') -File|Where-Object {$_.Extension -in @('.pem','.pfx')}).Count){throw 'Offline deployment generated certificates'}
 if($first.sync.running -or $first.sync.last_success -or $first.sync.error){throw 'Offline deployment attempted remote synchronization'}
 foreach($name in @('worktrace-collector','worktrace-personal','worktrace-evidence')){$b=Get-Content -LiteralPath (Join-Path $skills ($name+'\deployment.json')) -Raw|ConvertFrom-Json;if($b.root -ne $nodeRoot -or $b.role -ne 'collector'){throw 'Skill bound to wrong deployment'}}
 $dbBefore=Read-DatabaseIdentity;$configHash=Get-WorkTraceHash $configFile
 & $initializer @arguments|Out-Null
 $identity.org_id=$config.org_id;Save-Json $identityFile $identity
 & $initializer @arguments|Out-Null
 $dbAfter=Read-DatabaseIdentity
 if((Get-WorkTraceHash $configFile) -ne $configHash -or $dbBefore.stream -ne $dbAfter.stream -or $dbAfter.devices -ne 1 -or $dbAfter.events -ne 0 -or (Invoke-Local 'status').collection.enabled){throw 'Repeated deployment changed identity, collected desktop data, or resumed a pause'}
 $identity.employee_id='DIFFERENT_EMPLOYEE';Save-Json $identityFile $identity
 Must-Reject {& $initializer @arguments} 'employee conflict'
 $identity.employee_id='OFFLINE_TEST';$identity.org_id=[guid]::NewGuid().ToString();Save-Json $identityFile $identity
 Must-Reject {& $initializer @arguments} 'company conflict'
 $identity.org_id=$config.org_id;Save-Json $identityFile $identity
 $badSkills=Join-Path $run 'conflicting-skills';New-Item -ItemType Directory -Path (Join-Path $badSkills 'worktrace-personal') -Force|Out-Null
 Save-Json (Join-Path $badSkills 'worktrace-personal\deployment.json') @{role='collector';root=(Join-Path $run 'someone-else')}
 Must-Reject {& $initializer -IdentityFile $identityFile -WorkDir $nodeRoot -SkillsDirectory $badSkills -SkipMcp} 'existing skill binding'
 $tamper=Join-Path $engine 'src\protocol.mjs';[IO.File]::AppendAllText($tamper,'// synthetic tamper')
 Must-Reject {& $initializer @arguments} 'source hash mismatch'
 if((Get-WorkTraceHash $configFile) -ne $configHash){throw 'Rejected deployment modified existing configuration'}
 # Test the PowerShell handoff wrapper with a synthetic native CLI. No real
 # handoff/password is created; only a hash proves UTF-8 stdin survived PS 5.1.
 $wrapperRoot=Join-Path $run 'handoff-wrapper';New-Item -ItemType Directory -Path (Join-Path $wrapperRoot 'scripts'),(Join-Path $wrapperRoot 'src'),(Join-Path $wrapperRoot 'runtime') -Force|Out-Null
 foreach($name in @('Offline-Handoff.ps1','Ensure-Runtime.ps1','provision-common.ps1')){Copy-Item -LiteralPath (Join-Path $root ('scripts\'+$name)) -Destination (Join-Path $wrapperRoot ('scripts\'+$name))}
 Copy-Item -LiteralPath (Join-Path $nodeRoot 'runtime\node.exe') -Destination (Join-Path $wrapperRoot 'runtime\node.exe')
 $fakeCli="import {createHash} from 'node:crypto';let input='';for await(const c of process.stdin)input+=c.toString('utf8');console.log(JSON.stringify({args:process.argv.slice(2),password_hash:createHash('sha256').update(JSON.parse(input).password,'utf8').digest('hex')}));"
 [IO.File]::WriteAllText((Join-Path $wrapperRoot 'src\handoff-cli.mjs'),$fakeCli,(New-Object Text.UTF8Encoding($false)))
 $syntheticPassword='仅合成测试密码-Chem-2026-quote"slash\'
 function Read-Host {param([string]$Prompt,[switch]$AsSecureString) if(!$AsSecureString){throw 'Password prompt must use SecureString'};ConvertTo-SecureString -String $syntheticPassword -AsPlainText -Force}
 $encodingBefore=$OutputEncoding
 $wrapped=& (Join-Path $wrapperRoot 'scripts\Offline-Handoff.ps1') -Action Inspect -Input (Join-Path $run 'synthetic.wthandoff')|ConvertFrom-Json
 $hashTool=[Security.Cryptography.SHA256]::Create();try{$expectedPasswordHash=[BitConverter]::ToString($hashTool.ComputeHash([Text.Encoding]::UTF8.GetBytes($syntheticPassword))).Replace('-','').ToLowerInvariant()}finally{$hashTool.Dispose()}
 if($wrapped.password_hash -ne $expectedPasswordHash -or !(@($wrapped.args) -contains (Join-Path $run 'synthetic.wthandoff')) -or $OutputEncoding.CodePage -ne $encodingBefore.CodePage){throw 'Handoff wrapper corrupted UTF-8 input, alias or parent encoding'}
 Must-Reject {& (Join-Path $wrapperRoot 'scripts\Offline-Handoff.ps1') -Action Inspect -Input 'synthetic.wthandoff' -FinishPilot} 'FinishPilot on Inspect'
 Remove-Item Function:\Read-Host
 $passed=$true
}catch{$failure=$_.Exception.Message;Write-Output ('Verification error: '+$failure)}finally{
 $running=Join-Path $nodeRoot 'data\running.json'
 if(Test-Path -LiteralPath $running){$r=Get-Content -LiteralPath $running -Raw|ConvertFrom-Json;$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$r.pid) -ErrorAction SilentlyContinue;if($p -and $p.CommandLine.Contains((Join-Path $nodeRoot 'src\server.mjs'))){$owned+=[int]$r.pid;try{Invoke-Local 'shutdown' @{}|Out-Null}catch{}}}
 $tray=Join-Path $nodeRoot 'data\tray.pid';if(Test-Path -LiteralPath $tray){$trayId=[int](Get-Content -LiteralPath $tray);$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$trayId) -ErrorAction SilentlyContinue;if($p -and $p.CommandLine.Contains((Join-Path $nodeRoot 'Tray.ps1'))){$owned+=$trayId}}
 $deadline=[datetime]::UtcNow.AddSeconds(30)
 do{$left=@($owned|Where-Object {Get-Process -Id $_ -ErrorAction SilentlyContinue});if(!$left.Count){break};Start-Sleep -Milliseconds 300}while([datetime]::UtcNow -lt $deadline)
 $report=@{passed=($passed -and !$left.Count);failure=$failure;test_directory=$run;git_free_fixture=$true;offline_without_hub=$passed;repeat_preserves_identity_and_pause=$passed;conflict_and_tamper_rejected=$passed;three_skills_bound=$passed;handoff_secure_utf8_stdin_and_input_alias=$passed;desktop_capture_never_enabled=$true;real_model_not_called=$true;mcp_registration_skipped=$true;all_test_processes_stopped=(!$left.Count)}
 Save-Json (Join-Path $run 'offline-provision-report.json') $report
 $report|ConvertTo-Json
 if(!$report.passed){throw 'Offline provisioning verification failed'}
}
