# 按来源分层检索

`worktrace_knowledge_search` 必须指定 employee_id、device_id、from、to。先从 worktrace_status 的设备清单核对编号，日期使用含 UTC 毫秒的 ISO 字符串，单次不超过 31 天。不要按同名员工、窗口标题或 Screenpipe device_name 猜人员身份。

日期按各记录的 occurred_at 过滤，起止端点均包含。昨天的原始事件与今天保存的个人总结时间不同，候选检索沿用来源总结时间。查询“昨天怎样工作”时先查昨天原始记录；新总结可用 personal_history 或包含实际总结形成日期的明确范围查找，再核对引用的工作日期。若从原始日扩到总结日，说明原因并保留同一员工/设备约束，不能把没命中误报成没有总结。导入的时间范围则为 `[from,to)`，查整天可用下一天午夜减 1 毫秒作为 to。

默认返回 personal 与 candidate 的短摘要；include_raw=true 增加原始活动短摘要。query 为中文或其他文字的子串关键词，空格分隔时全部匹配。默认每层最多 8 条、扫描 300 条；结果可能只有最近窗口，next_cursor 非空表示还有未扫描内容。游标绑定原查询范围与关键词，换条件时清空游标。没有命中不能推断没有相关历史。

使用返回条目的 read 对象调用 `worktrace_knowledge_read`。详情仍有长度预算，content_truncated=true 时说明未返回完整内容；确需完整原始事件再按已知编号用 worktrace_get_evidence。不要为了取得更多材料去扩大员工或时间范围。

个人总结和候选中的 observed 是模型原声明，检索结果保留 claimed_basis 并按待核验分析呈现。user_confirmed 和 human 是存储来源标签，不能证明独立身份认证。原始活动只能证明记录存在；不能证明操作完成或业务成功。范围外证据只计缺口，不自动跨范围带回。

本地检索不调用模型、嵌入 API 或外部服务；这降低重复读取成本，但不能承诺固定百分比的额度节省。候选详情中的评估通过仍只代表离线文本契约通过，执行器尚未验收。
