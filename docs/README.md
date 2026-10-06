# 项目文档入口

核对日期：2026-10-06。当前版本 1.0.0（`dist/ustc-mail/package.json`）。能力清单以 [FEATURES.md](FEATURES.md) 为准，未完成事项与已知问题以 [BACKLOG.md](BACKLOG.md) 为准。**文档描述的是源码当前状态；界面与真机行为必须实机核对，不能只凭单元测试宣称已交付。**

## 按用途查找

| 用途 | 文档 |
| --- | --- |
| 这是什么、怎么装、怎么用 | [中文 README](../README.md) |
| 仓库布局、改动流程、构建、安全规则 | [AGENTS.md](../AGENTS.md) |
| 能力清单、使用条件与已知限制 | [FEATURES.md](FEATURES.md) |
| 当前问题、功能计划与待验收事项 | [BACKLOG.md](BACKLOG.md) |
| 安全审计、威胁模型与残余风险 | [SECURITY-AUDIT-2026-10-06.md](SECURITY-AUDIT-2026-10-06.md) |
| 真机验证记录与测试覆盖 | [VERIFICATION.md](VERIFICATION.md) |
| 可移植包的构建脚本 | [tools/build-skill.mjs](../tools/build-skill.mjs) |
| 技能说明（agent 读的文档） | [skill/SKILL.md](../skill/SKILL.md) |

## 文档维护规则

- **新问题与未验收行为记在 BACKLOG 里**；验收完成后移入 [VERIFICATION.md](VERIFICATION.md)，写明验证平台与结果。
- **不能仅凭源码或单元测试宣称交付完成**。涉及真实 IMAP 行为、中文搜索、只读性、跨平台钥匙串的改动，必须在真实环境验证后再改结论。
- **改了命令行参数或行为，同步更新 `skill/SKILL.md`**——那是 agent 真正读的文档，漏改会让 agent 用错命令。
- **改了安全面，同步更新审计文档**，而不是新写一份。
- 审计与验证记录**保留历史语境**，不因后续改动而重写；发现与实际不符时先在 BACKLOG 记录，确认后再更正。
- 文档里的命令都要能直接跑。示例路径统一用仓库相对路径或 `<skill>` 约定，**不写本机绝对路径**。
