# 验证记录

核对日期：2026-10-06。开发机为 Windows x64，Node v22.20.0（完整 ICU）。

本文件保留**真机验证记录与测试覆盖**，作为"哪些结论有证据、哪些没有"的依据。未完成项见 [BACKLOG.md](BACKLOG.md)。

## 真机验证（2026-10-06）

对真实账号 `charien@mail.ustc.edu.cn` 实测，全部通过：

| 项目 | 结果 |
| --- | --- |
| `INBOX` 列表 | 1367 封，最新数封正确返回 |
| skill 路径 | 在**无任何环境变量**下仅靠系统钥匙串跑通 |
| 中文主题解码 | 正常（「中国科大电子注册中心2026年09月用户【程岩】账单」「Re: USTC TokenWorks \| 会话mermaid图渲染功能」） |
| 发件人显示名 | 正常（`GitHub <noreply@github.com>`、`第二课堂领导小组办公室 <xtw@ustc.edu.cn>`、`wangfeng (@wangfeng) <gitlab@ustc.edu.cn>`） |
| 未读过滤 | `SEARCH UNSEEN` 与服务器一致 |
| 附件识别 | 最新 100 封里识别出 18 封带附件，抽查均为 200 KB 以上的通知类邮件 |
| 中文文件夹名（mUTF-7） | `已发送`(302)、`草稿箱`(1)、`已删除`(0)、`垃圾邮件`(9) 全部正确打开 |
| 不存在的文件夹 | 返回服务器原话 `NO SELECT Folder not exist` |
| 读正文 | `text/plain` 直接命中；HTML-only 邮件（urp 账单）转成可读纯文本 |
| 附件清单 | 两个 `.xls` 的中文文件名、类型、大小全部正确（226.0 KB / 5.1 KB），**且未下载** |
| **只读性** | 读了一封未读邮件（uid=1691663060）后重新列未读，它**仍然是未读** |
| 未知 uid | `read 999999999` 报 `IMAP_NOT_FOUND`，退出码 1 |
| 搜索：发件人 | `--from gitlab` → 13 封；`--from 第二课堂`（中文显示名）→ 190 封 |
| **搜索：中文主题** | `CHARSET UTF-8` + literal 被 Coremail 正确接受：`--subject 日报` → 18 封、`--subject 账单` → 40 封、`--subject 开题` → 0 封（确实没有） |
| 搜索：日期区间 | `--since 2026-10-05` → 10 封 |
| 搜索：组合条件 | `--subject 日报 --since 2026-10-05 --before 2026-10-06` → 精确 2 封 |
| 搜索：无命中 | 输出 `No messages matched.`，不报错 |
| **`--preview`** | 5 封一条连接 531 ms；同样 5 封分别 `read` 共 2711 ms（**快 5.1 倍**）。28 封汇总一条连接 934 ms |
| **TLS 校验** | 用裸 IP `202.38.64.8` 连接被拒绝（证书只签了域名），证明校验未被关闭 |
| **凭据** | Windows 凭据管理器写入 / 读取 / 删除往返正确，含非 ASCII 授权码 |
| 插件 schema（真实值） | 用真实邮箱返回的 list / search / read 结果过 DSH 的 `validateJsonSchemaValue`，三个输出 schema **全部接受** |
| **可移植性** | 把 `dist/ustc-mail` 复制到无关目录后，`--help` / 真机列表 / `--show` 全部正常，且包内不含任何本机绝对路径 |

**未验证**：macOS 与 Linux 的钥匙串（见 [BACKLOG](BACKLOG.md)）；真实服务器上的超大 literal 与不结束行。

## 测试覆盖

全部离线，不需要账号或网络：

```bash
node test/self-test.mjs          # 80 项
node test/check-credentials.mjs  # 21 项
node test/check-bundle.mjs       # 18 项
node test/check-schema.mjs "<path to dsh-tools/lib/index.js>"   # 可选
```

合计 **119 项**。

### `self-test.mjs`（80 项，含安全断言）

纯函数：RFC 2047 的 B/Q 编码与 UTF-8/GBK 解码、相邻编码字之间的空白折叠、头部折行、地址与日期规整、IMAP literal 命令编码、modified UTF-7 邮箱名、括号平衡扫描、FETCH 响应解析、BODYSTRUCTURE 解析（multipart/alternative、嵌套 multipart 的点分段号、附件与内联图片判别、literal 参数里的中文文件名）、quoted-printable / base64 / GBK 正文解码、HTML→纯文本转换、搜索条件构造（`dd-Mmm-yyyy` 日期转换、ASCII 加引号、非 ASCII 转 literal 并加 `CHARSET UTF-8`、空条件拒绝）、参数校验、渲染。

端到端（真实客户端代码跑在假 IMAP 服务器上）：非 ASCII 密码的 literal 登录、未读过滤、limit 截断、认证失败、连不上、空邮箱、abort 监听不泄漏、按段落读正文、HTML 正文转换、附件清单、正文截断、uid 不存在、主题/发件人搜索、搜索条件与日期经线路原样发出、**会话并发上限**、`--preview` 的**单连接**与片段压行、`preview 0` 不取正文、读不到的正文不拖垮整个列表。

### `check-credentials.mjs`（21 项）

文件写入与读回、非 ASCII 授权码往返、文件权限 600（POSIX）、钥匙串写入/读取/删除往返、**钥匙串优先于文件**、环境变量优先于两者、账号格式校验（连续两个点 / 空格 / 缺域名 / 无 @ 四种畸形全部拒绝**且不写任何文件**）、非 TTY 时给出明确指引、`--show` 不打印密码。

### `check-bundle.mjs`（18 项）

包能构建、与源码逐字节一致、入口是根目录的 `SKILL.md`、包含必需模块、**不包含**插件专属文件、唯一的 Windows 脚本是钥匙串后端、清单声明 ESM 且不带 `dsh` 字段、**包内不出现任何本机绝对路径**、`SKILL.md` 说明了自定位方式并覆盖三个平台的钥匙串、说明了 setup 需要交互终端。

## 复现方式

```bash
git clone git@github.com:charienustc/USTC-email-skill.git
cd USTC-email-skill
node test/self-test.mjs
node test/check-credentials.mjs   # 钥匙串部分会在没有钥匙串的平台上标注跳过
node test/check-bundle.mjs
```
