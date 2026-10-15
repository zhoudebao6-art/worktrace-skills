# Windows 微信只读原生组件

这是数据库读取边界，不是发送消息、注入或桌面控制插件。主程序只运行固定 SELECT，
首次准备另用独立程序；正文和密钥都不写日志。当前实现面向 Windows x64、微信 4.x
常见的 `db_storage/message/message_N.db`、`Msg_<MD5>` 和 `Name2Id` 结构。
这不代表所有 4.x 版本已经实机验证：本仓库测试只使用自建加密 SQLite/WAL 和自建进程。

## 固定依赖与构建

- [Tencent WCDB 2.1.16](https://github.com/Tencent/wcdb/releases/tag/v2.1.16)，
  commit `df808591b9f9a9ab42156006819c3550d5af13a3`，源码包 SHA256
  `260845053c5dedc4578570203a5ba235c3be1e74a671c2fc1aeb12c988dd5346`。
  只编译其 SQLCipher C 核心，不运行 WCDB C++ 自动维护层。
- [LLVM-MinGW 20260616](https://github.com/mstorsjo/llvm-mingw/releases/tag/20260616)，
  UCRT x64 包 SHA256 `b9b68a4d276e16fa25802aaba458e4638f64b3884c290aaccdc2d87083b6ca35`。
  编译工具只留构建缓存，目标员工机器不需要安装编译器。
- SQLCipher 使用它已有的 `SQLCIPHER_CRYPTO_CUSTOM` 接口，通过 Windows BCrypt/CNG
  提供 AES-256-CBC、HMAC、PBKDF2 和随机数。未携带源码包中的旧 OpenSSL 1.1.1l。
  这不是新的密码算法，也没有作 FIPS 认证声明。
- C# 薄宿主使用 Windows .NET Framework 4 与系统 `csc.exe`。DLL 只依赖 Windows
  系统库；不需要管理员安装 VC Runtime、Go、Python 或 NuGet 数据库驱动。

在源码根目录运行，输出目录必须不存在：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-wechat-reader.ps1 -OutputDirectory D:\codex+\temp\wechat-native-build -IncludeFixtures
$env:TEMP='D:\codex+\temp'; $env:TMP=$env:TEMP; $env:TMPDIR=$env:TEMP
$env:WORKTRACE_WECHAT_NATIVE_DIR='D:\codex+\temp\wechat-native-build'
node --test .\tests\wechat-native.test.mjs
```

构建入口验证两个下载包的散列，重新解压到专属临时目录，再编译；不运行下载的微信
自动化程序。生产构建省略 `-IncludeFixtures`，只能发布三个原生文件、许可证、构建清单；
不得发布 fixture 可执行文件。构建清单记录源码与产物 SHA256。发行 ZIP 的校验值必须由
发行流程再次固定，目标机器只安装经清单验证的包。

## 读取协议

`worktrace-wechat-reader.exe --dll <绝对DLL路径> --profile <绝对配置路径>` 以低优先级
常驻，通过标准输入逐行接收 JSON，每行返回一个 JSON。请求不能携带 SQL、密钥或改变
账号根目录。请求字段为 `id,query,database_path,shard_id,table_id,after,through,limit,
timeout_ms,expected_generation`；只有前五项按具体查询必需。

`query` 只接受 `schema`、`name2id`、`head`、`messages`。前三种分页表清单/用户名/最高
rowid，messages 以 `rowid>after AND rowid<=through ORDER BY rowid` 读取，并 LEFT JOIN
发送人的 `Name2Id.user_name`；找不到的发送人保留 null。所有 SQLite INTEGER 输出十进制
字符串，BLOB 为 `{encoding:'base64',data:'...'}`，不在原生层猜测解码。

成功结果含 `ok:true,complete:true,rows,has_more,readonly:true,db_generation`；head 另含
`high_watermark`，其他查询含 `next_cursor`。错误只有固定错误码，且 `complete:false`，
没有可供提交的部分 rows。每页至多 500 行、约 4MiB JSON，单行/字段超过 SQLite 512KiB
长度上限整页失败；超限需要上层明确处理缺口，不能直接跳过推进游标。超时最多 10 秒，
SQLite progress handler 与 busy timeout 限制查询；上层还须在取消/到期时终止自己持有的
reader 子进程。每请求独立打开只读连接，短事务结束立即关闭。

`db_generation` 是首次 16 字节 salt 与 Windows 卷/文件编号的摘要。mtime 不影响身份，
复制成新文件会成为新来源。游标只在账号、generation、分片、会话表四元组内有效。
源路径须在 profile 的账号根目录下，拒绝 UNC、链接/junction 和越界；主库打开共享读写但
不共享删除以阻止查询期间换文件。SQLite 可能更新 WAL 共享内存读标记，主库和 WAL 数据
没有写入；不使用 `immutable=1`，否则会漏掉已提交 WAL。

## 首次准备及恢复活动

`worktrace-wechat-setup.exe --dll <DLL> --profile <新文件> --account-root <账号目录>
--account-id <本人wxid> --pid <唯一已确认PID> --timeout-seconds <1..180>` 只在员工已被
告知且空闲时显式调用。要求初始至少 120 秒无键鼠，扫描每 1MiB 分块检查，恢复活动则
以 `employee_active` 中止；最多读 1GiB、最多 180 秒，每块主动让出 CPU。不后台重试。

只打开指定 `Weixin.exe/WeChat.exe` 的 QUERY_INFORMATION 与 VM_READ 权限，不写进程、
不注入、不重启。扫描方法改编自
[wx-cli 固定源码](https://github.com/r266-tech/wx-cli/blob/d833d68737454169848760642b2127302911de1b/internal/wxkey/setup_windows.go)，
只匹配已选账号数据库 salt 的候选原始 key，再用只读 SQL 实际验证；目录须与账号标识
匹配，至少一个已解锁库的 Name2Id 要含该账号。联系人表出现某 wxid 本身不证明登录人
身份，部署入口仍必须结合所选账号目录与用户明确确认，不能自动猜测多个账号/PID。

密钥以 Windows 当前用户 DPAPI 加密保存在独立 private 配置，ACL 只授予该用户和 SYSTEM；
配置含 `format,account_root,account_id,created_at,key_count,encrypted_keymap_base64`。
进程内解密是正常读取所必需，但不经 stdin/stdout、Web API、日志或移交包暴露。配置
不能跨 Windows 用户拷贝后继续使用。已有文件拒绝覆盖，刷新时生成新配置，经探测成功
后由部署入口切换。新盐或失效 key 只报告需要闲时重新准备，不在日常轮询扫描内存。

原始 key literal 不保证在所有版本/所有登录阶段存在；权限不足、超时、版本变化可能失败
或仅完成部分数据库。`complete:false` 和 verified/target 数量是实际边界，不能称为全量
成功。历史被删除的库、未落盘消息、未下载媒体、特殊压缩字典、账号未唯一确认等仍须
保持明确缺口。本模块不提供图片/视频/语音解密，也不能保证已撤回且从库中清除的正文。

## 验证边界

Windows 测试验证实际本机编译的 DLL：Node crypto 独立计算 SQLCipher v4 页面 HMAC 与
AES-CBC 解密；合成 WAL 提交/未提交隔离；重复 local_id 和大于 JavaScript 安全整数的
server_id；rowid/through 分页；不修改主库/WAL；路径/SQL/游标/DPAPI 篡改拒绝；大字段
整页失败；只读扫描自己生成的 fixture 子进程并生成可读取的 DPAPI 配置。生产 setup 会
拒绝 fixture 进程，只有单独编译的测试程序接受它，且不得随生产包发布。

没有运行真实微信、读取真实客户数据或密钥，也没有将合成测试写成真实微信兼容验证。
首次目标机器验证必须使用其实际版本和授权账号；未知结构应失败并返回缺口，不能猜测。
