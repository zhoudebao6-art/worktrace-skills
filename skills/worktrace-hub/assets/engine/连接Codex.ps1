$ErrorActionPreference='Stop'
$node=Join-Path $PSScriptRoot 'runtime\node.exe'
if(!(Test-Path -LiteralPath $node)){$node=(Get-Command node.exe -ErrorAction Stop).Source}
$codex=Get-Command codex.exe,codex.cmd,codex -ErrorAction SilentlyContinue | Select-Object -First 1
if(!$codex){throw '请先安装并登录 Codex，并确保命令行 codex 可用。'}
$raw=& $codex.Source mcp list --json
if($LASTEXITCODE -ne 0){throw '无法读取已有 MCP 配置，未修改。'}
$parsed=$raw|ConvertFrom-Json
$existing=@($parsed)|Where-Object {$_.name -eq 'worktrace'}|Select-Object -First 1
if($existing){
 $expected=Join-Path $PSScriptRoot 'src\mcp.mjs'
 if($existing.transport.command -ne $node -or !(@($existing.transport.args) -contains $expected)){throw '已有不同来源的 worktrace MCP，未覆盖。'}
 if(!$existing.enabled){throw '已有 worktrace MCP 被禁用，请在 Codex 设置中检查。'}
 Write-Output 'WorkTrace MCP already registered.';return
}
& $codex.Source mcp add worktrace -- $node (Join-Path $PSScriptRoot 'src\mcp.mjs') --data (Join-Path $PSScriptRoot 'data')
if($LASTEXITCODE -ne 0){throw 'MCP 登记失败，请查看上方 Codex 输出。'}
Write-Output 'WorkTrace MCP 已登记。重新打开 Codex 对话后可使用；工作记录程序需先启动。'
