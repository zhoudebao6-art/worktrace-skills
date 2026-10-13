# 从证据到岗位技能

先用 worktrace_candidates 查看统一库自动建立的个人候选，指定 candidate_id 读取完整 SKILL.md 文本、loop、evidence 和待验收清单。初稿是从个人方法生成的结构，不代表跨员工共识或已通过评估。由总控完善后，在部署目录 `candidates/<岗位-流程>/<版本>/` 输出新版本，保持原始事件不可修改。不要在员工个人技能目录自动安装。

每个候选包含：
- SKILL.md：用途和触发、必要输入、软件/接口、实际流程、完成条件、失败/等待退出条件。使用普通 Agent Skills frontmatter。
- evidence.json：引用的 event_id、task_id、覆盖员工与日期；逐项标注“观察到”“推断”“需要补证”，不复制整天敏感内容。
- eval-cases.json：用于验证的真实脱敏案例或明确标记的合成案例；把提炼规则的案例和验收案例分开，避免拿同一份示范当质量证据。
- loop.json：trigger、inputs、states、max_iterations、stop_when、wait_for、allowed_actions、completion_evidence、failure_route。默认最多三次有目标修订，缺输入进入等待，无外发权限时只产草稿。

客服可先提炼：询问案件进度 → 查询已提供事实 → 缺项登记 → 回复草稿 → 对照人工改稿 → 验收。未知进度必须待查，不补造报价、授权期限或已办结状态。

初期判断替代价值用“案例能否满足验收、是否有事实错误、哪些输入仍需人工”，不凭一天屏幕采样声称已学会岗位。真实业务动作需要对应接口与预设权限，此版候选只供离线回放和审阅。
