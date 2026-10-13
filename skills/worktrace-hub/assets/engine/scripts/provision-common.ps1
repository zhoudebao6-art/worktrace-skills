$ErrorActionPreference='Stop'
function Get-WorkTraceHash([string]$Path){$s=[IO.File]::OpenRead($Path);$h=[Security.Cryptography.SHA256]::Create();try{[BitConverter]::ToString($h.ComputeHash($s)).Replace('-','').ToLowerInvariant()}finally{$s.Dispose();$h.Dispose()}}
function Assert-WorkTracePlainPath([string]$Path){
 $cursor=[IO.Path]::GetFullPath($Path)
 while($cursor){
  if((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw "拒绝链接或 junction 路径：$cursor"}
  $parent=Split-Path $cursor -Parent;if(!$parent -or $parent -eq $cursor){break};$cursor=$parent
 }
}
function Copy-WorkTraceSource([string]$Source,[string]$Destination){
 $src=[IO.Path]::GetFullPath($Source).TrimEnd('\');$dest=[IO.Path]::GetFullPath($Destination).TrimEnd('\')
 Assert-WorkTracePlainPath $src;Assert-WorkTracePlainPath $dest
 if($src -eq $dest -or $dest.StartsWith($src+'\',[StringComparison]::OrdinalIgnoreCase)){throw '部署目录不能位于源码目录内部。'}
 $manifest=Get-Content -LiteralPath (Join-Path $src 'engine-manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json
 if($manifest.format -ne 'worktrace.source/1.0'){throw '源码清单无效。'}
 foreach($row in $manifest.files){
  if([IO.Path]::IsPathRooted($row.path) -or $row.path -match '(^|[/\\])\.\.([/\\]|$)'){throw '源码路径越界。'}
  $from=Join-Path $src $row.path;$to=Join-Path $dest $row.path
  Assert-WorkTracePlainPath $from;Assert-WorkTracePlainPath $to
  if((Get-WorkTraceHash $from) -ne $row.sha256){throw "源码校验失败：$($row.path)"}
  if((Test-Path -LiteralPath $to) -and (Get-WorkTraceHash $to) -ne $row.sha256){throw "目标已有不同内容，未覆盖：$to"}
 }
 foreach($row in $manifest.files){$to=Join-Path $dest $row.path;if(!(Test-Path -LiteralPath $to)){New-Item -ItemType Directory -Path (Split-Path $to -Parent) -Force|Out-Null;Copy-Item -LiteralPath (Join-Path $src $row.path) -Destination $to};if((Get-WorkTraceHash $to) -ne $row.sha256){throw "复制后校验失败：$to"}}
 $marker=Join-Path $dest 'engine-manifest.json';if(Test-Path -LiteralPath $marker){if((Get-WorkTraceHash $marker) -ne (Get-WorkTraceHash (Join-Path $src 'engine-manifest.json'))){throw '已有不同版本源码清单，未覆盖。'}}else{Copy-Item -LiteralPath (Join-Path $src 'engine-manifest.json') -Destination $marker}
}
