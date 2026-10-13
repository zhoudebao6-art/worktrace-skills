# 从工作记录到可核验候选：OpenAdapt 与 UFO 研究及本次实现

研究日期：2026-10-13。来源为官方仓库的代码、接口、许可和状态文档。本次没有安装或运行 OpenAdapt/UFO，没有调用真实模型、控制业务软件或采集员工数据；上游自述与基准成绩不能当作本项目的实测结论。

## 研究快照

| 官方项目 | 本次核对提交 | 与本项目的关系 |
| --- | --- | --- |
| [OpenAdapt](https://github.com/OpenAdaptAI/OpenAdapt/tree/7ae7ebc02048f41dd820ad826d3e78c4dcce2cd2) | `7ae7ebc02048f41dd820ad826d3e78c4dcce2cd2` | 当前组件入口；应区分新组件与历史单体实现 |
| [openadapt-flow](https://github.com/OpenAdaptAI/openadapt-flow/tree/6e4e4ed0fe4addedd7c38ced44176b42bc40165a) | `6e4e4ed0fe4addedd7c38ced44176b42bc40165a` | 显式演示、编译、执行及效果验收 |
| [openadapt-capture](https://github.com/OpenAdaptAI/openadapt-capture/tree/986ebaeae6700c58b0e523b54471ce8d3ef01925) | `986ebaeae6700c58b0e523b54471ce8d3ef01925` | 对齐录屏与输入事件的演示采集 |
| [openadapt-desktop](https://github.com/OpenAdaptAI/openadapt-desktop/tree/a6faa188085a18a0c05af551303902f649542793) | `a6faa188085a18a0c05af551303902f649542793` | 桌面界面和组件编排，不能只看界面就认定执行已成熟 |
| [Microsoft UFO](https://github.com/microsoft/UFO/tree/a795552d976c4c019d7c2f778a0effb5cef7de6b) | `a795552d976c4c019d7c2f778a0effb5cef7de6b` | Windows 任务执行及从任务经验、演示中检索复用 |

OpenAdapt 各仓库主体代码采用 MIT；Flow 的第三方说明另列 Git 源码中的部分 AGPL 基准材料，以及 FFmpeg 等组件的单独许可边界。UFO 的根许可为 MIT。若以后打包上游代码或二进制，应按实际文件和依赖保留相应许可；不能将仓库主体许可推及全部第三方内容。本次没有复制上游源码或随包分发上游组件。[Flow 第三方说明](https://github.com/OpenAdaptAI/openadapt-flow/blob/6e4e4ed0fe4addedd7c38ced44176b42bc40165a/THIRD_PARTY_NOTICES.md)、[UFO 许可](https://github.com/microsoft/UFO/blob/a795552d976c4c019d7c2f778a0effb5cef7de6b/LICENSE)。

## 实际读到的接口及适配判断

OpenAdapt Flow 的 `Effect` 描述操作完成后应该成立的条件，例如目标记录存在、字段达到指定值、出现精确的新记录集合。`ValueExpr` 可引用本次运行的参数，避免误把演示时的旧记录当成新结果。`EffectVerifier` 将确认、否定和无法确定区分开；业务接口、数据库或文件的独立回读，比执行模型宣称成功更有说服力。这些是接口设计，不代表已经为我们的案件系统提供适配器。[实际代码 effect.py](https://github.com/OpenAdaptAI/openadapt-flow/blob/6e4e4ed0fe4addedd7c38ced44176b42bc40165a/openadapt_flow/runtime/effects/effect.py)。

Flow 的输入是一次有边界的演示及对应事件、画面等信息。WorkTrace 日常活动采样缺少连续鼠标/键盘操作、任务开始结束和足够密集的执行前后状态，不能直接改名后作为有效演示输入。将来有必要对一个固定任务补录演示并做格式适配；本次不引入键盘录制。[官方录制格式与流程](https://github.com/OpenAdaptAI/openadapt-flow/blob/6e4e4ed0fe4addedd7c38ced44176b42bc40165a/docs/desktop/RECORDING.md)。

Windows 路径有实际 UIA 支持，但官方状态中的特定 WinForms 验收、合成分支/循环用例和平台声明，都不能证明微信、WPS、化工绘图软件已具备稳定执行能力。Desktop 也明确列出未完成的安装与联合验证工作。接入前应选一个目标软件、固定版本和小任务做隔离验证。[Flow 产品状态](https://github.com/OpenAdaptAI/openadapt-flow/blob/6e4e4ed0fe4addedd7c38ced44176b42bc40165a/docs/PRODUCT_STATUS.md)、[Desktop 实现状态](https://github.com/OpenAdaptAI/openadapt-desktop/blob/a6faa188085a18a0c05af551303902f649542793/docs/IMPLEMENTATION_STATUS.md)。

UFO 的 `ExperienceSummarizer` 从分段任务日志提取经验，生成带请求、子任务、应用和提示信息的结构化结果，再写入 YAML 与向量库。它让以后的任务可以找到相关经验；这属于经验整理与检索，并非自动训练出某员工的模型权重，也不是业务效果验证。[实际经验总结代码](https://github.com/microsoft/UFO/blob/a795552d976c4c019d7c2f778a0effb5cef7de6b/ufo/experience/summarizer.py)。

`DemonstrationSummarizer` 处理明确的演示记录并调用模型生成可复用样例；`Retriever` 再通过相似检索取回上下文。现有检索代码加载本地 FAISS 时允许危险反序列化，因此本项目不接收其他电脑直接提交的这类二进制索引，而以已有的 JSON、SQLite 和事件摘要作为来源。未来需要向量检索时，应从已校验的文本重新生成本地索引。[演示总结实现](https://github.com/microsoft/UFO/blob/a795552d976c4c019d7c2f778a0effb5cef7de6b/record_processor/summarizer/summarizer.py)、[检索实现](https://github.com/microsoft/UFO/blob/a795552d976c4c019d7c2f778a0effb5cef7de6b/ufo/rag/retriever.py)。

| 研究启发 | 本次已经实现 | 直接复用及暂缓事项 |
| --- | --- | --- |
| 验收应独立于执行模型自报 | 预先登记参考、已保存输出、后续反馈和程序精确匹配；缺证失败 | 独立实现 Node 模块；没有移植 OpenAdapt 效果验证器，也没有业务系统回读 |
| 经验需要任务与来源边界 | 候选绑定来源摘要、训练范围及不可覆盖的评估历史 | 沿用本地事件与 SQLite；没有复制 UFO 的 FAISS/YAML 加载器 |
| 演示与执行结果必须分开 | 训练与评估按事件、任务、案件隔离，正常/缺输入/反例均需覆盖 | 尚未录制目标软件演示、编译执行计划或验证真实软件效果 |
| 经验改变后要重新验证 | 候选内容、适配器声明、稿件新版或反馈变化使旧通过失效 | 后续真实执行适配器必须有自己的版本、授权边界和效果验收 |

## 候选评估的实际用法

实现位于 `src/candidates.mjs`，延续原有候选列表和候选推导，不自动发布、安装或执行候选。新增 `candidateEvaluate`、`candidateEvaluationHistory`、`candidateDefinitionHash` 与供 API/MCP 复用的 `candidateEvaluationSchema`。调用端应从服务配置注入 `org_id`，不允许用户选择别的组织。

一次完整离线评估按以下顺序准备，所有材料通过已有业务事件入口保存：

1. 获取候选全文中的 `definition_sha256`，冻结此次候选内容。
2. 分别准备正常、缺输入、反例三个样例；使用未进入训练范围的案件和任务，并且三个样例彼此不共用案件、任务或证据。
3. 每个任务先保存输入，再保存一个 `source_kind: human`、`kind: review` 的参考版本。参考正文使用下方 JSON 契约；需要独立人员预先确认参考才具有实际验收意义。
4. 再保存模型产生的 `source_kind: ai` 输出。参考与输出使用不同 `artifact_id`。
5. 最后保存指向该输出的 `artifact.feedback`。本模块要求最新反馈为 `adopted`、`reason_source: user_confirmed` 且有原因，但这些字段只是已存来源标记，不是身份认证或独立审批证明。
6. 使用新的幂等键提交三个样例。每个样例提供输入、输出、参考、反馈的事件编号；评估只读取已保存证据，不调用模型。

参考正文示例（占位符必须替换为真实编号和候选摘要）：

```json
{
  "format": "worktrace.candidate-reference/1.0",
  "candidate_id": "<候选 UUID>",
  "candidate_hash": "<definition_sha256>",
  "kind": "missing_input",
  "expected_behavior": "request_input",
  "input_event_ids": ["<已有输入事件 UUID>"],
  "expected_text": "请补充材料名称和对应案件编号后再继续。"
}
```

`normal` 对应 `draft`，`missing_input` 对应 `request_input`，`counterexample` 对应 `halt`。这些是离线样例的预期行为标签；文本相符并不能证明软件已停止操作或已完成真实动作。当前契约适合固定文本、固定格式草稿和确定性规则样例；开放式客服回复不能因为与参考措辞不同就推断业务质量差，应另行设计业务验收。

模块调用示例（API/MCP 入口使用相同请求字段，但不让调用者传 `org_id`）：

```js
candidateEvaluate(store, {
  candidate_id,
  org_id: serviceConfig.org_id,
  idempotency_key: 'review-20261013-001',
  cases: [
    {kind: 'normal', task_id, input_event_ids, output_event_id, reference_event_id, feedback_event_id},
    // 继续提交独立 missing_input 和 counterexample 样例
  ],
  notes: '固定模板离线样例；尚未验收软件执行和业务效果'
});
```

每次允许 1–12 个样例，每个样例 1–20 条输入。只提交一类时可以记录评估，但不会完整通过。输入、参考、输出和反馈的先后关系按数据库收录顺序检查，不能用调用者修改的时间字段伪装；离线导入也必须保持证据顺序。

| 当前状态 | 含义 |
| --- | --- |
| `pending` | 尚无评估 |
| `incomplete` | 已提交样例符合契约，但缺少必要种类 |
| `failed` | 至少一个样例不满足证据、隔离、顺序、反馈或文本契约 |
| `offline_evidence_passed` | 三种样例齐全且全部满足离线精确文本契约 |
| `stale` | 旧通过所依赖的候选定义、稿件或最新反馈已改变，需要重评 |

所有状态下候选均为 `draft`，`execution_ready` 与 `business_effect_verified` 均为 `false`。最新失败或不完整会替换候选当前的旧通过状态。相同幂等键、相同请求返回原历史记录；若之后已有失败，重试旧成功也不能恢复通过，调用者应读取 `current_evaluation_status`。相同键传不同内容直接拒绝。

评估历史保存候选定义摘要、训练范围摘要、各样例引用与结果、覆盖情况和局限说明，并写入审计记录。历史通过是过去某次评估的事实，不能当作当前候选可执行的授权。

## 拒绝反馈之后正式登记修订

导出目录里的 Skill/Loop 文件是工作稿。修改文件不会自动改变数据库中的候选，也不会让旧评估覆盖新文件。总控现在通过 `candidateRevise` 正式登记修订，通过 `candidateRevisionHistory` 查询修订历史；不直接修改 SQLite。API/MCP 使用导出的 `candidateRevisionSchema`，公司编号仍由服务配置注入。

先查询当前候选及最新反馈。若原通过样例新增了拒绝反馈，当前显示 `stale`；旧通过仍留在评估历史。可以先用最新反馈和新幂等键保存失败评估，再基于原训练材料修订说明与步骤：

```js
const current = candidateList(store, {candidate_id})[0];
const nextLoop = structuredClone(current.loop);
nextLoop.held_out_evaluation = 'pending';
// 在 nextLoop 中修改有依据的步骤；保留原始引用和退出条件。
const saved = candidateRevise(store, {
  candidate_id,
  org_id: serviceConfig.org_id,
  idempotency_key: 'revision-20261013-001',
  expected_definition_sha256: current.definition_sha256,
  skill_md: revisedSkillText,
  loop: nextLoop,
  reason: '说明具体修改内容、依据和仍未知的部分'
});
```

修订保留当前 `candidate_id`。初始版本为 1，首次修订为 2；新旧定义、内容摘要、原因、先前评估状态和审计在同一事务保存。`expected_definition_sha256` 防止用过期草稿覆盖别人已保存的新定义。没有内容变化时不创建空修订。相同幂等键只能用于相同请求；重试较早的成功修订只返回当时回执与当前版本，不回滚后续版本。

可登记内容有明确边界：

- `skill_md` 最多 60,000 字符，须有 frontmatter 与正文；frontmatter 只接受各一行 `name` 和 `description`，保留原候选名称。
- `loop` 必须沿用 `worktrace.loop-draft/1.0` 的完整字段结构，`status=draft`、`execution_adapter=null`、`held_out_evaluation=pending`；循环和模型调用上限均为 1–3。
- 原总结、员工、训练范围和证据清单不变。步骤中的 claim 只能引用该训练范围内的原始事件；不能引入验收案例、派生总结或其他来源。观察事实必须有引用，推断与未知须按对应 basis 标记。
- 保留“没有新增证据”“输入或判断依据不足”“需要外发或修改业务系统”“达到三轮上限”四项退出条件，可补充其他条件。不能通过修订开放桌面执行、外发或任意命令字段。

新定义登记后，当前评估变为 `pending`，原通过不沿用；下一轮参考契约须绑定返回的 `current_definition_sha256`。旧参考直接用于新定义会失败。修订登记只验证格式、来源范围与状态，不验证 Markdown 中的业务主张是否正确。

`candidateRevisionHistory(store,{candidate_id,org_id})` 默认返回最近 20 条摘要，不反复输出长篇定义；`include_definitions:true` 返回历史中的 `previous_definition` 与 `definition`，每次最多三条。修订与评估表都属于总控数据库，搬迁总控时需要完整备份 `data`，不能只靠传输事件的 wpack。

## 仍然不能证明的事情及下一步

编号隔离不能识别把相同材料改编号后重复使用，也不能证明生成输出的模型没看过参考答案。现有 `human` 和 `user_confirmed` 标记可由有权写入事件的客户端填报；因此本模块只验证记录之间的关系和文本契约，不能作为防伪人工签名或可信审批系统。

观察员工几天通常只能得到“在什么窗口做了什么”的部分证据。没有输入来源、动作意图、未发生的分支、隐藏业务状态、失败修复以及可独立核验的结果，无法知道某次操作为什么正确。更多录像本身不会补齐这些缺口。自动提炼出的 Skill/Loop 应持续保留未知项，并针对少量重复任务补充演示和反例。

后续进入真实执行前，应选一个边界明确的小任务，提供完整输入、固定目标软件环境和允许动作；保留独立测试案件；再实现按运行参数查询结果的业务适配器，检查预期变化、重复执行和附带损失。API/数据库可用时优先用它们核验；只有画面时明确标记证据强度。该阶段完成前，不应将离线文本匹配改名为“岗位替代成功”。

## 本次验证范围

`tests/candidate-evaluation.test.mjs` 的 14 个测试覆盖三种案例、训练重叠、组织/员工边界、缺失证据、事后参考、模型自报、最新反馈、失败降级、幂等审计、候选变化和版本失效，以及修订前后定义持久化、并发摘要保护、旧请求重试、引用/权限边界、重新验收和事务失败回滚。与原有 `tests/analysis.test.mjs` 的 3 个测试一起运行，共 17 个通过。

```powershell
$env:TEMP = 'D:\codex+\temp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
$env:NODE_COMPILE_CACHE = 'D:\codex+\cache\worktrace\node'
node --test tests/candidate-evaluation.test.mjs tests/analysis.test.mjs
```

测试使用隔离 SQLite、合成员工与合成稿件，未产生真实客户回复或软件操作。它证明上述存储、范围校验与状态行为通过测试，尚不证明实际客服质量、化工专业判断或桌面执行可靠性。
