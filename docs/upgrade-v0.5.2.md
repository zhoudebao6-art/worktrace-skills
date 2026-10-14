# v0.5.2 更新清单与原路径升级

版本日期：2026-10-14。面向已有 v0.4.1 及 main 分支 v0.5.0/v0.5.1 部署；全新电脑走[下载与安装](download.md)，独立化工分控走[离线部署](offline-collector.md)。本版仍为源码 ZIP，由目标电脑的 Codex 执行有备份的维护，不提供安装器二进制。

## 必须更新什么

| 对象 | 本次更新 | 部署要求 |
|---|---|---|
| 联网接入与连接恢复 | `src/invitations.mjs`、`src/lan-join.mjs` 与客户端模块、`scripts/Join-Lan.ps1` / `Join-WithInvite.ps1` / `Connect-Node.ps1` | 保留 main 已有的公司链接、单设备接入与重连；跨网离线分控不强行转成联网。 |
| 所有运行服务 | `src/server.mjs`、新增 `src/runtime-lifecycle.mjs` | 同目录独占、同机同员工设备身份互斥；停机等后台操作收尾；同步整批事务与认证复核。 |
| 总控和分控学习 | `src/jobs.mjs`、`src/worker.mjs`、`src/analysis.mjs`、`src/learning.mjs`、`src/personal-digest.mjs` | 待发队列翻页轮转、失败批次恢复、迟到结果拒收、正文优先取样、日报覆盖说明。 |
| 离线移交 | `src/offline-handoff.mjs` | 检查事件/原件/引用及恢复可用性；恢复中断保护；同身份服务运行时拒绝 Recover。 |
| 按需检查 | 新增 `src/readiness.mjs`、`src/admin-cli.mjs`、`src/mcp.mjs`、`scripts/skill-control.ps1` | 新 `worktrace_readiness` / admin `readiness`，识别证据与总结缺口；需要重连本 WorkTrace MCP。 |
| 版本及镜像 | `src/protocol.mjs`、新 `engine-manifest.json` 和其中全部受管文件 | API、磁盘程序和部署绑定必须一致为 0.5.2。事件协议 1.0/1.1/1.2、个人总结与移交格式继续兼容。 |
| 员工电脑 | `worktrace-collector`、`worktrace-personal`、`worktrace-evidence` | 三个技能及引用文档一并更新，保留各自 `deployment.json` 的原路径和身份。 |
| 真实总控电脑 | `worktrace-hub`（含完整源码镜像） | 技能与运行目录分别更新；分发旧镜像会把员工又部署到旧版。 |

发布页另附 `UPDATE-CONTENTS.json`，列明 v0.4.1 至本版全部新增/修改/移除源码路径。它用于审阅差异，**不是任意复制/删除文件的授权清单**；部署替换仍以经过核验的新旧引擎清单为准。

只更新 Skill 不会更新已运行的 Node 服务。只复制上述几个 `.mjs` 也可能造成混合版本，应核验并替换完整受管引擎集合。

## 必须保留什么

保留整个 `data`、原件和截图 BLOB、事件/流编号、org_id/employee_id/device_id/installation_id、`config.json`、登记密钥、证书、策略、检查点、MCP 和登录启动路径，以及目标 Node 运行时。备份原运行目录和技能，不能把数据库当缓存。旧状态是暂停就保持暂停；离线仍离线，总控没有上线时不创建假总控。

`runtime-lock.sqlite` 是本版本运行互斥的辅助数据库，不是工作证据。不要通过删除它绕过活动服务；异常退出后操作系统自动释放锁。同机身份锁限制活动克隆，无法检测另一台不联网电脑的离线副本；恢复和交接仍只保留一个活动源。

## 目标电脑操作顺序

1. 从 [v0.5.2 Release](https://github.com/zhoudebao6-art/worktrace-skills/releases/tag/v0.5.2) 下载专用 `worktrace-skills-v0.5.2.zip`、`SHA256SUMS.txt`。按[下载说明](download.md)核验压缩包和解压后的 `.worktrace-source.json`、引擎清单；使用新的非系统盘目录。
2. 从已安装技能 `deployment.json` 和实际进程查明唯一原部署、角色、版本、MCP/登录启动路径。核对旧引擎和技能的受管文件是否有本地改动，新增路径有无冲突。有改动先输出差异并保留，不强行覆盖。
3. 保存完整原状态、身份和策略到本机受限维护目录。分控可用 `Measure-CollectorPerformance.ps1` 做 20 秒只读前测。暂停学习；分控再暂停采集。等待正在执行的工作结束，经 admin `shutdown` 关闭本服务，核对服务、托盘和所属子进程已退出。不得按 `node.exe` 名称批量结束进程。
4. 在运行目录以外新建持久冷备，复制整个旧运行目录和已装技能；逐文件流式核验长度和 SHA256。冷备完成后才能替换程序。对照[既有升级操作细则的第 3 节](collector-performance.md#3-在原路径安全升级)，将其中目标版本/下载路径替换为本版；该文的 v0.4.1 测试数字是历史记录。
5. 按新旧引擎清单替换原路径中受管程序；新文件必须无冲突，移除项先备份后逐文件处理。最后写新 `engine-manifest.json` 并完整核验。保留 `data`、运行时和未知附加文件。**不要用 Initialize-OfflineNode、Join 或 bootstrap 覆盖初始化已有部署。**
6. 更新相应角色的技能。全部有合法共享安装收据时，从新下载包运行 `Install-SharedSkills.ps1 -Role collector|hub -SkillsDirectory 原技能目录 -Update`；这是角色二选一，不能把 `collector|hub` 原样传入。无收据的受管旧部署按新旧技能清单更新，保留绑定和本地附加文件，不补造收据。混合来源或内容冲突停在明确差异报告。分控再运行原部署 `Install-Skills.ps1 -Role collector -SkillsDirectory 原目录 -SkipMcp` 核对内容并校正绑定版本。总控技能整体清单核验通过后，仅把原 `deployment.json.version` 更新为 0.5.2，保留原 root/role；不要重新 bootstrap。
7. 从原路径启动，继续保持暂停。核对 API/引擎清单/技能绑定版本均为 0.5.2，身份与 stream 不变，旧事件 JSON/摘要/顺序/归属和 BLOB 原件逐项保持。新辅助表、索引可能改变 SQLite 文件字节，不能用整个数据库文件哈希不变作验收条件。
8. 重连这个 WorkTrace MCP，读取 `worktrace_readiness`；没有 MCP 时用原部署 Node 调用 `src/admin-cli.mjs --command readiness --role collector --dir 原data目录`（总控角色改为 hub）。检查原检查点仍可读取，无总结的原始记录被明确提示。验收后恢复此前已授权的原记录/学习状态，再做分控后测。不要为验收自动发送微信、扩大范围或调用真实模型。

任何启动或证据核验失败：保持暂停，停止本次服务，完整另存失败现场，再从已核验冷备回退；只启动一套同身份部署。失败之后新增的数据不能被旧备份直接覆盖。

## 使用与兼容边界

- 角色模型仍为总控 `gpt-6-astra`、分控 `gpt-6.1-sol`。保留已有明确的 `high` 或 `xhigh`，不因升级静默改变质量与费用；新部署沿用 main 的 `xhigh` 默认。需要调整必须显式配置。
- 日间轻量记录与夜间有界分析分离。完整移交的全量校验只在显式移交时发生，大库会花时间；新 readiness 只在排查时调用。
- 个人学习在最早 1000 条待处理窗口内优先正文/文件/业务证据，同小时/进程/状态/完整标题相同的无正文活动可聚合。报告会说明窗口外积压，不能声称当天全部学完。
- 总控共享每天调用预算。失败批次不会独占自动循环；仍不是按员工平均分配额度的调度器。
- 只有原始记录、没有 `learning.summary` 的移交包可以保存与人工核验；本版不会伪造员工总结来自动生成个人候选 Skill。
- 本机合成故障、部署和升级测试不替代员工现场 Word/WPS/微信/化工原件效果检查。完整验证情况见[本版复查报告](architecture-review-v0.5.2.md)。

## 发给目标电脑 Codex

> 请读取并执行 https://raw.githubusercontent.com/zhoudebao6-art/worktrace-skills/v0.5.2/prompts/upgrade-worktrace-v0.5.2.txt ，核验本机原部署后升级运行服务和对应技能到 v0.5.2，先冷备，保留全部数据、身份、离线模式和原暂停状态，按指令报告本机验收结果。

