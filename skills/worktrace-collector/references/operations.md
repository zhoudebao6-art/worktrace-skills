# 分控操作

使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<本技能目录>/scripts/control.ps1" -Action <动作>`。

- `start`：启动本机服务和可见托盘，不自行开始采集。
- `status`：检查 role、employee_id、device_id、collection、sync 和 pending。
- `init -InputFile "专属登记文件绝对路径.enroll.json"`：绑定公司、员工和电脑。已初始化只返回状态，不覆盖身份。
- `policy -InputFile "公司采集策略绝对路径.json"`：采用完整策略。以 status.collection.policy 为基础，只修改已经确定的字段；不能删掉默认密码工具排除项来解决无法读取。
- `capture -InputFile "动作参数绝对路径.json"`：内容为 `{"enabled":true}` 或 `{"enabled":false}`。
- `sync`：立刻增量补传。成功返回 sent；即使 sent=0，也完成一次身份验证心跳。错误返回非零码，保留本地待传事件。
- `shutdown`：退出本机服务；退出前持久化的 enabled 设置保留，启动时依工作时段恢复。如要求永久暂停，先 capture false。

策略示例（应用需按公司真实软件调整）：
```json
{"interval_seconds":15,"idle_seconds":300,"workdays":[1,2,3,4,5],"start":"09:00","end":"18:00","timezone":"Asia/Shanghai","content_processes":["wps.exe"],"excluded_processes":["keepass.exe","keepassxc.exe","1password.exe"],"excluded_title_terms":["密码","password","支付验证","私人"],"record_titles":false,"screenshots":false}
```

content_processes 中的软件会读取窗口标题和可访问控件名称；编辑框跳过，截图若开启会尝试遮蔽可识别编辑框。UIA 不完整时跳过截图并记录缺口；自绘控件仍需实际应用验证，不能保证所有敏感字段都自动识别。此版不采集原始语音或附件内容。

LAN Join 和 Connect 默认设置当前 Windows 用户登录启动；`-SkipLogonStartup` 仅跳过设置，不删除已有项。其他部署入口按其参数配置软件根目录的“设置登录启动.ps1”。关机、休眠、锁屏或未登录不能保证工作采样，不能声称 24 小时无缺口。

## 已有部署的维护与恢复

先读本技能及同目录 personal、evidence 的 deployment.json，核对唯一 role/root、身份与 connection_mode。联网部署需要恢复服务、MCP 或登录启动时，从已核验完整源码执行 `scripts/Connect-Node.ps1 -WorkDir <原目录> -SkillsDirectory <原技能目录>`；WorkDir 可省略，由三个已装技能绑定发现。日常服务已有配置时使用上面的 start、status、sync。Connect 复用原身份和信任，保持采集/学习开关；`-SkipMcp`、`-SkipLogonStartup` 分别跳过对应设置。离线仅恢复本地服务，不运行 Connect 或询问公司链接。

正常断网、重启或新对话不重新索要链接、登记、重装或清 data。绑定冲突、损坏或数据存在而缺配置时先恢复原配置或明确原目录，不扫描整个磁盘/局域网，也不当作首次安装。旧版在员工电脑按[一次修复指令](https://raw.githubusercontent.com/zhoudebao6-art/worktrace-skills/main/prompts/repair-collector-connection.txt)更新技能并运行新版 Connect；普通仓库地址足够下载，无需公司完整链接。

## 从公司链接在局域网自动接入

仅首次没有任何本机部署或接入状态时，收集完整 `https://github.com/zhoudebao6-art/worktrace-skills/tree/main#worktrace-join=v1.<...>` 公司链接，按[当前下载手册](https://github.com/zhoudebao6-art/worktrace-skills/blob/main/docs/download.md)匿名 clone main。使用本机 Git 或实际发现并 `--version` 核验的 Codex 自带 Git，必要时设置 WORKTRACE_GIT。保留 .git、核验来源和干净 commit，读取 AGENTS.md；旧 v0.4.1 ZIP 不含此入口，不伪造 .worktrace-source.json。已完成部署可以仅用 `Join-Lan.ps1 -WorkDir <原目录>` 续用。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '<完整源码目录>\scripts\Join-Lan.ps1' -ConnectionLink '<完整公司连接链接>' -WorkDir '<本机独立长期目录>' -EmployeeId '<真实唯一员工编号>' -EmployeeName '<真实姓名>' -ComputerLabel '<实际电脑名称>'
```

总控已启用实际 LAN 网段时，无需邀请码、私有接入文件或总控逐台确认。脚本核对公司、HTTPS 地址及公开证书，准备固定 Node、本机服务、三个分控技能、MCP 与身份心跳；正式接入保留 MCP，不传 -SkipMcp。每台电脑本地生成秘密，不借用别人的登记材料或 Codex 登录。自报身份不等于实名核验，employee_id 必须使用真实唯一编号。

首次采集和自动学习关闭，当前用户登录启动默认设置，`-SkipLogonStartup` 可跳过。公司已明确工作范围并授权开始时才加 -StartCapture，保留既有手动暂停。首次真实身份缺失时询问必要字段，不填示例身份。已有离线、其他公司、不同员工或总控部署不能覆盖，换机/增设备由管理员按真实情况处理。

私有请求和登记结果保存在 `WorkDir\setup\lan-enrollment`，包括 request.json 的 request_secret/device_token、enrollment.json。不要输出这些内容，不复制到别的电脑，不放源码或公开 ZIP。首次尚未完成时保留原请求、连接资料和身份在原目录恢复；已完成部署的断网使用 Connect，不再登记。地址或证书真实变化需核验后受控迁移，不接受任意 HubUrl 覆盖或关闭 TLS。

核验 collector 身份、`gpt-6.1-sol/xhigh`、正确 MCP 路径与同步回执；总控 last_seen 更新完成连接验收。真实工作采样、暂停/补传与个人总结到达分别验证，不能用心跳替代。详细流程见[局域网手册](https://github.com/zhoudebao6-art/worktrace-skills/blob/main/docs/lan-join.md)。

## 从私有邀请码首次接入

此入口存在于当前完整 main；按下载手册匿名 clone 并核验，或使用维护者实际交付并校验的完整源码 ZIP，源码与运行目录分开。管理员单独交付的 `.invite.json` 是私有凭证，不能公开、共用或打入源码包。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '<完整源码目录>\scripts\Join-WithInvite.ps1' -InviteFile '<本人私有目录>\device.invite.json' -WorkDir '<本机独立运行目录>' -EmployeeId '<真实唯一员工编号>' -EmployeeName '<实际姓名>' -ComputerLabel '<实际电脑名称>'
```

必要时追加 `-HubUrl '<邀请码允许的HTTPS origin>'`，用于选择已经配置且实际可达的地址；不能自行填写任意地址。跨网使用公司批准的 Tailscale 私有网络时，需要本机与总控已登录并获批，访问策略放行，证书覆盖实际地址。未登录或未实测时报告待完成，禁止关闭证书验证。

`-EnableLogonStartup` 启用当前用户登录启动；`-StartCapture` 只有明确范围及授权开启时才使用，缺省为 false。两者都未指定时，首次接入不会开启采集或设置登录启动。自动学习不会因接入自动开启；后续按公司策略单独验证 `gpt-6.1-sol/xhigh` 并配置。

脚本配置本机服务、三个分控技能、MCP 和身份心跳。`-SkillsDirectory` 仅用于确实由 Codex 读取的自定义技能目录；正式接入通常保留 MCP，不传 `-SkipMcp`。保留 `WorkDir\setup\self-enrollment` 的受限请求状态和登记文件；失败后使用同一邀请码、目录、身份和原参数重试，不删除状态或复制别人的 data。

邀请码限时且只登记一个设备。持码填写姓名是自报身份；employee_id 应使用公司真实唯一编号。已存在该编号（包括撤销记录）时由总控核对后手工处理，不能另造编号绕过或覆盖离线身份。邀请码到期或撤销不影响已登记设备的正常同步；停用设备需总控单独撤销。

验收应分开报告：本机身份与模型正确、总控心跳到达、实际工作活动到达、个人总结到达。心跳成功不代表工作采样和总结已经验证，也不代表员工数据已经被用于学习。
