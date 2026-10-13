# 真实总控部署手册

所有路径为示例，先替换为公司实际目录、共享名、公司名和 IPv4。首次只选一两台员工电脑，验收后扩展。开发电脑仅执行隔离测试与发布，不初始化生产公司、不接管员工桌面。

## 1. 在指定总控电脑取源码和安装技能

按 [下载与分发方法](download.md) 从公开的 [v0.3.0 Release](https://github.com/zhoudebao6-art/worktrace-skills/releases/tag/v0.3.0) 直接下载专用发布 ZIP 和 SHA256 校验文件，无需 Git、GitHub 账号或邀请；也可取得公司转发的同一原包。校验后解压到这台目标电脑的独立源码目录。示例源码目录为 `D:\WorkTraceSource`，应包含 `.worktrace-source.json`。不要用 GitHub 自动生成的 Source code ZIP 替代专用资产。

v0.3.0 新增外部来源事件规范 1.1，旧原生事件 1.0 仍可读取。涉及此类同步的总控和分控运行服务应一起升级；先备份完整 data，在独立目录验证。安装新 Skill 不会替换运行服务。旧 v0.2.1 发布及原校验值不变，升级细节见 [研究与优化报告](research-and-optimization.md)。

```powershell
Set-Location -LiteralPath 'D:\WorkTraceSource'
powershell -NoProfile -ExecutionPolicy Bypass -File '.\scripts\Install-SharedSkills.ps1' -Role hub
if ($LASTEXITCODE -ne 0) { throw '技能安装未完成，请先检查错误。' }
$skillDest = Join-Path $env:USERPROFILE '.agents\skills\worktrace-hub'
```

安装器记录来源和文件校验值，供以后 `-Update` 验证。旧版手动复制或目录链接安装没有该记录，遇到同名技能时应先保留、检查来源和部署绑定，再安排迁移，不直接覆盖。安装技能本身不会启动生产服务。

在总控 Codex 新开对话，发：

> 使用 $worktrace-hub。本机是公司指定总控，源码位于 D:\WorkTraceSource，服务/数据目录用 D:\WorkTraceHub。请核对环境后准备服务。公司名和本机局域网地址按我提供的真实值初始化，随后按员工清单准备分控接入；不要操作微信。

Skill 执行等效于：

```powershell
& "$skillDest\scripts\bootstrap.ps1" -WorkDir 'D:\WorkTraceHub'
& "$skillDest\scripts\control.ps1" -Action status
```

bootstrap 校验源码、准备 Node、启动本地服务/托盘、注册 `worktrace` MCP，写入该 Skill 的 deployment.json。重开 Codex 对话验证 `worktrace_status`。已有不同角色、源码或 MCP 配置时保留原配置并报错，不自动覆盖。

将真实公司配置写入 UTF-8 `D:\WorkTraceAdmin\hub.json`：

```json
{"org_name":"替换为真实公司名","address":"192.168.1.10","hub_port":19221}
```

address 必须来自总控 status.ips；需要固定 IP 或 DHCP 保留。运行：

```powershell
& "$skillDest\scripts\control.ps1" -Action init -InputFile 'D:\WorkTraceAdmin\hub.json'
```

本机管理页面仅 127.0.0.1:19220；员工仅访问 HTTPS 同步端口 19221。公司管理员按实际网络策略允许员工网段访问此端口及已有 SMB 共享；不要关闭 TLS 验证或暴露公网。总控休眠时员工先保存本地，恢复后补传。

## 2. 总控准备员工专属入口

先准备一份全员只读代码共享，例如 `\\HUB-PC\WorkTraceSource`；另为每人建立管理员可写、仅对应员工可读的专属目录，例如 `\\HUB-PC\WorkTraceJoin-CS001`。**脚本不自动创建共享/ACL，目录隐蔽不等于权限隔离。** 使用有权限的路径；不要放在 Git 仓库内。

`D:\WorkTraceAdmin\roster.json` 格式：

```json
[
 {"employee_id":"CS001","employee_name":"替换实际姓名","label":"替换员工电脑名","drop_path":"\\\\HUB-PC\\WorkTraceJoin-CS001","work_dir":"D:\\WorkTrace","start_capture":true,"enable_logon_startup":true},
 {"employee_id":"CS002","employee_name":"替换实际姓名","label":"替换员工电脑名","drop_path":"\\\\HUB-PC\\WorkTraceJoin-CS002","work_dir":"D:\\WorkTrace","start_capture":true,"enable_logon_startup":true}
]
```

每台电脑 `work_dir` 都是它自己的本地路径；一人一目录、一份登记密钥。没有 D 盘就改实际非系统盘；缓存无 D 盘时回落到部署目录下 runtime-temp/runtime-cache。

```powershell
& "$skillDest\scripts\prepare-fleet.ps1" -RosterFile 'D:\WorkTraceAdmin\roster.json' -SourceShare '\\HUB-PC\WorkTraceSource'
```

需要正文时增加 `-CompanyPolicyFile <完整策略.json>`，按 [分控策略说明](../skills/worktrace-collector/references/operations.md) 从默认策略修改真实应用进程。先测正文再决定是否需要截图。默认活动记录不足以学习具体回复，不能一部署就声称采集到全部工作。

源码共享只含服务、技能、运行时；专属目录包含 enrollment.json、join.json、Join-WorkTrace.ps1，登记密钥不能粘贴聊天或上传 GitHub。`prepared_not_connected` 仅代表已准备。

## 3. 员工电脑首次加入

在对应员工已登录 Windows 桌面的 Codex 发：

> 公司已告知工作记录范围。请在本机运行我的专属接入脚本 \\HUB-PC\WorkTraceJoin-CS001\Join-WorkTrace.ps1，核对 CS001 是本机员工编号，按配置接入分控 Skill、MCP 和工作时段记录，并验证总控收到心跳。保持现有手动暂停状态。

实际入口：

```powershell
& '\\HUB-PC\WorkTraceJoin-CS001\Join-WorkTrace.ps1'
```

已授权的公司登录脚本/桌面执行通道可替代这次手动触发；同 LAN 本身不提供执行权限。WinRM/Session 0 后台会话不能据此声称能观察员工桌面。

脚本复制并核验服务、绑定唯一身份、安装三个分控技能、登记 MCP，按清单决定初次开始和登录启动。重复执行不会重新开启员工手动暂停的记录。新开员工 Codex 对话确认三个技能和 `worktrace_status`；CLI 不在 PATH 时先修复该电脑 Codex 安装。

## 4. 逐项验收，然后安排学习

1. 员工/设备编号正确，总控 last_seen 更新。
2. 员工正常在试点软件工作，活动事件到达总控；若配置正文则现场核验内容可读。不要从心跳推断正文有效。
3. 托盘暂停停止采集，恢复遵守工作时段；短时断网保留 pending，恢复后不重复入库。
4. 员工调用 `$worktrace-personal` 分析已存证据，保存个人总结；总控通过 personal_history 查询到同一 event_id，抽查三处关键步骤及判断。
5. 总控提出一个确实欠缺的补证问题，员工下次同步接收、下次个人学习回答或明确 blocked。确认问题没有变成操作电脑的命令。
6. 按 [夜间循环手册](nightly-loop.md) 配置本机 Codex 执行器：总控 Astra/high + AutoDispatch，分控 6.1 Sol/high。验收真实任务与回执、限额、暂停、取消及断线恢复；未启用的电脑继续手动触发。

调度由服务执行，每任务最多三批；无新证据结束、保留暂停、不操作微信。消息接收与业务外发是不同权限。频率和预算由总控根据积压调整。执行质量按 [两层循环](../skills/worktrace-hub/references/learning-loop.md) 记录，不用采样数量作为员工效率评价。

升级先停止旧服务并备份完整 data，然后准备新版本目录、验证数据兼容与 MCP 路径再切换。本版脚本遇到不同文件会停止，没有自动覆盖升级/数据库降级功能。
