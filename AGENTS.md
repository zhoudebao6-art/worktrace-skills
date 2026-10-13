# WorkTrace 开发与部署约定

先明确当前电脑的角色。克隆或阅读仓库不意味着这台机器就是总控；生产总控由用户指定。开发测试只用隔离目录、合成身份，测试结束停止自己创建的服务。不得顺带启动微信或采集真实客户正文。

源码根目录的 src/bridge/public/scripts/skills 是维护源。修改引擎或分控技能后运行 `node scripts/refresh-engine.mjs` 更新总控 Skill 内源码镜像和 SHA256 清单；不得手工修改镜像后遗漏源文件。Git 不包含 Node 二进制，运行 Ensure-Runtime.ps1 准备已固定校验值的版本。

安装、下载、测试的 TEMP/TMP/TMPDIR 使用 D:\codex+\temp，工具缓存使用 D:\codex+\cache；没有 D 盘的目标机器用部署目录下 runtime-temp/runtime-cache。本地配置、数据库、登记文件和凭据不是缓存。

核心验证：Node 全部测试；涉及 bootstrap/Join/运行时的修改再运行 tests/provision.verify.ps1；界面修改运行 tests/browser.verify.mjs（通过 WORKTRACE_PLAYWRIGHT 指定已有 Playwright，浏览器缓存放 D 盘）。技能格式校验不代替业务语义与实机验证。

个人总结必须引用本员工本设备原始事件，不能把采样次数当工时或把模型假设当事实。总控负责流程归纳、冲突处理、补证、候选 Skill/Loop 的留出案例回放；未经业务验收不能声称实现人工替代。

本仓库不包含部署后的公司数据。发布前检查 git 暂存文件和密钥模式，保持换行稳定，校验源码镜像清单。升级保留原配置与数据库；远程部署需要真实目标信息和已有执行通道。

## 其他电脑下载使用

用户已授权将整个技能源码仓库公开，员工可以匿名读取源码和下载经校验的发布 ZIP，也可使用公司的共享副本。无需 GitHub 账号或 Write 协作者权限。下载与安装方法见 docs/download.md；不共享登录凭据，不把员工证据、公司数据库、登记文件或实际部署配置上传到这个公开仓库。

日常安装/更新入口是 scripts/Install-SharedSkills.ps1，接受 Git 源码或带 .worktrace-source.json 的发布源码目录。它不初始化本机总控、不注册 MCP、不启动采集。已有生产部署仍按 deployment.json 指向原部署目录；更新技能不自动升级服务或迁移数据库。

发布前运行 `node scripts/verify-source.mjs` 和适用测试。维护者用 scripts/export-source.mjs 从已提交源码生成下载目录，再压缩并发布 SHA256；不把运行目录、员工证据或安装后的技能目录作为发布源。
