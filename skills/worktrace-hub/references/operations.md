# 总控操作

本技能目录记为 `<skill>`。命令使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<skill>/scripts/control.ps1" -Action <动作>`。

1. 首次先运行本技能 bootstrap.ps1 搭建环境，见 deployment.md。之后 `start` 启动本机服务；`status` 输出身份、候选本机 IPv4、设备及同步状态，不输出密钥。
2. 首次配置：把实际参数存为 UTF-8 JSON，例如 `{"org_name":"实际公司名称","address":"192.168.1.10","hub_port":19221}`。执行 `-Action init -InputFile "绝对路径/hub.json"`。地址必须来自本机 status.ips，员工电脑需可访问。
3. 登记分控：输入 JSON `{"employee_id":"CS001","employee_name":"实际姓名","label":"实际电脑名称"}`，执行 `-Action enroll -InputFile "绝对路径/employee.json" -OutputFile "受控目录/CS001.enroll.json"`。输出只给文件路径和编号；不要读取其密钥内容到对话。重复调用会创建新设备，先查 status.devices，响应不确定时不要直接重试。
4. 优先用 prepare-fleet.ps1 按清单准备分控接入，由员工 Codex 在自己的交互桌面执行接入入口。不要复制总控 data 或某员工的 data 给另一台电脑。
5. 总控本地界面端口 19220，员工同步 HTTPS 端口 19221。由管理员按公司网络策略放行可信局域网；不自动打开公网访问。此版总控不主动连接或操纵员工桌面。
6. CLI 汇总：`-Action report -InputFile "绝对路径/range.json"`。输入如 `{"from":"2026-10-12T16:00:00.000Z","to":"2026-10-13T15:59:59.999Z","employee":"CS001"}` 对应上海 10 月 13 日全天。不要把示例日期当成当前日期。
7. `shutdown` 仅退出本机 WorkTrace 服务。总控停止时分控仍本地记录并保留待传数据。

bootstrap/Join-Node 脚本会登记本机 worktrace MCP，不改变其他 MCP。Skill 下的 deployment.json 只有程序路径和角色，可检查；data 下的配置包含凭据，不可贴入对话。
