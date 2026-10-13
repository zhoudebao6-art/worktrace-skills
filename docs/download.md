# 其他电脑下载与使用

仓库保持私有。其他员工电脑只需要取得源码 ZIP，不需要 Git、GitHub 账号或仓库写入权限，也不参与分支和 PR。指定真实总控电脑负责部署；当前开发电脑不是生产总控。

## 1. 所有者下载并校验

GitHub 个人私有仓库不提供只读协作者权限，因此采用“有权限的所有者下载 → 公司局域网共享”的方式分发。只有已授权账号才能访问 [v0.2.1 发布页面](https://github.com/zhoudebao6-art/worktrace-skills/releases/tag/v0.2.1)，私有下载链接不能直接当作员工匿名下载地址。参考 [GitHub 个人仓库权限说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/repository-access-and-collaboration/permission-levels-for-a-personal-account-repository)。

在发布页面的 Assets 下载这两个文件：

- `worktrace-skills-v0.2.1.zip`
- `SHA256SUMS.txt`

这是带完整性清单的源码包，不是安装程序。不要用 GitHub 自动生成的 Source code ZIP 替代上述资产；专用包包含离线安装所需的 `.worktrace-source.json`。

所有者也可在自己的已授权电脑执行：

```powershell
gh release download v0.2.1 --repo zhoudebao6-art/worktrace-skills --pattern 'worktrace-skills-v0.2.1.zip' --pattern 'SHA256SUMS.txt' --dir 'D:\WorkTraceDownloads\v0.2.1'
```

在下载目录校验，确认显示 `SHA256 校验通过` 后再分发：

```powershell
$downloadDir = 'D:\WorkTraceDownloads\v0.2.1'
$zipName = 'worktrace-skills-v0.2.1.zip'
$checksumLines = @(Get-Content -LiteralPath (Join-Path $downloadDir 'SHA256SUMS.txt') | Where-Object { $_ -match [regex]::Escape($zipName) })
if ($checksumLines.Count -ne 1) { throw '校验清单缺少唯一对应记录。' }
$expectedHash = ($checksumLines[0] -split '\s+')[0]
if ($expectedHash -notmatch '^[0-9a-fA-F]{64}$') { throw 'SHA256 格式不正确。' }
$zipStream = [IO.File]::OpenRead((Join-Path $downloadDir $zipName))
$sha256 = [Security.Cryptography.SHA256]::Create()
try { $actualHash = ([BitConverter]::ToString($sha256.ComputeHash($zipStream))).Replace('-', '') }
finally { $sha256.Dispose(); $zipStream.Dispose() }
if ($actualHash -ne $expectedHash) { throw 'ZIP 校验失败，停止分发。' }
'SHA256 校验通过'
```

将两个文件放到员工可读取的公司共享目录，例如 `\\HUB-PC\WorkTraceDownloads\v0.2.1`。保持这一分发目录由管理员维护，员工只读。共享的是源码包和校验文件，不是公司数据库、个人总结、密钥或其他人的 Codex 登录文件。此步骤不创建共享或更改公司现有权限。

## 2. 目标电脑解压并安装技能

每台目标电脑将两个文件复制到本地，按上面的方式再校验一次。每个新版本用一个独立目录解压，保留旧版；示例使用 `D:\WorkTraceSource-v0.2.1`：

```powershell
$sourceDir = 'D:\WorkTraceSource-v0.2.1'
if (Test-Path -LiteralPath $sourceDir) { throw '目录已存在，请核对现有内容或另选新目录。' }
Expand-Archive -LiteralPath 'D:\WorkTraceDownloads\v0.2.1\worktrace-skills-v0.2.1.zip' -DestinationPath $sourceDir
Set-Location -LiteralPath $sourceDir
```

确认此目录下有 `scripts\Install-SharedSkills.ps1` 与 `.worktrace-source.json`。安装脚本会核对来源清单和文件哈希，无需在员工电脑安装 Git。总控和分控只选择对应的一条命令：

```powershell
# 只在用户指定的真实总控电脑执行：
powershell -NoProfile -ExecutionPolicy Bypass -File '.\scripts\Install-SharedSkills.ps1' -Role hub
```

```powershell
# 分控电脑执行，安装采集、证据、个人总结三个技能：
powershell -NoProfile -ExecutionPolicy Bypass -File '.\scripts\Install-SharedSkills.ps1' -Role collector
```

默认安装到当前 Windows 用户的 `.agents\skills`。必要时可传 `-SkillsDirectory '<实际技能目录>'`；自定义目录需要确实是 Codex 读取的位置，否则仅复制不会自动发现。命令中的执行策略仅用于这个 PowerShell 进程，不修改系统策略；请先完成来源与哈希校验。完成后在 Codex 新开对话核对技能。

安装只复制与核验技能，不启动服务、不登记员工、不配置 MCP、不开始采集。各电脑使用自己的 Codex 登录。总控自动任务仍使用 `gpt-6-astra/high`，分控使用 `gpt-6.1-sol/high`；账号需要具备对应模型的使用权限。

## 3. 先部署总控，再接入员工

按 [部署手册](deployment.md) 完成以下顺序：

1. 指定真实总控电脑，安装总控技能，在 Codex 调用 `$worktrace-hub`，把公司运行目录配置在源码目录之外，例如 `D:\WorkTraceHub`。
2. 总控配置实际公司与 LAN 地址，为每名员工生成专属接入目录和 `Join-WorkTrace.ps1`，确认员工身份与采集范围。
3. 员工在自己已登录的桌面会话中运行对应 Join 脚本，完成本地服务、分控身份、技能绑定与 MCP。Join 本身会安装所需分控技能，因此正式接入可直接走这一步；提前安装技能只用于让 Codex 先理解操作规程。
4. 核验真实采样、暂停、断线补传和总结同步，再按 [夜间循环手册](nightly-loop.md) 启用自动学习。

每个员工只能使用自己的接入文件，不能把同一登记密钥分给多台电脑。下载到源码不等于已接入总控。仅让其他电脑使用技能时，到第 2 节即可；需要采集和学习时才继续真实部署。

## 4. 更新技能

以后由所有者下载新版专用 ZIP 和校验文件，再按同样流程分发、校验、解压到新的版本目录。在新版目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File '.\scripts\Install-SharedSkills.ps1' -Role collector -Update
```

总控将 `collector` 改为 `hub`；使用过 `-SkillsDirectory` 时继续传入原路径。脚本先验证原安装来源和文件、备份并核验旧版，再保留 `deployment.json` 等本地配置更新技能。遇到来源不明的同名技能、已有文件被手动修改或目录链接时会停止，不强行覆盖。旧版 Join 安装的技能若没有此安装器的来源记录，应保留原目录，按现有部署维护流程处理。

**更新技能不会替换已绑定的运行服务或升级数据库。** 服务升级需单独安排：停止自己管理的服务、备份完整 `data`，在独立新目录验证兼容性与 MCP 路径，再切换。源码、已安装技能、生产运行目录是三个位置，不应混用。

## 5. 可以直接发给其他电脑 Codex

**安装分控技能：**

> 请从公司提供的共享位置【填写路径】取得 worktrace-skills-v0.2.1.zip 和 SHA256SUMS.txt，保存到本机非系统盘。先校验 ZIP，再解压到新的独立目录，阅读 docs/download.md 与 AGENTS.md。使用 scripts/Install-SharedSkills.ps1 -Role collector 安装三个分控技能，核验来源清单和安装结果；我不需要 GitHub 账号或共创环境。保留已有技能与本地修改。本次只安装技能，不启动采集、不操作微信、不初始化总控。说明正式接入需要总控给我的专属 Join 脚本。

**在真正的总控电脑部署：**

> 这台电脑是公司指定的真实总控。请从【填写已校验源码位置】阅读 docs/download.md 和 AGENTS.md，安装 worktrace-hub，然后按技能与 docs/deployment.md 准备运行目录【例如 D:\WorkTraceHub】。公司名称、LAN 地址与员工清单使用我提供的真实值，不猜测身份，不把数据库放进源码目录。总控 Astra/high，分控 6.1 Sol/high。先准备总控与员工专属 Join 入口，再逐项验证采样和同步；未验收前不要声称已接入全部员工或学会业务。

**更新已有技能：**

> 请校验公司提供的新版 ZIP 和 SHA256SUMS.txt，解压到独立新目录，读取更新说明。用 scripts/Install-SharedSkills.ps1 -Role collector -Update 更新本机技能，核验旧版备份与 deployment.json 保留。遇到未知来源、本地修改或目录链接时保留并报告。本次不升级运行服务或数据库；告诉我技能版本和实际运行服务是否仍需单独升级。
