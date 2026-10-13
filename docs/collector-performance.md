# 分控性能诊断与 v0.4.1 升级

适用于已经部署的 v0.4.0 分控。先量化卡顿，再把原运行目录中的服务程序升级；只更新 Skill 不会让旧服务自动变快。以下路径都是目标员工电脑的路径，当前开发电脑不是生产总控，也不能替代员工电脑实测。

本次不改变采集范围、工作时段、模型或推理强度。总控保持 `gpt-6-astra/high`，分控保持 `gpt-6.1-sol/high`。程序性能改进不证明已经完整理解员工工作，更不等于岗位替代已验收。

## 1. 先做 20 秒只读诊断

从[公开 v0.4.1 Release](https://github.com/zhoudebao6-art/worktrace-skills/releases/tag/v0.4.1)下载专用 `worktrace-skills-v0.4.1.zip` 与 `SHA256SUMS.txt`，按[下载手册](download.md)核对 ZIP，并解压到独立新目录。核验 `.worktrace-source.json` 中每个文件的 SHA256、长度及安全相对路径，版本应为 `0.4.1`；GitHub 自动生成的 Source code ZIP 不适用。不要覆盖现有运行目录，也不要先运行初始化脚本。

从已安装 `worktrace-collector/deployment.json` 找到原运行目录，核对 `role=collector`；三个技能的绑定应指向同一目录。例如原运行目录是 `D:\WorkTraceNode`，新包在 `D:\WorkTraceSource-v0.4.1`，则执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File 'D:\WorkTraceSource-v0.4.1\scripts\Measure-CollectorPerformance.ps1' -DataDir 'D:\WorkTraceNode\data' -DurationSeconds 20 -Output 'D:\WorkTraceReports\before-v0.4.1.json'
```

输出路径必须不存在。脚本不启动或停止服务，不改变采集、学习或进程优先级；发现服务 PID 与该运行目录不匹配会在调用接口前停止。默认 20 秒，允许 10–60 秒。它先调用一次轻量状态接口；仅当返回 404，或旧版的特定 400 JSON 错误“不支持的请求”时，退回一次完整状态。授权失败等其他 400 不退回。随后只采样进程计数器，不反复查询数据库。

报告包含本服务及直属、路径已核验的 observer/parser 的 CPU、内存、进程 I/O，以及版本、开关、数据库文件大小和可用的策略规模。它不包含员工姓名、消息正文、文件路径、窗口标题、命令行或本机接口密钥。不要把另行保存的完整 status、config 或 running.json 当作这个脱敏报告上传。

阅读指标时注意：

- CPU 以一个逻辑核心为 100%，不是整机 CPU 百分比；进程 I/O 包括非磁盘 I/O，不能直接等同物理磁盘吞吐。
- 两秒一次的进程采样可能漏掉短命解析器；没有 parser 行不证明没有解析发生。
- 旧版完整状态自身可能昂贵，`api_probe_ms` 单独记录；新版 brief 不扫描历史计数。策略快照可能滞后，报告会标注来源。
- UIA/PrintWindow 也可能让被观察的 Word、WPS、微信进程执行代码或等待。WorkTrace 自身 CPU 低，不能单独证明用户没有卡顿。本脚本不扩大到其他进程或采集正文。

升级后在相同应用、相近数据和操作下再运行一次，使用新的输出名。若仍是特定应用卡顿，可在用户授权下做一次短时“暂停记录—相同操作—恢复原状态”的对照；原来暂停就继续暂停。不要靠更换便宜模型、降低推理强度或静默缩小采集范围冒充代码优化。

## 2. 本版改进与测量边界

v0.4.1 为托盘提供不做历史统计的 brief 状态接口，减少重复学习统计，为常用查询增加覆盖索引；文件巡检分批让出事件循环，对已确认未变的文件复用指纹，并保留周期复核。实际采集路径仍需在员工使用的软件版本上验收。

下面是开发电脑、Node 22.23.2、隔离 SQLite、合成身份与证据的热缓存测量，不是员工设备的性能承诺。数据库组采用 10 万条事件、约每千条一份总结、大多数原始事件已归入总结；旧版五次、优化后七次取中位数。没有真实模型或桌面采集。

| 合成检查 | v0.4.0 | 优化后 | 含义 |
| --- | ---: | ---: | --- |
| 完整状态链（不含文件统计） | 924.77 ms | 191.18 ms | 索引与消除重复统计；仍随历史增长 |
| 未归入总结的证据计数 | 196.21 ms | 82.14 ms | 覆盖索引减少大正文表读取；不是常数时间 |
| worker 状态 | 558.46 ms | 90.29 ms | 避免重复完整学习统计 |
| 24 个已稳定、各 1 MiB 原件的一轮巡检 | 186.11–200.57 ms | 14.16–16.24 ms | 旧版每轮读 24 MiB；新版热缓存本轮读 0 字节 |
| 同轮巡检中的 1 ms 计时器延迟 | 186.18–200.90 ms | 0.61–0.91 ms | 新版巡检允许其他请求继续处理 |

文件组前后都保存 24 条版本事件；首次读取和每六小时复核仍读取内容，文件修改后也要重新读取。计时受本机负载、缓存与文件系统影响。历史完整状态和深度总结仍有成本，所以不能用这些数字宣称所有卡顿已消除。

## 3. 在原路径安全升级

这是交给目标电脑 Codex 执行的维护流程，不是“一键覆盖”安装器。版本路径示例须先替换成该电脑核实的实际路径。需要读取状态和完整冷备数据的步骤在本机完成，不能把内容贴回对话或公开仓库。

### A. 核对来源、身份和正在运行的进程

1. 记录新包根目录 `$source`、原运行目录 `$runtime`、原技能目录 `$skills`。原绑定、MCP 的 `--data` 参数、登录启动路径应一致；有多个部署时只维护用户指定的一套。
2. 新引擎位于 `$source\skills\worktrace-hub\assets\engine`。核验新包下载清单及其中的 `engine-manifest.json` 全部文件；原 `$runtime\engine-manifest.json` 必须是可核对的旧版清单，逐项核验旧受管文件没有本地修改。禁止链接、越界路径、大小写碰撞或新文件覆盖未知本地文件。
3. 核验已装三个技能与旧引擎的对应技能源一致。没有共享安装收据的部署绑定技能是正常旧安装方式；只允许明确绑定本运行目录且文件逐项匹配的情况。若有未知同名技能、人工改动或来源无法确定，保留现场、报告差异并停止本次升级，不伪造收据。
4. 从 `data/running.json` 取得 PID、端口，在本机核验可执行文件为 `$runtime\runtime\node.exe`、命令行指向 `$runtime\src\server.mjs`，并记录创建时间。托盘用 `data/tray.pid` 加 `$runtime\Tray.ps1` 核验。PID 单独不能证明归属。
5. 将一次完整 status 和原 config 保存在仅本机可访问的维护记录中：身份包括 org_id、employee_id、device_id、installation_id，数据库 meta 中另取 stream_id；记录 connection_mode、采集策略、文件策略、学习完整策略、原采集开关、MCP 与登录启动路径。不要输出本机密钥。

### B. 空闲时暂停并完整冷备

正在执行的模型任务先有界等待完成；仍忙则停止升级，保留现场，不强制结束来绕过检查。记住原状态后，用完整原学习策略仅将 `paused` 改为 `true`，写入本机 `worker-paused.json`；另写 `capture-paused.json` 内容为 `{"enabled":false}`。使用原服务的正式管理入口：

```powershell
# 变量必须来自 A 中核验的实际路径；维护文件放在独立、本机受限目录。
& "$runtime\runtime\node.exe" "$runtime\src\admin-cli.mjs" --command worker-configure --role collector --dir "$runtime\data" --input "$maintenance\worker-paused.json"
if ($LASTEXITCODE -ne 0) { throw '暂停学习失败，停止升级。' }
& "$runtime\runtime\node.exe" "$runtime\src\admin-cli.mjs" --command capture --role collector --dir "$runtime\data" --input "$maintenance\capture-paused.json"
if ($LASTEXITCODE -ne 0) { throw '暂停记录失败，停止升级。' }
```

确认学习和文件扫描均 idle，observer/parser 已退出再停服务。新版可查 brief；旧版最多每五秒一次完整状态、有界等待，不做一秒多次轮询。暂停过程中如已有任务被取消，保留失败检查点，之后必须明确重试，不因联网恢复自动重跑模型。

```powershell
& "$runtime\runtime\node.exe" "$runtime\src\admin-cli.mjs" --command shutdown --role collector --dir "$runtime\data"
if ($LASTEXITCODE -ne 0) { throw '正常退出请求失败，未替换程序。' }
```

确认先前核验的服务、托盘和采集子进程均已退出；旧托盘通常下一轮轮询自行退出。未退出则暂不覆盖。禁止 `taskkill /IM node.exe` 等按名称结束所有进程。维护期间不要再用旧面板或其他 Codex 任务启动本部署。

在运行目录之外创建一个此前不存在的持久备份目录，例如 `D:\WorkTraceBackups\before-v0.4.1-<时间>`。备份整个旧运行目录（包括完整 `data`、配置、凭据、SQLite 及存在的 WAL/SHM、原件、旧程序和运行时）和三个已装技能；可排除明确的 `runtime-temp/runtime-cache`，不得把数据库或登录资料当缓存。MCP/登录启动配置只保存对应本部署的记录，不复制或公开整个 Codex 凭据目录。

复制前检查实际路径及链接，按原相对路径复制，逐文件流式 SHA256 和长度核对备份；不得覆盖已有备份。可用 .NET SHA256，避免依赖某个 PowerShell 模块。冷备核验通过前不得修改程序。备份留在用户选定的非系统盘，不放进会清理的临时缓存。

### C. 只替换已核验的受管程序与技能

以新旧引擎清单做差异计划。对旧清单列出的、已核验无改动的程序文件，用新引擎中对应的文件替换；新增文件先确认目标不存在。旧版独有受管文件先已备份，按逐文件清单移出运行源目录，不能整目录递归删除。保护 `data`、运行时 node.exe、身份、部署绑定、MCP 路径、登录启动及未知附加配置。新 `engine-manifest.json` 最后写入，再完整核验新程序。不要调用 `Initialize-OfflineNode.ps1`、Join 或 bootstrap 进行覆盖升级。

三技能按来源分别处理：

- 全部来自 `Install-SharedSkills` 且都有正确收据时，从**新包根目录**运行下列命令；安装器先检查旧受管文件、备份并保留 `deployment.json`。不要从已部署引擎目录执行该共享安装器。
- 旧部署直接安装、没有收据时，必须先完成 A 的绑定与文件对照，再按新旧技能源清单更新这三个目录的受管文件，保留 `deployment.json` 和不冲突的本地附加配置；新版新增文件与本地文件冲突即停止。不要删除目录重装，也不要补造 `.worktrace-install.json`。
- 混合来源或本地修改先停在备份和差异报告，不强行套一条通用命令。

```powershell
# 仅适用于三个技能均有正确共享安装收据的情况。
powershell -NoProfile -ExecutionPolicy Bypass -File "$source\scripts\Install-SharedSkills.ps1" -Role collector -SkillsDirectory "$skills" -Update
if ($LASTEXITCODE -ne 0) { throw '技能更新失败，按备份回退，不启动混合版本。' }

# 两种受管安装方式在文件更新核验后，都从原运行目录校正绑定版本。
powershell -NoProfile -ExecutionPolicy Bypass -File "$runtime\Install-Skills.ps1" -Role collector -SkillsDirectory "$skills" -SkipMcp
if ($LASTEXITCODE -ne 0) { throw '绑定校验失败，按备份回退。' }
```

`-SkipMcp` 是为了保留已有 MCP 配置，不代表不需要验证 MCP。已有 MCP 子进程可能还缓存旧模块；验收服务后，通过 Codex 的重新连接/新会话重新加载此 WorkTrace MCP，确认工具版本。不要改其他 MCP 或结束整台电脑的 Codex。

### D. 启动、核验，再恢复原状态

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$runtime\Start.ps1" -NoBrowser
if ($LASTEXITCODE -ne 0) { throw '新版启动失败，执行下述回退。' }
& "$runtime\runtime\node.exe" "$runtime\src\admin-cli.mjs" --command status --role collector --dir "$runtime\data"
if ($LASTEXITCODE -ne 0) { throw '新版状态读取失败，执行下述回退。' }
```

将完整状态保存在本机维护记录中。验收必须同时满足：

1. 新 PID 的可执行路径、命令行、创建时间吻合；运行 API 返回 `version=0.4.1`，新 brief 接口可用，磁盘引擎清单和三个技能 `deployment.json.version` 同为 `0.4.1`。只看到 Skill 新文字不算服务升级。
2. org_id、employee_id、device_id、installation_id、stream_id 与原记录逐一一致；connection_mode、采集/文件/学习策略以及 MCP/登录启动路径未被替换。验收时记录和学习继续暂停。
3. 以**停机冷备时**数据库中的原事件集合为基准，对照事件 event_id、hash、org/device/employee、stream_id、sequence 及原 JSON 摘要，原事件均保留且相同；对 assets 和 file_versions 的原记录核对 SHA256、长度与实际 BLOB 摘要。只在本机流式核对，不导出正文。可用 Node 内置 `node:sqlite` 的只读连接进行核验，不用 Store 构造器打开备份导致迁移。
4. 新索引会改变 SQLite 文件字节，所以不要求升级后整个 SQLite 文件 SHA 与旧文件相同。暂停、恢复可能合法增加 collector 事件；要求原事件前缀完整，不用不加区分的总条数判断丢失或篡改。
5. MCP 重连及已授权的少量业务样本检查单独记录结果；不为“验收”自动打开客户微信、发送消息或调用模型。开发合成测试不能替代员工软件实测。

上述通过后，若升级任务已授权继续原记录，才恢复保存的原采集开关和完整原学习策略；原来暂停就保留暂停。记录迁移后诊断报告、版本、身份一致性、原证据验证及未完成边界。离线仍离线，不新增总控或同步目标。

### E. 失败回退

启动或证据核验失败时保持暂停，正常关闭并确认**本次升级的**服务和托盘退出；先把失败现场完整保留到另一新目录，再从已核验冷备恢复旧程序、data 和三技能，核对后仅启动一套旧部署。不要同时运行两个同身份副本，也不要用旧备份覆盖失败后新增的数据而不留副本。

冷备是在暂停后取得的，回退启动默认仍暂停；保留维护前原状态记录，待问题明确后按授权恢复。无法证明进程归属、备份完整或身份一致时，停在明确错误，不继续覆盖。

## 4. 直接交给员工电脑 Codex

复制[升级指令](../prompts/upgrade-collector-performance.txt)全文，或发送：

> 请读取 https://raw.githubusercontent.com/zhoudebao6-art/worktrace-skills/v0.4.1/prompts/upgrade-collector-performance.txt ，先核实这台电脑原有 WorkTrace 分控绑定，按其中固定 v0.4.1 发布包与步骤完成只读诊断和有冷备的原路径升级，保留身份、原证据、MCP 与原暂停状态。不要初始化新分控，也不要只更新 Skill 后宣称服务已升级。给出本机实际验收结果和未完成事项。

## 5. 发布前验证记录（2026-10-13）

在 Windows、Node 22.23.2、Windows PowerShell 5.1 上验证：

- Node 全量测试 122/122 通过，无跳过。包括文件读取预算与跨轮遍历、修改中断、暂停撤销、版本链、UIA 遍历预算、历史库索引、轻量状态零 SQL，以及页面慢请求与隐藏轮询。
- 诊断脚本四种接口行为通过：新版 brief、旧版特定 400、404、授权失败 400；授权失败不回退。另用真实公开 v0.4.0 程序复测了旧版兼容，两个版本各完成一次 20 秒诊断。
- 离线部署、局域网协议下的总控与两个隔离分控部署通过；三技能绑定、重复执行保持身份与暂停状态、活动元数据同步通过。联网测试在本机隔离实例完成，不代表已经验证异机网络或 SMB。
- 浏览器 10 项业务回归通过；四个主技能格式和 54 个引擎镜像文件校验通过。浏览器与部署测试只使用合成业务数据，有限的原生活动探针关闭正文和截图。
- 从真实 v0.4.0 发布包建立合成离线分控，再按本文原路径升级至 v0.4.1。74 个冷备文件逐项核验；原 3 条事件的完整 JSON 摘要、归属、序号与 stream、2 个原件 BLOB、总结与前序版本链、2 个个人批次、待处理本地任务、全部策略和身份保持一致；三个部署绑定及实际服务均为 v0.4.1。原暂停状态保持，所有演练服务与托盘均已退出。

升级演练没有截图附件样本，没有重连员工 MCP，也没有执行失败回退或调用真实模型。完整冷备已验证，失败回退流程已说明；这不等同于上述未执行步骤已经实测。员工电脑的实际负载、特定 Word/WPS/微信版本、MCP 重连和工作质量须在目标设备按前后诊断与业务样本继续核对。
