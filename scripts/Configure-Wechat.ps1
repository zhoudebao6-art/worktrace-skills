param(
 [Parameter(Mandatory=$true)][string]$DeploymentRoot,
 [string]$ReaderDirectory,[string]$AccountRoot,[string]$AccountId,
 [switch]$PrepareKeysWhenIdle,[switch]$Enable
)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($DeploymentRoot).TrimEnd('\')
. (Join-Path $PSScriptRoot 'provision-common.ps1')
Assert-WorkTracePlainPath $root
$data=Join-Path $root 'data';$node=Join-Path $root 'runtime\node.exe'
Assert-WorkTracePlainPath $data;Assert-WorkTracePlainPath $node
if(!(Test-Path -LiteralPath (Join-Path $data 'config.json'))){throw 'Existing collector required; do not initialize a replacement.'}
$identity=Get-Content -LiteralPath (Join-Path $data 'config.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($identity.role -ne 'collector'){throw 'Only the existing employee collector can configure this source.'}
if(Test-Path -LiteralPath 'D:\'){$taskTemp='D:\codex+\temp';$taskCache='D:\codex+\cache\worktrace-wechat'}else{$taskTemp=Join-Path $root 'runtime-temp';$taskCache=Join-Path $root 'runtime-cache\wechat'}
New-Item -ItemType Directory -Path $taskTemp,$taskCache -Force|Out-Null
$env:TEMP=$taskTemp;$env:TMP=$taskTemp;$env:TMPDIR=$taskTemp;$env:NODE_COMPILE_CACHE=Join-Path $taskCache 'node'
$utf8=New-Object Text.UTF8Encoding($false)
function Admin([string]$Command,[object]$Value=$null){
 $arguments=@((Join-Path $root 'src\admin-cli.mjs'),'--command',$Command,'--role','collector','--dir',$data)
 $inputPath=$null
 try{if($null -ne $Value){$inputPath=Join-Path $taskTemp ('worktrace-wechat-input-'+[guid]::NewGuid().ToString()+'.json');[IO.File]::WriteAllText($inputPath,($Value|ConvertTo-Json -Depth 12),$utf8);$arguments+=@('--input',$inputPath)};$result=& $node @arguments;if($LASTEXITCODE -ne 0){throw "WorkTrace admin failed: $Command"};($result -join "`n")|ConvertFrom-Json}
 finally{if($inputPath -and (Test-Path -LiteralPath $inputPath)){Remove-Item -LiteralPath $inputPath -Force}}
}
$status=Admin 'status'
if($status.version -ne '0.6.0'){throw 'Upgrade the actual runtime to 0.6.0 before configuring WeChat.'}
$manifestPath=Join-Path $root 'runtime\wechat-reader-release.json'
$manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8|ConvertFrom-Json
if($manifest.format -ne 'worktrace.wechat-native-release/1.0' -or $manifest.platform -ne 'windows-x64' -or ![Environment]::Is64BitOperatingSystem){throw 'Unsupported native manifest or OS.'}
if(!$ReaderDirectory){
 $ReaderDirectory=Join-Path $root ('runtime\wechat-reader-'+$manifest.version)
 if(!(Test-Path -LiteralPath $ReaderDirectory)){
  if($manifest.url -notmatch '^https://github\.com/zhoudebao6-art/worktrace-skills/releases/download/v0\.6\.0/[A-Za-z0-9_.-]+\.zip$' -or $manifest.sha256 -notmatch '^[a-f0-9]{64}$'){throw 'Invalid pinned native release.'}
  $zip=Join-Path $taskCache ($manifest.sha256+'.zip')
  if(!(Test-Path -LiteralPath $zip) -or (Get-WorkTraceHash $zip) -ne $manifest.sha256){Invoke-WebRequest -UseBasicParsing -Uri $manifest.url -OutFile ($zip+'.partial');if((Get-WorkTraceHash ($zip+'.partial')) -ne $manifest.sha256){throw 'Native ZIP SHA256 mismatch; not executed.'};Move-Item -LiteralPath ($zip+'.partial') -Destination $zip -Force}
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive=[IO.Compression.ZipFile]::OpenRead($zip)
  try{if($archive.Entries.Count -gt 30){throw 'Too many native package entries.'};foreach($entry in $archive.Entries){if($entry.FullName -match '(^|[/\\])\.\.([/\\]|$)|^[\/]|:' -or $entry.Length -gt 30MB){throw 'Unsafe native ZIP entry.'}}}finally{$archive.Dispose()}
  Assert-WorkTracePlainPath $ReaderDirectory
  Expand-Archive -LiteralPath $zip -DestinationPath $ReaderDirectory
 }
}
$ReaderDirectory=[IO.Path]::GetFullPath($ReaderDirectory);Assert-WorkTracePlainPath $ReaderDirectory
foreach($entry in $manifest.files){if($entry.path -notmatch '^[A-Za-z0-9_.-]+$' -or $entry.sha256 -notmatch '^[a-f0-9]{64}$'){throw 'Unsafe native file manifest.'};$file=Join-Path $ReaderDirectory $entry.path;Assert-WorkTracePlainPath $file;if(!(Test-Path -LiteralPath $file) -or (Get-WorkTraceHash $file) -ne $entry.sha256){throw "Native file verification failed: $($entry.path)"}}
$sourceFile=Join-Path $data 'wechat-source.json';Assert-WorkTracePlainPath $sourceFile
$existing=if(Test-Path -LiteralPath $sourceFile){Get-Content -LiteralPath $sourceFile -Raw -Encoding UTF8|ConvertFrom-Json}else{$null}
if(!$AccountRoot -and $existing){$AccountRoot=$existing.account_root}
if(!$AccountId -and $existing){$AccountId=$existing.account_id}
if(!$AccountRoot){
 $candidates=@();$bases=@((Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'xwechat_files'),(Join-Path $env:USERPROFILE 'Documents\xwechat_files'))|Select-Object -Unique
 foreach($base in $bases){if(Test-Path -LiteralPath $base){foreach($directory in Get-ChildItem -LiteralPath $base -Directory){if(Test-Path -LiteralPath (Join-Path $directory.FullName 'db_storage\message')){$candidates+=$directory.FullName}}}}
 $candidates=@($candidates|Select-Object -Unique)
 if($candidates.Count -ne 1){throw 'Cannot uniquely identify the account directory. Supply -AccountRoot; do not choose the newest folder or scan all disks.'};$AccountRoot=$candidates[0]
}
$AccountRoot=[IO.Path]::GetFullPath($AccountRoot).TrimEnd('\')
Assert-WorkTracePlainPath $AccountRoot;Assert-WorkTracePlainPath (Join-Path $AccountRoot 'db_storage\message')
if(!(Test-Path -LiteralPath (Join-Path $AccountRoot 'db_storage\message'))){throw 'This adapter requires a Windows 4.x account directory containing db_storage\message.'}
if(!$AccountId){$AccountId=(Split-Path $AccountRoot -Leaf) -replace '_[a-fA-F0-9]{4}$',''}
if($AccountId -notmatch '^[A-Za-z0-9_@.-]{1,160}$'){throw 'Account ID is ambiguous; specify the verified account ID.'}
if($existing -and ($existing.account_id -cne $AccountId -or [IO.Path]::GetFullPath($existing.account_root).TrimEnd('\') -ine $AccountRoot)){throw 'Existing source belongs to a different account. Do not silently rebind it.'}
$private=Join-Path $root 'private';$profile=if($existing -and $existing.account_root -eq $AccountRoot -and $existing.account_id -eq $AccountId){$existing.profile_path}else{Join-Path $private 'wechat-profile.json'}
Assert-WorkTracePlainPath $private
$profile=[IO.Path]::GetFullPath($profile)
if(!$profile.StartsWith($private+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'The DPAPI profile must remain inside this deployment private directory.'}
Assert-WorkTracePlainPath $profile
if(!(Test-Path -LiteralPath $profile)){
 if(!$PrepareKeysWhenIdle){[ordered]@{ok=$false;reason='idle_key_setup_required';runtime_upgraded=$true;source_enabled=$false;next='Rerun with -PrepareKeysWhenIdle while employee is idle. Existing collector remains unchanged.'}|ConvertTo-Json;return}
 if(-not ('WorkTraceWechatSetupIdle' -as [type])){Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class WorkTraceWechatSetupIdle { [StructLayout(LayoutKind.Sequential)] struct L { public uint cbSize; public uint dwTime; } [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref L x); public static uint Seconds() { L x=new L();x.cbSize=(uint)Marshal.SizeOf(x);if(!GetLastInputInfo(ref x))throw new Exception("Idle check failed");return unchecked((uint)Environment.TickCount-x.dwTime)/1000; }}'}
 if([WorkTraceWechatSetupIdle]::Seconds() -lt 120){[ordered]@{ok=$false;reason='employee_active';runtime_upgraded=$true;source_enabled=$false;next='Key preparation deferred until idle; no desktop input or key scan performed.'}|ConvertTo-Json;return}
 $processes=@(Get-Process -Name Weixin,WeChat -ErrorAction SilentlyContinue|Where-Object {$_.MainWindowHandle -ne 0})
 if($processes.Count -ne 1){throw 'A unique already logged-in Weixin/WeChat process is required. No process will be started or restarted.'}
 New-Item -ItemType Directory -Path $private -Force|Out-Null
 $setup=Join-Path $ReaderDirectory 'worktrace-wechat-setup.exe';$dll=Join-Path $ReaderDirectory 'worktrace-wcdb.dll'
 $result=& $setup '--dll' $dll '--profile' $profile '--account-root' $AccountRoot '--account-id' $AccountId '--pid' ([string]$processes[0].Id) '--timeout-seconds' '120'
 if($LASTEXITCODE -ne 0){throw 'Read-only key preparation failed; original collector is unchanged. Check the non-secret native status.'}
 $prepared=($result -join "`n")|ConvertFrom-Json
 if(!$prepared.ok -or !(Test-Path -LiteralPath $profile)){throw 'Native setup did not verify a local profile.'}
}
$binding=[ordered]@{format='worktrace.wechat-source/1.0';reader_path=(Join-Path $ReaderDirectory 'worktrace-wechat-reader.exe');dll_path=(Join-Path $ReaderDirectory 'worktrace-wcdb.dll');profile_path=$profile;account_root=$AccountRoot;account_id=$AccountId}
$backup=if($existing){$sourceFile+'.backup-'+[guid]::NewGuid().ToString()}else{$null}
if($backup){Assert-WorkTracePlainPath $backup;Copy-Item -LiteralPath $sourceFile -Destination $backup}
try{
 Assert-WorkTracePlainPath ($sourceFile+'.tmp');Assert-WorkTracePlainPath $sourceFile
 [IO.File]::WriteAllText($sourceFile+'.tmp',($binding|ConvertTo-Json -Depth 5),$utf8);Move-Item -LiteralPath ($sourceFile+'.tmp') -Destination $sourceFile -Force
 $probe=Admin 'wechat-probe';if(!$probe.ok){throw 'Native metadata probe did not pass.'}
 if($Enable){$policy=$status.wechat.policy;$policy.enabled=$true;if(!$existing){$policy.capture_since=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')};$null=Admin 'wechat-configure' $policy}
 [ordered]@{ok=$true;version='0.6.0';read_only=$true;global_capture_unchanged=$true;source=(Admin 'wechat-status');probe=$probe;field_message_verification='pending normal authorized work messages';mcp='Reconnect existing WorkTrace MCP; query tools are wechat_status/wechat_list_chats/wechat_read_chat.'}|ConvertTo-Json -Depth 12
}catch{
 if($backup){Copy-Item -LiteralPath $backup -Destination $sourceFile -Force}else{if(Test-Path -LiteralPath $sourceFile){Remove-Item -LiteralPath $sourceFile -Force}}
 throw
}
