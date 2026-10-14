---
name: worktrace-personal
description: 在联网或独立离线员工分控上用 WorkTrace MCP 总结个人工作方法、操作步骤和判断依据，核验人工改稿与结果，将引用原始证据的个人总结保存到本地数据库。用于工作复盘、增量学习和下班总结。
---

目标是让下一位执行者能够复现做法。应用名称和流水账不足以说明学会；遇到缺失的判断理由、输入或结果，要具体标明。读取资料不会授予操作软件或对外发送的权限。

任何复盘、测试或续用都先读取本技能及同目录 worktrace-collector、worktrace-evidence 的 `deployment.json`，核对唯一的 role/root，再用 `worktrace_status` 确认 role=collector、员工编号和 connection_mode。服务或 MCP 不可用时，联网部署从已核验源码运行 `scripts/Connect-Node.ps1 -WorkDir <原目录> -SkillsDirectory <原技能目录>`，或用 collector 的 control start/status/sync；沿用本机身份与信任，不因重启、断网或新对话再次索要链接或登记。离线只恢复本地服务；绑定缺损或冲突先恢复原配置或明确原目录，不扫描磁盘/局域网，也不将其当首次安装。仅首次没有任何本机状态才转 collector 收集连接和身份。连接恢复保持采集、学习开关原状。

自动执行器角色模型固定 gpt-6.1-sol，新部署默认 xhigh；已有合法 high/xhigh 保持原设置，显式修改才变更强度。交互复盘选择该模型和已约定强度。若自动学习启用，先在本机面板暂停学习，等 busy=false 再手动领取/保存。保持现有采集/暂停状态；这份技能只分析已保存证据。公司已授权工作学习时沿用授权，不逐条打断员工确认。

本次循环按 [references/learning-loop.md](references/learning-loop.md) 执行。先 `worktrace_personal_next`：无批次立即结束；有批次使用其 batch_id、digest，并通过 `worktrace_get_evidence` 核对必要原文，通过 `worktrace_tasks` 补充已记录任务上下文；只有批次包含的事件可作为本次引用。必要截图最多六张，未读过的图不得声称已核实。

检查 batch.selection 与 source_coverage：新批次在最早 1000 条未归组记录的窗口内优先正文、文件和业务证据；相同小时/应用/状态/完整标题的无正文活动才聚合。窗口外或本批未选记录仍待处理，旧批次 selection 可能为空。代表片段不是完整操作录像，原始计数不是工时；不得因一批结束宣称一天已学完。

按 `worktrace_personal_save` 的结构记录工作方法。每个步骤分别填写 action（怎样操作）、decision（为什么选这一步）、check（如何确认正确）；同时记录触发、输入、输出、异常、人工修改和缺口。事实引用原始 event_id，推断用 inferred，未看到用 unknown。只有实际任务证据才填写 task_id/case_id，不能由标题相似猜测客户身份。

只有应用元数据时 coverage=metadata_only、procedures 可为空，说明不能还原回复和判断；不要凑出假流程。看到内容也不能把没有回执的草稿当作已发送；outcome_observed 必须有结果证据，其含义不是“程序证明学会”。

化工、财务、设计等岗位遇到公式、结构图、数值、单位或修订批注时，按 [references/learning-loop.md](references/learning-loop.md) 提取已存原件到新的审阅文件核对；解析文字与界面截图不能替代未读过的原件。自动执行器只收到有界正文和必要截图，不会自行打开原件或调用业务工具；无法核实时保留 unknown 和原件事件编号，交给后续审阅。

总控补证只是一组问题：能从现有证据回答则 request_state=answered；无新证据则 blocked 并把具体缺口记入 open_questions。不能为回答问题擅自操作微信、增加采集范围或打断员工。默认问题先积累到下班复盘，有必要才集中询问。

保存后先验证本地落库；联网模式由服务自动同步，离线模式等待人工交接，不把未同步作为本地保存失败。最多处理三批，每批默认 50 条摘要，保存即形成检查点；出现一次工具错误保存可说明的状态并退出，保留批次供下次恢复。无新证据、不确定问题已登记或达到预算时结束。不要分析自己生成的总结来循环“学习”。

日报是数据库总结的派生视图，按总结保存日组织，并列出原始引用日期与选样局限。日报生成失败不撤销已存总结，也不为重建日报重跑付费模型；使用正式 personal-digest 管理命令重建。暂停、网络恢复与重新打开 Codex 不等于允许重试失败模型；先核对本地检查点，明确重试或手动完成同一批次。

读取 `worktrace_personal_history` 可了解过去方法，不能把模型旧结论当新的独立证据。跨员工统一规则、发布候选 skill、设计业务执行 loop 由总控负责。

需要回忆某项做法时，先用 `worktrace_knowledge_search`，明确本人的 employee_id、device_id 和最多 31 天的 UTC 范围，按关键词取方法摘要；有 next_cursor 才继续下一窗。需要核对时用返回的 read 参数调用 `worktrace_knowledge_read`；它也有截断预算，缺口不能补写。历史总结只能辅助理解，本次保存引用仍限领取批次。不要将所有历史全文反复放入模型上下文。

外部事件带 provenance：ActivityWatch 只有活动元数据；Screenpipe OCR/UI 是可见文本，不是完整操作演示。来源记录、模型总结、人工核验声明分别保留；不能把模型旧结论重新当成独立原始证据。

服务已提供可选夜间执行器，由部署目录 scripts/Configure-Learning.ps1 启用；Skill 文字本身不是定时器。联网由总控队列调度，离线由服务按本地日期创建一次有界 personal.summarize 日任务，需实测任务与总结而不是只看 enabled。默认每日最多 6 次调用、每任务 3 批；失败和超时也消耗预算，无新证据即结束。本地任务来源与总控任务分开，不能伪造总控 job 或上传其回执。

查看 worktrace_node_jobs 中分配给本机的任务。只有总控来源任务才使用 worktrace_reply_to_hub，明确这是分控 Codex 的分析，不冒充员工本人。每任务回复不可覆盖，后续用新任务。离线时问题与方法候选先留本地，不声称跨员工规则已经验证。未启用执行器时手动触发；有缺口、故障或待处理事项才报告。
