# 总控负责的无安装包部署

总控 Skill 自带 assets/engine 源码和可验证清单；Node 运行时首次从官方获取并校验 SHA256，总控准备一份后供员工接入复制。也可提前通过 Ensure-Runtime.ps1 的 Candidate 参数准备同版本已校验二进制。它不依赖开发电脑的目录，不要求员工另装 Python/Node。

## 首次总控环境
在总控已登录桌面的 Codex 执行本技能 `scripts/bootstrap.ps1 -WorkDir <公司指定本机目录>`。目录用长期保留的非系统盘位置，不能是员工公用共享目录。已有不同内容时脚本停止，不覆盖。

bootstrap 启动服务和托盘、注册 worktrace MCP；新对话可使用工具。尚未初始化公司时，用 control.ps1 init 配置实际公司名、总控本机 LAN 地址和同步端口，详见 operations.md。不得为了省事填测试公司名。

## 员工清单与共享

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
