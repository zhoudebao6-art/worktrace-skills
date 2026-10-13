# 控制面与统一数据规范

原始事件和个人总结使用根目录 data-standard-v1.schema.json；应用程序还校验设备/员工归属、引用存在、版本父链、策略和附件哈希。控制消息不伪装成工作证据，不进入训练/总结的原始事件队列。

| 对象 | 关键字段与约束 | 存放位置 |
|---|---|---|
| 工作证据 | org_id、employee_id、device_id、event_id、stream_id/sequence、UTC occurred_at、timezone、policy_hash、app/context/payload/attachments | 两端 events/assets/policies |
| 个人方法 | worktrace.personal/1.0、batch_id/digest、source_coverage、原始 evidence_event_ids、request_id/state、result | learning.summary 事件，同步归总控 |
| 下行任务 | worktrace.job/1.0、job_id、device_id、kind、唯一 idempotency_key、created_at/not_before/expires_at、payload[message/max_batches/limit] | 两端 node_jobs |
| 任务回执 | job_id、revision、state、result、cancel_seen | 上行同步，确认版本后停止重传 |
| 分控文字回复 | reply_id、job_id、device_id、author=node_codex、created_at、text（最多4000字符） | 两端 node_replies；按 reply_id 确认 |
| 补证 | request_id、device_id、source_event_id、questions、state、result_event_id | 两端 learning_requests；最多两组，禁止递归 |
| 总控分析 | batch_id、employee_id、digest、status、result[summary/findings/open_questions] | 总控 analysis_batches/members |
| 候选 | candidate_id、source_event_id、procedure_index、analysis_batch_id、employee_id、status=draft、skill_md、loop、evidence、evaluation | 总控 skill_candidates |

HTTPS 同步请求携带公司/设备/安装编号、事件/附件/策略、job_receipts 和 replies；响应确认 event_ids、job_acks、reply_acks，同时携带该设备 jobs 和 learning_requests。设备令牌认证与登记绑定在处理控制内容前执行。控制响应不授权改变采集范围或执行任意程序。

任务结果含义：queued=尚未执行，running=正在本地处理，succeeded=分析已保存或查询/收件已完成，blocked=缺输入/限额/过期/调用异常，cancelled=总控撤回，interrupted=运行中重启、结果不确定。succeeded 不是员工已读、业务已发送或案件办结。

同幂等键的不同任务拒绝，终态不被旧回执改写。取消有单独送达确认，避免离线取消丢失或无限占用下行队列。回执终态即使保存成功，也应通过 summary_event_ids 等查询证据是否已同步；回执和大批证据可能在不同同步包到达。

所有协议版本为首版；升级须保持旧数据解释方式并运行兼容测试，不将字段语义静默改名。当前每人固定一台电脑，员工换机重新登记设备，不复用已有安装密钥克隆第二台。
