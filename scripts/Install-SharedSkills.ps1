param(
 [Parameter(Mandatory=$true)][ValidateSet('hub','collector')][string]$Role,
 [string]$SkillsDirectory,
 [switch]$Update
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$sourceRoot=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$receiptName='.worktrace-install.json'
$utf8=New-Object Text.UTF8Encoding($false)

function Get-SharedHash([string]$Path){
 $stream=[IO.File]::OpenRead($Path);$sha=[Security.Cryptography.SHA256]::Create()
 try{return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}
 finally{$stream.Dispose();$sha.Dispose()}
}

function Assert-NoReparse([string]$Path){
 $cursor=[IO.Path]::GetFullPath($Path)
 while($cursor){
  if(Test-Path -LiteralPath $cursor){
   $item=Get-Item -LiteralPath $cursor -Force
   if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "拒绝链接或 junction 路径：$cursor"}
  }
  $parent=Split-Path $cursor -Parent
  if(!$parent -or $parent -eq $cursor){break};$cursor=$parent
 }
}
function Test-Within([string]$Path,[string]$Parent){
 $p=[IO.Path]::GetFullPath($Path).TrimEnd('\','/')
 $r=[IO.Path]::GetFullPath($Parent).TrimEnd('\','/')
 return $p.Equals($r,[StringComparison]::OrdinalIgnoreCase) -or $p.StartsWith($r+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)
}
function Assert-Relative([string]$Path){
 if(!$Path -or [IO.Path]::IsPathRooted($Path) -or $Path.Contains(':') -or $Path.Contains('\')){throw '文件清单含不安全相对路径。'}
 foreach($part in $Path.Split('/')){if(!$part -or $part -eq '.' -or $part -eq '..' -or $part.EndsWith('.') -or $part.EndsWith(' ')){throw '文件清单含不安全相对路径。'}}
}
function Get-Inventory([string]$Root){
 Assert-NoReparse $Root
 $result=@{}
 if(!(Test-Path -LiteralPath $Root)){return $result}
 if(!(Get-Item -LiteralPath $Root -Force).PSIsContainer){throw "技能路径不是目录：$Root"}
 $pending=New-Object 'Collections.Generic.Stack[string]';$pending.Push($Root)
 while($pending.Count){
  foreach($item in Get-ChildItem -LiteralPath $pending.Pop() -Force){
   if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "技能内含链接或 junction，未复制：$($item.FullName)"}
   if($item.PSIsContainer){$pending.Push($item.FullName);continue}
   $relative=$item.FullName.Substring($Root.TrimEnd('\','/').Length+1).Replace('\','/')
   Assert-Relative $relative
   $result[$relative]=@{path=$relative;sha256=(Get-SharedHash $item.FullName);size=$item.Length}
  }
 }
 return $result
}
function Assert-SourceFile([string]$Path){
 $parts=$Path.Split('/');$leaf=$parts[-1]
 if($parts -contains 'data' -or $parts -contains '.git' -or $parts -contains 'node_modules' -or $parts -contains '__pycache__' -or
    $leaf -in @('node.exe','deployment.json','config.json','running.json','enrollment.json','credentials.json','.worktrace-install.json') -or
    $leaf -match '(^\.env($|\.)|\.(sqlite.*|db|pem|pfx|key|wpack|enroll\.json)$)'){
  throw "技能源包含运行数据、凭据或运行时二进制，未复制：$Path"
 }
}
function Assert-EqualInventory($Expected,$Actual,[string]$Label){
 if($Expected.Count -ne $Actual.Count){throw "$Label 文件数不一致。"}
 foreach($entry in $Expected.GetEnumerator()){
  if(!$Actual.ContainsKey($entry.Key) -or $Actual[$entry.Key].sha256 -ne $entry.Value.sha256 -or $Actual[$entry.Key].size -ne $entry.Value.size){throw "$Label 内容不一致：$($entry.Key)"}
 }
}
function Copy-Inventory([string]$From,[string]$To,$Inventory){
 Assert-NoReparse $From;Assert-NoReparse $To
 New-Item -ItemType Directory -Path $To -Force|Out-Null
 foreach($key in @($Inventory.Keys|Sort-Object)){
  $target=Join-Path $To $key
  New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force|Out-Null
  Copy-Item -LiteralPath (Join-Path $From $key) -Destination $target -Force
 }
}
function Read-FileList($Entries){
 $result=@{}
 if(@($Entries).Count -gt 5000){throw '来源清单过大。'}
 foreach($entry in $Entries){
  Assert-Relative $entry.path
  if($entry.sha256 -notmatch '^[a-f0-9]{64}$' -or ($entry.size -isnot [int] -and $entry.size -isnot [long]) -or $entry.size -lt 0 -or $result.ContainsKey($entry.path)){throw '来源清单内容无效。'}
  $result[$entry.path]=@{path=$entry.path;sha256=$entry.sha256;size=$entry.size}
 }
 return $result
}
function Check-Engine([string]$Skill,$Inventory){
 $prefix='assets/engine/';$file=Join-Path $Skill 'assets/engine/engine-manifest.json'
 if(!(Test-Path -LiteralPath $file)){throw '总控技能源缺少引擎校验清单。'}
 $manifest=Get-Content -LiteralPath $file -Raw -Encoding UTF8|ConvertFrom-Json
 if($manifest.format -ne 'worktrace.source/1.0'){throw '不支持的引擎校验清单。'}
 $listed=Read-FileList $manifest.files;$actual=@{}
 foreach($key in $Inventory.Keys){
  if($key.StartsWith($prefix) -and $key -ne ($prefix+'engine-manifest.json')){
   $relative=$key.Substring($prefix.Length);$actual[$relative]=$Inventory[$key]
  }
 }
 Assert-EqualInventory $listed $actual '引擎清单校验'
}
function Invoke-Git([string[]]$Arguments){
 $lines=@(& $script:git -c core.quotepath=false -C $sourceRoot @Arguments 2>&1)
 if($LASTEXITCODE -ne 0){throw 'Git 来源校验失败；请使用已克隆且已提交的源码，并检查 origin 配置。'}
 return @($lines|ForEach-Object{$_.ToString()})
}

Assert-NoReparse $sourceRoot
$gitMode=Test-Path -LiteralPath (Join-Path $sourceRoot '.git')
$downloadFiles=$null
if($gitMode){
 $git=if($env:WORKTRACE_GIT){$env:WORKTRACE_GIT}else{(Get-Command git.exe -ErrorAction Stop).Source}
 $gitRoot=(Invoke-Git @('rev-parse','--show-toplevel')) -join ''
 if(![IO.Path]::GetFullPath($gitRoot).Equals($sourceRoot,[StringComparison]::OrdinalIgnoreCase)){throw '请从仓库根目录下的 scripts/Install-SharedSkills.ps1 运行。'}
 $commit=(Invoke-Git @('rev-parse','HEAD')) -join ''
 if($commit -notmatch '^([a-f0-9]{40}|[a-f0-9]{64})$'){throw '无有效 Git 提交。'}
 $origin=(Invoke-Git @('remote','get-url','origin')) -join ''
 if(!$origin -or $origin -match '^[a-z]+://[^/]*@'){throw 'origin 为空或含内嵌凭据，未记录来源。请使用无令牌的仓库地址。'}
 $repository=$origin.TrimEnd('/').Replace('git@github.com:','https://github.com/') -replace '\.git$',''
}else{
 $downloadPath=Join-Path $sourceRoot '.worktrace-source.json'
 if(!(Test-Path -LiteralPath $downloadPath)){throw '源码目录既不是 Git 克隆，也没有已校验下载包清单 .worktrace-source.json。请使用发布的完整源码包。'}
 $download=Get-Content -LiteralPath $downloadPath -Raw -Encoding UTF8|ConvertFrom-Json
 if($download.format -ne 'worktrace.download/1.0' -or $download.commit -notmatch '^[a-f0-9]{40}$' -or $download.repository -notmatch '^https://github\.com/[^/@]+/[^/@]+$'){throw '下载包来源清单格式无效。'}
 $downloadFiles=Read-FileList $download.files
 if($downloadFiles.ContainsKey('.worktrace-source.json')){throw '下载包清单不能将自身列为源码文件。'}
 $actual=Get-Inventory $sourceRoot;$actual.Remove('.worktrace-source.json')
 foreach($key in $actual.Keys){Assert-SourceFile $key}
 Assert-EqualInventory $downloadFiles $actual '完整下载包校验'
 $commit=$download.commit;$repository=$download.repository;$origin=$repository
}
if(!$SkillsDirectory){$SkillsDirectory=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.agents\skills'}
$destRoot=[IO.Path]::GetFullPath($SkillsDirectory).TrimEnd('\','/')
Assert-NoReparse $destRoot
if((Test-Within $destRoot $sourceRoot) -or (Test-Within $sourceRoot $destRoot)){throw '技能源与安装目录不能重叠。'}
$names=if($Role -eq 'hub'){@('worktrace-hub')}else{@('worktrace-collector','worktrace-evidence','worktrace-personal')}
$plans=@()

# Preflight every selected skill before creating or changing any installation.
foreach($name in $names){
 $source=Join-Path $sourceRoot ('skills/'+$name);$dest=Join-Path $destRoot $name
 $files=Get-Inventory $source
 if(!$files.ContainsKey('SKILL.md')){throw "技能源缺少 SKILL.md：$name"}
 foreach($key in $files.Keys){Assert-SourceFile $key}
 if($gitMode){
  $tracked=@(Invoke-Git @('ls-files','--',('skills/'+$name+'/')))
  $trackedFiles=@{}
  foreach($path in $tracked){$trackedFiles[$path.Substring(('skills/'+$name+'/').Length)]=$true}
  if($trackedFiles.Count -ne $files.Count){throw "技能源存在未跟踪或缺失文件：$name；请提交干净源码后安装。"}
  foreach($key in $files.Keys){if(!$trackedFiles.ContainsKey($key)){throw "技能源未由 Git 管理：$key"}}
  if(@(Invoke-Git @('status','--porcelain=v1','--untracked-files=all','--',('skills/'+$name+'/'))).Count){throw "技能源存在尚未提交的修改：$name"}
 }
 if($Role -eq 'hub'){Check-Engine $source $files}
 $oldFiles=Get-Inventory $dest;$managed=@{};$action='install';$previousCommit=$null
 if(Test-Path -LiteralPath $dest){
  $receiptPath=Join-Path $dest $receiptName
  if(!$oldFiles.ContainsKey($receiptName)){throw "已有同名技能但无共享安装收据，未自动接管：$dest；请用独立 SkillsDirectory 检视迁移。"}
  $receipt=Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8|ConvertFrom-Json
  if($receipt.format -ne 'worktrace.skill-install/1.0' -or $receipt.skill -ne $name -or $receipt.role -ne $Role -or $receipt.repository -ne $repository){throw "已有技能来源或角色不同，未覆盖：$name"}
  $managed=Read-FileList $receipt.files;$previousCommit=$receipt.commit
  foreach($key in $managed.Keys){
   if(!$oldFiles.ContainsKey($key) -or $oldFiles[$key].sha256 -ne $managed[$key].sha256 -or $oldFiles[$key].size -ne $managed[$key].size){throw "已安装技能存在本地修改，未覆盖：$name/$key；请保留修改，并在独立目录检查新版后迁移。"}
  }
  foreach($key in $files.Keys){if($oldFiles.ContainsKey($key) -and !$managed.ContainsKey($key)){throw "新版本与本地附加文件冲突，未覆盖：$name/$key"}}
  $same=$commit -eq $previousCommit
  if($same){Assert-EqualInventory $files $managed '同版本来源校验';$action='unchanged'}
  elseif(!$Update){throw "技能源版本已变化：$name；请检查后显式使用 -Update。"}
  else{$action='update'}
 }
 $plans+=@{name=$name;source=$source;dest=$dest;files=$files;oldFiles=$oldFiles;managed=$managed;action=$action;backup=$null;previousCommit=$previousCommit}
}

$backupRoot=$null
if(@($plans|Where-Object{$_.action -eq 'update'}).Count){
 $backupRoot=Join-Path $destRoot ('.worktrace-backups/'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[Guid]::NewGuid().ToString('N'))
 Assert-NoReparse $backupRoot
 foreach($plan in $plans|Where-Object{$_.action -eq 'update'}){
  Assert-EqualInventory $plan.oldFiles (Get-Inventory $plan.dest) '更新前安装目录校验'
  $plan.backup=Join-Path $backupRoot $plan.name
  Copy-Inventory $plan.dest $plan.backup $plan.oldFiles
  Assert-EqualInventory $plan.oldFiles (Get-Inventory $plan.backup) '完整备份校验'
 }
}
$changed=@()
try{
 foreach($plan in $plans){
  if($plan.action -eq 'unchanged'){continue}
  Assert-EqualInventory $plan.oldFiles (Get-Inventory $plan.dest) '写入前安装目录校验'
  $changed+=,$plan
  Copy-Inventory $plan.source $plan.dest $plan.files
  foreach($key in $plan.managed.Keys){
   if(!$plan.files.ContainsKey($key)){Remove-Item -LiteralPath (Join-Path $plan.dest $key) -Force}
  }
  $record=@{format='worktrace.skill-install/1.0';skill=$plan.name;role=$Role;repository=$repository;origin=$origin;commit=$commit;installed_at=[DateTime]::UtcNow.ToString('o');files=@($plan.files.Values|Sort-Object path)}
  [IO.File]::WriteAllText((Join-Path $plan.dest $receiptName),($record|ConvertTo-Json -Depth 8),$utf8)
  $expected=@{};foreach($key in $plan.oldFiles.Keys){if(!$plan.managed.ContainsKey($key)){$expected[$key]=$plan.oldFiles[$key]}}
  foreach($key in $plan.files.Keys){$expected[$key]=$plan.files[$key]}
  $actual=Get-Inventory $plan.dest;$expected[$receiptName]=$actual[$receiptName]
  Assert-EqualInventory $expected $actual '安装结果校验'
 }
}catch{
 $failure=$_
 # Restore file contents from verified backups. Never delete an unverified directory tree.
 foreach($plan in $changed){
  $current=Get-Inventory $plan.dest
  foreach($key in $current.Keys){if(!$plan.oldFiles.ContainsKey($key)){Remove-Item -LiteralPath (Join-Path $plan.dest $key) -Force}}
  if($plan.backup){Copy-Inventory $plan.backup $plan.dest $plan.oldFiles}
  Assert-EqualInventory $plan.oldFiles (Get-Inventory $plan.dest) '失败回滚校验'
 }
 throw $failure
}
foreach($plan in $plans){
 [PSCustomObject]@{skill=$plan.name;action=$plan.action;directory=$plan.dest;commit=$commit;backup=$plan.backup;deployment='preserved; running service unchanged'}|ConvertTo-Json -Compress
}
Write-Output '技能文件已校验；未启动服务、MCP 或采集。新开 Codex 对话发现技能。技能更新不会升级已绑定运行目录。'
