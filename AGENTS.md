# 开发指引（给接手的开发者与 AI 助手）

USTC Email Skill 是一个只读访问中国科大邮箱的 agent 技能：一份 `SKILL.md` 加一套零第三方依赖的 Node 实现，打成可移植包后可复制到任何 agent 与操作系统。本文件说明仓库布局、改动流程、构建与发版，以及必须遵守的安全规则。用户文档见 [README.md](README.md)；待办见 [docs/BACKLOG.md](docs/BACKLOG.md)。

始终用中文与负责人沟通；文档默认中文；代码注释与命令输出用英文。

## 1. 仓库与分支

单一仓库，`main` 一条线，不开分支。远端是 GitHub：

| 目录 | 远端 | 分支 | 内容 |
| --- | --- | --- | --- |
| 本仓 | `github.com/charienustc/USTC-email-skill` | `main` | 技能、实现、测试、可移植包、文档 |

- **日常改动直接提交到 `main` 并推送**，不开分支、不开 MR。**推送不触发任何自动检查**——唯一的 workflow（`.github/workflows/keychain-verification.yml`）是 `workflow_dispatch`，只在需要验 macOS / Linux 钥匙串时手动跑。所以推送前必须自己把 §5 跑完。
- 提交信息写清**为什么**改，而不只是改了什么。
- 推送前必须跑完 [§5 测试](#5-测试)，全绿才算完成。
- 改动涉及 `skill/` 或 `lib/` 时，**必须重新构建可移植包**（见 §4），否则 `dist/` 会与源码漂移。

## 2. 本仓布局

| 路径 | 内容 |
| --- | --- |
| `skill/SKILL.md` | **技能源文件**。位置无关，用 `<skill>` 相对定位；这是 agent 真正读的文档 |
| `bin/ustc-mail.mjs` | 命令行入口：`list` / `search` / `read` / `attach`，参数解析与渲染选择 |
| `bin/setup-credentials.mjs` | 跨平台凭据录入：关回显、保存前校验账号、保存后验证登录 |
| `bin/credential-store.ps1` | Windows 钥匙串后端（`CredRead`/`CredWrite` 的 P/Invoke），**纯 ASCII** |
| `lib/imap.js` | 自己写的 IMAP4rev1 客户端：TLS、literal、modified UTF-7、响应读取 |
| `lib/mime.js` | RFC 2047 解码、头部展开、地址与日期规整（纯函数） |
| `lib/bodystructure.js` | BODYSTRUCTURE 解析：定位正文段、列出附件 |
| `lib/keychain.js` | 跨平台钥匙串：Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service |
| `lib/credentials.js` | 凭据解析顺序：配置 → 环境变量 → 钥匙串 → 600 文件 |
| `lib/list.js` `lib/search.js` `lib/read.js` | 三个动作本身，与调用方式解耦 |
| `lib/preview.js` | 在已开的连接里给整个列表附正文片段 |
| `lib/attach.js` | 保存附件：文件名重建、分块取件、落盘与大小上限 |
| `lib/format.js` | 模型可见文本的渲染 |
| `lib/gate.js` | 进程级并发闸门（最多 3 个会话） |
| `lib/args.js` | 参数校验，三处共用，避免各自漂移 |
| `index.js` + `lib/tool-schema.js` + `cordis.patch.yml` + `locale/` | **插件形态（刻意不安装）** |
| `tools/build-skill.mjs` | 打包 / 检查 / 安装可移植包 |
| `test/` | 全部离线测试，不需要账号 |
| `dist/ustc-mail/` | **构建产物，会提交进仓库** |
| `windows-extra/` | 仅 Windows 的可选图形壳，**不进入可移植包** |
| `.github/workflows/` | **仅手动触发**的钥匙串验证（macOS / Linux runner），推送不跑 |
| `docs/` | 文档入口、功能说明、待办、审计、验证记录 |

### 为什么 `dist/` 也提交

这个仓库存在的目的是**发布一个技能**。提交 `dist/ustc-mail/` 让访客可以直接下载可用的技能目录，不必先装 Node 再构建。代价是改完源码必须重新构建——`test/check-bundle.mjs` 会**断言产物与源码逐字节一致**，漂移了测试就红。

### 为什么插件形态保留却不安装

两条路的核心实现完全共享（`lib/` 约 1900 行），插件专属的只有 `index.js` + `lib/tool-schema.js`（约 250 行）。插件形态已被离线测试覆盖，留着可以让共享核心的改动同时受益于两条路。但当前产品**不支持插件自动更新**（升级要卸载再装），而这台机器有过装插件影响启动的经历，所以默认走技能路线。**不要擅自安装。**

## 3. 日常改动流程

1. 确认工作树干净：`git status --short --branch`。
2. 改 `lib/` 与 `bin/`。**共享核心改动要同时想一遍插件形态是否需要同步**（一般不需要，除非动了参数或输出形状）。
3. 跑测试（§5）。改了协议、编码、凭据或参数校验时，**必须同时补断言**。
4. 如果改了命令行参数或行为，同步更新 `skill/SKILL.md`——那是 agent 读的文档，漏改会让 agent 用错命令。
5. 重新构建并安装：`node tools/build-skill.mjs --install`。
6. 提交并推送。

### 常见改法

- **加一个命令或参数**：`bin/ustc-mail.mjs` 加解析 → `lib/args.js` 加校验 → 对应 `lib/<动作>.js` → `lib/format.js` 渲染 → `lib/tool-schema.js` 同步（保持两条路一致）→ `skill/SKILL.md` 补说明 → `test/self-test.mjs` 补断言。
- **加一个平台的钥匙串**：`lib/keychain.js` 加一个 backend 工厂 + 在 `keychainBackend()` 里分派。**探测不到必须返回 `undefined` 而不是抛错**，否则没有那套钥匙串的机器会直接挂掉。
- **改凭据查找顺序**：只改 `lib/credentials.js`，其余模块不该知道来源。
- **改可移植包的内容**：`tools/build-skill.mjs` 的 `FILES` 列表是显式白名单，新模块**必须手动登记**，否则不会进包。

## 4. 构建与发版

```bash
node tools/build-skill.mjs              # 产出 dist/ustc-mail
node tools/build-skill.mjs --check      # 检查产物是否与源码一致（CI 与测试用它）
node tools/build-skill.mjs --install    # 构建 + 装进 $DSH_HOME/skills/ustc-mail
node tools/build-skill.mjs --install <dir>   # 装到指定目录
```

包由三部分构成，缺一不可：

1. **`SKILL.md`**——说明文件，必须能自己定位目录（用 `<skill>` 约定，**不许出现任何绝对路径**）。
2. **自带代码**——`bin/` + `lib/`，位置无关。
3. **`package.json`**——只声明 `"type": "module"` 等最小字段。**故意不带 `dsh` 字段**，否则会被当成插件。

包会被复制到别的机器和别的 agent，所以：

- **不许出现本机绝对路径**。`test/check-bundle.mjs` 会扫全部文本文件，出现 `F:\...` 或 `C:\Users\...` 直接判失败。
- **不许出现平台专属文件**，唯一例外是 `bin/credential-store.ps1`（Windows 钥匙串要用，其他平台不会加载）。

没有标签、没有发布产物、**推送不跑任何自动检查**。想给别人版本，让对方克隆仓库或下载 `dist/ustc-mail/`。

唯一的 workflow 是 `.github/workflows/keychain-verification.yml`，**仅手动触发**，用来在真实的 macOS 与 Linux runner 上验钥匙串（本机是 Windows，验不了 `security`）。改钥匙串代码后可以手动跑一次；它不需要任何凭据。

## 5. 测试

全部离线，不需要账号、不需要网络：

```bash
node test/self-test.mjs          # 99 项：纯函数 + 端到端（跑在假 IMAP 服务器上）
node test/check-credentials.mjs  # 52 项：凭据层（数目随钥匙串是否可用略变，见下）
node test/check-bundle.mjs       # 18 项：可移植包
node test/check-schema.mjs "<path to dsh-tools/lib/index.js>"   # 可选：用 DSH 的校验器复核插件 schema
```

合计 169 项。**改动后必须全绿**；`check-bundle.mjs` 会先构建再比对，所以它也能发现忘记重新构建的 `dist/`。

`check-credentials.mjs` 的项数**取决于这台机器上钥匙串能不能真的用**：能往返就多跑几项真钥匙串断言（54），只有命令没有守护进程就转去验回退（50）。**这不代表测试被跳过**，代表它在当前环境里验了能验的东西；两种情况都会打印一行说明走到了哪条分支。

覆盖范围与真机验证记录见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

界面上看不到的东西（真实 IMAP 行为、中文搜索、只读性）**必须用真实邮箱验证**，不能只靠假服务器——假服务器证明不了 Coremail 接受什么。

## 6. 安全规则（必须遵守）

- **不提交、不打印任何凭据**：邮箱授权码、令牌、私钥。凭据只存在于系统钥匙串或权限 600 的文件里，**任何情况下都不进仓库**。提交前用 `git diff --cached` 复核。
- **不读取、不复述用户的授权码**。需要检查时只看长度与来源，**不看内容**。
- **不替用户跑 `bin/setup-credentials.mjs`**：它需要交互终端，而且不该由 AI 经手口令。发现凭据缺失时，让用户自己运行。
- **不许破坏邮箱的只读性**。任何情况下都不得引入 `STORE`、`COPY`、`MOVE`、`EXPUNGE`、`APPEND`、`SELECT`（读写打开）或 SMTP。邮箱一律用 `EXAMINE` 打开，正文一律用 `BODY.PEEK`。**这是这个项目对用户的承诺，不是可选项。**（`attach` 写的是本地磁盘，邮箱一样不动。）
- **附件名是外部数据，一律重建后再落盘**。发件人能控制这个名字，所以 `safeFileName` 只取最后一段、替换路径分隔符与控制字符、给 Windows 保留名加前缀；写出前还要再校验目标确实在指定目录内。**新增任何写文件的代码都必须走同一条净化路径**，不许直接拼路径。
- **不要给插件加会写文件的工具**。`attach` 刻意只在 CLI / 技能形态提供：写文件应当由命令行加显式目标目录来做，而不是由一个本来只读的工具集悄悄落盘。`test/self-test.mjs` 里 `plugin: nothing in the tool set writes` 就是守这条的。
- **不许关掉 TLS 校验**。`rejectUnauthorized: true` 必须放在配置展开之后；自定义 CA 可以传，校验不能关。
- **不许把凭据写进命令行参数**（进程列表可见）。macOS 的 `security` 命令有这个固有妥协，已记录在审计里；新增代码不得再引入同类问题。
- **搜索里永远不要发 `TEXT` 检索键**。实测差异极大：`BODY` 与搜头部同量级（20–140 ms），`TEXT` 要 **4.7–6 秒且不缓存**；更糟的是**结果不一致**——同一个词，`SUBJECT`∪`BODY` 是 48 封，`TEXT` 只返回 36 封，**漏掉 14 封**、另有 2 封在并集之外。要"到处搜"就用 `OR SUBJECT x BODY x`（实测 48 ms，结果**精确等于**并集）。`test/self-test.mjs` 里 `never TEXT` 那组断言就是守这条的。
- **推送、打标签、改仓库设置前先征得负责人同意。**
- 改动涉及安全面时，同步更新 [docs/SECURITY-AUDIT-2026-10-06.md](docs/SECURITY-AUDIT-2026-10-06.md)。

## 7. 已知情况

- **三个平台的钥匙串都已在真机验证**：Windows 本机、Linux（WSL Ubuntu 24.04，含真实 `gnome-keyring-daemon` 往返）、macOS（`macos-latest` runner 上的真实 `security`）。macOS 第一轮就抓到 `security -w` 对非 ASCII 密码返回十六进制转储——**改钥匙串代码后用 `gh workflow run keychain-verification.yml` 复验**。见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。
- **钥匙串"可用"不等于"能用"**：`secret-tool` 常在没有 session bus 的 headless 机器上被装上。读会静默回退，**写会在失败时退回文件并说明原因**。新增凭据写入代码必须走 `storeCredentials`（`lib/credentials.js`），不要直接调 `backend.write`。
- **macOS 保存凭据的一瞬间，授权码对进程列表可见**：`security add-generic-password` 只接受命令行参数。Linux 的 `secret-tool` 从 stdin 读，没有这个问题。
- **`--preview` 的片段是压成一行的**，且只取 `preview × 6 + 1024` 字节（上限 64 KiB）的原始载荷，所以 HTML 邮件或高比例转义的邮件，片段可能短于请求的字符数。**片段只用于判断要不要细看，不能代替 `read`。**
- **技能与代码分处两地**：源文件在 `skill/`，实际生效的副本在 `$DSH_HOME/skills/ustc-mail/`。改完必须 `--install`，否则技能目录里还是旧的。
- **插件形态未安装**，`list_plugins` 里不会有 `ustc_mail_*`。
