# 同一局域网的链接自动接入

此流程由员工电脑上的 Codex 准备环境并连接总控。首次没有任何本机部署或接入状态时，才需要公司连接链接和真实身份；已有分控日常维护、重启或断网恢复优先复用本机配置，无需再次找链接。总控在用户指定后启用实际局域网自动登记，不需要逐台确认或单独邀请码。

自动登记默认关闭。启用后，总控允许来自已配置、且仍与本机网卡精确匹配的 RFC1918 IPv4 网段进行首次登记。公司链接不是登录密码；该模式信任允许网段内持有连接信息的人自报身份。每台设备仍有独立密钥，后续同步校验设备和事件归属。

## 总控准备一次

先在用户指定的总控完成公司初始化和运行服务升级，确认员工可达的 HTTPS 地址及证书。不要把总控数据目录、管理令牌或证书私钥交给员工。LAN 管理命令使用运行目录内的 `src/admin-cli.mjs`，不是给 `control.ps1` 增加不存在的 Action。

```powershell
& '<总控运行目录>\runtime\node.exe' '<总控运行目录>\src\admin-cli.mjs' --command lan-join-status --role hub --dir '<总控运行目录>\data'
```

查看 `current_cidrs`，与用户要求的实际公司网络及网卡核对。参数 JSON 严格为 `{"enabled":true,"allowed_cidrs":["<真实当前网段/掩码>"]}`，保存到总控受控配置目录，随后执行：

```powershell
& '<总控运行目录>\runtime\node.exe' '<总控运行目录>\src\admin-cli.mjs' --command lan-join-configure --role hub --dir '<总控运行目录>\data' --input '<局域网参数.json>'
& '<总控运行目录>\runtime\node.exe' '<总控运行目录>\src\admin-cli.mjs' --command lan-join-link --role hub --dir '<总控运行目录>\data'
```

最多 8 个网段，只接受标准网络地址及当前非回环 IPv4 网卡真实掩码对应的 RFC1918 网段；不能用全网、公网、回环或扩大掩码代替。仅因电脑安装了其他 VPN 而出现的网卡不代表用户授权员工从该网络加入；按实际公司网络选择。每次新接入再次核对网段仍有效。用户已要求启用的网络无需逐台再次确认。

`lan-join-link` 返回 `url`、公司编号/名称、HTTPS 地址和允许网段。将返回的完整 `url` 交给员工 Codex；片段中只有 `worktrace.lan-link/1.0` 格式、公司信息、地址和公开证书，没有设备秘密。该链接虽不含密码，仍属于本公司的连接资料，不提交到公共仓库。

总控地址应稳定。DHCP 地址或证书真实变化时核验公司目标和证书，再受控迁移既有配置；新链接不能无验证覆盖原有信任，不能关闭 TLS。同步与登记使用 HTTPS 19221；管理接口继续仅本机 127.0.0.1，不向员工开放管理端口或远程桌面控制。

## 已有分控：从本机状态恢复

每次使用 WorkTrace 技能，先读技能自己的 `deployment.json`，再核对同一技能目录下 collector、personal、evidence 三份绑定的 role/root。只检查这些绑定、用户明确的运行目录和其中的接入状态，不扫描整个磁盘或局域网。服务运行时用 status 检查；需要恢复联网服务时，从已核验的当前完整源码执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '<完整源码目录>\scripts\Connect-Node.ps1' -WorkDir '<原运行目录>' -SkillsDirectory '<原技能目录>'
```

`WorkDir` 可省略，由当前用户已安装的三个分控技能绑定发现唯一目录；自定义技能位置用 `-SkillsDirectory`。脚本复用设备身份、地址和证书，恢复服务、当前用户 MCP 与登录启动，验证状态及同步。`-SkipMcp`、`-SkipLogonStartup` 分别跳过对应设置，不表示删除已有配置。日常也可从 collector 技能运行 control 的 start、status、sync。已完成部署可运行 `Join-Lan.ps1 -WorkDir <原目录>` 进入恢复流程，无需 ConnectionLink 或重新填写身份。

恢复不重新登记、不重装 data，也不改变采集或自动学习开关。联网服务断网时保留待传事件，网络恢复后按 30 秒周期补传；Windows 登录启动帮助重启后恢复服务，关机、休眠和未登录期间不保证在线。离线分控只恢复本地服务和本地保存，不运行联网恢复，也不询问总控链接。多份绑定冲突、配置损坏或数据存在但缺配置时，先恢复原配置或让用户明确原目录，不能视作首次安装。

旧版分控需要在**员工电脑的 Codex 上执行一次**[连接修复指令](../prompts/repair-collector-connection.txt)。普通[仓库链接](https://github.com/zhoudebao6-art/worktrace-skills)足够取得修复源码；更新技能后运行 Connect，随后新对话和正常断网无需重复提供公司链接。仅更新总控不能替员工电脑完成这一步；没有实际执行通道时只交付指令，不声称远端已修复。

## 员工 Codex 自动部署

把完整公司链接与以下指令交给员工 Codex，或让它读取 [完整员工指令](../prompts/lan-collector.txt)：

> 这台电脑是公司的员工分控。先从已装三个分控技能的 deployment.json 检查原部署；已有联网部署按当前 main 的 Connect-Node 恢复连接，不再次索要链接或登记。仅首次没有任何本机状态时，使用完整公司链接并收集真实唯一员工编号、姓名和实际电脑名。按 docs/download.md 核验源码，完成服务、三个技能、MCP、登录启动和心跳，核验 6.1 Sol／极高。保留原身份、证据及采集/学习开关；首次采集和学习关闭，已有离线不转换。

Codex 按 [下载手册](download.md) 使用本机 Git 或实际发现的 Codex 自带 Git，匿名 clone 当前 `main`；设置 `WORKTRACE_GIT` 为已验证的路径即可，无需 GitHub 登录。读取 `AGENTS.md`，记录 commit，并运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '<完整源码目录>\scripts\Join-Lan.ps1' -ConnectionLink '<完整公司连接链接>' -WorkDir '<本机长期运行目录>' -EmployeeId '<真实唯一员工编号>' -EmployeeName '<真实姓名>' -ComputerLabel '<实际电脑名称>'
```

接入脚本核对链接、公司和 HTTPS 证书，准备固定版本 Node，并调用正式 Join 流程建立本机服务、分控采集/个人总结/证据三个技能及 MCP。员工电脑需要自己的 Codex 登录；不会从总控复制登录凭据。LAN 接入默认设置当前 Windows 用户登录启动，`-SkipLogonStartup` 可跳过设置；原 `-EnableLogonStartup` 兼容保留。`-StartCapture` 仅用于已明确授权的工作范围，缺省不采集。自动学习另按 [夜间循环](nightly-loop.md) 配置并验收。

真实员工编号必须唯一，不能填测试值、借用其他员工编号，或为绕过冲突而临时改名。已有员工要增加电脑、换机或迁移离线身份时，保留现状，由管理员按真实情况处理。自动接入不提供人员身份核实，也不授予对其他电脑桌面的控制权。

## 重试与停用

客户端在 `WorkDir\setup\lan-enrollment` 保留连接资料、请求秘密、设备秘密、登记结果及接入状态。`connection.json` 中是公司公开连接信息；`request.json` 和 `enrollment.json` 是私有凭据。整个目录保留在原电脑，不能提交源码、复制给另一台电脑或在聊天显示内容。

已完成部署的网络中断按前述 Connect 流程复用本机身份，不再走首次登记。首次登记尚未完成时保留原请求和已保存连接资料，在原目录恢复同一请求；服务端验证请求秘密和设备秘密后幂等恢复同一设备。不得删状态、改员工编号或换目录反复登记。已有总控、其他公司/员工或独立离线的数据会阻止覆盖初始化。

关闭新登记：保存 `{"enabled":false,"allowed_cidrs":[]}` 后再次运行 `lan-join-configure`。这只关闭新的 LAN 自动登记，已登记设备仍使用独立密钥同步；停用某台设备应在本机管理面板核对 `device_id` 后撤销。撤销不删除历史证据。手工登记与一次性邀请码入口继续保留。

## 验收标准

1. 员工本机实际运行角色为 collector，公司/员工/设备身份正确，执行器为 `gpt-6.1-sol/xhigh`；总控执行器为 `gpt-6-astra/xhigh`。
2. 本机技能、MCP 与登录启动指向原长期目录，服务与可见托盘正常；总控设备 `last_seen` 更新，同步没有身份或 TLS 错误。登录启动配置可核对，实际登录后的恢复须在发生登录后另行验证。
3. 记录已授权启用后，验证真实工作样本、暂停及断线补传。身份心跳成功只完成连接验收。
4. 学习已配置后，核对引用原始证据的个人总结确实保存并同步；安装、模型配置或空日报不等于业务学习完成。

员工连在访客 Wi-Fi、隔离 VLAN 或客户端隔离网络时，即使显示相同路由器名称也可能无法访问总控。先按具体网络错误排查，不能扫描其他电脑猜身份、关闭 TLS 或修改无关 VPN。跨网接入不属于此 LAN 自动登记范围。
