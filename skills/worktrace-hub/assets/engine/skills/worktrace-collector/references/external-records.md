# 导入已有外部记录

用于用户明确提供的 ActivityWatch JSON 或 Screenpipe OCR/UI 搜索导出。先核对当前分控身份、文件来自哪台工作电脑、采集范围和时间；读取技能不授权安装上游采集器。不会连接上游服务、打开文件路径字段、录音或操作微信。

ActivityWatch 使用带 buckets 对象的官方导出，每个 bucket.hostname 必须与 source_instance 一致。Screenpipe 使用完整 `{data,pagination}` 或 `{pages:[页面...]}`，从 offset=0 收齐所有页面；只接受 OCR/UI，拒绝 Audio/Input/Memory。导出时固定已结束的时间段并使用单机本地结果（include_cloud=false）。device_name 可能是采集设备名称，不用于辨认员工。没有机器标识的导出必须由提供者明确说明来源，导入不构成认证。

在已经部署并运行的分控服务目录使用其 runtime/node.exe；身份从该部署的 config 取值，不在选项中传员工编号。以下均为占位路径和合成实例名，应换成用户提供的值。

将不含正文的选项保存为本地 import-options.json：

```json
{"source":"activitywatch","source_instance":"SYNTHETIC-PC","timezone":"Asia/Shanghai","from":"2026-10-12T00:00:00+08:00","to":"2026-10-13T00:00:00+08:00","dry_run":true}
```

```powershell
& .\runtime\node.exe .\src\admin-cli.mjs --command import-external --role collector --dir '<部署数据目录>' --input '<选项文件>' --records '<来源导出JSON>'
```

先检查 dry_run 返回的数量、排除数、覆盖限制；范围正确后将 dry_run 改为 false 再执行同一命令。导入限 16 MiB、10,000 条和最多 31 天，按来源时间 `[from,to)` 选择。Screenpipe 改 source 为 screenpipe 并指定明确实例标识。重复导入不重复记录，内容变更会整批拒绝；不要换来源名字绕过冲突。

新事件使用协议 1.1；参与同步的分控、总控均需 WorkTrace 0.3 或更高版本。旧的 1.0 事件继续可读。导入仅写入本分控已登记的 SQLite，再经既有 HTTPS/wpack 汇总；不建立新公司、不代替离线首次建档。更新已安装技能不会更新绑定的运行服务，需要分别升级并备份。

ActivityWatch 保持元数据，Screenpipe 保持外部可见文本。provenance 包含来源 ID、摘要、类型和时间；policy_hash 使用传输兼容载体，不证明上游当时策略。导出本身没有数字签名认证，摘要用于追溯与冲突检测。
