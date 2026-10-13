# 其他电脑下载与使用

当前 `main` 包含局域网链接自动接入、一次性邀请码、总控 `gpt-6-astra/xhigh` 和分控 `gpt-6.1-sol/xhigh`。需要这些功能时使用下面的完整 Git 源码流程。历史 [v0.4.1 Release](https://github.com/zhoudebao6-art/worktrace-skills/releases/tag/v0.4.1) 保留原来的性能优化与离线部署能力，不包含局域网链接接入及本次模型修订；不能将旧 ZIP 当作当前 `main`。

仓库公开，员工读取源码不需要 GitHub 账号、登录或写入权限。公司数据、公司连接链接、登记凭据和 Codex 登录信息均不提交到仓库。源码目录与长期运行目录分开。

## 1. 匿名取得当前完整源码

员工电脑优先使用本机 `git`。Codex 自带可用 Git 时，可以将实际发现的 `git.exe` 绝对路径设置为 `WORKTRACE_GIT`；先执行 `--version` 验证，不猜测其他电脑的工具路径。当前 shell 没有 Git 时，先定位已安装的 Codex/Git 工具；仍不可用则安装正式 Git for Windows 后继续，不伪造 `.worktrace-source.json`，也不用 GitHub 自动生成 ZIP 冒充带清单的发布包。

以下在员工电脑执行；示例目录可改为本机实际可用的非系统盘位置。没有 D 盘时选择独立长期目录，缓存放运行目录的 `runtime-temp` / `runtime-cache`。有 D 盘时按 `AGENTS.md` 使用 `D:\codex+\temp` 和 `D:\codex+\cache`。

```powershell
$sourceDir = 'D:\WorkTraceSource-main'
if (Test-Path -LiteralPath $sourceDir) { throw '源码目录已存在，先核对已有部署或使用新目录。' }
$gitExe = if ($env:WORKTRACE_GIT) { $env:WORKTRACE_GIT } else { (Get-Command git -ErrorAction Stop).Source }
& $gitExe --version
if ($LASTEXITCODE -ne 0) { throw 'Git 不可用。' }
$env:WORKTRACE_GIT = $gitExe
& $gitExe clone --branch main --single-branch 'https://github.com/zhoudebao6-art/worktrace-skills.git' $sourceDir
if ($LASTEXITCODE -ne 0) { throw '源码下载失败，保留错误信息。' }
& $gitExe -C $sourceDir remote get-url origin
& $gitExe -C $sourceDir rev-parse HEAD
& $gitExe -C $sourceDir status --short
```

由员工 Codex 确认 Git 来源为本仓库、记录 commit、检查工作树干净，并阅读新副本中的 `AGENTS.md` 和相应技能。接入脚本另行核验源码镜像清单和固定 Node 运行时；有专用发布来源清单时也逐文件核验。首次需要网络下载已固定 SHA256 的 Node，不需要 npm 安装。不要删掉 `.git` 或改写清单来绕过来源检查。源码读取或 clone 不会初始化任何公司。

## 2. 同一局域网：给员工 Codex 一个公司连接链接

总控先按 [局域网接入手册](lan-join.md) 启用实际局域网的自动登记，然后生成公司连接链接。完整链接以本仓库 `tree/main#worktrace-join=v1.` 开头，片段包含公司名称、公司编号、总控 HTTPS 地址和公开证书。将**整个链接**交给员工电脑的 Codex；普通仓库地址不包含连接目标，不能让它猜测公司或扫描网络寻找总控。

总控已启用此模式时，员工无需邀请码、私有接入文件或逐台总控确认。员工 Codex 取得当前 `main` 后，使用真实唯一员工编号、真实姓名、实际电脑名称，在本人已登录桌面执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '<完整源码目录>\scripts\Join-Lan.ps1' -ConnectionLink '<总控提供的完整公司连接链接>' -WorkDir '<本机长期运行目录>' -EmployeeId '<真实唯一员工编号>' -EmployeeName '<真实姓名>' -ComputerLabel '<实际电脑名称>'
```

该入口准备固定 Node、本机服务、三个分控技能、MCP、独立设备身份和总控心跳。每台电脑本地生成自己的设备密钥，不复用另一台电脑的登记文件或 Codex 登录。身份由员工填写，自动接入不等于核实其真实姓名。

首次采集和自动学习默认关闭；公司已明确工作范围并授权开始记录时才加 `-StartCapture`，要求当前用户登录启动时加 `-EnableLogonStartup`。保留原有手动暂停；已有离线分控、其他员工或其他公司的数据不能覆盖。故障重试沿用同一运行目录、身份与原始接入状态。详见 [员工完整指令](../prompts/lan-collector.txt)（[纯文本](https://raw.githubusercontent.com/zhoudebao6-art/worktrace-skills/main/prompts/lan-collector.txt)）。

验收分开报告：实际运行的角色与 `gpt-6.1-sol/xhigh`、本机 MCP/技能、总控收到的设备心跳、实际工作记录和个人总结。心跳成功不能替代真实采样与学习验收。此方式只用于总控允许的实际局域网网段，不自动建立跨网通道。

## 3. 只安装技能或部署总控

需要先让 Codex 认识技能、暂不接入时，在已核验的完整源码运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '<完整源码目录>\scripts\Install-SharedSkills.ps1' -Role collector
```

分控安装采集、个人学习和证据三个技能。用户指定的真实总控电脑改用 `-Role hub`，然后按 [总控部署手册](deployment.md) 与 `worktrace-hub` 技能准备服务。安装技能本身不启动记录、不初始化公司、不注册运行服务 MCP；下一次 Codex 对话发现新技能。直接使用 `Join-Lan.ps1` 时会完成所需分控技能和 MCP，不要求员工先单独安装。

默认技能目录为当前用户 `.agents\skills`；自定义目录必须确实由 Codex 读取。已有安装用相同参数加 `-Update`，先核验旧版、备份并保留 `deployment.json`。遇到未知来源、本地修改或目录链接时保留原状处理。更新技能不会自动升级既有运行服务、修改数据库或迁移离线身份。服务升级按 [性能诊断与升级说明](collector-performance.md) 核验来源、空闲停机、完整冷备、升级和复验。

## 4. 其他接入方式继续可用

- 管理员手工登记：使用总控为该电脑准备的 `Join-WorkTrace.ps1`，或按 [部署手册](deployment.md) 的员工清单流程。
- 一次性邀请码：当前完整源码的 `scripts/Join-WithInvite.ps1 -InviteFile <本人.invite.json> -WorkDir <目录> -EmployeeId <编号> -EmployeeName <姓名> -ComputerLabel <电脑名>`。每个私有文件只给一台电脑，默认 7 天；管理员操作见 [总控操作](../skills/worktrace-hub/references/operations.md)。邀请码、重试秘密、登记文件不得放入公共仓库或 ZIP。
- 独立离线分控：按 [离线手册](offline-collector.md)，使用完整来源而非仅有 `engine-manifest.json` 的联网 Join 副本。旧离线数据转换为联网需要独立迁移，不能重新初始化覆盖。

跨网仍需公司实际可用的路由/VPN、证书地址与访问策略。只有同一 Wi-Fi 名称、仅安装组网软件或只在总控本机测试，都不能证明远端已经接入。

## 5. 历史发布源码包

需要固定旧版时，可从 [v0.4.1 发布页](https://github.com/zhoudebao6-art/worktrace-skills/releases/tag/v0.4.1) 下载 [worktrace-skills-v0.4.1.zip](https://github.com/zhoudebao6-art/worktrace-skills/releases/download/v0.4.1/worktrace-skills-v0.4.1.zip) 与 [SHA256SUMS.txt](https://github.com/zhoudebao6-art/worktrace-skills/releases/download/v0.4.1/SHA256SUMS.txt)，核对唯一对应的 ZIP SHA256，再完整解压到新目录。该专用源码包包含 `.worktrace-source.json`；GitHub 自动生成的 Source code ZIP 不等价。

历史发布只具有其自身版本的功能和配置。新的发布资产只有维护者实际生成、校验并发布后才能使用，不根据版本号猜测下载地址。维护者从干净、已提交源码执行 `scripts/export-source.mjs` 生成下载目录；不要将安装后的技能目录、运行目录或公司连接资料作为公开发布来源。
