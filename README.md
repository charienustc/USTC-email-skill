# USTC Email Skill

只读访问中国科学技术大学邮箱（`mail.ustc.edu.cn`）的 agent 技能。零第三方依赖，Windows / macOS / Linux 通用。

- 技能说明：[`skill/SKILL.md`](skill/SKILL.md)
- 可直接使用的包：[`dist/ustc-mail/`](dist/ustc-mail/)
- 许可以：[MIT](LICENSE)

## 能做什么

- **列出**邮件：发件人、主题、日期、已读状态、大小、有无附件
- **搜索**：按主题 / 发件人 / 收件人 / 日期 / 未读，中文直接可用
- **读取**某一封的正文和附件清单
- **`--preview`**：给整个列表附上正文片段，用来做汇总

**只读**：每次都用 `EXAMINE` 打开、`BODY.PEEK` 取内容，代码里没有 STORE / COPY / EXPUNGE / APPEND，也不会标记已读、删除或发送。附件只列名字和大小，不下载。

## 安装

需要 Node 18+。把 `dist/ustc-mail/` 整个目录复制到你的 agent 技能目录：

```sh
# DSH
cp -r dist/ustc-mail "$DSH_HOME/skills/ustc-mail"

# Claude Code 及同类
cp -r dist/ustc-mail ~/.claude/skills/ustc-mail
```

`SKILL.md` 会自己定位所在目录，放在哪里都能用。

从源码重新构建：

```sh
node tools/build-skill.mjs            # 产出 dist/ustc-mail
node tools/build-skill.mjs --check    # 检查产物是否与源码一致
```

## 快速开始

```sh
node bin/setup-credentials.mjs                        # 输入账号和客户端授权码（关回显）
node bin/ustc-mail.mjs list --limit 20                # 最新 20 封
node bin/ustc-mail.mjs search --subject 账单           # 按主题搜
node bin/ustc-mail.mjs read 1691663063                # 读正文
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `list` | 最新邮件。`--limit`（1–100）、`--unread`、`--preview`（0–600） |
| `search` | 按条件搜。`--subject` `--from` `--to` `--since` `--before` `--unread`，**至少给一个** |
| `read <uid>` | 读一封。`--max-chars`（500–200000） |

三者都支持 `--folder`（默认 `INBOX`，中文名可用）和 `--json`；`--help` 看全部。

`read` 的 `uid` 来自 `list` 或 `search`，所以流程是先列/搜、再读。

**每次调用都是一条新的 IMAP 连接**（约 0.3–3 秒，与邮件大小无关），所以粗筛请用 `--preview`：

```sh
# 好：一条连接拿 20 封的片段
node bin/ustc-mail.mjs list --limit 20 --preview 200

# 差：20 条连接
node bin/ustc-mail.mjs read <uid>   # × 20
```

## 凭据

按顺序查找：配置 → 环境变量 → **系统钥匙串** → `~/.dsh/ustc-mail-credentials.json`（权限 600）。

| 平台 | 钥匙串 |
| --- | --- |
| Windows | 凭据管理器（条目 `USTC-Mail`） |
| macOS | 钥匙串（服务名 `USTC-Mail`） |
| Linux | Secret Service（需要 `secret-tool`） |

没有钥匙串的机器（比如无桌面的服务器）**会静默跳过那一层**，直接用文件，不会因此失败。

```sh
node bin/setup-credentials.mjs            # 录入：关回显，保存前校验账号，保存后验证登录
node bin/setup-credentials.mjs --show     # 看凭据来自哪里（不显示密码）
node bin/setup-credentials.mjs --remove   # 忘掉已保存的凭据
```

账号若开了二次验证，密码要填邮箱设置里生成的**客户端授权码**。

> Windows 上另有一个可选图形弹窗：`windows-extra\setup-credentials-gui.ps1`，它只是薄壳，逻辑仍在上面这个 `.mjs`。

## 项目结构

```
skill/SKILL.md            技能源文件（位置无关，不写死绝对路径）
bin/ustc-mail.mjs         命令行入口
bin/setup-credentials.mjs 跨平台凭据录入
lib/                      实现：IMAP 客户端、MIME、钥匙串、渲染
test/                     离线测试，不需要账号
tools/build-skill.mjs     打包 / 检查 / 安装
dist/ustc-mail/           构建产物，可直接复制使用
windows-extra/            仅 Windows 的可选图形壳
index.js + cordis.patch.yml   插件形态（未安装，保留以保持两条路同步）
```

## 开发

```sh
node test/self-test.mjs          # 80 项：协议与端到端（跑在假 IMAP 服务器上）
node test/check-credentials.mjs  # 21 项：凭据层
node test/check-bundle.mjs       # 18 项：可移植包
```

全部离线。改动顺序：改 `lib/` 和 `bin/` → 跑测试 → 改 `skill/SKILL.md` → `node tools/build-skill.mjs --install`。

## 已知限制

- 不能下载附件、发信、标记已读、移动或删除
- HTML 正文转纯文本是粗略的，会丢样式、表格布局和图片
- 搜索是**子串匹配**，只搜头部字段，没有正则 / `OR` / `NOT`
- 日期按**服务器内部日期**算，`--before` 不含当天
- `--preview` 的片段压成一行，且只用于判断要不要细看，**不能代替 `read`**

## 更多文档

- [安全说明](docs/SECURITY.md) —— 审计结果、威胁模型、残余风险
- [开发与验证](docs/DEVELOPMENT.md) —— 实测记录、测试覆盖、设计取舍、故障排查
