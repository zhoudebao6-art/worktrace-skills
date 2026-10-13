# 采集来源研究与离线适配

核对日期：2026-10-13。研究与测试只访问官方公开资料、使用合成 JSON；没有安装或启动上游软件，没有读取员工屏幕、客户数据或真实导出，没有调用模型。

## 官方来源与版本

| 项目 | 本次核对提交 | 定位、许可与本次取舍 |
| --- | --- | --- |
| [Screenpipe](https://github.com/screenpipe/screenpipe) | `ffeac69dd6b528bf0450e38ec03839e3f172df7f` | 官方介绍已包括工作流程发现和生成 agents/skills；Windows、本地历史与 MCP 可用。当前为 [Screenpipe Commercial License](https://github.com/screenpipe/screenpipe/blob/ffeac69dd6b528bf0450e38ec03839e3f172df7f/LICENSE.md)，不是旧版 MIT；源码或自行编译版本商用需商业许可，组织评估期最多 7 天，官方成品另依订阅条款。本次仅自行实现用户已有 JSON 的读取适配，不复制或捆绑上游实现。 |
| [ActivityWatch](https://github.com/ActivityWatch/activitywatch) | `e0d283f822648d3c05c08bdb3d47cda6d98278da` | Windows、本地 SQLite、事件桶和 JSON 导出，许可为 [MPL-2.0](https://github.com/ActivityWatch/activitywatch/blob/e0d283f822648d3c05c08bdb3d47cda6d98278da/LICENSE.txt)。适合作为活动记录来源；活动时长、窗口标题不能证明完整操作方法。暂不分发上游组件或修改其源码。 |
| ActivityWatch `aw-server` / `aw-core` | `6d29c4c9d377d9ef18a3341ef654b3f40da8c06f` / `28c3acf047b225f90592e1c47c8ec2596612d70b` | 以实际 REST 导出实现和 Event 序列化核对字段，不仅依赖过时的 JSON schema 描述。 |

可直接对接的是数据接口，不是把上游的许可、服务、控制权限或效果承诺一并拿来使用。Screenpipe 的商业部署或源码复用另行决定；ActivityWatch 的 MPL 条件在实际分发或修改上游文件时另行落实。

## ActivityWatch 的真实导出形状

官方 [导出说明](https://docs.activitywatch.net/en/latest/features/exporting-data.html) 的全量和单桶 JSON 接口均返回 `{"buckets":{"桶编号":{...桶元数据,"events":[...]}}}`。实际依据是 [REST 输出](https://github.com/ActivityWatch/aw-server/blob/6d29c4c9d377d9ef18a3341ef654b3f40da8c06f/aw_server/rest.py) 和 [export_bucket 实现](https://github.com/ActivityWatch/aw-server/blob/6d29c4c9d377d9ef18a3341ef654b3f40da8c06f/aw_server/api.py)。`aw_core/schemas/export.json` 把 buckets 写为数组，与此实现不一致；本适配器只接受真实导出的对象映射，拒绝猜测数组含义。

```json
{"buckets":{"aw-watcher-window_SYNTHETIC-PC":{"id":"aw-watcher-window_SYNTHETIC-PC","type":"currentwindow","client":"aw-watcher-window","hostname":"SYNTHETIC-PC","events":[{"timestamp":"2026-10-12T09:30:00+08:00","duration":30,"data":{"app":"synthetic.exe","title":"合成标题"}}]}}}
```

Python 服务导出会主动删除 event.id，Rust 导出可能保留。因此事件身份按已登记员工/设备、来源实例、桶编号和来源发生时间建立，不依赖导出顺序或可选 id。相同身份但时长、数据或桶类型发生变化时拒绝覆盖；建议导出已经结束的时间段，避免尚在续写的 heartbeat。毫秒内同桶多个不同事件会作为身份冲突拒绝，需要人工核对，不能静默合并。

每个桶的 hostname 必须与操作者指定的 source_instance 完全一致，多台电脑的混合导出需先在来源端按电脑拆分。`data.app/title` 仅映射应用元数据，`data.text`、URL、自定义字段不会作为正文。duration 保留在 provenance 中，不能直接累加工时，也不能推出具体键鼠操作。其他字段只参与来源摘要，不完整复制到 WorkTrace。

## Screenpipe 的只读搜索结果

依据官方 [搜索 OpenAPI](https://docs.screenpipe.com/api-reference/search/search-screen-and-audio-content)（API 1.0.0），接受 `{data:[{type,content}],pagination:{limit,offset,total}}`，或把原始页面按顺序放入 `{pages:[第一页,第二页,...]}`。

```json
{"data":[{"type":"OCR","content":{"frame_id":1,"text":"合成可见文字","timestamp":"2026-10-12T01:30:00Z","app_name":"synthetic.exe","window_name":"合成窗口"}}],"pagination":{"limit":10,"offset":0,"total":1}}
```

仅接受 `OCR`（frame_id）与 `UI`（id）的原始观察文本，保留来源类型。拒绝 Audio、Input 和模型生成的 Memory，避免混入未经本次授权的输入记录或把总结重新包装成原始证据。可见文本不证明谁发送消息、是否点了按钮、是否成功保存或案件是否办结。

要求第一页 offset=0、连续 offset、相同 total、中间页满额、最后数量达到 total，且页面之间不能重复记录。检查只证明提供页面自洽，无法发现操作者删改 JSON 或上游采集漏报。导出应固定查询范围、关闭云端混合（`include_cloud=false`），在时间段结束后收齐页面。上游截断后的正文不能由本适配器还原。

来源实例由操作者明确绑定单机导出；若内容含 machine_id 则必须匹配。不要拿 device_name 猜员工电脑：上游 [搜索实现](https://github.com/screenpipe/screenpipe/blob/ffeac69dd6b528bf0450e38ec03839e3f172df7f/crates/screenpipe-db/src/db/search.rs) 将其与 video_chunks 等采集设备关联，machine_id 是独立条件。旧 UI/OCR 响应不一定携带电脑标识，导入本身不构成身份认证。

本次不会访问任何导出中的 file_path、URL 或 frame 字段，不读取视频、不生成截图附件、不连接本地上游 API，也不执行文本中的命令。

## WorkTrace 接口与同步

```javascript
import {normalizeExternalRecords,importExternalRecords} from './src/external-records.mjs';
const options={source:'activitywatch',source_instance:'SYNTHETIC-PC',
  org_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  device_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',employee_id:'SYNTHETIC-EMPLOYEE',
  timezone:'Asia/Shanghai',from:'2026-10-12T00:00:00+08:00',to:'2026-10-13T00:00:00+08:00'};
// input 是操作者已经提供的 JSON 文本、UTF-8 Buffer 或普通 JSON 对象。
const preview=normalizeExternalRecords(input,options);
const receipt=importExternalRecords(store,input,options);
```

所有 options 字段均必填。from/to 必须带时区，范围为 `[from,to)`，最多 31 天。按来源发生时间筛选，排除数量会报告；这不证明导出的桶或搜索结果覆盖了该时间段的全部工作。输入限 16 MiB、10,000 条记录、500 个 ActivityWatch 桶和 1,000 页，并限制 JSON 深度及节点数。超限应从来源端缩小导出范围，不能通过跳过页面解决。文本超过 12,000 字符或应用字段截短时标记 truncated，来源摘要仍覆盖截短前的记录。

规范化输出 `{events,policies,report}`；导入返回 `{added,duplicates,event_ids,report}`。真正导入会校验已经登记且未撤销的员工设备，将新事件追加到本地同步流；重导出、顺序变化和重试不会再次入库或重新制造待同步记录。冲突整批拒绝，不部分写入。导入不会更改当前采集策略或启动服务。

外部事件使用 schema_version `1.1`、activity.snapshot 和严格 provenance；原有事件仍使用 1.0。涉及外部事件的总控/分控必须一起升级到支持该规范的 WorkTrace 0.3，旧端应拒收。ActivityWatch 的 payload.text 为空、capture_status 为 activity_only；Screenpipe 有文字时为 external_text，不能伪装成本机 UIA 或执行动作。policy_hash 附带兼容旧传输的策略载体，其内容不是上游真实采集策略证明，也不会扩大本机记录授权。

导入入口由本机已认证管理员提供，组织/员工/设备身份应取运行配置，不能直接信任 JSON 自带身份。导入纯函数的预览流编号只用于稳定输出；需要进入正常同步必须调用 importExternalRecords，而非把预览事件直接 ingest。

## 借鉴、暂缓与验证边界

- 直接复用接口：ActivityWatch JSON 桶、Screenpipe OCR/UI 搜索结果，统一纳入 WorkTrace 原始事件、个人总结和离线 wpack 证据链；新增依赖为零。
- 借鉴设计：事件与元数据分离、保留来源时间、先筛选再交模型、先验证覆盖再生成流程。官方 [ActivityWatch AI 指南](https://docs.activitywatch.net/en/latest/examples/agents-and-ai.html) 同样建议时间范围限定与本地聚合。
- 暂缓：上游后台自动采集、云端历史、音频、键盘输入、自动执行上游 pipes、商业组件集成。当前需求可先用明确边界的离线适配验证价值。
- 已用合成测试验证：官方形状、时区及非法日期、员工设备绑定、元数据不冒充正文、完整分页、体积限制、幂等与冲突整批拒绝、同步 ACK 不重复、加密 wpack 导出再导入保存 provenance。
- 尚未验证：真实上游实例导出兼容性、Windows 采集质量、员工岗位方法提取效果、模型输出质量和业务验收。通过解析测试不等于已学会替代员工。
