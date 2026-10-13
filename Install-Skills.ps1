param([Parameter(Mandatory=$true)][ValidateSet('hub','collector')][string]$Role,[string]$SkillsDirectory,[switch]$SkipMcp)
$ErrorActionPreference='Stop'
function Get-SkillHash([string]$Path){$stream=[IO.File]::OpenRead($Path);$sha=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose();$sha.Dispose()}}
function Test-SharedSkillSource([string]$Source,[string]$Destination,[string]$Name,[string]$ExpectedRole){
 $receiptPath=Join-Path $Destination '.worktrace-install.json'
 if(!(Test-Path -LiteralPath $receiptPath -PathType Leaf)){return $false}
 $receipt=Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
 if($receipt.format -ne 'worktrace.skill-install/1.0' -or $receipt.skill -ne $Name -or $receipt.role -ne $ExpectedRole -or $receipt.repository -ne 'https://github.com/zhoudebao6-art/worktrace-skills' -or $receipt.commit -notmatch '^[a-f0-9]{40}$'){throw '共享技能来源收据无效，未绑定部署。'}
 if((Get-Item -LiteralPath $Destination).Attributes -band [IO.FileAttributes]::ReparsePoint){throw '共享技能目录是链接，未绑定部署。'}
 $sourceFiles=@(Get-ChildItem -LiteralPath $Source -File -Recurse)
 if(@($receipt.files).Count -ne $sourceFiles.Count){throw '共享技能文件清单与部署源码不同，请先检查版本。'}
 $recorded=@{}
 foreach($entry in $receipt.files){
  if([IO.Path]::IsPathRooted($entry.path) -or $entry.path -match '(^|[/\\])\.\.([/\\]|$)' -or $recorded.ContainsKey([string]$entry.path) -or $entry.sha256 -notmatch '^[a-f0-9]{64}$'){throw '共享技能文件清单无效。'}
  $recorded[[string]$entry.path]=$entry
 }
 foreach($file in $sourceFiles){
  $rel=$file.FullName.Substring($Source.Length+1).Replace('\','/');$entry=$recorded[$rel];$installed=Join-Path $Destination $rel
  if(!$entry -or !(Test-Path -LiteralPath $installed -PathType Leaf) -or $entry.size -ne $file.Length -or (Get-SkillHash $file.FullName).ToLowerInvariant() -ne $entry.sha256 -or (Get-SkillHash $installed).ToLowerInvariant() -ne $entry.sha256){throw '共享技能已修改或与接入版本不同，未覆盖或绑定。'}
 }
 return $true
}
if(!$SkillsDirectory){$SkillsDirectory=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.agents\skills'}
$destRoot=[IO.Path]::GetFullPath($SkillsDirectory)
New-Item -ItemType Directory -Path $destRoot -Force|Out-Null
$names=if($Role -eq 'hub'){@('worktrace-hub')}else{@('worktrace-collector','worktrace-evidence','worktrace-personal')}
foreach($name in $names){
 $source=Join-Path $PSScriptRoot ('skills\'+$name);$dest=Join-Path $destRoot $name
 if(Test-Path -LiteralPath $dest){
  $bindingPath=Join-Path $dest 'deployment.json'
  if(!(Test-Path -LiteralPath $bindingPath)){
   if(!(Test-SharedSkillSource $source $dest $name $Role)){throw "已有同名技能 $dest，未覆盖。"}
   @{root=$PSScriptRoot;role=$Role;version='0.2.1'}|ConvertTo-Json|Set-Content -LiteralPath $bindingPath -Encoding UTF8
  }
  $old=Get-Content -LiteralPath $bindingPath -Raw -Encoding UTF8|ConvertFrom-Json
  if($old.root -ne $PSScriptRoot -or $old.role -ne $Role){throw "已有不同来源技能 $dest，未覆盖。"}
  foreach($file in Get-ChildItem -LiteralPath $source -File -Recurse){$rel=$file.FullName.Substring($source.Length+1);$target=Join-Path $dest $rel;if(!(Test-Path -LiteralPath $target) -or (Get-SkillHash $file.FullName) -ne (Get-SkillHash $target)){throw "技能内容已有差异，请保留原版后另行升级：$dest"}}
 }else{
  Copy-Item -LiteralPath $source -Destination $dest -Recurse
  @{root=$PSScriptRoot;role=$Role;version='0.2.1'}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $dest 'deployment.json') -Encoding UTF8
 }
 Write-Output "Skill installed: $dest"
}
if(!$SkipMcp){& (Join-Path $PSScriptRoot '连接Codex.ps1')}
Write-Output 'Skill 文件已安装；如当前对话未发现新技能，请新开 Codex 对话。此操作没有开启采集。'
