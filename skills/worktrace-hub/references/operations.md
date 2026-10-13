# 总控操作

本技能目录记为 `<skill>`。命令使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<skill>/scripts/control.ps1" -Action <动作>`。

1. 首次先运行本技能 bootstrap.ps1 搭建环境，见 deployment.md。之后 `start` 启动本机服务；`status` 输出身份、候选本机 IPv4、设备及同步状态，不输出密钥。
2. 首次配置：把实际参数存为 UTF-8 JSON，例如 `{"org_name":"实际公司名称","address":"192.168.1.10","hub_port":19221}`。执行 `-Action init -InputFile "绝对路径/hub.json"`。地址必须来自本机 status.ips，员工电脑需可访问。
3. 登记分控：输入 JSON `{"employee_id":"CS001","employee_name":"实际姓名","label":"实际电脑名称"}`，执行 `-Action enroll -InputFile "绝对路径/employee.json" -OutputFile "受控目录/CS001.enroll.json"`。输出只给文件路径和编号；不要读取其密钥内容到对话。重复调用会创建新设备，先查 status.devices，响应不确定时不要直接重试。
4. 用户要求同一局域网链接自动连接时，按下面 LAN Join 操作启用实际网段并生成公司链接；预先登记方式使用 prepare-fleet.ps1。员工 Codex 在自己的交互桌面执行接入入口，不复制总控 data 或某员工 data 给另一台电脑。
5. 总控本地界面端口 19220，员工同步 HTTPS 端口 19221。由管理员按公司网络策略放行可信局域网；不自动打开公网访问。此版总控不主动连接或操纵员工桌面。
6. CLI 汇总：`-Action report -InputFile "绝对路径/range.json"`。输入如 `{"from":"2026-10-12T16:00:00.000Z","to":"2026-10-13T15:59:59.999Z","employee":"CS001"}` 对应上海 10 月 13 日全天。不要把示例日期当成当前日期。
7. `shutdown` 仅退出本机 WorkTrace 服务。总控停止时分控仍本地记录并保留待传数据。

bootstrap/Join-Node 脚本会登记本机 worktrace MCP，不改变其他 MCP。Skill 下的 deployment.json 只有程序路径和角色，可检查；data 下的配置包含凭据，不可贴入对话。

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

把响应中的完整 url 给员工电脑 Codex。该 GitHub 链接片段只包含公司编号/名称、hub_url 和 ca_pem 公开证书，不含邀请码、私钥或设备秘密；不提交到公开源码。普通仓库地址不能代替它。员工匿名取得当前 main 后运行 Join-Lan.ps1，使用真实身份和独立设备秘密，成功后核对总控 devices/last_seen。

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
