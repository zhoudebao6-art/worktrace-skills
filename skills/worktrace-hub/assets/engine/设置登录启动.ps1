param([switch]$Remove)
$ErrorActionPreference='Stop'
$key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$name='WorkTrace-'+([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($PSScriptRoot))).Replace('-','')).Substring(0,12)
if($Remove){Remove-ItemProperty -LiteralPath $key -Name $name -ErrorAction SilentlyContinue;Write-Output '已取消当前软件的登录启动。';return}
$value='powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $PSScriptRoot 'Start.ps1')+'" -NoBrowser'
New-ItemProperty -LiteralPath $key -Name $name -Value $value -PropertyType String -Force | Out-Null
Write-Output '已设置当前用户登录时启动。采集只会在已开启记录且符合工作时段时运行。'
