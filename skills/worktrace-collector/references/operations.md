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

LAN Join 和 Connect 默认设置当前 Windows 用户登录启动；`-SkipLogonStartup` 仅跳过设置，不删除已有项。其他部署入口按其参数配置软件根目录的“设置登录启动.ps1”。关机、休眠、锁屏或未登录不能保证工作采样，不能声称 24 小时无缺口。

## 已有部署的维护与恢复

先读本技能及同目录 personal、evidence 的 deployment.json，核对唯一 role/root、身份与 connection_mode。联网部署需要恢复服务、MCP 或登录启动时，从已核验完整源码执行 `scripts/Connect-Node.ps1 -WorkDir <原目录> -SkillsDirectory <原技能目录>`；WorkDir 可省略，由三个已装技能绑定发现。先用 status/readiness 只读检查；确需恢复且已确认无冲突实例时才 start 或 Connect，再验 sync。Connect 不替代引擎受管升级，另核对实际 API 版本。Connect 复用原身份和信任，保持采集/学习开关；`-SkipMcp`、`-SkipLogonStartup` 分别跳过对应设置。离线仅恢复本地服务，不运行 Connect 或询问公司链接。

正常断网、重启或新对话不重新索要链接、登记、重装或清 data。绑定冲突、损坏或数据存在而缺配置时先恢复原配置或明确原目录，不扫描整个磁盘/局域网，也不当作首次安装。旧版在员工电脑按[一次修复指令](https://raw.githubusercontent.com/zhoudebao6-art/worktrace-skills/main/prompts/repair-collector-connection.txt)更新技能并运行新版 Connect；普通仓库地址足够下载，无需公司完整链接。

## 从公司链接在局域网自动接入

仅首次没有任何本机部署或接入状态时，收集完整 `https://github.com/zhoudebao6-art/worktrace-skills/tree/main#worktrace-join=v1.<...>` 公司链接，按[当前下载手册](https://github.com/zhoudebao6-art/worktrace-skills/blob/v0.5.2/docs/download.md)下载并校验 v0.5.2 专用发布 ZIP，也可匿名 clone main。使用本机 Git 或实际发现并 `--version` 核验的 Codex 自带 Git，必要时设置 WORKTRACE_GIT。Git 来源保留 .git 并核验干净 commit；专用 ZIP 校验 .worktrace-source.json，读取 AGENTS.md；旧 v0.4.1 ZIP 不含此入口，不伪造 .worktrace-source.json。已完成部署可以仅用 `Join-Lan.ps1 -WorkDir <原目录>` 续用。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '<完整源码目录>\scripts\Join-Lan.ps1' -ConnectionLink '<完整公司连接链接>' -WorkDir '<本机独立长期目录>' -EmployeeId '<真实唯一员工编号>' -EmployeeName '<真实姓名>' -ComputerLabel '<实际电脑名称>'
```

总控已启用实际 LAN 网段时，无需邀请码、私有接入文件或总控逐台确认。脚本核对公司、HTTPS 地址及公开证书，准备固定 Node、本机服务、三个分控技能、MCP 与身份心跳；正式接入保留 MCP，不传 -SkipMcp。每台电脑本地生成秘密，不借用别人的登记材料或 Codex 登录。自报身份不等于实名核验，employee_id 必须使用真实唯一编号。

首次采集和自动学习关闭，当前用户登录启动默认设置，`-SkipLogonStartup` 可跳过。公司已明确工作范围并授权开始时才加 -StartCapture，保留既有手动暂停。首次真实身份缺失时询问必要字段，不填示例身份。已有离线、其他公司、不同员工或总控部署不能覆盖，换机/增设备由管理员按真实情况处理。

私有请求和登记结果保存在 `WorkDir\setup\lan-enrollment`，包括 request.json 的 request_secret/device_token、enrollment.json。不要输出这些内容，不复制到别的电脑，不放源码或公开 ZIP。首次尚未完成时保留原请求、连接资料和身份在原目录恢复；已完成部署的断网使用 Connect，不再登记。地址或证书真实变化需核验后受控迁移，不接受任意 HubUrl 覆盖或关闭 TLS。

核验 collector 身份、gpt-6.1-sol（新建默认 xhigh，已有合法 high/xhigh 保留）、正确 MCP 路径与同步回执；总控 last_seen 更新完成连接验收。真实工作采样、暂停/补传与个人总结到达分别验证，不能用心跳替代。详细流程见[局域网手册](https://github.com/zhoudebao6-art/worktrace-skills/blob/main/docs/lan-join.md)。

## 从私有邀请码首次接入

此入口包含在 v0.5.2 专用发布 ZIP 及兼容完整 main；按下载手册校验发布包或匿名 clone 的干净 commit，源码与运行目录分开。管理员单独交付的 `.invite.json` 是私有凭证，不能公开、共用或打入源码包。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '<完整源码目录>\scripts\Join-WithInvite.ps1' -InviteFile '<本人私有目录>\device.invite.json' -WorkDir '<本机独立运行目录>' -EmployeeId '<真实唯一员工编号>' -EmployeeName '<实际姓名>' -ComputerLabel '<实际电脑名称>'
```

必要时追加 `-HubUrl '<邀请码允许的HTTPS origin>'`，用于选择已经配置且实际可达的地址；不能自行填写任意地址。跨网使用公司批准的 Tailscale 私有网络时，需要本机与总控已登录并获批，访问策略放行，证书覆盖实际地址。未登录或未实测时报告待完成，禁止关闭证书验证。

`-EnableLogonStartup` 启用当前用户登录启动；`-StartCapture` 只有明确范围及授权开启时才使用，缺省为 false。两者都未指定时，首次接入不会开启采集或设置登录启动。自动学习不会因接入自动开启；后续按公司策略单独验证 gpt-6.1-sol 与实际 high/xhigh 并配置，既有强度不静默改变。

脚本配置本机服务、三个分控技能、MCP 和身份心跳。`-SkillsDirectory` 仅用于确实由 Codex 读取的自定义技能目录；正式接入通常保留 MCP，不传 `-SkipMcp`。保留 `WorkDir\setup\self-enrollment` 的受限请求状态和登记文件；失败后使用同一邀请码、目录、身份和原参数重试，不删除状态或复制别人的 data。

邀请码限时且只登记一个设备。持码填写姓名是自报身份；employee_id 应使用公司真实唯一编号。已存在该编号（包括撤销记录）时由总控核对后手工处理，不能另造编号绕过或覆盖离线身份。邀请码到期或撤销不影响已登记设备的正常同步；停用设备需总控单独撤销。

验收应分开报告：本机身份与模型正确、总控心跳到达、实际工作活动到达、个人总结到达。心跳成功不代表工作采样和总结已经验证，也不代表员工数据已经被用于学习。

## 先诊断角色和实际版本

v0.5.2 提供只读 `worktrace_readiness`，按需检查角色、模式、运行/存储、个人总结缺口和建议下一步；设备多时按返回 pagination 分页。它不调用模型，不放入五秒托盘轮询。没有 MCP 时使用：

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
