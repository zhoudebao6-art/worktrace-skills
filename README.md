# WorkTrace Skills · 分控个人学习与总控汇总

用于已告知员工的 Windows 固定工作电脑：记录工作证据，由分控 Codex 整理个人操作方法，汇入指定总控电脑的统一数据库，由总控逐步完善岗位 Skill 和有界 Loop。

**只有用户指定的电脑承担总控；读取源码不会指定本机角色。** 总控 Skill 按校验清单准备源码和固定 Node 运行时，再为员工准备接入入口。

## 其他电脑下载使用

本仓库已公开，包含总控、分控采集、个人总结和证据四个技能及配套服务源码。当前局域网链接自动接入使用完整 `main` 源码，无需 GitHub 登录：

```powershell
git clone --branch main --single-branch https://github.com/zhoudebao6-art/worktrace-skills.git D:\WorkTraceSource-main
```

使用本机 Git 或已核验的 Codex 自带 Git，路径可通过 `WORKTRACE_GIT` 提供；先阅读 [下载使用手册](docs/download.md) 核验来源、commit 与干净工作树。历史 [v0.4.1 Release](https://github.com/zhoudebao6-art/worktrace-skills/releases/tag/v0.4.1) 不包含此次 LAN 链接接入及模型配置，保留供旧版使用，不用旧包替代当前源码。

**同一局域网直接接入：** 总控按 [局域网接入手册](docs/lan-join.md) 启用实际网段并生成公司连接链接。员工把整个链接交给自己电脑的 Codex，使用真实员工编号和姓名，Codex 从当前源码运行 `scripts/Join-Lan.ps1`，完成运行时、本机服务、三个分控技能、MCP 与总控心跳。无需逐台总控确认、邀请码或私有接入文件。普通仓库地址没有公司目标，不能代替含 `#worktrace-join=v1.` 片段的公司连接链接。

可直接给员工 Codex 读取 [局域网分控完整指令](prompts/lan-collector.txt)（[纯文本地址](https://raw.githubusercontent.com/zhoudebao6-art/worktrace-skills/main/prompts/lan-collector.txt)）。公司链接只含地址、公司信息和公开证书，不含设备秘密；每台分控独立生成密钥。首次记录与自动学习默认关闭，已有离线或不同身份数据不覆盖。管理员手工登记与一次性邀请码方式仍保留。

只安装技能时运行 `scripts/Install-SharedSkills.ps1 -Role collector`，总控使用 `-Role hub`；更新追加 `-Update`。脚本核验并备份旧版、保留部署绑定，不强行覆盖来源不明或本地修改的技能。技能安装不启动采集，也不会升级已绑定的运行服务。完整流程见 [下载使用手册](docs/download.md)。

**让另一台电脑的 Codex 自己读取：** [化工案件员工独立离线分控完整指令](prompts/chemical-offline-collector.txt)（[纯文本地址](https://raw.githubusercontent.com/zhoudebao6-art/worktrace-skills/main/prompts/chemical-offline-collector.txt)）。v0.4.1 已包含无需总控的首次建档、本地有界学习、文档版本取证和完整加密移交；目标电脑直接部署发布版，无需现场开发。见 [离线分控操作手册](docs/offline-collector.md)。

v0.4.1 优化白天记录时的文件读取、托盘轮询和界面采集负载。已有员工分控按[性能诊断与升级说明](docs/collector-performance.md)及[升级指令](prompts/upgrade-collector-performance.txt)更新实际运行服务；只更新 Skill 不会使旧服务获得优化。离线能力的原验证记录见 [v0.4.0 报告](docs/validation-v0.4.md)。历史 v0.3.0 的六项目研究与优化见 [研究报告](docs/research-and-optimization.md)。旧发布保留；公开仓库只保存通用源码、说明和合成测试，不保存公司工作数据。

当前源码将总控和分控的推理强度统一设为 `xhigh`（极高），分别使用 `gpt-6-astra` 和 `gpt-6.1-sol`。历史 Release 不会自动取得新功能；已有部署须升级实际服务并复验。

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
3. **总控准备环境与员工入口**：bootstrap 配置实际公司/LAN 地址；选择同网自动登记时，启用真实网段并生成公司连接链接。需要管理员预登记时仍可使用 prepare-fleet，公共源码与私有登记材料分开。
4. **员工首次接入**：在该员工已登录桌面内，让其 Codex 持完整公司连接链接运行 `Join-Lan.ps1`，或使用已有专属 `Join-WorkTrace.ps1`。自动配置本地服务、分控/个人学习/证据 Skill 和 MCP。首次本机执行由员工电脑上的 Codex 完成，不需要总控接管桌面。
5. **验收采集与同步**：确认员工编号、设备编号、真实活动样本、暂停和断线补传。默认仅应用元数据，学习正文前需针对公司实际软件配置并实测。
6. **验收个人总结**：运行 `$worktrace-personal`，核对操作、判断、检查、结果、人工修改、未知项及引用；确认 `learning.summary` 真正到达总控。只见元数据时应得到“证据不足”，不是虚构方法。
7. **启用夜间队列与自动学习**：按 [夜间循环手册](docs/nightly-loop.md)，在真实分控启用本机执行器，在真实总控启用 AutoDispatch。总控 Astra/xhigh、分控 6.1 Sol/xhigh；双向消息、持久化任务与回执使用已有 HTTPS 同步。不需要保持聊天常开，尚未启用时可手动调用技能。
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

技能、MCP 与 Codex 的关系可参考 [OpenAI 技能说明](https://developers.openai.com/plugins/concepts/skills) 和 [MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。本项目不会拷贝员工 Codex 登录信息。账号和额度使用各电脑本机登录；自动学习按角色固定模型和 xhigh（极高）推理强度，采集/同步不调用模型 API。
