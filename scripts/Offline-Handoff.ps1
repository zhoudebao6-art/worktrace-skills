param([Parameter(Mandatory=$true)][ValidateSet('Export','Inspect','Restore','Recover','Import')][string]$Action,[string]$DataDir,[Alias('Input')][string]$InputFile,[string]$Output,[string]$Destination,[switch]$FinishPilot)
$ErrorActionPreference='Stop'
$source=Split-Path $PSScriptRoot -Parent
if(Test-Path -LiteralPath 'D:\'){$taskTemp='D:\codex+\temp';$taskCache='D:\codex+\cache\worktrace'}else{$taskTemp=Join-Path $source 'runtime-temp';$taskCache=Join-Path $source 'runtime-cache'}
New-Item -ItemType Directory -Path $taskTemp,$taskCache -Force|Out-Null
$env:TEMP=$taskTemp;$env:TMP=$taskTemp;$env:TMPDIR=$taskTemp;$env:NODE_COMPILE_CACHE=Join-Path $taskCache 'node'
$node=Join-Path $source 'runtime\node.exe';if(!(Test-Path -LiteralPath $node)){throw '请先部署 WorkTrace 运行目录，再从运行目录执行此脚本。'}
& (Join-Path $PSScriptRoot 'Ensure-Runtime.ps1') -Root $source
if(!$DataDir){$DataDir=Join-Path $source 'data'}
if($Action -eq 'Export' -and !$Output){throw 'Export 需要新的 -Output 路径'}
if($Action -ne 'Export' -and !$InputFile){throw '此操作需要 -Input 移交包路径'}
if($Action -in @('Restore','Recover') -and !$Destination){throw 'Restore/Recover 需要新的 -Destination 目录'}
if($FinishPilot -and $Action -ne 'Export'){throw '-FinishPilot 仅用于 Export。'}
$secure=Read-Host '请在本机输入移交密码（12–200字符，不会显示或保存）' -AsSecureString
$pointer=[IntPtr]::Zero
$previousEncoding=$OutputEncoding
try{
 $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
 $password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
 if($password.Length -lt 12 -or $password.Length -gt 200){throw '密码长度应为12–200字符'}
 $arguments=@((Join-Path $source 'src\handoff-cli.mjs'),'--action',$Action,'--dir',$DataDir)
 if($InputFile){$arguments+=@('--input',$InputFile)};if($Output){$arguments+=@('--output',$Output)};if($Destination){$arguments+=@('--destination',$Destination)};if($FinishPilot){$arguments+=@('--finish-pilot','true')}
 $payload=@{password=$password}|ConvertTo-Json -Compress
 # JSON Unicode escapes keep stdin valid UTF-8 even when Windows PowerShell
 # 5.1 inherits an ASCII native pipeline from the caller. JSON.parse restores
 # the original password; neither the secret nor an encoding change is saved.
 $payload=[regex]::Replace($payload,'[^\x00-\x7F]',{param($match) '\u'+([int][char]$match.Value).ToString('x4')})
 $OutputEncoding=New-Object Text.UTF8Encoding($false)
 $payload | & $node @arguments
 if($LASTEXITCODE -ne 0){throw '移交操作未成功，原机资料保留，请核对错误。'}
}finally{if($pointer -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)};$password=$null;$payload=$null;$OutputEncoding=$previousEncoding;$secure.Dispose()}
