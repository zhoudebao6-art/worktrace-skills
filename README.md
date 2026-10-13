# WorkTrace Skills · 分控个人学习与总控汇总

用于已告知员工的 Windows 固定工作电脑：记录工作证据，由分控 Codex 整理个人操作方法，汇入指定总控电脑的统一数据库，由总控逐步完善岗位 Skill 和有界 Loop。

**开发电脑不是总控。总控是另一台指定设备；以下生产部署步骤在那台电脑执行。** 不需要开发电脑在线，不制作安装包。总控 Skill 按校验清单准备源码和固定 Node 运行时，再为员工准备专属接入入口。

## 其他电脑下载使用

本仓库已公开，包含总控、分控采集、个人总结和证据四个技能及配套服务源码。其他电脑无需 GitHub 登录，直接从 [发布页](https://github.com/zhoudebao6-art/worktrace-skills/releases/tag/v0.4.0) 下载 `worktrace-skills-v0.4.0.zip` 和 `SHA256SUMS.txt`，核验后解压源码，例如到 `D:\WorkTraceSource`：

```powershell
Set-Location D:\WorkTraceSource
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-SharedSkills.ps1 -Role hub
```

`-Role hub` 只安装总控技能；员工电脑改为 `-Role collector`，安装分控、个人学习和证据技能。安装不指定生产角色、不启动服务或采集。下一轮 Codex 对话可发现新技能；生产初始化继续按下文进行。

后续将新版源码解压到新目录，再运行相同脚本并加 `-Update`。脚本保留部署绑定并检查本地修改，更新前备份；已有不同来源技能不会强行覆盖。已部署服务需另按升级流程处理。

这是源码分发，不是安装包；总控技能继续负责正式环境搭建。完整下载步骤见 [下载使用手册](docs/download.md)。也可以匿名克隆本仓库后安装。专用发布 ZIP 带有离线安装清单，GitHub 自动生成的 Source code ZIP 不能直接替代它。

**让另一台电脑的 Codex 自己读取：** [化工案件员工独立离线分控完整指令](prompts/chemical-offline-collector.txt)（[纯文本地址](https://raw.githubusercontent.com/zhoudebao6-art/worktrace-skills/main/prompts/chemical-offline-collector.txt)）。v0.4.0 已包含无需总控的首次建档、本地有界学习、文档版本取证和完整加密移交；目标电脑直接部署发布版，无需现场开发。见 [离线分控操作手册](docs/offline-collector.md)。

v0.4.0 离线分控改进及实测范围见 [验证报告](docs/validation-v0.4.md)。历史 v0.3.0 增加 ActivityWatch/Screenpipe 导出适配、按员工设备分层检索、可追溯的候选离线验收。详见 [六项目研究与优化报告](docs/research-and-optimization.md) 和 [本版验证记录](docs/validation-v0.3.md)。旧 v0.2.1 发布保持不变；公开仓库只保存通用源码、说明和合成测试，不保存公司工作数据。

## 为什么这样做

| 选择 | 原因与实际边界 |
|---|---|
| 本地采集服务 + Codex 按批学习 | 不需要模型持续看屏幕，关闭聊天仍能保存/补传；Skill 本身不是后台服务。 |
| 分控先理解个人方法，总控再统一 | 分控保留操作上下文；总控比较不同员工的条件分支与结果，避免直接把个人习惯变成公司规则。 |
| 原始证据 + 任务/版本 + 结构化总结 | “打开过微信”不能证明怎样回复；实际草稿、人工改动、结果及引用能支持复现和核验。 |
| SQLite 本地优先 + HTTPS 增量同步 | 离线不丢待传数据，同 ID 内容重复不重复入库，按员工/设备严格归属。 |
| 总控补证问题 + 有界循环 | 疑点返回对应员工端，下次学习处理；不确定即等待新证据，避免自我重复推理。 |

这适合先做客服流程学习和草稿协作。**不能承诺一天监控就学会岗位，也不是控制所有软件的通用自动化工具。** 专有控件可能不提供 UIA 正文；密码框/编辑框跳过，截图只在明确配置且控件树可处理时启用。当前不录键盘、剪贴板、麦克风，不解析语音，不自动回复微信，不连接尚未提供的案件系统。

## 总步骤

**总控尚未上线或跨局域网时**：直接按 [离线分控手册](docs/offline-collector.md) 在员工电脑部署，数日后带回加密完整移交包。第一次建总控时明确接纳包内公司/设备编号；不同公司编号不得静默合并。以下为联网部署步骤。

1. **选真实总控与试点员工**：先 1–2 人。总控和员工需能相互访问目标 LAN 的 HTTPS/共享路径；开发机可处于不同网络。跨 LAN 不自动发现或穿透，须公司已有路由/VPN。每人固定一台电脑、一个明确员工编号。
2. **在真实总控下载仓库并安装总控 Skill**：按 [完整部署方法](docs/deployment.md) 复制 `skills/worktrace-hub` 到其 `.agents/skills`，然后在那台电脑的 Codex 中调用。不要把本仓库目录当作公司数据库目录。
3. **总控准备环境与员工入口**：bootstrap 配置实际公司/LAN 地址；prepare-fleet 为各员工准备独立登记文件和接入脚本。公共源码共享与每人私有接入目录分开。
4. **员工首次接入**：在该员工已登录的桌面内，让其 Codex 运行专属 Join-WorkTrace.ps1。自动配置本地服务、分控/个人学习/证据 Skill 和 MCP。没有既有远程执行权限时，这次本机触发仍必需。
5. **验收采集与同步**：确认员工编号、设备编号、真实活动样本、暂停和断线补传。默认仅应用元数据，学习正文前需针对公司实际软件配置并实测。
6. **验收个人总结**：运行 `$worktrace-personal`，核对操作、判断、检查、结果、人工修改、未知项及引用；确认 `learning.summary` 真正到达总控。只见元数据时应得到“证据不足”，不是虚构方法。
7. **启用夜间队列与自动学习**：按 [夜间循环手册](docs/nightly-loop.md)，在真实分控启用本机执行器，在真实总控启用 AutoDispatch。总控 Astra/high、分控 6.1 Sol/high；双向消息、持久化任务与回执使用已有 HTTPS 同步。不需要保持聊天常开，尚未启用时可手动调用技能。
8. **总控完善 Loop 与候选 Skill**：按 [学习循环](skills/worktrace-hub/references/learning-loop.md) 核验、比较、补证、留出案例回放。验证后再决定业务自动化权限与接口；保持原始证据和候选版本可追溯。

## 交付内容

- `skills/worktrace-hub`：可单独复制的总控技能，含源码镜像、部署与学习操作规程。
- `skills/worktrace-collector`：员工身份/采集/同步维护。
- `skills/worktrace-personal`：把个人做法写成结构化、有来源、可复核的总结。
- `skills/worktrace-evidence`：客服跟进、撰写初稿质检的草稿与人工版本记录。
- `src` / `bridge` / `public`：运行服务、Windows 被动探针、本机管理界面。
- `data-standard-v1.schema.json`：统一事件格式，含 `worktrace.personal/1.0` 总结载荷。
- [整体方案与结构选择](docs/architecture.md)、[结构审查与优化报告](docs/review-report.md)、[双向消息及夜间循环](docs/nightly-loop.md)。
- [数据、备份和费用边界](docs/data-and-operations.md)、[验证记录](docs/validation.md)。

运行环境：Windows x64，Windows PowerShell 5.1/.NET 4.7.2+，员工桌面已登录；Codex 已安装/登录且 CLI 可用。固定 Node v22.23.2 首次由脚本从 [Node 官方分发](https://nodejs.org/en/download/archive/v22.23.2) 获取并按固定 SHA256 校验，总控准备一份后共享给员工，不要求每台自行下载或装 Node/Python。运行服务无 npm 依赖。运行时固定版本应由维护者评估升级并复验，不自动漂移。

技能、MCP 与 Codex 的关系可参考 [OpenAI 技能说明](https://developers.openai.com/plugins/concepts/skills) 和 [MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。本项目不会拷贝员工 Codex 登录信息。账号和额度使用各电脑本机登录；自动学习按角色固定模型和 high 推理强度，采集/同步不调用模型 API。
