# 总控负责的无安装包部署

总控 Skill 自带 assets/engine 源码和可验证清单；Node 运行时首次从官方获取并校验 SHA256，总控准备一份后供员工接入复制。也可提前通过 Ensure-Runtime.ps1 的 Candidate 参数准备同版本已校验二进制。它不依赖开发电脑的目录，不要求员工另装 Python/Node。

## 首次总控环境
在总控已登录桌面的 Codex 执行本技能 `scripts/bootstrap.ps1 -WorkDir <公司指定本机目录>`。目录用长期保留的非系统盘位置，不能是员工公用共享目录。已有不同内容时脚本停止，不覆盖。

bootstrap 启动服务和托盘、注册 worktrace MCP；新对话可使用工具。尚未初始化公司时，用 control.ps1 init 配置实际公司名、总控本机 LAN 地址和同步端口，详见 operations.md。不得为了省事填测试公司名。

## 同一局域网：链接自动接入

用户要求员工只交链接给本机 Codex 即自动连接时，选择 LAN Join，不要求先提供员工清单、共享目录、私有邀请码或总控逐台确认。先升级实际服务至包含 `src/lan-join.mjs` 的当前源码，再在本机用 `lan-join-status` 核对实际公司网卡。按 operations.md 启用该网卡真实 RFC1918 网段，生成 `lan-join-link`。其他软件的 VPN 网卡不自动纳入公司接入范围。

完整公司链接为 GitHub `tree/main#worktrace-join=v1.<base64url JSON>`，JSON 严格含 `format=worktrace.lan-link/1.0`、`hub_url`、`org_id`、`org_name`、`ca_pem`，不含任何私钥或设备秘密。用命令生成，不手工拼接或把实际公司链接写入公共仓库。普通仓库地址缺少公司信息；不能让员工扫描网络猜总控。

员工 Codex 按[当前下载手册](https://github.com/zhoudebao6-art/worktrace-skills/blob/main/docs/download.md) 匿名 clone 完整 main，使用本机 Git 或实际核验的 Codex 自带 Git，可设 WORKTRACE_GIT。核对 origin、commit 和干净工作树；不使用旧 v0.4.1 ZIP 或伪造来源清单。随后在员工已登录桌面执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '<完整源码目录>\scripts\Join-Lan.ps1' -ConnectionLink '<总控返回的完整公司链接>' -WorkDir '<员工本机长期目录>' -EmployeeId '<真实唯一员工编号>' -EmployeeName '<真实姓名>' -ComputerLabel '<实际电脑名称>'
```

完整步骤及可转发指令见[局域网接入手册](https://github.com/zhoudebao6-art/worktrace-skills/blob/main/docs/lan-join.md)和[员工指令](https://raw.githubusercontent.com/zhoudebao6-art/worktrace-skills/main/prompts/lan-collector.txt)。该模式默认关闭；开启后，允许网段内的设备自行申报身份。每台设备生成独立秘密，总控只接受该网段及原始请求一致的幂等重试；员工姓名仍需按真实人员填写，不是系统实名验证。

Join-Lan 会准备固定 Node、服务、三个分控技能、MCP 和心跳，首次采集及自动学习关闭。`-EnableLogonStartup` 和 `-StartCapture` 按已经授权的部署范围启用，不能恢复员工主动暂停。`WorkDir\setup\lan-enrollment` 含私有请求和登记状态，保留原位供同身份重试，不复制或公开。已有离线、其他公司或不同身份数据拒绝覆盖。

网段须仍与当前网卡真实掩码匹配，总控 HTTPS 地址须仍属于本机网卡且被证书覆盖。DHCP 漂移、访客网络隔离或 TLS 不匹配按实际原因修复，不扩大允许网段、关闭证书验证或开放本机管理 API。实际员工心跳到达只验收连接，工作记录和个人总结需分别核验。

## 员工清单与共享（手工登记方式）

准备 UTF-8 JSON 数组，每个对象：
```json
[
 {"employee_id":"CS001","employee_name":"实际姓名","label":"实际电脑名","drop_path":"\\\\员工电脑\\专属受控接入目录","work_dir":"D:\\WorkTrace","start_capture":true,"enable_logon_startup":true}
]
```

这些是格式示例，部署前使用实际值。
- drop_path 由总控可写、对应员工可读；可以是已有受控共享，或总控有权限的目标电脑目录。不同员工不得共用目录。不要将登记密钥放进全员共享目录。
- SourceShare 是所有目标员工可读取的一份通用源码目录，通常为已有 UNC 共享。只放代码/运行时，无公司数据库和密钥。脚本不自动开 SMB、放宽防火墙或更改其他软件配置。
- work_dir 是该员工电脑上的本地长期目录；接入脚本从源码共享复制并核验，再在本地运行。
- start_capture 和 enable_logon_startup 仅在公司既定部署要求中明确为 true 时开启；不能把员工主动暂停解释成需要自动恢复。

执行：
`scripts/prepare-fleet.ps1 -RosterFile <清单> -SourceShare <现有源码共享路径> -CompanyPolicyFile <可选完整采集策略>`

脚本生成每台电脑独立的 enrollment.json、join.json 和 Join-WorkTrace.ps1，重跑时沿用同一已登记设备；结果 prepared_not_connected 表示准备完成，不代表接入完成。没有提供策略时不改原策略，新设备默认只采样应用活动。更新策略请用本机管理接口，不用反复重新接入。

## 首次员工接入与验收

无远程执行基础设施时，给员工电脑的 Codex 一条指令：
“公司已告知工作记录范围。请在本机已登录桌面运行【我的专属目录中的 Join-WorkTrace.ps1】，完成身份绑定、分控 Skill/MCP 接入和同步验证，按配置的工作时段运行。”

这一步只需首次完成；后续由本地服务采集和补传。总控可以准备全部内容，但仅凭同局域网不能自动取得其他电脑的执行权限。拥有既有授权通道时，可由总控代为触发这条命令，必须在员工交互会话中执行；不要从后台服务/session 0 读取别的登录用户桌面。

Join-Node 检查交互会话、身份、已有数据和源码哈希，不匹配时停止。安装分控 Skill 与 MCP 仅作用于正在执行的 Windows 用户，不复制 Codex 账号信息。返回同步成功表示身份心跳到达；随后总控还应检查一条真实应用活动，才确认采样链路正常。

部署失败保留本地数据和已登记身份。总控状态中 last_seen 不存在时报告尚未接入；有心跳无采样时检查时段、暂停、锁屏、权限和具体应用，不能把两者混为一谈。

## 一次性接入码自助登记

当前 main 提供持码接入；历史公开 v0.4.1 包不包含这个入口。总控运行服务和员工完整源码均须包含 `src/invitations.mjs`、`src/invite-client.mjs`、`scripts/Join-WithInvite.ps1`。只更新 Skill 文本不会升级服务。手工 `enroll` / `prepare-fleet.ps1` 仍可使用。

1. 先确认员工到总控 HTTPS 地址可达。局域网通常使用总控固定 LAN 地址；跨网可使用公司批准的 Tailscale 私有网络。后者须双方完成登录、设备批准和访问策略，且目标地址包含在总控证书与邀请码的 allowed_urls 中。账号未登录或尚未验证外部设备时，报告跨网待完成；不要关闭证书验证、暴露管理端口或把本机测试当跨网验收。
2. 在总控通过 `invitations-create` 生成独立私有 `.invite.json`，见 operations.md。默认有效期 7 天，可指定 1–30 天，一码最多登记一台设备。公开源码包和每人的私有邀请码分开交付；同一码不能给多个人或多台电脑。邀请码、后续 enrollment、request 状态和公司数据不能上传 GitHub、放入公共共享或打入公开 ZIP。
3. 员工 Codex 在本人已登录桌面内，从校验后的完整源码运行以下命令。示例路径及身份必须替换为实际值；WorkDir 是长期保留的本机独立目录，不能与源码目录重叠。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '<完整源码目录>\scripts\Join-WithInvite.ps1' -InviteFile '<本人的私有目录>\device.invite.json' -WorkDir '<本机长期运行目录>' -EmployeeId '<公司真实唯一员工编号>' -EmployeeName '<实际姓名>' -ComputerLabel '<实际电脑名称>'
```

只有邀请码确实包含备用地址时才追加 `-HubUrl '<允许的HTTPS origin>'`，不附路径、参数或凭据。需要当前用户登录自动启动时追加 `-EnableLogonStartup`。首次 `StartCapture` 默认 false；只有已明确工作范围并授权开启时才追加 `-StartCapture`。自动学习仍需样本验收后单独配置。分控自动任务模型为 `gpt-6.1-sol/xhigh`。

员工编号必须真实且唯一，不能填测试值或其他员工编号；该方式是凭码自行申报，不能作为系统核实姓名的证明。同公司已登记过的 employee_id（包括已撤销设备）不能自助再次使用；同员工增加电脑、换机或恢复旧身份由总控核对后走手工登记。已有总控、其他员工或离线分控的数据不能用邀请码覆盖。

脚本在 `WorkDir\setup\self-enrollment` 保存受限的请求状态和登记文件。网络中断后保留这些文件，使用原邀请码、原身份、原目录及原参数重试；服务端只对相同请求秘密和身份返回原设备。不要删除状态、换姓名、换码反复登记。输出心跳通过只证明身份连接；真实活动及个人总结到达后才能验收业务链路。

邀请码到期或撤销只阻止新的兑换及远程重试，不会停用已经登记的设备。需要停止设备同步时必须单独撤销该 device_id；也不能把撤销设备解释为删除其已有工作证据。
