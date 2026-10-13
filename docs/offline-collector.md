# 无总控的离线分控部署

v0.4.0 提供正式离线分控入口，不需要员工电脑修改源码。这里“离线”指尚未连接公司总控；本地记录与数据库不依赖总控，Codex 学习仍需该电脑自己的账号、可用额度和模型网络。当前电脑必须是被指定的员工电脑，不能把开发电脑当总控或员工机。

## 1. 一次核对身份与范围

集中取得公司名称、员工唯一编号/显示名、电脑标签、实际工作时间、允许记录的应用与资料目录。缺少目录时保持文件取证关闭，不扫描整盘。公司已统一告知时沿用部署授权，日常不要求员工逐条解释。

每名员工固定一台电脑。首次若没有 org_id，程序生成并保存公司编号；多台属于同一公司的离线节点应使用同一个 org_id。可把第一台的公司编号填入其他节点身份文件，但不能复制第一台的 data、device_id、installation_id 或 stream_id。编号相同不代表未来总控已经接纳。

建议把源码、运行数据和交接成果分开：

| 用途 | 本文示例 |
|---|---|
| 完整发布源码 | D:\WorkTraceChemSource |
| 运行程序与 data | D:\WorkTraceChem |
| 本机身份/策略文件 | D:\WorkTraceChemAdmin |
| 加密交接成果 | D:\WorkTraceChemHandoff |

没有 D 盘时选择实际可用磁盘；缓存回落到运行目录的 runtime-temp/runtime-cache。不要把数据库放进技能、下载缓存或 Git 仓库。

## 2. 下载并部署

从公开的 [v0.4.0 Release](https://github.com/zhoudebao6-art/worktrace-skills/releases/tag/v0.4.0) 下载专用 `worktrace-skills-v0.4.0.zip` 与 `SHA256SUMS.txt`，无需 GitHub 登录。也可由公司转发同一原包。GitHub 自动生成的 Source code ZIP 没有完整发布清单，不能代替专用资产。

例如在一个新下载目录执行：

```powershell
$release = 'https://github.com/zhoudebao6-art/worktrace-skills/releases/download/v0.4.0'
curl.exe -L --fail "$release/worktrace-skills-v0.4.0.zip" -o '.\worktrace-skills-v0.4.0.zip'
if ($LASTEXITCODE -ne 0) { throw 'ZIP 下载失败。' }
curl.exe -L --fail "$release/SHA256SUMS.txt" -o '.\SHA256SUMS.txt'
if ($LASTEXITCODE -ne 0) { throw '校验文件下载失败。' }
$rows = @(Get-Content -LiteralPath '.\SHA256SUMS.txt' | Where-Object { $_ -match '^[a-fA-F0-9]{64}\s+\*?worktrace-skills-v0\.4\.0\.zip$' })
if ($rows.Count -ne 1) { throw '未找到唯一的发布 ZIP 校验项。' }
$stream = [IO.File]::OpenRead((Join-Path (Get-Location) 'worktrace-skills-v0.4.0.zip'))
$sha = [Security.Cryptography.SHA256]::Create()
try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
finally { $stream.Dispose(); $sha.Dispose() }
if ($actual -ne ($rows[0] -split '\s+')[0].ToLowerInvariant()) { throw 'ZIP 校验失败。' }
if (Test-Path -LiteralPath 'D:\WorkTraceChemSource') { throw '源码目录已存在，请检查或选新目录。' }
Expand-Archive -LiteralPath '.\worktrace-skills-v0.4.0.zip' -DestinationPath 'D:\WorkTraceChemSource'
```

解压后根目录应直接含 scripts、skills、.worktrace-source.json。阅读 AGENTS.md，再在 `D:\WorkTraceChemAdmin\identity.json` 保存以下 JSON，将所有示例内容换成真实值；已有公司编号时增加 org_id：

```json
{
  "format": "worktrace.offline-identity/1.0",
  "org_name": "替换真实公司名称",
  "employee_id": "CHEM001",
  "employee_name": "替换员工显示名",
  "label": "替换本机电脑标签"
}
```

在员工已登录的 Windows 交互会话执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File 'D:\WorkTraceChemSource\scripts\Initialize-OfflineNode.ps1' -IdentityFile 'D:\WorkTraceChemAdmin\identity.json' -WorkDir 'D:\WorkTraceChem'
if ($LASTEXITCODE -ne 0) { throw '离线部署未完成。' }
```

脚本校验发布文件与引擎清单、准备固定 SHA256 的 Node、初始化 collector/offline、安装本账号的 collector/personal/evidence 三个技能并注册 worktrace MCP。首次采集与自动学习均未启用。不会配置总控、生成证书或尝试远程同步。重复执行同一命令沿用原身份与暂停状态，身份不符、未知同名技能、不同源码或其他 MCP 绑定会报错并保留原配置。

新开 Codex 对话验证三个技能和 worktrace_status。首次下载 Node 需要网络；“无需总控”不等于首次安装完全无需互联网。登录启动可在核验本机目录后用部署目录的 `设置登录启动.ps1` 设置；也可首次传 `-EnableLogonStartup`。注销、关机或睡眠期间不能继续观察员工桌面，不自行修改电源策略。

## 3. 核对范围后启用记录

本地状态应为 role=collector、connection_mode=offline，员工/设备正确，尚未连接总控。初始策略为工作日 09:00–18:00、15 秒活动采样、正文与截图关闭。按实际时段和进程配置采集；只记录窗口标题无法复现客户回复与化学判断。可从 status 取得完整 policy，按[采集策略说明](../skills/worktrace-collector/references/operations.md)修改后用 admin 的 policy 命令提交。

文件取证另用完整 JSON 策略。离线单文件上限 20 MiB，联网模式上限 4 MiB；下面是离线示例，roots 必须换成明确允许的业务目录：

```json
{
  "enabled": true,
  "roots": ["D:\\替换为已允许的业务资料目录"],
  "extensions": [".docx", ".xlsx", ".pdf", ".txt", ".md", ".csv"],
  "interval_seconds": 60,
  "max_file_bytes": 20971520,
  "max_files_per_scan": 2000,
  "max_versions_per_scan": 10
}
```

保存为 `D:\WorkTraceChemAdmin\file-policy.json` 后：

```powershell
$node = 'D:\WorkTraceChem\runtime\node.exe'
$cli = 'D:\WorkTraceChem\src\admin-cli.mjs'
$data = 'D:\WorkTraceChem\data'
& $node $cli --command files-configure --role collector --dir $data --input 'D:\WorkTraceChemAdmin\file-policy.json'
if ($LASTEXITCODE -ne 0) { throw '文件范围配置失败。' }
```

确认范围后再通过托盘/本机面板恢复采集；或把 `{"enabled":true}` 写入本地 JSON，使用 admin 的 `--command capture --input <文件>`。文件取证服从同一采集开关与工作时段；手动 `files-scan` 也不能越过这些条件。首次扫描只记录候选稳定性，至少间隔配置时长再次扫描后才保存稳定版本。修改原文件后需再次稳定；不要把扫描返回成功当作已保存版本。

保存版本包含 document.version 事件、原件哈希和数据库内原件。当前解析支持 UTF-8/UTF-16LE 文本、DOCX 正文与表中文字、XLSX 坐标原始值/公式缓存。PDF 保留原件但没有正文解析；化学结构图、公式图、Word 修订/批注等需标注缺口。解析文字不能证明结构式、配比或实验结论已核实。每个已保存版本应能从个人证据批次定位，不能只检查外部文件夹存在。

需要复核原件时，把 `{"event_id":"实际 document.version 的 UUID"}` 写为本地请求 JSON，通过 `admin-cli.mjs --command file-extract --role collector --dir <data> --input <请求.json> --output <新的审阅文件>` 导出；不覆盖工作原件。导出只是提取已存版本，不代表程序已理解其中结构式或公式。

## 4. 本地夜间学习

完成合成验证与一段允许的实际样本核验后，在本机配置：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File 'D:\WorkTraceChem\scripts\Configure-Learning.ps1' -DataDir 'D:\WorkTraceChem\data' -Action Enable -MaxCallsPerDay 6 -Start '18:00' -End '23:59'
```

采用本机 Codex 登录、gpt-6.1-sol/high，不共享账号。时间按真实下班时间调整；模型不可用时报告个人自动学习尚未验收，不静默换模型。本地服务创建每日幂等的 personal.summarize 任务，最多三批，消费新增原始证据并保存 learning.summary。无总控任务也应能运行；必须验收队列、回执与实际总结，不能只看开关。

离线任务与总控任务分开，不上传本地任务回执，也不能给本地任务伪造“回复总控”。暂停、超时、重启和日预算受执行器控制；无新证据结束，失败不无限重试。手动复盘先暂停学习并等 busy=false，保留原采集状态。纯窗口元数据只能得到 metadata_only，总结不升级为“已经学会岗位”。

按 [夜间学习手册](nightly-loop.md)查看暂停、恢复与用量。化工岗位重点记录真实出现的输入、动作、判断、核验、改稿、例外和结果；理由未见则 unknown，推断则 inferred，不能补造实验或检索结论。

个人总结保存后会重建 `data/daily-reports` 下的可读日总结，也可手动执行 `admin-cli.mjs --command personal-digest --role collector --dir <data>`。日报按总结保存日组织，可能包含此前积压的工作，不能等同于该日全部实际操作。它是数据库总结的派生视图，保留来源和未知项，不能作为新的独立证据反复学习。

## 5. 数日后移交与恢复

从部署目录运行正式离线交接入口，密码在本机提示中输入，不写进命令、聊天或包内。输出路径必须新建：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File 'D:\WorkTraceChem\scripts\Offline-Handoff.ps1' -Action Export -DataDir 'D:\WorkTraceChem\data' -Output 'D:\WorkTraceChemHandoff\CHEM001-pilot.wthandoff' -FinishPilot
```

结束试点用 -FinishPilot 保持暂停；中途交接不传此开关，恢复行为以脚本回执为准。导出前检查活动任务结束及记录状态，只有一致备份或已确认服务退出的冷备才算完整；普通 wpack 不包含全部未完成队列、游标和运行状态。不要直接拷运行中的主 SQLite 文件或删除 WAL/SHM。

检查与解包审阅：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File 'D:\WorkTraceChem\scripts\Offline-Handoff.ps1' -Action Inspect -Input 'D:\WorkTraceChemHandoff\CHEM001-pilot.wthandoff'
powershell -NoProfile -ExecutionPolicy Bypass -File 'D:\WorkTraceChem\scripts\Offline-Handoff.ps1' -Action Restore -Input 'D:\WorkTraceChemHandoff\CHEM001-pilot.wthandoff' -Destination 'D:\WorkTraceChemReview-new'
```

Restore 目标必须全新，它只用于审阅，不能作为活跃分控启动。原主机需要恢复时，使用 `-Action Recover -Input <包> -Destination <全新目录>`；恢复默认暂停，不允许跨主机继续原身份。不要把“可以解密审阅”等同于“可以接着采集”。

未来总控先 Inspect 核对公司/设备清单，按[总控离线接收步骤](../skills/worktrace-hub/references/offline-handoff.md)接纳身份，再 Import；不能给新总控随机换 org_id 后强行合并，也不能覆盖总控原库。接收的总控在另一台真实设备，开发测试接收目录不是正式总控。本版事件规范为 1.2，汇总 bundle 为 1.1，完整交接格式为 1.0，接收端须支持对应版本。

加密包不等于已被接收。保留原机数据直至事件、附件、文件版本、总结引用、未完成状态和校验清单均核对完成；不上传员工资料或包到 GitHub。详细交接能力与边界以同版脚本说明和回执为准。

## 6. 验证范围与更新

维护者可运行 `powershell -NoProfile -ExecutionPolicy Bypass -File tests/offline-provision.verify.ps1`。该测试使用隔离目录、合成身份和当前源码构造的测试发布目录，检验免 Git 初始化、重复身份/stream 不变、默认暂停、三个技能绑定、冲突与篡改拒绝，并关闭自建服务；跳过 MCP 注册，不捕获桌面、不调用真实模型。它不能替代真实员工电脑上的 MCP、正文读取、指定模型与交接业务验收。

更新技能不等于更新运行服务。已有生产目录不覆盖；保留完整 data 和绑定，在新源码目录核验新版本，再按迁移安排切换服务。离线转联网也不是重新初始化，须先明确总控接纳与身份迁移，不能用 enrollment 覆盖现有离线身份。

给员工电脑 Codex 的直接入口：

> 读取并按 https://raw.githubusercontent.com/zhoudebao6-art/worktrace-skills/v0.4.0/prompts/chemical-offline-collector.txt 部署本机独立离线分控。仅使用该公开发布的 v0.4.0 专用包，先核验身份、范围和已有部署；不要把本机当总控。
