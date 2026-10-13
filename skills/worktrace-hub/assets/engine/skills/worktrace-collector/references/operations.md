# 分控操作

使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<本技能目录>/scripts/control.ps1" -Action <动作>`。

- `start`：启动本机服务和可见托盘，不自行开始采集。
- `status`：检查 role、employee_id、device_id、collection、sync 和 pending。
- `init -InputFile "专属登记文件绝对路径.enroll.json"`：绑定公司、员工和电脑。已初始化只返回状态，不覆盖身份。
- `policy -InputFile "公司采集策略绝对路径.json"`：采用完整策略。以 status.collection.policy 为基础，只修改已经确定的字段；不能删掉默认密码工具排除项来解决无法读取。
- `capture -InputFile "动作参数绝对路径.json"`：内容为 `{"enabled":true}` 或 `{"enabled":false}`。
- `sync`：立刻增量补传。成功返回 sent；即使 sent=0，也完成一次身份验证心跳。错误返回非零码，保留本地待传事件。
- `shutdown`：退出本机服务；退出前持久化的 enabled 设置保留，启动时依工作时段恢复。如要求永久暂停，先 capture false。

策略示例（应用需按公司真实软件调整）：
```json
{"interval_seconds":15,"idle_seconds":300,"workdays":[1,2,3,4,5],"start":"09:00","end":"18:00","timezone":"Asia/Shanghai","content_processes":["wps.exe"],"excluded_processes":["keepass.exe","keepassxc.exe","1password.exe"],"excluded_title_terms":["密码","password","支付验证","私人"],"record_titles":false,"screenshots":false}
```

content_processes 中的软件会读取窗口标题和可访问控件名称；编辑框跳过，截图若开启会尝试遮蔽可识别编辑框。UIA 不完整时跳过截图并记录缺口；自绘控件仍需实际应用验证，不能保证所有敏感字段都自动识别。此版不采集原始语音或附件内容。

部署要求登录自动启动时，在软件根目录执行“设置登录启动.ps1”，作用于当前 Windows 用户；否则保持手动启动。未经配置的系统休眠、锁屏、开机未登录都不能采样，不能声称 24 小时无缺口。
