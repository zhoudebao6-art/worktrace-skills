# 验证边界

2026-10-13 实测：27/27 Node 测试、九项浏览器流程、四个 Skill 格式校验，以及一总控两分控独立进程部署通过。真实 Sol/high → Astra/high 合成案例调用与候选落库通过。详见 review-report.md 与 verification.json。自动测试使用合成员工与案件，不使用真实客户正文。

已实现的验证入口：

```powershell
$env:TEMP='D:\codex+\temp'; $env:TMP=$env:TEMP; $env:TMPDIR=$env:TEMP
& scripts/Ensure-Runtime.ps1
& runtime/node.exe --test --test-concurrency=1 tests/*.test.mjs
& tests/provision.verify.ps1
```

Node 测试覆盖协议/身份/去重/导出、任务与版本、分析批次、真实 MCP stdio、真实 HTTPS 多实例同步、个人总结及补证闭环。provision 验证从独立技能目录准备一总控两分控、身份与重复接入、真实 Windows 活动元数据及停服清理。另有浏览器和启动器验证脚本。新的 Configure-Learning.ps1 已验证 Enable/Pause、角色模型及暂停写入。手动复盘与自动模式互斥。

**一台开发电脑上的独立进程测试不等于现场多电脑部署。** 实际远程 SMB ACL、防火墙、本机 Codex 账号/模型可用性及锁屏后的调度、员工具体应用正文/截图质量、个人总结的业务正确率、留出真实案例和替代人工效果必须在目标局域网试点。bootstrap/Join 测试使用 SkipMcp，避免改变开发电脑 MCP；MCP 协议本身单独使用真实 stdio 测试。

Skill frontmatter 校验只证明格式可发现，不能作为“学会岗位”的证据。合成工作案例验证结构和流转，不替代真实客户业务验收。

需要显式进行真实模型链路验证时（使用当前账号，确实消耗两次模型调用）：

```powershell
$env:WORKTRACE_TEST_CODEX=(Get-Command codex.exe).Source
& runtime/node.exe tests/real-loop.verify.mjs
```

脚本使用合成内容，分别调用 Sol/high 与 Astra/high；不启动微信，结果写入本地忽略文件。测试前准备 D 盘 TEMP 和运行时。
