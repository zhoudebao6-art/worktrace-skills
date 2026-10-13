$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$info=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'data\running.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$base='http://127.0.0.1:'+$info.port
$auth=@{Authorization='Bearer '+($info.url -split '#key=')[1]}
$icon=[Windows.Forms.NotifyIcon]::new();$icon.Icon=[Drawing.SystemIcons]::Information;$icon.Text='WorkTrace';$icon.Visible=$true
$menu=[Windows.Forms.ContextMenuStrip]::new()
$open=$menu.Items.Add('打开工作记录面板');$toggle=$menu.Items.Add('开始 / 暂停工作记录');$exit=$menu.Items.Add('退出本机服务')
$open.add_Click({Start-Process $info.url})
$icon.add_DoubleClick({Start-Process $info.url})
$toggle.add_Click({try{$s=Invoke-RestMethod ($base+'/api/status') -Headers $auth -TimeoutSec 2;$body=@{enabled=(!$s.collection.enabled)}|ConvertTo-Json -Compress;Invoke-RestMethod ($base+'/api/capture') -Method Post -Headers $auth -ContentType 'application/json' -Body $body -TimeoutSec 4|Out-Null}catch{}})
$exit.add_Click({try{Invoke-RestMethod ($base+'/api/shutdown') -Method Post -Headers $auth -ContentType 'application/json' -Body '{}' -TimeoutSec 3|Out-Null}catch{};[Windows.Forms.Application]::Exit()})
$icon.ContextMenuStrip=$menu
$timer=[Windows.Forms.Timer]::new();$timer.Interval=5000
$timer.add_Tick({try{$s=Invoke-RestMethod ($base+'/api/status') -Headers $auth -TimeoutSec 2;$label=if($s.role -eq 'hub'){'WorkTrace - 公司汇总端'}else{'WorkTrace - '+$s.collection.state};$icon.Text=$label.Substring(0,[Math]::Min(63,$label.Length));$toggle.Enabled=($s.role -eq 'collector')}catch{[Windows.Forms.Application]::Exit()}})
$timer.Start()
try{[Windows.Forms.Application]::Run()}finally{$timer.Stop();$timer.Dispose();$icon.Visible=$false;$icon.Dispose();$menu.Dispose()}
