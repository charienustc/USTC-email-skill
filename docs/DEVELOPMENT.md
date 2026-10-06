# 开发与验证记录

这份文档放的是开发过程材料：实测记录、测试覆盖细节、设计取舍、后续计划。
常规的安装与使用见 [README](../README.md)。

## 真机验证结果（2026-10-06）

对 `charien@mail.ustc.edu.cn` 实测，全部通过：

| 项目 | 结果 |
| --- | --- |
| `INBOX` 列表 | 1367 封，最新数封正确返回 |
| skill 路径 | 在**无任何环境变量**下仅靠钥匙串跑通，输出正常 |
| 中文主题解码 | 正常（如「中国科大电子注册中心2026年09月用户【程岩】账单」「Re: USTC TokenWorks \| 会话mermaid图渲染功能」） |
| 发件人显示名 | 正常（`GitHub <noreply@github.com>`、`第二课堂领导小组办公室 <xtw@ustc.edu.cn>`、`wangfeng (@wangfeng) <gitlab@ustc.edu.cn>`） |
| 未读过滤 | `SEARCH UNSEEN` 实测与服务器一致 |
| 附件识别 | 最新 100 封里识别出 18 封带附件，抽查均为 200 KB 以上的通知类邮件 |
| 中文文件夹名（mUTF-7） | `已发送`(302)、`草稿箱`(1)、`已删除`(0)、`垃圾邮件`(9) 全部正确打开 |
| 不存在的文件夹 | 返回服务器原话：`NO SELECT Folder not exist` |
| **读正文** | 若干封真实邮件正文正确读出：`text/plain` 直接命中，HTML-only 邮件（urp 账单）转成可读纯文本 |
| **附件清单** | `第二课堂` 那封的两个 `.xls` 中文文件名、类型、大小全部正确（226.0 KB / 5.1 KB），且未下载 |
| **只读性（实测）** | 读了一封未读邮件（uid=1691663060）后重新列未读，它**仍然是未读** |
| **未知 uid** | `read 999999999` 报 `IMAP_NOT_FOUND`，退出码 1 |
| **EXAMINE 回归** | 改用只读 `EXAMINE` 后，列表路径仍正常 |
| **搜索：发件人** | `--from gitlab` → 13 封；`--from 第二课堂`（中文显示名）→ 190 封 |
| **搜索：中文主题（关键）** | `CHARSET UTF-8` + literal 被 Coremail 正确接受：`--subject 日报` → 18 封、`--subject 账单` → 40 封；`--subject 开题` → 0 封（确实没有） |
| **搜索：日期区间** | `--since 2026-10-05` → 10 封 |
| **搜索：组合条件** | `--subject 日报 --since 2026-10-05 --before 2026-10-06` → 精确 2 封 |
| **搜索：无命中** | 输出 `No messages matched.`，不报错 |
| **`--preview`** | 5 封一条连接 531 ms；同样 5 封分别 `read` 共 2711 ms（**快 5.1 倍**）。28 封汇总一条连接 934 ms |
| **插件 schema（真实值）** | 用真实邮箱返回的 list / search / read 结果过 DSH 自己的 `validateJsonSchemaValue`，三个输出 schema **全部接受** |
| **插件注册契约** | 三个工具名、各自的参数集、`required` 字段、以及三个渲染器的输出均有断言（离线测试） |
| **可移植性** | 把 `dist/ustc-mail` 复制到无关目录后，`--help` / 真机列表 / `--show` 全部正常 |

## 测试覆盖

```sh
node test/self-test.mjs          # 80 项：纯函数 + 端到端（跑在假 IMAP 服务器上）
node test/check-credentials.mjs  # 21 项：凭据层
node test/check-bundle.mjs       # 18 项：可移植包
node test/check-schema.mjs "<path to dsh-tools>"   # 可选：用 DSH 自己的校验器复核 schema
```

全部离线，不需要账号。

**`self-test.mjs`（80 项，含安全断言）**：RFC 2047 的 B/Q 编码与 UTF-8/GBK 解码、相邻编码字之间的空白折叠、头部折行、地址与日期规整、IMAP literal 命令编码、modified UTF-7 邮箱名、括号平衡扫描、FETCH 响应解析、BODYSTRUCTURE 解析（multipart/alternative、嵌套 multipart 的点分段号、附件与内联图片判别、literal 参数里的中文文件名）、quoted-printable / base64 / GBK 正文解码、HTML→纯文本转换、搜索条件构造（`dd-Mmm-yyyy` 日期转换、ASCII 加引号、非 ASCII 转 literal 并加 `CHARSET UTF-8`、空条件拒绝）、参数校验、渲染；以及**端到端**——真实客户端代码跑在假 IMAP 服务器上（非 ASCII 密码的 literal 登录、未读过滤、limit 截断、认证失败、连不上、空邮箱、abort 监听不泄漏、按段落读正文、HTML 正文转换、附件清单、正文截断、uid 不存在、主题/发件人搜索、搜索条件与日期经线路原样发出、会话并发上限、列表与搜索的正文片段）。

**`check-credentials.mjs`（21 项）**：文件往返、非 ASCII 授权码、文件权限 600（POSIX）、钥匙串写入/读取/删除往返、钥匙串优先于文件、环境变量优先于两者、账号格式校验（四种畸形全部拒绝且不写文件）、非 TTY 时给出明确指引、`--show` 不打印密码。

**`check-bundle.mjs`（18 项）**：包能构建、与源码一致、入口是根目录的 `SKILL.md`、包含必需模块、**不包含**插件专属文件、唯一的 Windows 脚本是钥匙串后端、清单声明 ESM 且不带 `dsh` 字段、**包内不出现任何本机绝对路径**、`SKILL.md` 说明了自定位方式并覆盖三个平台的钥匙串。

## 设计取舍

**为什么是 skill 而不是插件。** 两条路的核心实现完全共享（`lib/` 约 1900 行），插件专属的只有 `index.js` + `lib/tool-schema.js`（约 250 行）。

| | skill | 插件 |
| --- | --- | --- |
| 升级方式 | 改文件立刻生效 | 卸载再装（产品当前限制） |
| 激活风险 | 无 | 装错可能影响应用启动 |
| 适用面 | 任何读 `SKILL.md` 的 agent、任何系统 | 仅本产品 |

插件形态保留在仓库里（未安装），因为它已被离线测试覆盖，且共享核心改动时两条路同时受益。

**为什么 `--preview` 放在列表里而不是单独一个命令。** 列表 `uidFetch` 本来就返回 BODYSTRUCTURE，所以正文段的位置是已知的；预览只需在**已开的那条连接**里多取一次 section。做成独立命令会多一次连接，收益就没了。

**为什么代码跟着 skill 走。** 要让 skill 位置无关，它必须自带代码。仓库仍是唯一源头，`tools/build-skill.mjs` 产出 `dist/ustc-mail`，`--check` 断言两者一致。

## 后续计划

1. 下载附件到工作区（需要大小上限、随机文件名、只写工作区内）。
2. 发信（SMTP `mail.ustc.edu.cn:465`）——涉及「替用户做动作」，要单独设计确认流程。
3. 搜正文（`BODY`/`TEXT` 检索键）——现在只搜头部字段。
4. 需要工具卡时，把本包装成插件（三个工具已同步完成）。

### 已完成

- ✅ **汇总能力**：`--preview` 让列表/搜索在同一条连接里附上正文片段。
- ✅ **skill 路由规则收紧**：明令禁止用 `list --limit 100` 代替 `search`、禁止逐封 `read` 试探、禁止未确认就挑一封读；并写入成本模型。
- ✅ **凭据层跨平台化**：按平台自动选钥匙串，无钥匙串时回退权限 600 的文件。
- ✅ **录入跨平台化**：`bin/setup-credentials.mjs` 关回显输入 + 保存前校验 + 保存后验证登录；Windows 另留一个可选图形壳。
- ✅ **可移植包**：自带代码、位置无关。

## 改动的顺序

1. 改 `lib/` 和 `bin/ustc-mail.mjs`
2. 跑 `node test/self-test.mjs`
3. 如果动了 skill 的说明，改 `skill/SKILL.md`
4. `node tools/build-skill.mjs --install` 更新 `dist/` 和技能目录
5. **全程不需要动 profile**

## 故障排查

| 现象 | 含义与下一步 |
| --- | --- |
| `IMAP_AUTH_FAILED` | 密码不对，或邮箱设置里没开 IMAP，或需要用客户端授权码 |
| `IMAP_CONNECT_FAILED` | 到 `mail.ustc.edu.cn:993` 不通（校园网/VPN/防火墙） |
| `IMAP_TIMEOUT` | 服务器无响应；默认 20 秒无数据即超时 |
| `IMAP_MAILBOX_FAILED` | 文件夹名不对，错误里带服务器的原话 |
| `IMAP_NOT_FOUND` | `read` 的 uid 在这个文件夹里不存在（注意 `--folder` 要一致） |
| `IMAP_SEARCH_FAILED` | 服务器拒绝了搜索条件；错误里带服务器原话 |
| 「Give at least one of "subject"…」 | `search` 没给任何条件 |
| 「account name is not configured」 | 账号没给：跑 `node bin/setup-credentials.mjs` |
| 「password is not configured」 | 密码没给：跑 `node bin/setup-credentials.mjs` |
| 「"maxChars" must be an integer from 500 to 200000」 | `--max-chars` 超出范围 |
| 「"preview" must be an integer from 0 to 600」 | `--preview` 超出范围 |
| 提示需要交互终端 | `setup-credentials.mjs` 要你自己在终端里跑；无人值守用 `--user X --secret-stdin` |
