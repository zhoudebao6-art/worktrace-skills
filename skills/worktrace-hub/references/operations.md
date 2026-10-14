# 总控操作

本技能目录记为 `<skill>`。命令使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<skill>/scripts/control.ps1" -Action <动作>`。

1. 首次先运行本技能 bootstrap.ps1 搭建环境，见 deployment.md。之后 `start` 启动本机服务；`status` 输出身份、候选本机 IPv4、设备及同步状态，不输出密钥。
2. 首次配置：把实际参数存为 UTF-8 JSON，例如 `{"org_name":"实际公司名称","address":"192.168.1.10","hub_port":19221}`。执行 `-Action init -InputFile "绝对路径/hub.json"`。地址必须来自本机 status.ips，员工电脑需可访问。
3. 登记分控：输入 JSON `{"employee_id":"CS001","employee_name":"实际姓名","label":"实际电脑名称"}`，执行 `-Action enroll -InputFile "绝对路径/employee.json" -OutputFile "受控目录/CS001.enroll.json"`。输出只给文件路径和编号；不要读取其密钥内容到对话。重复调用会创建新设备，先查 status.devices，响应不确定时不要直接重试。
4. 用户要求同一局域网链接自动连接时，按下面 LAN Join 操作启用实际网段并生成公司链接；预先登记方式使用 prepare-fleet.ps1。员工 Codex 在自己的交互桌面执行接入入口，不复制总控 data 或某员工 data 给另一台电脑。
5. 总控本地界面端口 19220，员工同步 HTTPS 端口 19221。由管理员按公司网络策略放行可信局域网；不自动打开公网访问。此版总控不主动连接或操纵员工桌面。
6. CLI 汇总：`-Action report -InputFile "绝对路径/range.json"`。输入如 `{"from":"2026-10-12T16:00:00.000Z","to":"2026-10-13T15:59:59.999Z","employee":"CS001"}` 对应上海 10 月 13 日全天。不要把示例日期当成当前日期。
7. `shutdown` 仅退出本机 WorkTrace 服务。总控停止时分控仍本地记录并保留待传数据。

bootstrap/Join-Node 脚本会登记本机 worktrace MCP，不改变其他 MCP。Skill 下的 deployment.json 是程序路径、角色与版本，可检查；data 下的配置包含凭据，不可贴入对话。

## 局域网链接自动登记

使用已升级运行目录的 `src/admin-cli.mjs`。默认策略 `{"enabled":false,"allowed_cidrs":[]}`；该功能不通过原 control.ps1 的 Action 调用。管理端继续仅本机回环授权访问。

```powershell
& '<总控运行目录>\runtime\node.exe' '<总控运行目录>\src\admin-cli.mjs' --command lan-join-status --role hub --dir '<总控运行目录>\data'
```

返回 policy、active、current_cidrs。将实际公司网卡的精确 CIDR 写为 UTF-8 JSON `{"enabled":true,"allowed_cidrs":["<真实网络地址/掩码>"]}`，不能用示例网段、全网、公网、回环或扩大掩码，最多 8 项。输入必须是当前非回环网卡真实掩码对应的 RFC1918 网段；不自动授权其他 VPN 网络。已取得用户启用授权时直接执行，无需逐台确认员工。

```powershell
& '<总控运行目录>\runtime\node.exe' '<总控运行目录>\src\admin-cli.mjs' --command lan-join-configure --role hub --dir '<总控运行目录>\data' --input '<局域网配置.json>'
& '<总控运行目录>\runtime\node.exe' '<总控运行目录>\src\admin-cli.mjs' --command lan-join-link --role hub --dir '<总控运行目录>\data'
```

把响应中的完整 url 给员工电脑 Codex。该 GitHub 链接片段只包含公司编号/名称、hub_url 和 ca_pem 公开证书，不含邀请码、私钥或设备秘密；不提交到公开源码。普通仓库地址不能代替它。员工取得已校验的 v0.5.2 专用 ZIP 或匿名 main 后运行 Join-Lan.ps1，使用真实身份和独立设备秘密，成功后核对总控 devices/last_seen。

每次登记重验网段与总控地址仍属于当前网卡。DHCP 改址或网卡变化时先修复实际配置，不扩大策略。暂时关闭新登记可输入 `{"enabled":false,"allowed_cidrs":[]}` 调用同一 configure 命令；已登记设备继续正常认证同步，停用单设备需另行撤销 device_id。自动登记信任允许网段内的人自报身份，不等于核实真实姓名。

完整操作及验收见 [deployment.md](deployment.md) 和[局域网手册](https://github.com/zhoudebao6-art/worktrace-skills/blob/main/docs/lan-join.md)。LAN Join 不开启跨网通道、管理端口或远程桌面权限。

## 一次性接入码

本次修订使用运行目录的 `src/admin-cli.mjs`；不要向原 control.ps1 传未实现的 Action。输出目录必须为当前用户受控私有目录，不能是公共源码目录或全员共享。示例均替换为真实路径。

```powershell
& '<总控运行目录>\runtime\node.exe' '<总控运行目录>\src\admin-cli.mjs' --command invitations-create --role hub --dir '<总控运行目录>\data' --output '<私有交付目录>\device.invite.json'
```

默认 7 天、单次登记一个设备，命令只输出文件路径、邀请码编号和有效期，不输出码。需要自定义时以 `--input '<参数.json>'` 传入 `{"expires_in_days":7,"allowed_urls":["https://实际受信地址:19221"]}`；期限仅 1–30 天，总地址数至多 8。地址必须被总控证书覆盖且网络实际可达。不要复制示例地址、随意新增外网 URL 或通过关闭 TLS 校验迁就地址。

查询状态与撤销：

```powershell
& '<总控运行目录>\runtime\node.exe' '<总控运行目录>\src\admin-cli.mjs' --command invitations-list --role hub --dir '<总控运行目录>\data'
& '<总控运行目录>\runtime\node.exe' '<总控运行目录>\src\admin-cli.mjs' --command invitations-revoke --role hub --dir '<总控运行目录>\data' --input '<撤销参数.json>'
```

撤销参数内容为 `{"invite_id":"实际邀请码编号"}`。这些管理动作仍仅通过本机授权接口完成；员工不需要管理令牌。若生成结果不确定，先查列表和目标文件，避免不断创建新码。到期或撤码不撤销已登记设备；停用设备另用本机面板的设备撤销入口，核对 device_id 后操作。

跨网选用 Tailscale 时，登录、设备批准、访问策略和证书地址缺一不可。安装程序完成但未登录时，只能报告软件已准备，不能宣称外网接入完成。邀请码持有人自报真实唯一 employee_id、姓名及电脑名，管理员应按实际人员核对首台到达的身份；没有实际心跳与样本时不报告部署成功。

## 运行、学习与故障检查

按需调用 `worktrace_readiness`，或 `admin-cli.mjs --command readiness --role hub --dir <data>`。设备很多时用 device_id 或 limit/offset 分页，分别检查证据、个人总结和最近日期。raw 已收到但 personal_summary 为零时按 offline-handoff.md 手动 all 审阅，不重建公司或冒充员工补写总结。此检查不调用模型；服务在线不等于已完成学习。

服务 API 版本、运行目录引擎清单、总控 Skill 的 deployment.json、MCP initialize 返回版本分开核验。完整 GitHub 包用于升级源码；仅运行 Install-SharedSkills 不会更新生产服务。原路径受管更新要空闲停机、完整冷备、核对身份和证据、重连自己的 MCP；bootstrap 用于首次建立，不作为覆盖升级入口。

下发任务仅对已建立 HTTPS 同步的设备生效；离线快照设备无法收消息，last_seen 为空正常。每设备轮转领取未确认任务；取消和未确认结果继续重传，不能把回执缺失当完成。原分控不可达时把问题保留为下一次人工交接清单。

自动总控每份批次每本地日最多尝试一次，失败或额度耗尽保留 open 检查点，不再挡住其他批次。查看 status.worker.hub_schedule 的近期尝试与 next_retry_day；旧失败最早在下一本地自然日允许窗口重试，未尝试批次优先，未尝试之间仍按到达顺序。总控每天预算共享，不是按员工均分，也不保证每位员工当夜完成。离线分控失败规则不同，仍需明确 retry-local，不因跨日自动重付费。变更学习设置或自然离开允许时段后迟到的结果不保存，已预留用量不退回。

卡顿先观察自己服务与数据规模，证据/原件/analysis-runs 都是业务数据，不作为缓存清除。不能通过换端口启动同 data 第二实例、删除锁或结束所有 node 进程恢复。任务故障用明确批次与幂等键处理；模型/输入缺口、运行故障、未同步是不同问题，不能用重复初始化统一解决。
