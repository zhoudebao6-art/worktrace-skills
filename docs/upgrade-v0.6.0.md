# v0.6.0 原路径升级与微信数据库通道

本版为已安装 WorkTrace 的员工电脑增加可选微信数据库证据通道。**先升级实际运行服务和技能，再在目标员工电脑验收通道；升级本身不启用微信数据库读取。** 不在开发电脑读取真实微信，不将员工电脑初始化为总控。尚无总控或不在同一局域网的分控保持离线模式。

## 更新范围

| 对象 | 必须怎样更新 |
|---|---|
| 原运行引擎 | 替换新清单中的完整受管程序，包括微信协议/存储/增量读取/本机管理与读取 MCP；不能只拷几个 `.mjs`。 |
| 三个员工技能 | `worktrace-collector`、`worktrace-personal`、`worktrace-evidence` 一并核验更新；保留原 `deployment.json` 的 root/role。 |
| WorkTrace MCP | 重连本 WorkTrace MCP，核对实际版本；新版磁盘文件不证明旧 MCP 子进程已重启。 |
| 微信只读解析器 | 目标员工机单独准备并验收，默认不启用；不替代或启动旧的发送 MCP。 |
| 真实总控 | 接收协议 1.3 前需另行升级到兼容版本；本分控脚本不修改另一台总控。 |

保留整个 `data`、数据库/原件、身份与 stream、联网凭据、离线模式、采集/文件/学习策略、工作时段、暂停状态、失败检查点、运行时、未知附加文件、MCP 与登录启动路径。新增辅助表/索引可能改变 SQLite 文件字节，证据验收比较原事件 JSON/摘要/序列和原件 BLOB，不要求整库文件哈希不变。

## 1. 下载和预检

匿名下载 [v0.6.0 Release](https://github.com/zhoudebao6-art/worktrace-skills/releases/tag/v0.6.0) 的专用 `worktrace-skills-v0.6.0.zip`、`SHA256SUMS.txt` 和更新清单。使用目标电脑的新非系统盘源码目录，核验 ZIP、`.worktrace-source.json` 全部文件和内嵌引擎清单。GitHub 自动生成的 `Source code.zip` 不能替代带清单的专用资产。

从三个技能绑定与实际进程确认唯一原分控目录。没有现有 `data/config.json`、数据库或合法绑定时先报告，不创建新身份；多个部署、来源不明、受管文件被修改或新增路径与本地文件冲突时保留原内容，停止覆盖升级。`Connect-Node` 仅恢复连接，`Install-SharedSkills` 仅安装技能，两者均不升级正在运行的引擎。

本次自动升级入口要求原引擎为 v0.5.2 或后续兼容版本，具备目录与设备身份互斥接口。更早版本不能绕过此要求：先按其已验证的原路径维护流程升级到 v0.5.2，或做有备份的专门迁移，不重初始化来代替升级。

下面路径是目标电脑示例，必须先替换为核实的真实值；新备份目录必须不存在，且不能放在运行目录或源码目录内：

```powershell
$download = 'D:\WorkTraceSource-v0.6.0'
$original = 'D:\WorkTraceNode'
$backup = 'D:\WorkTraceBackups\v0.6.0-本次唯一维护目录'
powershell -NoProfile -ExecutionPolicy Bypass -File "$download\scripts\Upgrade-ExistingNode.ps1" -DeploymentRoot $original -SourceEngine "$download\skills\worktrace-hub\assets\engine" -BackupDirectory $backup -DryRun
```

`-DryRun` 核验旧/新引擎、固定 Node、原主机/数据库身份与证据、新增冲突及本服务归属，不暂停服务、不修改业务数据库或创建备份。它仍需读取文件与数据库，不能称完全没有 I/O。正式维护前不要同时用其他对话更新同一部署。

## 2. 先准备三个技能

保存三个原技能的完整备份并逐文件核验。检查共享安装收据：

```powershell
# 三技能已有合法 .worktrace-install.json 时：
powershell -NoProfile -ExecutionPolicy Bypass -File "$download\scripts\Install-SharedSkills.ps1" -Role collector -SkillsDirectory 'D:\本机原技能目录' -Update
# 只有合法 deployment.json、且三技能均匹配原部署清单时，使用这一条替代上一条：
powershell -NoProfile -ExecutionPolicy Bypass -File "$download\scripts\Install-SharedSkills.ps1" -Role collector -SkillsDirectory 'D:\本机原技能目录' -Update -AdoptDeployment
```

这一步在引擎替换前执行：旧部署接管需要原绑定版本与原引擎清单相符。安装脚本会备份、核验受管技能并保留部署绑定；未知来源或本地修改会拒绝。不要补造收据、修改旧版号绕过检查，或覆盖不属于本分控的同名技能。此时仅技能文件更新，运行服务仍是原版。

## 3. 正式升级原分控服务

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$download\scripts\Upgrade-ExistingNode.ps1" -DeploymentRoot $original -SourceEngine "$download\skills\worktrace-hub\assets\engine" -BackupDirectory $backup
```

脚本只接受已登记的 `collector`，不支持总控或首次安装，不调用 Initialize/Join/bootstrap：

1. 保存原策略和身份。原服务运行时暂停自动学习和记录，等待在途工作结束，正常 API shutdown 并等待自己服务/托盘/采集解析子进程退出。原服务停着时不会为升级启动它。
2. 由独立维护守卫持有原目录与员工设备身份锁，阻止另一入口在冷备/替换期间启动同一分控。将原运行目录冷备到 `BackupDirectory\deployment`，逐文件核验长度和 SHA256；只排除必须保持独占锁定、可重新生成且不含证据的 `data/runtime-lock.sqlite` 及其 journal/WAL/SHM，结果报告逐项列出。工作证据数据库、原件、配置、凭据和其他运行文件均保留；核验失败不替换程序。冷备和策略记录是持久业务备份，不是可删缓存。守卫不打开工作证据库，正常结束、父进程退出或标准输入关闭后释放锁。
3. 按经过核验的新旧清单替换受管程序；新文件无冲突，旧移除项已有冷备，新清单最后写入。`data`、Node 运行时与未知文件保留。不会更改登录启动或 MCP 配置。
4. 原程序与证据核验通过后释放维护守卫。原来运行则从原路径启动，先保持维护暂停，核验 API 实际版本、原身份/stream、事件前缀和原件，再读取 readiness，最后恢复此前已授权的原采集和学习状态。原来暂停仍暂停，原 `high`/`xhigh` 沿用。原来停机则只做磁盘/数据库核验并仍停机，报告不声称运行验收已完成。

下载和预检期间不停止原采集，但正式维护有停机间隔；冷备时间随原库和原件规模增加。暂停/恢复可能产生正常 `collector.*` 事件，不能用总事件数完全不变作为验收。脚本不会开启新的微信数据库通道，也不会自动发消息或为了测试调用模型。

结果在 `BackupDirectory\upgrade-result.json`；其中 `skills_updated=false`、`mcp_reconnected=false` 是脚本职责边界，需继续下一节。失败报告给出阶段并保留冷备和现场，**不会自动以旧备份覆盖可能新增的数据**。失败后保持暂停或停机，先另存现场，再按已校验冷备受控回退；只保留一套活动身份，不按进程名批量结束进程，不删除运行锁绕过现有服务。

## 4. 校正绑定、重连和验收

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$original\Install-Skills.ps1" -Role collector -SkillsDirectory 'D:\本机原技能目录' -SkipMcp
```

这会核对三技能与新引擎并校正绑定版本；它不重新登记、不重建数据库、不重启服务。然后只重连本 WorkTrace MCP，已有 MCP 内包含新增只读微信工具，无需重复注册。核对实际 API、引擎清单、三个绑定与 MCP 初始化版本均为 0.6.0；本来停机时明确“引擎与技能已更新、服务未启动”，不为凑齐版本检测恢复录制。

运行中的分控按需执行 `worktrace_readiness` 或原运行时的 `src/admin-cli.mjs --command readiness --role collector --dir <原data>`，核对原始记录、个人总结、待处理批次与实际故障。缺少总结须如实保留，不能由升级过程代写。旧业务数据与暂停/时段策略保持，新增数据库通道待验收的状态不能阻断原 UIA/文件采集。

按[微信数据库手册](wechat-database.md)在目标员工机准备、探测和验收。初次密钥准备放在员工已同意的空闲时机；不在正在忙碌时反复读取进程，不为解析失败停止原采集。没有此时机就完成服务升级、保留原采集并报告该通道待启用。

协议 1.3 需要兼容总控。旧总控拒收时保持本地队列，明确需要在真实总控电脑升级，不清空消息、不改成旧协议、不强制联网。离线分控继续本地学习和完整移交。

## 验证边界

仓库的 `tests/wechat-upgrade.verify.ps1` 用隔离合成身份、消息和版本化测试引擎检查运行/停机分控的升级、预检拒绝、冷备、身份和证据保留、原状态恢复；不读取微信、不调用模型、不注册 MCP。该测试不能证明每个员工微信版本或现场性能已通过。发布与员工现场分别报告真实完成项目，不能把升级测试当作微信全量采集验收。

交给员工电脑 Codex 的固定版本指令：

> 请读取并执行 https://raw.githubusercontent.com/zhoudebao6-art/worktrace-skills/v0.6.0/prompts/upgrade-worktrace-v0.6.0.txt ，核对本机原分控，备份并升级服务与三技能，保留身份、数据、工作时段和原运行/暂停状态；微信数据库通道仅在本机兼容性与范围验收后启用。
