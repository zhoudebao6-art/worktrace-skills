# 分控卡顿与已有部署升级

先按 deployment.json 找到本员工原运行目录，核验服务 PID 的路径和创建时间。用经过来源校验的 v0.4.1 完整发布包运行 scripts/Measure-CollectorPerformance.ps1 -DataDir <原data目录> -DurationSeconds 20 -Output <新JSON文件>；命令前加 powershell -NoProfile -ExecutionPolicy Bypass -File。脚本只读本服务及已核验直属 observer/parser 的 CPU、内存、I/O，不读证据正文、不改变策略。brief 返回 404，或旧版特定 400 JSON 错误“不支持的请求”时，只退回一次完整状态；授权失败等其他 400 不退回，不轮询大库。

本服务 CPU 低不证明 Word/WPS/微信没有被 UIA/PrintWindow 拖慢；若仍卡顿，需用户授权的短时暂停/原状态恢复对照。不要先换低质量模型、降推理强度或静默缩小范围。

升级服务必须按[固定 v0.4.1 升级手册](https://github.com/zhoudebao6-art/worktrace-skills/blob/v0.4.1/docs/collector-performance.md)执行，不只更新 Skill。核验旧源码与技能无本地修改，保存身份与原状态，空闲时暂停学习和采集，API 关闭自己的服务并确认托盘退出；完整冷备并哈希核验 data、旧程序和三技能，按新旧清单在原路径更新受管文件、保留身份、MCP 和登录启动，三技能绑定校正版本。不要重新 Initialize/Join，不伪造收据、不覆盖未知修改、不结束其他进程。

启动后保持暂停，验证实际 API 版本和 PID 路径、三技能版本、身份/stream 一致及冷备中的原事件、附件、文件原件均保留。SQLite 因索引变化可以改变字节；核对原 event_id/hash/stream/sequence 和原件摘要，不能只看总条数。重新连接该 WorkTrace MCP 载入新模块，不改其他连接。成功后按已有授权恢复原状态；原本暂停就保持暂停。失败现场先另存，再用完整冷备回退，绝不启动两个同身份副本。

全量 status/config/running、备份和证据只存本机；仅脱敏诊断指标可用于远程排查。正式逐步流程和可粘贴指令以手册为准，报告明确区分程序升级、合成测试与员工软件实测。
