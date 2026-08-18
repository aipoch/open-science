# Localization terminology decisions

This document records the August 2026 review of English nouns that were still visible in the
Simplified Chinese, Traditional Chinese, or Japanese interface. It complements the binding catalog
rules in [`i18n-glossary.md`](i18n-glossary.md).

## Evidence used

The review separates community evidence from the final product decision:

- GitHub's maintained [Simplified Chinese](https://docs.github.com/zh/copilot/concepts/agents/about-agent-skills)
  Copilot docs use 技能 and include 智能体技能, but also use 代理 elsewhere on the same page. Its
  [Japanese](https://docs.github.com/ja/copilot/concepts/agents/about-agent-skills) counterpart uses
  エージェント and スキル consistently. This supports the native Skill choices and Japanese Agent
  choice while documenting that Simplified Chinese Agent usage is not fully settled.
- Traditional Chinese sources likewise vary among 代理, 代理程式, and 智能體. Microsoft uses
  [智能體](https://learn.microsoft.com/zh-tw/startups/build/ai/agents/intro-agents) in AI-agent
  explanatory prose, but not consistently across its catalog. The Chinese Agent choices are
  therefore explicit Open Science product decisions, confirmed by the product owner, rather than a
  claim of universal community consensus.
- The [Agent Skills specification](https://agentskills.io/specification) defines `SKILL.md` as the
  required file name. GitHub's localized pages preserve commands and paths such as `gh skill`,
  `.github/skills`, `.claude/skills`, and `.agents/skills`; those protocol identifiers must remain
  byte-for-byte unchanged even when surrounding prose is localized.
- Traditional technical documentation uses
  [詞元](https://learn.microsoft.com/zh-tw/azure/foundry/openai/latest) for model tokens.
- Microsoft documents model tokens as
  [词元](https://learn.microsoft.com/zh-cn/dotnet/ai/conceptual/understanding-tokens) in
  Simplified Chinese, while Japanese model documentation uses
  [トークン](https://learn.microsoft.com/ja-jp/azure/foundry/responsible-ai/openai/transparency-note).
- GitHub uses [令牌](https://docs.github.com/zh/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
  for Simplified Chinese credentials; Microsoft uses
  [權杖](https://learn.microsoft.com/zh-tw/entra/identity-platform/id-tokens) in Traditional
  Chinese; GitHub uses
  [トークン](https://docs.github.com/ja/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
  in Japanese.
- The public [VS Code localization repository](https://github.com/microsoft/vscode-loc) publishes
  Microsoft-managed language packs and accepts translation feedback through GitHub issues. Its
  Simplified Chinese, Traditional Chinese, and Japanese catalogs provide comparison evidence for
  marketplace, connector, shell, and other developer-tool terminology.
- Japanese marketplace usage has two established spellings: AWS uses
  [マーケットプレイス](https://docs.aws.amazon.com/ja_jp/marketplace/latest/buyerguide/create-your-private-marketplace.html),
  while Microsoft uses
  [マーケットプレース](https://learn.microsoft.com/ja-jp/marketplace/what-is-commercial-marketplace).
  Open Science therefore records its selected spelling instead of claiming universal consensus.

These sources establish native-language candidates. The confirmed Open Science product decision
is the final authority where the sources vary.

## Candidate and final terminology

| English term         | zh-Hans candidates   | zh-Hant candidates      | ja candidates                                  | Final choice (zh-Hans / zh-Hant / ja)    | Why this choice                                                                                                                                    |
| -------------------- | -------------------- | ----------------------- | ---------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skill / Skills       | 技能, Skill, 技巧    | 技能, Skill, 技巧       | スキル, Skill                                  | 技能 / 技能 / スキル                     | GitHub's localized AI documentation uses these native generic nouns, and the product owner confirmed them. Exact identifiers remain English.       |
| Agent / Agents       | 智能体, 代理, Agent  | 智能體, 代理程式, Agent | エージェント, Agent                            | 智能体 / 智能體 / エージェント           | 智能体 distinguishes an AI actor from software proxies in Chinese; Japanese community usage converges on エージェント.                             |
| Main Agent           | 主智能体, 主要智能体 | 主智能體, 主要智能體    | メインエージェント, 主エージェント             | 主智能体 / 主智能體 / メインエージェント | Treat the role name as a complete localized compound; the short `Main` label expands to the same term.                                             |
| Subagent / Subagents | 子智能体, 子 Agent   | 子智能體, 子 Agent      | サブエージェント, サブ Agent                   | 子智能体 / 子智能體 / サブエージェント   | Matches each locale's selected Agent term and reads naturally as a role label.                                                                     |
| Notebook             | Notebook, 笔记本     | Notebook, 筆記本        | Notebook, ノートブック                         | Notebook / Notebook / Notebook           | Fixed feature name; retaining it avoids the paper-notebook reading in Chinese.                                                                     |
| token (model usage)  | 词元, token, 标记    | 詞元, token, 語彙基元   | トークン, token                                | 词元 / 詞元 / トークン                   | Official model documentation supports the selected native terms; this meaning covers input, output, cache, context, and usage counts.              |
| token (credential)   | 令牌, token          | 權杖, token, 令牌       | トークン, token                                | 令牌 / 權杖 / トークン                   | Credential terminology follows localized GitHub and Microsoft authentication documentation.                                                        |
| Shell                | 命令行, Shell, 终端  | 命令列, Shell, 終端機   | シェル, コマンドライン, Shell                  | 命令行 / 命令列 / シェル                 | Chinese prioritizes a clear user-facing label; Japanese uses its established technical transliteration. `Notebook` remains unchanged in compounds. |
| Specialist           | 专家, 专业智能体     | 專家, 專業智能體        | スペシャリスト, 専門エージェント               | 专家 / 專家 / スペシャリスト             | Short, established generic role terms fit dense UI.                                                                                                |
| Marketplace          | 市场, 应用市场       | 市集, 應用市集          | マーケットプレイス, マーケットプレース, ストア | 市场 / 市集 / マーケットプレイス         | Translate the generic discovery surface; Japanese sources split, so Open Science selects one documented spelling consistently.                     |
| Connector            | 连接器, 连接项       | 連接器, 連線項目        | コネクタ, 接続                                 | 连接器 / 連接器 / コネクタ               | Established generic domain terms; exact directory and product names remain unchanged.                                                              |

## Identifier exceptions

File names, extensions, commands, paths, protocol identifiers, API fields, code spans, URLs, and
fixed proper names recorded in the retained glossary are not rewritten merely because they contain
one of these words. Examples include `SKILL.md`, `.skill`, `skill://`, `.agents/skills`,
`AGENTS.md`, `ssh-agent`, `setup-token`, `max_tokens`, `specialist.json`,
`openscience-specialist-template.zip`, `Specialist Marketplace protocol`, and
`Claude Connectors Directory`.

## Decision tree

```text
Does the text name a file, extension, command, path, protocol/API identifier, URL, or a fixed proper
name recorded in the retained glossary?
├─ Yes → Retain the exact identifier or proper name.
└─ No
   ├─ Is the term Notebook?
   │  └─ Yes → Retain Notebook in every locale.
   ├─ Is the term token?
   │  ├─ Authentication credential → 令牌 / 權杖 / トークン.
   │  └─ Model input, output, context, or usage → 词元 / 詞元 / トークン.
   ├─ Is it Skill, Agent, Shell, or a compound containing one of them?
   │  └─ Yes → Use the complete native term from the final-choice table.
   ├─ Is it another generic role, surface, or domain noun listed above?
   │  └─ Yes → Translate independently for zh-Hans, zh-Hant, and ja.
   └─ No → Record candidates and defer until evidence or product context resolves it.

Compound examples:
Main Agent → 主智能体 / 主智能體 / メインエージェント
Subagent → 子智能体 / 子智能體 / サブエージェント
Notebook shell → Notebook 命令行 / Notebook 命令列 / Notebook シェル
```
