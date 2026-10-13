param([Parameter(Mandatory=$true)][ValidateSet('hub','collector')][string]$Role,[string]$SkillsDirectory,[switch]$SkipMcp)
$ErrorActionPreference='Stop'
function Get-SkillHash([string]$Path){$stream=[IO.File]::OpenRead($Path);$sha=[Security.Cryptography.SHA256]::Create();try{[BitConverter]::ToString($sha.ComputeHash($stream))}finally{$stream.Dispose();$sha.Dispose()}}
if(!$SkillsDirectory){$SkillsDirectory=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.agents\skills'}
$destRoot=[IO.Path]::GetFullPath($SkillsDirectory)
New-Item -ItemType Directory -Path $destRoot -Force|Out-Null
$names=if($Role -eq 'hub'){@('worktrace-hub')}else{@('worktrace-collector','worktrace-evidence','worktrace-personal')}
foreach($name in $names){
 $source=Join-Path $PSScriptRoot ('skills\'+$name);$dest=Join-Path $destRoot $name
 if(Test-Path -LiteralPath $dest){
  $bindingPath=Join-Path $dest 'deployment.json'
  if(!(Test-Path -LiteralPath $bindingPath)){throw "已有同名技能 $dest，未覆盖。"}
  $old=Get-Content -LiteralPath $bindingPath -Raw -Encoding UTF8|ConvertFrom-Json
  if($old.root -ne $PSScriptRoot -or $old.role -ne $Role){throw "已有不同来源技能 $dest，未覆盖。"}
  foreach($file in Get-ChildItem -LiteralPath $source -File -Recurse){$rel=$file.FullName.Substring($source.Length+1);$target=Join-Path $dest $rel;if(!(Test-Path -LiteralPath $target) -or (Get-SkillHash $file.FullName) -ne (Get-SkillHash $target)){throw "技能内容已有差异，请保留原版后另行升级：$dest"}}
 }else{
  Copy-Item -LiteralPath $source -Destination $dest -Recurse
  @{root=$PSScriptRoot;role=$Role;version='0.2.0'}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $dest 'deployment.json') -Encoding UTF8
 }
 Write-Output "Skill installed: $dest"
}
if(!$SkipMcp){& (Join-Path $PSScriptRoot '连接Codex.ps1')}
Write-Output 'Skill 文件已安装；如当前对话未发现新技能，请新开 Codex 对话。此操作没有开启采集。'
