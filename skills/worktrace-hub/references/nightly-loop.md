# 双向消息与夜间学习的实际运行方法

## 模型与运行条件

按用户要求，自动任务固定为：总控 `gpt-6-astra` + `high`，分控 `gpt-6.1-sol` + `high`。参数直接传给每次 `codex exec`，不依赖聊天窗口中上一次选择，也不静默换成其他模型。交互式使用 Skill 时，在对应 Codex 对话选择相同模型与高推理强度；Skill 文字本身不能切换已开始的对话模型。

各电脑使用本机 Codex 登录，不集中复制员工登录凭据。首次启用前用该电脑账号验证指定模型可用。执行器已在 Codex CLI 0.162.0-alpha.17.2 验证；旧 CLI 缺少 `--ignore-user-config` / `--ignore-rules` 或禁用工具参数时应升级，失败保持 blocked，不移除隔离参数来强行运行。

记录服务需要在员工登录的交互会话运行。夜间分析只处理已保存数据，不抢鼠标键盘；锁屏不等于注销。关机、休眠、注销、断网或额度不可用不能视为仍在线。目标电脑的锁屏/睡眠策略需现场验证。

## 一次性启用

完成部署、真实采样和同步验收后，在**每台真实分控**执行，路径换成它的部署目录：

```powershell
& 'D:\WorkTrace\scripts\Configure-Learning.ps1' -DataDir 'D:\WorkTrace\data' -Action Enable -MaxCallsPerDay 6 -Start '18:00' -End '23:59'
```

在**真实总控**执行：

```powershell
& 'D:\WorkTraceHub\scripts\Configure-Learning.ps1' -DataDir 'D:\WorkTraceHub\data' -Action Enable -AutoDispatch -MaxCallsPerDay 6 -Start '18:00' -End '23:59'
```

脚本按角色自动选择模型；必要时用 `-CodexPath '<本机 codex.exe 绝对路径>'`。不要照抄另一台电脑 Codex 的安装路径。默认工作日与时区为周一至周五、Asia/Shanghai。非默认工作日可通过完整 worker-configure 策略设置；首版窗口必须在同一自然日内。

服务每 5 秒检查本地队列，分控约每 30 秒同步上下行内容。这些检查不调用模型。总控每天给每个未撤销设备创建一个稳定幂等键的 `personal.summarize` 任务；节点仅在本地学习启用、允许时段内执行。未启用的分控会排队并在过期后标记 blocked，不假装完成。

每日默认每台最多 6 次模型调用预留，单任务最多 3 批；失败/超时的调用也占预留预算。状态查询、消息接收、纯活动记录归纳不耗模型。总控自动分析每次一份个人总结、抽查最多六条原始事件；日限额对整个总控生效，不是每名员工各六次。员工增多后可能形成积压，应查看队列与用量再调整（上限 30），不是直接无限循环。

自动学习和手动 MCP 复盘互斥。手动运行 personal_next / analysis_next 前先暂停自动学习，等 busy=false。保存后再恢复。管理面板提供“暂停/恢复自动学习”，采集开关独立；也可执行：

```powershell
& 'D:\WorkTrace\scripts\Configure-Learning.ps1' -DataDir 'D:\WorkTrace\data' -Action Pause
& 'D:\WorkTrace\scripts\Configure-Learning.ps1' -DataDir 'D:\WorkTrace\data' -Action Status
```

恢复可用面板按钮保持原配置；重新执行 Enable 会采用命令行传入或默认的时段/限额。没有启用自动学习时仍能手动调用技能。

## 总控与分控怎样互传

总控 Codex 通过 `worktrace_enqueue_job` 指定真实 device_id、kind、唯一 idempotency_key。支持：

| 类型 | 实际含义 |
|---|---|
| personal.summarize | 分控整理新增已存证据或待补证批次 |
| node.status | 返回本节点学习状态，不调用模型 |
| message | 消息持久化进入节点队列，不代表员工已读 |

例如要求总控：“给 CS001 对应设备下发今晚一次个人总结任务，先从 status 确认 device_id；幂等键用 nightly-manual:日期:设备编号；最多三批。只分析已保存证据。”

`worktrace_node_jobs` 查看 queued/running/succeeded/blocked/cancelled/interrupted 与回执；`worktrace_cancel_job` 在分控下次同步后中止任务。取消不能撤销已经消耗的额度或已保存的总结。网络离线时取消不是立即生效。

分控 Codex 可通过 `worktrace_reply_to_hub(job_id,text)` 回复任务或消息，标记 author=node_codex。每个任务一份不可覆盖的回复；后续追问创建新任务。总控用 `worktrace_node_replies` 阅读。没有运行模型的普通 message 只确认到达服务，不自动生成寒暄回复；自动总结任务另有结构化完成/失败回执。

针对个人总结的疑点，总控用 `worktrace_learning_request` 创建补证，再等下次个人总结或下发新 personal.summarize 任务。单份原始总结最多两组补证、每组最多八问，答复不得递归触发追问。缺事实保留 blocked。

## 候选 Skill / Loop

个人结构化方法回传后，总控保存分析时自动建立候选记录：SKILL.md 文本、loop 对象、原始证据引用、缺口和待验收清单。通过 `worktrace_candidates` 查询，指定 candidate_id 读取完整内容。它们存于统一库的 skill_candidates，不自动安装到员工技能目录。

初始候选是根据个人方法生成的带来源草稿。跨员工比较、冲突处理、完善岗位规则、生成留出案例及评估仍由总控 Skill 执行；不能把自动生成草稿说成自动通过验证。总控按 candidate.md 保存到专门候选目录（避免目录名重叠覆盖），对照实际业务完善版本。

## 成本与验收

2026-10-13 官方标准文本 API 单价：Astra 输入 $10 / 百万 token、输出 $50；6.1 Sol 输入 $2、输出 $10。相同输入/输出 token 下分控调用约是 Astra 的 1/5；高推理可能改变实际输出量，图像、缓存、服务档位另计。当前执行器使用 Codex 登录，不能把 API 单价比例直接当订阅额度比例。参考 [模型对比](https://developers.openai.com/api/docs/models/compare?model=gpt-6-astra&model=gpt-6.1-sol) 与 [推理配置](https://learn.chatgpt.com/docs/config-file/config-reference)。

个人证据先聚合、只处理新增、纯活动不调模型、保存后不重读、按需图像，有助于同时控制成本与错误。每次用量记录保留 model、reasoning_effort、input/output/reasoning token；每日调用次数只是预留次数上限，不是精确金额上限。

现场首次验收应覆盖：消息来回、总结回传、总控分析/候选、重复投递不重跑、暂停、取消、离线补传、重启中断、限额阻止。开发验证与现场验证边界见审查报告。
