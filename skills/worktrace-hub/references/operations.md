# 总控操作

本技能目录记为 `<skill>`。命令使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<skill>/scripts/control.ps1" -Action <动作>`。

1. 首次先运行本技能 bootstrap.ps1 搭建环境，见 deployment.md。之后 `start` 启动本机服务；`status` 输出身份、候选本机 IPv4、设备及同步状态，不输出密钥。
2. 首次配置：把实际参数存为 UTF-8 JSON，例如 `{"org_name":"实际公司名称","address":"192.168.1.10","hub_port":19221}`。执行 `-Action init -InputFile "绝对路径/hub.json"`。地址必须来自本机 status.ips，员工电脑需可访问。
3. 登记分控：输入 JSON `{"employee_id":"CS001","employee_name":"实际姓名","label":"实际电脑名称"}`，执行 `-Action enroll -InputFile "绝对路径/employee.json" -OutputFile "受控目录/CS001.enroll.json"`。输出只给文件路径和编号；不要读取其密钥内容到对话。重复调用会创建新设备，先查 status.devices，响应不确定时不要直接重试。
4. 优先用 prepare-fleet.ps1 按清单准备分控接入，由员工 Codex 在自己的交互桌面执行接入入口。不要复制总控 data 或某员工的 data 给另一台电脑。
5. 总控本地界面端口 19220，员工同步 HTTPS 端口 19221。由管理员按公司网络策略放行可信局域网；不自动打开公网访问。此版总控不主动连接或操纵员工桌面。
6. CLI 汇总：`-Action report -InputFile "绝对路径/range.json"`。输入如 `{"from":"2026-10-12T16:00:00.000Z","to":"2026-10-13T15:59:59.999Z","employee":"CS001"}` 对应上海 10 月 13 日全天。不要把示例日期当成当前日期。
7. `shutdown` 仅退出本机 WorkTrace 服务。总控停止时分控仍本地记录并保留待传数据。

bootstrap/Join-Node 脚本会登记本机 worktrace MCP，不改变其他 MCP。Skill 下的 deployment.json 是程序路径、角色与版本，可检查；data 下的配置包含凭据，不可贴入对话。

## 运行、学习与故障检查

按需调用 `worktrace_readiness`，或 `admin-cli.mjs --command readiness --role hub --dir <data>`。设备很多时用 device_id 或 limit/offset 分页，分别检查证据、个人总结和最近日期。raw 已收到但 personal_summary 为零时按 offline-handoff.md 手动 all 审阅，不重建公司或冒充员工补写总结。此检查不调用模型；服务在线不等于已完成学习。

服务 API 版本、运行目录引擎清单、总控 Skill 的 deployment.json、MCP initialize 返回版本分开核验。完整 GitHub 包用于升级源码；仅运行 Install-SharedSkills 不会更新生产服务。原路径受管更新要空闲停机、完整冷备、核对身份和证据、重连自己的 MCP；bootstrap 用于首次建立，不作为覆盖升级入口。

下发任务仅对已建立 HTTPS 同步的设备生效；离线快照设备无法收消息，last_seen 为空正常。每设备轮转领取未确认任务；取消和未确认结果继续重传，不能把回执缺失当完成。原分控不可达时把问题保留为下一次人工交接清单。

自动总控每份批次每本地日最多尝试一次，失败或额度耗尽保留 open 检查点，不再挡住其他批次。查看 status.worker.hub_schedule 的近期尝试与 next_retry_day；旧失败最早在下一本地自然日允许窗口重试，未尝试批次优先，未尝试之间仍按到达顺序。总控每天预算共享，不是按员工均分，也不保证每位员工当夜完成。离线分控失败规则不同，仍需明确 retry-local，不因跨日自动重付费。变更学习设置或自然离开允许时段后迟到的结果不保存，已预留用量不退回。

卡顿先观察自己服务与数据规模，证据/原件/analysis-runs 都是业务数据，不作为缓存清除。不能通过换端口启动同 data 第二实例、删除锁或结束所有 node 进程恢复。任务故障用明确批次与幂等键处理；模型/输入缺口、运行故障、未同步是不同问题，不能用重复初始化统一解决。
