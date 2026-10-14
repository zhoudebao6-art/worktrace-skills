# 接收尚未连接总控的离线分控

v0.4.0 的 `.wthandoff` 保存一致的完整 SQLite 快照，包含文件原件、截图、策略、原始事件、个人总结与本地任务检查点。密码必须由管理员在目标电脑安全输入，不能交给聊天或写进仓库。总控归并只读入证据和总结；员工本地队列与消费进度留在备份，不覆盖总控队列。

1. 在用户指定的真实总控上搭建当前版本服务，尚未初始化公司时先不要随机新建组织。
2. 在运行目录执行 `scripts/Offline-Handoff.ps1 -Action Inspect -Input <包路径> -Output <新的身份JSON路径>`。核对已告知员工的编号、姓名、设备和公司。SHA256另与发出方回执核对。输出身份文件不含密码和登录凭据，但仍属于公司资料，不上传公开仓库。
3. 新总控的初始化 JSON 保持实际 `org_name`、本机 `address`、`hub_port`，增加 `offline_identity` 字段，值为上一操作输出的身份对象。运行 `src/admin-cli.mjs --command init --role hub --dir <运行目录/data> --input <初始化JSON>`。这一步接纳原 `org_id/device_id/installation_id`，生成总控自己的真实证书；不重写旧事件。
4. 总控已是相同 `org_id` 时，先用 `admin-cli --command adopt-offline-device --role hub --dir <data> --input <身份JSON>` 明确登记原设备。若是另一 `org_id`，拒绝无声合并；保留包并采用独立汇总环境或另行设计显式组织迁移，不篡改历史哈希。
5. 运行 `scripts/Offline-Handoff.ps1 -Action Import -DataDir <总控data> -Input <包路径>`。核对新增/重复事件数、原件和截图数；复读个人总结及其原始引用。重复导入应新增零条；后续快照继续增量归并。
6. 用 `worktrace_personal_history` 和明确员工/设备范围的检索提取个人方法，再由总控生成并评估候选 Skill/Loop。导入成功不证明方法正确或岗位已学会。

## 接收了原始记录却没有个人总结

先分清“未收到”“已收到但无正文”“有内容而未分析”“有总结但只是 metadata_only”。调用 worktrace_readiness 按设备分页检查，再核对 Inspect/Import 回执、个人历史和本员工/设备原始范围；报告缺口，不凭服务在线或文件数量推断岗位已学会。本地 personal_members/任务检查点不会并入总控，不能据总控缺少这些表断言来源丢失。

原分控仍可用：由该电脑自己的 Codex 核对模型、预算及失败检查点，暂停自动学习后按 worktrace-personal 补做至多三批，再生成新的增量移交快照。不能因这次接收需要而自动恢复员工手动暂停的采集。

原分控不可用：总控先暂停自动分析并等 busy=false，调用 `worktrace_analysis_next`，明确 `employee`、`source="all"` 和不超过 50 的 limit。先检查返回批次确属该员工，按原始事件 ID 读取正文/截图/原件，使用 `worktrace_analysis_save` 保存**总控审阅**与缺项，最多三批。已有 open 批次先按其来源完成，不能替换 batch_id/digest。all 包含原始事件及可能存在的总结，逐条区分类型；本路径不创建 learning.summary、不伪造原员工分析、不自动生成纯 raw 的个人候选。没有方法依据时仅登记未知。

此时可另存带来源的审阅设计供后续使用，但需要恢复分控总结/补证与独立验收后才能进入当前个人候选流程。离线节点没有网络任务通道；总控创建补证问题不代表员工已收到，问题应列入下次人工交接清单。不要为发问题配置穿透、改写 hub_url 或重新登记原身份。

需要只读审阅全库用 `-Action Restore -Destination <全新目录>`；其 `REVIEW-ONLY.json` 会阻止被误启动为分控。`Recover` 只允许原电脑、原主机绑定，恢复到新目录后保持记录和学习暂停，不直接启动服务。

首次离线试点建立的公司 UUID 应在后续同公司离线节点初始化时显式沿用。不能让多台独立创建的不同公司 UUID 被视为天然属于同一公司。离线设备的 `last_seen` 为空是正常状态，人工带回不等于已经建立局域网通信。

不要求两台机器在同一局域网，不扫描或配置穿透，不导出 Codex/GitHub 登录。接收核验完成前保留原机数据库。
