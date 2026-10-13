param([Parameter(Mandatory=$true)][string]$RosterFile,[Parameter(Mandatory=$true)][string]$SourceShare,[string]$CompanyPolicyFile,[string]$HubRoot)
$ErrorActionPreference='Stop'
$skill=Split-Path $PSScriptRoot -Parent;$source=Join-Path $skill 'assets\engine'
. (Join-Path $source 'scripts\provision-common.ps1')
if(!$HubRoot){$HubRoot=(Get-Content -LiteralPath (Join-Path $skill 'deployment.json') -Raw -Encoding UTF8|ConvertFrom-Json).root}
$node=Join-Path $HubRoot 'runtime\node.exe';$cli=Join-Path $HubRoot 'src\admin-cli.mjs';$data=Join-Path $HubRoot 'data'
$status=& $node $cli --command status --role hub --dir $data|ConvertFrom-Json
if($LASTEXITCODE -ne 0 -or !$status.configured -or $status.role -ne 'hub'){throw '请先配置并启动总控。'}
$parsedRoster=Get-Content -LiteralPath $RosterFile -Raw -Encoding UTF8|ConvertFrom-Json
$roster=@($parsedRoster)
if($roster.Count -eq 0 -or $roster.Count -gt 100){throw '每次准备 1–100 台电脑。'}
$seen=@{};$paths=@{}
foreach($person in $roster){
 if(!$person.employee_id -or $person.employee_id -notmatch '^[\p{L}\p{N}_.-]{1,80}$' -or !$person.employee_name -or !$person.label -or !$person.drop_path -or $person.work_dir -notmatch '^[A-Za-z]:\\'){throw '员工清单缺少有效身份、专属接入目录或员工本机工作目录。'}
 $dest=[IO.Path]::GetFullPath($person.drop_path).TrimEnd('\')
 if($seen.ContainsKey($person.employee_id) -or $paths.ContainsKey($dest)){throw '员工编号和专属接入目录不得重复。'}
 if($dest -eq [IO.Path]::GetFullPath($SourceShare).TrimEnd('\') -or $dest.StartsWith([IO.Path]::GetFullPath($SourceShare).TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw '员工接入密钥目录不能放在公共源码共享中。'}
 foreach($prior in $paths.Keys){if($dest.StartsWith($prior+'\',[StringComparison]::OrdinalIgnoreCase) -or $prior.StartsWith($dest+'\',[StringComparison]::OrdinalIgnoreCase)){throw '员工专属接入目录不能相互包含。'}}
 if([IO.Path]::GetFullPath($SourceShare).TrimEnd('\').StartsWith($dest+'\',[StringComparison]::OrdinalIgnoreCase)){throw '公共源码目录不能位于员工密钥目录中。'}
 $seen[$person.employee_id]=$true;$paths[$dest]=$true
}
Copy-WorkTraceSource -Source $source -Destination $SourceShare
& (Join-Path $SourceShare 'scripts\Ensure-Runtime.ps1') -Root $SourceShare -Candidate $node
$result=@()
foreach($person in $roster){
 $dest=[IO.Path]::GetFullPath($person.drop_path);New-Item -ItemType Directory -Path $dest -Force|Out-Null
 $enrollment=Join-Path $dest 'enrollment.json';$spec=Join-Path $dest 'employee-request.json'
 if(Test-Path -LiteralPath $enrollment){
  $identity=Get-Content -LiteralPath $enrollment -Raw -Encoding UTF8|ConvertFrom-Json
  $registered=@($status.devices)|Where-Object {$_.device_id -eq $identity.device_id -and $_.employee_id -eq $person.employee_id -and !$_.revoked}
  if($identity.org_id -ne $status.org_id -or $identity.employee_id -ne $person.employee_id -or !$registered){throw '已有接入文件归属不符或设备已撤销，未覆盖。'}
 }else{
  if(@($status.devices|Where-Object {$_.employee_id -eq $person.employee_id -and $_.label -eq $person.label -and !$_.revoked}).Count){throw "已有同员工同电脑登记但接入文件缺失；请先核对，未重复创建设备：$($person.employee_id)"}
  @{employee_id=$person.employee_id;employee_name=$person.employee_name;label=$person.label}|ConvertTo-Json|Set-Content -LiteralPath $spec -Encoding UTF8
  & $node $cli --command enroll --role hub --dir $data --input $spec --output $enrollment|Out-Null
  if($LASTEXITCODE -ne 0){throw '设备登记失败。'}
  $identity=Get-Content -LiteralPath $enrollment -Raw -Encoding UTF8|ConvertFrom-Json
 }
 $job=@{format='worktrace.join/1.0';employee_id=$person.employee_id;device_id=$identity.device_id;engine_source=[IO.Path]::GetFullPath($SourceShare);work_dir=$person.work_dir;start_capture=($person.start_capture -eq $true);enable_logon_startup=($person.enable_logon_startup -eq $true)}
 $job|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $dest 'join.json') -Encoding UTF8
 if($CompanyPolicyFile){Copy-Item -LiteralPath $CompanyPolicyFile -Destination (Join-Path $dest 'policy.json') -Force}
 $joinScript=@'
$ErrorActionPreference='Stop'
$settings=Join-Path $PSScriptRoot 'join.json'
$job=Get-Content -LiteralPath $settings -Raw -Encoding UTF8|ConvertFrom-Json
& (Join-Path $job.engine_source 'scripts\Join-Node.ps1') -Settings $settings
'@
 $joinScript|Set-Content -LiteralPath (Join-Path $dest 'Join-WorkTrace.ps1') -Encoding UTF8
 $result+=@{employee_id=$person.employee_id;device_id=$identity.device_id;state='prepared_not_connected';entrypoint=(Join-Path $dest 'Join-WorkTrace.ps1');work_dir=$person.work_dir}
}
$result|ConvertTo-Json -Depth 5
