param([Parameter(Mandatory=$true)][string]$Settings,[string]$SkillsDirectory,[switch]$SkipMcp)
$ErrorActionPreference='Stop'
$source=Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'provision-common.ps1')
$settingsPath=[IO.Path]::GetFullPath($Settings);$inbox=Split-Path $settingsPath -Parent
$job=Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8|ConvertFrom-Json
if($job.format -ne 'worktrace.join/1.0' -or $job.work_dir -notmatch '^[A-Za-z]:\\' -or $job.work_dir -match '(^|\\)\.\.(\\|$)'){throw '接入配置无效，work_dir 必须为本机绝对路径。'}
if(![Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0){throw '请在员工已经登录的交互桌面会话内执行；远程服务会话不能据此证明桌面采集可用。'}
$enrollment=Join-Path $inbox 'enrollment.json';$identity=Get-Content -LiteralPath $enrollment -Raw -Encoding UTF8|ConvertFrom-Json
if($identity.employee_id -ne $job.employee_id -or $identity.device_id -ne $job.device_id){throw '登记文件与接入配置身份不一致。'}
Copy-WorkTraceSource -Source $source -Destination $job.work_dir
& (Join-Path $job.work_dir 'scripts\Ensure-Runtime.ps1') -Root $job.work_dir -Candidate (Join-Path $source 'runtime\node.exe')
$existingConfig=Join-Path $job.work_dir 'data\config.json'
if(Test-Path -LiteralPath $existingConfig){$existing=Get-Content -LiteralPath $existingConfig -Raw -Encoding UTF8|ConvertFrom-Json;if($existing.role -ne 'collector' -or $existing.device_id -ne $identity.device_id){throw '目标已有不同身份，未启动或变更。'}}
$node=Join-Path $job.work_dir 'runtime\node.exe';$cli=Join-Path $job.work_dir 'src\admin-cli.mjs';$data=Join-Path $job.work_dir 'data'
& (Join-Path $job.work_dir 'Start.ps1') -NoBrowser
$before=& $node $cli --command status --role collector --dir $data|ConvertFrom-Json
if($LASTEXITCODE -ne 0){throw '不能读取本机状态。'}
if($before.configured -and ($before.device_id -ne $identity.device_id -or $before.employee_id -ne $identity.employee_id)){throw '本机已绑定其他设备或员工，未覆盖。'}
& $node $cli --command init --role collector --dir $data --input $enrollment|Out-Null
if($LASTEXITCODE -ne 0){throw '分控初始化失败。'}
$install=@{Role='collector';SkipMcp=$SkipMcp};if($SkillsDirectory){$install.SkillsDirectory=$SkillsDirectory}
& (Join-Path $job.work_dir 'Install-Skills.ps1') @install
if(!$before.configured -and (Test-Path -LiteralPath (Join-Path $inbox 'policy.json'))){& $node $cli --command policy --role collector --dir $data --input (Join-Path $inbox 'policy.json')|Out-Null;if($LASTEXITCODE -ne 0){throw '公司策略无效。'}}
if(!$before.configured -and $job.start_capture -eq $true){$captureFile=Join-Path $data 'deployment-capture.json';' {"enabled":true}'|Set-Content -LiteralPath $captureFile -Encoding UTF8;& $node $cli --command capture --role collector --dir $data --input $captureFile|Out-Null;if($LASTEXITCODE -ne 0){throw '启动采集失败。'}}
if($job.enable_logon_startup -eq $true){& (Join-Path $job.work_dir '设置登录启动.ps1')}
& $node $cli --command sync --role collector --dir $data
if($LASTEXITCODE -ne 0){throw '本机已保存配置，但尚未同步成功；请检查总控与网络。'}
Write-Output '分控接入和身份心跳已完成。具体业务软件采样仍需实测，总控可检查 last_seen。'
