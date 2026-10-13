# Mem0、Agent S 源码研究与 WorkTrace 检索改进

研究日期：2026-10-13。只读核对上游官方代码、文档与许可证，没有安装其服务、调用真实模型、采集员工桌面或发送消息。本次实现为 WorkTrace 原生 SQLite 检索，没有引入这两个项目的 SDK、云服务或代码副本。

## 固定研究来源

| 项目 | 本次核对的 main 提交 | 许可证 |
|---|---|---|
| [Mem0](https://github.com/mem0ai/mem0) | `d26ba5e4518cef7fff3c66d4f715b21adf9feabe` | [Apache-2.0](https://github.com/mem0ai/mem0/blob/d26ba5e4518cef7fff3c66d4f715b21adf9feabe/LICENSE) |
| [Agent S](https://github.com/simular-ai/Agent-S) | `15776a8dc659658b1963816ea006f7af1978e595` | [Apache-2.0](https://github.com/simular-ai/Agent-S/blob/15776a8dc659658b1963816ea006f7af1978e595/LICENSE) |

许可证名称用于标明来源；本次没有复制上游实现。将来实际引入依赖或再分发代码时，仍需保留对应声明并检查所选模型、依赖及服务条款。

## Mem0 可以借鉴什么

源码将用户、代理、运行标识与任意元数据分开；创建或更新时不允许普通元数据重设身份。查询要求带身份过滤，提供返回条数限制和元数据条件。本次借鉴的是“先确定谁的资料，再检索相关记忆”，不是把用户提供的任意员工编号当成授权。WorkTrace 进一步把请求范围与本机角色、公司配置和设备登记核对：分控只读本人本设备，总控也须明确选择员工、设备和时间段。[官方身份与检索实现](https://github.com/mem0ai/mem0/blob/d26ba5e4518cef7fff3c66d4f715b21adf9feabe/mem0/memory/main.py)

Mem0 的开源库与自托管服务是不同部署形态，默认组件还包含 LLM、嵌入模型和向量存储。对本阶段的少量公司电脑，直接接入会增加模型调用、依赖和运维；暂不采用。先用本地 SQLite 的中文子串检索验证身份、引用链和实际召回需求，再决定是否增加向量索引。[官方开源部署与默认组件](https://docs.mem0.ai/open-source/overview)

上游当前 README 的效果表含托管平台专有优化，并说明开源 SDK 不能照搬其分数；其中还提到将代理报告的执行信息作为可存记忆。本项目不引用这些效果数字作为实测收益，也不把“代理说完成”升级为员工操作事实。事实库保留原始证据，个人总结和候选规则始终分层。[官方算法与开源范围说明](https://github.com/mem0ai/mem0/blob/d26ba5e4518cef7fff3c66d4f715b21adf9feabe/README.md)

## Agent S 可以借鉴什么

S1 的知识模块确实保存情节与叙事经验，并用嵌入检索相似经历；这是可研究的经验复用结构。它面向代理执行任务的经验，不能直接等同于员工全天工作记录、实际人工修改和组织统一证据库。[S1 知识模块](https://github.com/simular-ai/Agent-S/blob/15776a8dc659658b1963816ea006f7af1978e595/gui_agents/s1/core/Knowledge.py)

当前 S3 主类是 Worker 加界面定位的执行循环，可保留有限截图轨迹并启用反思。其 `procedural_memory.py` 主要构造提示模板；不能仅凭文件名宣称现版具备自动积累员工个人方法库的能力。[S3 主类](https://github.com/simular-ai/Agent-S/blob/15776a8dc659658b1963816ea006f7af1978e595/gui_agents/s3/agents/agent_s.py)、[S3 模板代码](https://github.com/simular-ai/Agent-S/blob/15776a8dc659658b1963816ea006f7af1978e595/gui_agents/s3/memory/procedural_memory.py)

它可运行于 Windows、macOS、Linux，公开使用入口配置生成模型和界面定位模型，单显示器是文档中的运行要求。适合将来作为受控执行适配器候选，目前不接管员工桌面，也不把基准成绩视为本公司软件的成功率。[官方安装与执行说明](https://github.com/simular-ai/Agent-S/blob/15776a8dc659658b1963816ea006f7af1978e595/README.md)

## 现有问题与本次改进

此前 `Store.list` 对整段事件 JSON 搜索，个人历史主要按员工列最近记录，候选列表与个人历史又是不同入口。调用方若没有补上设备、时间和来源检查，容易把宽泛检索结果或模型归纳再次当作事实输入；反复读全文也扩大上下文。

新增 `src/knowledge.mjs` 提供两种读取：

```javascript
knowledgeSearch(store, config, {
  employee_id, device_id, from, to,
  query: '', limit: 8, scan_limit: 300,
  include_raw: false, cursor: undefined
});

knowledgeRead(store, config, {
  employee_id, device_id, from, to,
  layer: 'raw', // raw | personal | candidate
  id: eventOrCandidateId
});
```

共同规则：员工、设备、UTC 毫秒起止时间必须明确，时间段最多 31 天；公司编号来自服务配置，不能由检索输入覆盖。记录时间过滤不等于业务发生时间已被语义核验。已撤销设备的历史资料仍可由合法范围读取，设备撤销不能据此授予其他设备访问。

- **三个层级分别返回。** `layers.personal` 为个人总结/方法，`layers.candidate` 为总控候选，`layers.raw` 为原始记录。默认只返前两层短摘要；显式 `include_raw` 也只返回原始短预览，正文需按编号单条读取。
- **有界且可继续。** 每层默认扫描 300 条源记录，允许 1–1000，默认返回 8 条、最多 20；候选每个来源最多处理 8 条方法。`scan` 报告本页实际检查量；`next_cursor` 继续更旧窗口，并绑定原身份、时间、关键词和是否读取原始层。游标不是跨查询通用令牌。
- **中文可用，无模型调用。** NFKC 规范化后做大小写不敏感的子串匹配，多组空白分隔关键词要求同时出现，不把 `%`、SQL 片段或通配符当表达式。排序按记录由新到旧，未实现向量语义排序、同义词扩展或全库全文搜索。
- **字段而非整库大 JSON。** 搜索只读取必要字段片段，单字段最多前 4000 字符；原始层也检索应用名和窗口标题，标题命中明确标为元数据，不冒充正文。个人层搜索摘要和方法名称，候选层搜索标题及来源摘要。原始步骤或长稿后半段可能没有被命中；需要时扩大日期、换词或按已知编号查证，不能把无命中解释成“没有发生”。
- **给出可执行的证据定位。** 返回事件编号、哈希和 `read.tool/read.arguments`，可直接交给 `worktrace_knowledge_read`；不拼不存在的网页或伪造 MCP 资源 URI。相关原始引用也重新检查员工、设备和时间范围，未返回数量保留为缺口。
- **不升级模型主张。** 总结和候选的整体依据为 `hypothesis`；详情保留原模型 `claimed_basis`，即使原标注为 observed 也不自动转为核验事实。AI 草稿为 hypothesis，人工修改或 user_confirmed 只保留声明来源，不视为独立身份认证。真实活动记录的 observed 只指捕获到记录，不证明文本中说的业务结果为真。
- **候选使用当前评估视图。** 读取详情时先检查来源设备，再计算当前候选评估状态；定义、稿件或反馈变化后的旧通过记录应显示 stale。离线评估也不使候选具备生产执行权限。
- **输出有上限。** 每次输出最多 128 KiB；详情只读一个对象，文字、数组和层级超限明确标记 `content_truncated`，不加载截图二进制。需要更小回复时降低 `limit`。首次读取会为已有 SQLite 事件建范围索引，这是本地一次性成本；后续只读索引窗口，不建立外部记忆账户。

这增加了一个严格的学习检索入口，不声称原有查询工具或所有 UI 都已改用该入口。自动学习仍需调用方选择合适范围；本次也没有实现无限期回放、向量数据库迁移或模型蒸馏。

## 本地验证

`tests/knowledge.test.mjs` 使用临时 SQLite 和合成人员/记录，测试了中文与 NFKC 查询、窗口标题命中与元数据标记、跨员工/设备/公司拒绝、时间边界、三层游标连续读取、不重复不丢同来源候选、空匹配窗口的继续检索、显式原文与截断、SQL 样式输入、模型主张分级、范围外引用和动态 stale 评估。独立运行 8 项全部通过；没有启动采集、微信或真实模型。整体集成验证以本次发布报告为准。
