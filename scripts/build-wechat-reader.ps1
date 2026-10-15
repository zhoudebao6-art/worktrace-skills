[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [string]$CacheDirectory = 'D:\codex+\cache\worktrace-native-build',
  [switch]$IncludeFixtures
)
$ErrorActionPreference='Stop'
$env:TEMP='D:\codex+\temp';$env:TMP=$env:TEMP;$env:TMPDIR=$env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP,$CacheDirectory | Out-Null
$cache=[IO.Path]::GetFullPath($CacheDirectory)
$output=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $output){throw 'OutputDirectory must be new; never overwrite an installed reader.'}
$source=Join-Path (Split-Path $PSScriptRoot -Parent) 'native\wechat-reader'
$csc=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if(-not (Test-Path -LiteralPath $csc)){throw 'Windows x64 .NET Framework 4 compiler is required.'}
function Get-PinnedArchive([string]$Name,[string]$Url,[string]$Sha256) {
  $path=Join-Path $cache $Name
  if((Test-Path -LiteralPath $path) -and (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower() -eq $Sha256){return $path}
  $partial=$path+'.partial'
  # Resume across attempts. A failed transfer is never extracted or executed.
  for($attempt=0;$attempt -lt 8;$attempt++){
    & curl.exe --fail --location --http1.1 --connect-timeout 20 --max-time 180 --continue-at - --silent --show-error --output $partial $Url
    if($LASTEXITCODE -eq 0){break}
  }
  if(-not(Test-Path -LiteralPath $partial) -or (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLower() -ne $Sha256){throw "Pinned download failed integrity check: $Name"}
  if(Test-Path -LiteralPath $path){throw "Existing cache file has unexpected SHA256: $Name"}
  Move-Item -LiteralPath $partial -Destination $path
  return $path
}
$wcdbSha='260845053c5dedc4578570203a5ba235c3be1e74a671c2fc1aeb12c988dd5346'
$llvmSha='b9b68a4d276e16fa25802aaba458e4638f64b3884c290aaccdc2d87083b6ca35'
$wcdbZip=Get-PinnedArchive 'wcdb-2.1.16.zip' 'https://github.com/Tencent/wcdb/releases/download/v2.1.16/wcdb-2.1.16.zip' $wcdbSha
$llvmZip=Get-PinnedArchive 'llvm-mingw-20260616-ucrt-x86_64.zip' 'https://github.com/mstorsjo/llvm-mingw/releases/download/20260616/llvm-mingw-20260616-ucrt-x86_64.zip' $llvmSha
$work=Join-Path $env:TEMP ('worktrace-native-build-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work,$output | Out-Null
& tar.exe -xf $wcdbZip -C $work
if($LASTEXITCODE -ne 0){throw 'WCDB extraction failed'}
& tar.exe -xf $llvmZip -C $work
if($LASTEXITCODE -ne 0){throw 'LLVM extraction failed'}
$wcdb=Join-Path $work 'wcdb-2.1.16'
$cipher=Join-Path $wcdb 'sqlcipher'
$clang=Join-Path $work 'llvm-mingw-20260616-ucrt-x86_64\bin\x86_64-w64-mingw32-clang.exe'
$cmake=Get-Content -LiteralPath (Join-Path $cipher 'sqlcipher.cmake') -Raw
$files=[regex]::Matches($cmake,'\$\{SQLCIPHER_ROOT\}/([^\s)]+\.c)') | ForEach-Object {Join-Path $cipher $_.Groups[1].Value} | Select-Object -Unique
$defs=[regex]::Match($cmake,'set\(SQLCIPHER_COMMON_DEFS([\s\S]*?)\)').Groups[1].Value -split '\s+' | Where-Object {$_}
$arguments=@('-shared','-O2','-Wl,--no-insert-timestamp','-Wno-implicit-const-int-float-conversion','-Wno-deprecated-declarations','-Wno-implicit-function-declaration','-Wno-ignored-attributes','-o',(Join-Path $output 'worktrace-wcdb.dll'),('-I'+$cipher),('-I'+(Join-Path $cipher 'src')),('-I'+(Join-Path $cipher 'ext\fts3')),('-I'+(Join-Path $cipher 'ext\rtree')))
$arguments+=($defs|ForEach-Object {'-D'+$_})
$arguments+=@('-DSQLITE_CORE','-DOMIT_MEMLOCK','-DOMIT_MEM_SECURITY','-DSQLCIPHER_PREPROCESSED=1','-DSQLCIPHER_CRYPTO_CUSTOM','-DSQLITE_OS_WIN=1','-DSQLITE_OMIT_LOAD_EXTENSION','-DSQLITE_API=__declspec(dllexport)','-DNDEBUG')
$arguments+=$files
$arguments+=@((Join-Path $source 'crypto_cng.c'),'-lbcrypt')
& $clang @arguments
if($LASTEXITCODE -ne 0){throw 'Native codec build failed'}
function Build-Host([string]$Name,[string]$Main,[string[]]$Extra=@()) {
  & $csc /nologo /platform:x64 /target:exe /optimize+ /r:System.Web.Extensions.dll /r:System.Security.dll ('/out:'+(Join-Path $output $Name)) @Extra (Join-Path $source 'Native.cs') (Join-Path $source 'Profile.cs') (Join-Path $source $Main)
  if($LASTEXITCODE -ne 0){throw "C# host build failed: $Name"}
}
Build-Host 'worktrace-wechat-reader.exe' 'Reader.cs'
Build-Host 'worktrace-wechat-setup.exe' 'Setup.cs'
if($IncludeFixtures){Build-Host 'worktrace-native-fixture.exe' 'Fixture.cs';Build-Host 'worktrace-native-fixture-setup.exe' 'Setup.cs' @('/define:SYNTHETIC_SETUP')}
Copy-Item -LiteralPath (Join-Path $wcdb 'LICENSE') -Destination (Join-Path $output 'LICENSE-Tencent-WCDB.txt')
Copy-Item -LiteralPath (Join-Path $cipher 'LICENSE') -Destination (Join-Path $output 'LICENSE-SQLCipher.txt')
Copy-Item -LiteralPath (Join-Path $source 'THIRD-PARTY-NOTICES.md') -Destination $output
$binaryFiles=Get-ChildItem -LiteralPath $output -File | ForEach-Object {[ordered]@{path=$_.Name;size=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower()}}
$sourceFiles=Get-ChildItem -LiteralPath $source -File | ForEach-Object {[ordered]@{path=$_.Name;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower()}}
[ordered]@{format='worktrace.wechat-native-build/1.0';platform='windows-x64';wcdb_version='2.1.16';wcdb_commit='df808591b9f9a9ab42156006819c3550d5af13a3';wcdb_archive_sha256=$wcdbSha;llvm_version='20260616';llvm_archive_sha256=$llvmSha;crypto_provider='Windows CNG';fixtures=[bool]$IncludeFixtures;sources=@($sourceFiles);files=@($binaryFiles)} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $output 'build-manifest.json') -Encoding UTF8
Write-Output $output
