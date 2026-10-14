# 分控操作

使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<本技能目录>/scripts/control.ps1" -Action <动作>`。

- `start`：启动本机服务和可见托盘；已有记录开关可能在工作时段恢复，先核对原状态和当前运行授权，不把启动当成只读诊断。
- `status`：检查 role、employee_id、device_id、collection、sync 和 pending。
- `init -InputFile "专属登记文件绝对路径.enroll.json"`：绑定公司、员工和电脑。已初始化只返回状态，不覆盖身份。
- `policy -InputFile "公司采集策略绝对路径.json"`：采用完整策略。以 status.collection.policy 为基础，只修改已经确定的字段；不能删掉默认密码工具排除项来解决无法读取。
- `capture -InputFile "动作参数绝对路径.json"`：内容为 `{"enabled":true}` 或 `{"enabled":false}`。
- `sync`：联网模式立刻增量补传，成功返回 sent；sent=0 仍可能完成身份验证心跳。离线返回 skipped/offline 正常，不存在总控心跳。错误保留本地待传事件。
- `shutdown`：退出本机服务；退出前持久化的 enabled 设置保留，启动时依工作时段恢复。如要求永久暂停，先 capture false。

策略示例（应用需按公司真实软件调整）：
```json
{"interval_seconds":15,"idle_seconds":300,"workdays":[1,2,3,4,5],"start":"09:00","end":"18:00","timezone":"Asia/Shanghai","content_processes":["wps.exe"],"excluded_processes":["keepass.exe","keepassxc.exe","1password.exe"],"excluded_title_terms":["密码","password","支付验证","私人"],"record_titles":false,"screenshots":false}
```

content_processes 中的软件会读取窗口标题和可访问控件名称；编辑框跳过，截图若开启会尝试遮蔽可识别编辑框。UIA 不完整时跳过截图并记录缺口；自绘控件仍需实际应用验证，不能保证所有敏感字段都自动识别。聊天语音和附件不自动打开；另行配置的允许目录可以保存 document.version 原件，解析边界见离线手册。

部署要求登录自动启动时，在软件根目录执行“设置登录启动.ps1”，作用于当前 Windows 用户；否则保持手动启动。未经配置的系统休眠、锁屏、开机未登录都不能采样，不能声称 24 小时无缺口。

## 先诊断角色和实际版本

v0.5 提供只读 `worktrace_readiness`，按需检查角色、模式、运行/存储、个人总结缺口和建议下一步；设备多时按返回 pagination 分页。它不调用模型，不放入五秒托盘轮询。没有 MCP 时使用：

```powershell
& '<运行目录>\runtime\node.exe' '<运行目录>\src\admin-cli.mjs' --command readiness --role collector --dir '<运行目录>\data'
```

旧服务没有 readiness 时按 status 与旧版正式诊断入口检查，不能因为新 Skill 写了工具名就假定服务支持。

| 检查对象 | 应读取什么 | 不一致时做什么 |
| --- | --- | --- |
| 正在运行的服务 | 原 data 的 running.json 对应 PID/路径与实际 API version | 核验归属，不改端口再起第二份；先正常停机再升级 |
| 磁盘程序 | 原运行目录 engine-manifest.json 及全部文件哈希 | 按完整发布清单更新受管文件；保留 data、未知修改与冷备 |
| 三个分控 Skill | collector/personal/evidence 的 deployment.json 与文件来源 | 只更新受管文件，保留原 root/role；未更新服务时如实说明 |
| MCP | 该连接的 initialize.serverInfo.version 和数据目录 | 服务更新后重新连接该 WorkTrace MCP，其他连接保持原状 |

## 常见问题的停止条件

| 现象 | 下一步 |
| --- | --- |
| 无总控/不同局域网 | 离线保存与本地学习，人工 wthandoff 移交；不自动建总控、穿透或改成联网 |
| 有记录却没有正文/总结 | 分开核对应用可访问性、允许目录版本、模型与学习开关、未完成批次；无正文则 metadata_only |
| 待处理增长 | 查 selection 有界窗口、内容覆盖与未归组数；优先核查有价值正文/文件，不能把采样数当效率 |
| 模型失败或超时 | 本地离线批次需明确 retry-local 或手动完成；费用预留不自动退回，不因网络恢复自动重复调用 |
| 同 data 已被另一服务占用 | 核验原 PID/启动时间/路径并使用原实例；不删锁、不换端口绕过，不结束其他项目 |
| 卡顿 | 用 Measure-CollectorPerformance 的前后报告；必要时经授权做同应用暂停对照，不静默降质量 |
| 日报缺失但总结已存 | 运行 personal-digest 重建；不要删除总结或重新付费生成 |
| 停电、锁屏、磁盘不足 | 保留 data/WAL 与原件；核对服务和暂停状态，备份后恢复；缺失时段如实列出 |
| 版本或升级失败 | 保持暂停，留存失败现场并用已核验冷备回退；不要重新 Initialize/Join 改身份 |

GitHub 的完整发布包同时包含引擎和 Skill 来源。只有文件名/版本改变不代表运行进程已更新。服务升级需核验旧受管文件、空闲停机、完整冷备、按新旧清单更新原路径、校正绑定、启动核验身份及原证据、重连 MCP；未知改动先给差异报告。性能手册中旧版示例仅适用其明确版本，不用旧包覆盖新的部署。新版结果必须分别报告“技能文件已更新”“服务实际已运行新版”“MCP 已重连”，未做的项目明确保留。
