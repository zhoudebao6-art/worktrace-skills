---
name: worktrace-personal
description: 在员工分控上用 WorkTrace MCP 总结个人工作方法、操作步骤和判断依据，核验人工改稿与结果，处理总控补证并同步为统一数据库中的个人总结。用于工作复盘、增量学习和下班总结。
---

目标是让下一位执行者能够复现做法。应用名称和流水账不足以说明学会；遇到缺失的判断理由、输入或结果，要具体标明。读取资料不会授予操作软件或对外发送的权限。

先 `worktrace_status` 核对 role=collector 和员工编号。自动执行器固定 gpt-6.1-sol/high；交互复盘也选择该模型与高推理强度。若自动学习启用，先在本机面板暂停学习，等 busy=false 再手动领取/保存。保持现有采集/暂停状态；这份技能只分析已保存证据。公司已授权工作学习时沿用授权，不逐条打断员工确认。

本次循环按 [references/learning-loop.md](references/learning-loop.md) 执行。先 `worktrace_personal_next`：无批次立即结束；有批次使用其 batch_id、digest，并通过 `worktrace_get_evidence` 核对必要原文，通过 `worktrace_tasks` 补充已记录任务上下文；只有批次包含的事件可作为本次引用。必要截图最多六张，未读过的图不得声称已核实。

按 `worktrace_personal_save` 的结构记录工作方法。每个步骤分别填写 action（怎样操作）、decision（为什么选这一步）、check（如何确认正确）；同时记录触发、输入、输出、异常、人工修改和缺口。事实引用原始 event_id，推断用 inferred，未看到用 unknown。只有实际任务证据才填写 task_id/case_id，不能由标题相似猜测客户身份。

只有应用元数据时 coverage=metadata_only、procedures 可为空，说明不能还原回复和判断；不要凑出假流程。看到内容也不能把没有回执的草稿当作已发送；outcome_observed 必须有结果证据，其含义不是“程序证明学会”。

总控补证只是一组问题：能从现有证据回答则 request_state=answered；无新证据则 blocked 并把具体缺口记入 open_questions。不能为回答问题擅自操作微信、增加采集范围或打断员工。默认问题先积累到下班复盘，有必要才集中询问。

保存后由服务自动同步。最多处理三批，每批默认 50 条摘要，保存即形成检查点；出现一次工具错误保存可说明的状态并退出，保留批次供下次恢复。无新证据、不确定问题已登记或达到预算时结束。不要分析自己生成的总结来循环“学习”。

读取 `worktrace_personal_history` 可了解过去方法，不能把模型旧结论当新的独立证据。跨员工统一规则、发布候选 skill、设计业务执行 loop 由总控负责。

需要回忆某项做法时，先用 `worktrace_knowledge_search`，明确本人的 employee_id、device_id 和最多 31 天的 UTC 范围，按关键词取方法摘要；有 next_cursor 才继续下一窗。需要核对时用返回的 read 参数调用 `worktrace_knowledge_read`；它也有截断预算，缺口不能补写。历史总结只能辅助理解，本次保存引用仍限领取批次。不要将所有历史全文反复放入模型上下文。

外部事件带 provenance：ActivityWatch 只有活动元数据；Screenpipe OCR/UI 是可见文本，不是完整操作演示。来源记录、模型总结、人工核验声明分别保留；不能把模型旧结论重新当成独立原始证据。

服务已提供可选夜间执行器，由部署目录 scripts/Configure-Learning.ps1 启用，总控通过持久化任务队列调度；Skill 文字本身不是定时器。查看 worktrace_node_jobs 中分配给本机的消息；需要给总控回复时用 worktrace_reply_to_hub，明确这是分控 Codex 的分析，不冒充员工本人。每任务回复不可覆盖，后续用新任务。未启用执行器时手动触发；有缺口、故障或待处理事项才报告。
