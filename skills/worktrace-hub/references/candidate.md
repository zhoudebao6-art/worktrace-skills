# 从证据到岗位技能

先用 worktrace_candidates 查看统一库自动建立的个人候选，指定 candidate_id 读取完整 SKILL.md 文本、loop、evidence 和待验收清单。初稿是从个人方法生成的结构，不代表跨员工共识或已通过评估。由总控完善后，按下文登记修订；需要审阅文件时在部署目录 `candidates/<岗位-流程>/<版本>/` 导出新版本，保持原始事件不可修改。不要在员工个人技能目录自动安装。

每个候选包含：
- SKILL.md：用途和触发、必要输入、软件/接口、实际流程、完成条件、失败/等待退出条件。使用普通 Agent Skills frontmatter。
- evidence.json：引用的 event_id、task_id、覆盖员工与日期；逐项标注“观察到”“推断”“需要补证”，不复制整天敏感内容。
- eval-cases.json：用于验证的真实脱敏案例或明确标记的合成案例；把提炼规则的案例和验收案例分开，避免拿同一份示范当质量证据。
- loop.json：当前可登记的 worktrace.loop-draft/1.0，仅含 format、status、trigger、inputs、steps、outcome、exceptions、stop_conditions、max_iterations、max_model_calls、execution_adapter、held_out_evaluation、source_event_id。默认最多三轮/三次调用；不是可执行状态机。

自动初稿直接来自分控 procedures，没有自动合并总控 findings 中的否定或修正。完善前必须复读对应 analysis_batch_id 的总控审阅和原始证据，对不成立的方法保留明确反例/缺口；不要仅因数据库有候选就展示为已纠正的方法。用下面的正式修订入口保存完善结果，仍保持 draft。

需要设计 states、transitions、wait_for、allowed_actions、completion_evidence、failure_route 时，另存 design-notes.md 或 execution-design.json，注明“尚未接入执行器的设计”。这些不是当前 loop schema 的字段，直接传给 candidate_revise 会被拒绝。不得把设计文件的动作清单当作已获执行权限或已有适配器。

客服可先提炼：询问案件进度 → 查询已提供事实 → 缺项登记 → 回复草稿 → 对照人工改稿 → 验收。未知进度必须待查，不补造报价、授权期限或已办结状态。

初期判断替代价值用“案例能否满足验收、是否有事实错误、哪些输入仍需人工”，不凭一天屏幕采样声称已学会岗位。真实业务动作需要对应接口与预设权限，此版候选只供离线回放和审阅。

## 保存可追踪的离线验收

完善候选时先调用 worktrace_candidates 读取最新 definition_sha256 和原 loop。用 `worktrace_candidate_revise` 提交 candidate_id、expected_definition_sha256、独立 idempotency_key、修订后的完整 skill_md/loop 与 reason。修订沿用原来源引用，最多三轮/三次调用，execution_adapter 保持 null，status 保持 draft。新增无证据判断保留 unknown，不能扩大原证据范围。摘要冲突时重新读当前版本并合并，不强行覆盖。

成功登记会保存旧/新定义和修订理由，当前验收回到 pending；用 `worktrace_candidate_revisions` 查历史。本地文件的改动不会自动进入数据库，不能直接改 SQLite。新版本必须重新准备绑定新定义摘要的参考和案例，不能沿用旧通过。重试旧修订键只返回历史回执，不恢复旧版本。

WorkTrace 0.3 提供 `worktrace_candidate_evaluate` 和 `worktrace_candidate_evaluations`。适用于有确定参考文本的窄任务；开放式专利稿件质量仍需人工语义评估，不能用字符串相等替代。

1. 总控读取候选取得 candidate_id 与 definition_sha256；由候选所属员工的分控，按随包的 worktrace-evidence 技能为 normal、missing_input、counterexample 分别登记独立 task_id 和 case_id。总控不直接创建分控工作事件，也不通过学习消息要求分控绕过角色限制。不能与提炼批次共享任务、案件或事件，不要只换编号复制同一材料。
2. 在生成待测输出之前，实际提供参考的人在该分控登记一个 human/review 稿件，其 content_text 为下面的 JSON。AI 不得自行制造人工参考或 user_confirmed 反馈。参考不要传给待测生成过程。
3. 分控保存独立生成的 ai 稿件和实际核验反馈，经既有 HTTPS、wpack 或完整 wthandoff 移交后，总控先核对原始事件已到达，再调用评估工具传入各类 task_id、input_event_ids、reference_event_id、output_event_id、feedback_event_id；idempotency_key 标识本次评估，重复调用不覆盖。原分控不可用或没有真实人工参考时，保持评估缺口，不在总控冒充员工补写。

```json
{"format":"worktrace.candidate-reference/1.0","candidate_id":"<候选UUID>","candidate_hash":"<definition_sha256>","kind":"missing_input","expected_behavior":"request_input","input_event_ids":["<输入事件UUID>"],"expected_text":"<人工事先指定的精确参考文本>"}
```

kind 对应行为：normal → draft；missing_input → request_input；counterexample → halt。这些是预期标签，不是对桌面行为的观测。评估检查引用、顺序、独立性、最新反馈和文本一致性；调用者不能传入 passed。三类齐全且满足契约才为 offline_evidence_passed，否则为 failed 或 incomplete。新反馈、稿件版本或候选定义变化时原通过显示 stale。

候选始终 draft，execution_ready=false；人工来源标签未做独立身份认证，输入编号隔离也不能证明模型未见过答案。历史成功重试不会覆盖当前失败。评估历史属于总控数据库，当前 wpack 只携带事件与总结，不携带候选/评估表；迁移总控须备份完整 data，不能只导出 wpack。
