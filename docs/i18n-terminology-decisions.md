# Localization terminology decisions

This document records the August 2026 review of English nouns that were still visible in the
Simplified Chinese, Traditional Chinese, or Japanese interface. It complements the binding catalog
rules in [`i18n-glossary.md`](i18n-glossary.md).

## Evidence used

The review uses maintained localization projects and official localized documentation as evidence
of established technical usage, rather than translating the words literally:

- The public [VS Code localization repository](https://github.com/microsoft/vscode-loc) publishes
  Microsoft-managed language packs and accepts translation feedback through GitHub issues. Its
  [Simplified Chinese](https://github.com/microsoft/vscode-loc/blob/main/i18n/vscode-language-pack-zh-hans/translations/main.i18n.json),
  [Traditional Chinese](https://github.com/microsoft/vscode-loc/blob/main/i18n/vscode-language-pack-zh-hant/translations/main.i18n.json),
  and [Japanese](https://github.com/microsoft/vscode-loc/blob/main/i18n/vscode-language-pack-ja/translations/main.i18n.json)
  catalogs expose community-reviewed marketplace, shell, skill, and agent terminology, including
  places where the locales deliberately differ.
- [GitHub Docs in Simplified Chinese](https://docs.github.com/zh/copilot/concepts/agents/about-agent-skills)
  and [Japanese](https://docs.github.com/ja/copilot/concepts/agents/about-agent-skills) translate
  generic agent/skill concepts as 智能体 / 技能 and エージェント / スキル.
- Japanese marketplace usage has two established spellings: AWS uses
  [マーケットプレイス](https://docs.aws.amazon.com/ja_jp/marketplace/latest/buyerguide/create-your-private-marketplace.html),
  while Microsoft uses
  [マーケットプレース](https://learn.microsoft.com/ja-jp/marketplace/what-is-commercial-marketplace).
  The choice below is therefore a product consistency decision, not a claim that one spelling is
  universally correct.

These sources establish candidate language, but the Open Science product glossary remains the
final authority for first-class feature names.

### Evidence by term

| Term                | Locale evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Product resolution                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Skill / Agent       | GitHub's Chinese and Japanese Copilot documentation uses 技能 / 智能体 and スキル / エージェント; VS Code language packs also vary by context.                                                                                                                                                                                                                                                                                                                                  | External usage does not converge across Chinese contexts. Open Science retains the existing English feature names in every locale.        |
| Notebook            | Literal candidates include 笔记本, 筆記本, and ノートブック; [Jupyter Notebook](https://jupyter-notebook.readthedocs.io/en/stable/) supplies the product-category naming reference rather than a locale consensus.                                                                                                                                                                                                                                                              | Treat this as a product naming decision: retain the existing Open Science feature name and avoid the paper-notebook reading in Chinese.   |
| token (model usage) | Microsoft model documentation uses mixed terms: the [Simplified Chinese reference](https://learn.microsoft.com/zh-cn/azure/foundry/openai/reference) mixes 代币, 令牌, 标记, and raw `token` field names; the [Traditional Chinese transparency note](https://learn.microsoft.com/zh-tw/azure/foundry/responsible-ai/openai/transparency-note) defines 代幣; Japanese uses [トークン](https://learn.microsoft.com/ja-jp/azure/foundry/responsible-ai/openai/transparency-note). | No cross-locale consensus is asserted. Retaining compact lowercase `token` in dense usage displays is an explicit product-style decision. |
| token (credential)  | GitHub uses [令牌](https://docs.github.com/zh/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) in Simplified Chinese; Microsoft uses [權杖](https://learn.microsoft.com/zh-tw/entra/identity-platform/id-tokens) in Traditional Chinese; GitHub uses [トークン](https://docs.github.com/ja/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) in Japanese.                                      | Adopt 令牌 / 權杖 for Chinese credentials. Keep the product's existing lowercase `token` style in Japanese.                               |
| Specialist          | GitHub uses [专家](https://docs.github.com/zh/copilot/tutorials/customization-library/custom-agents/your-first-custom-agent) and [スペシャリスト](https://docs.github.com/ja/copilot/tutorials/customization-library/custom-agents/your-first-custom-agent); Microsoft uses [專家](https://learn.microsoft.com/zh-tw/shows/copilot-learning-hub/building-ai-agents-with-microsoft-azure-insights-from-the-experts).                                                             | Use the established generic role term independently in each locale.                                                                       |
| Marketplace         | VS Code uses 市场 / 市集; Microsoft also uses [市集](https://learn.microsoft.com/zh-tw/marketplace/what-is-commercial-marketplace). Japanese sources split between マーケットプレイス and マーケットプレース.                                                                                                                                                                                                                                                                   | Use 市场 / 市集 and select the established AWS spelling マーケットプレイス; retain either spelling inside exact product names.            |
| Connector           | Microsoft documentation uses [连接器](https://learn.microsoft.com/zh-cn/connectors/custom-connectors/), [連接器](https://learn.microsoft.com/zh-tw/connectors/), and [コネクタ](https://learn.microsoft.com/ja-jp/connectors/connectors).                                                                                                                                                                                                                                       | Use those exact generic domain terms.                                                                                                     |
| Shell               | VS Code usage keeps `Shell` or `shell` in Simplified Chinese, sometimes uses 殼層 in Traditional Chinese, and consistently uses シェル in Japanese.                                                                                                                                                                                                                                                                                                                             | Retain the precise technical term `Shell` in both Chinese catalogs and use シェル in Japanese.                                            |
| Main Agent          | This is a product compound rather than an independent community term.                                                                                                                                                                                                                                                                                                                                                                                                           | Translate the qualifier and apply the mandatory retained `Agent` spelling.                                                                |

## Candidate and final terminology

| English term        | zh-Hans candidates   | zh-Hant candidates   | ja candidates                                  | Final choice (zh-Hans / zh-Hant / ja) | Decision                                                                                                                                         |
| ------------------- | -------------------- | -------------------- | ---------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Skill / Skills      | Skill, 技能          | Skill, 技能          | Skill, スキル                                  | Skill / Skill / Skill                 | Retain the first-class Open Science feature name and preserve interoperability with package metadata and documentation.                          |
| Agent               | Agent, 智能体, 代理  | Agent, 代理程式      | Agent, エージェント                            | Agent / Agent / Agent                 | Community sources do not converge on one Chinese term; retain the first-class product name in all locales.                                       |
| Notebook            | Notebook, 笔记本     | Notebook, 筆記本     | Notebook, ノートブック                         | Notebook / Notebook / Notebook        | Retain the feature name and avoid the paper-notebook meaning in Chinese.                                                                         |
| token (model usage) | token, 词元          | token, 詞元          | token, トークン                                | token / token / token                 | Retain the compact technical term used in model context and usage displays.                                                                      |
| token (credential)  | 令牌, token          | 權杖, token          | token, トークン                                | 令牌 / 權杖 / token                   | Use the established Chinese credential terms; retain the existing Japanese technical spelling.                                                   |
| Specialist          | 专家, 专业 Agent     | 專家, 專業 Agent     | スペシャリスト, 専門 Agent                     | 专家 / 專家 / スペシャリスト          | This is a generic role, and each final term is already established in the corresponding catalog or official technical documentation.             |
| Marketplace         | 市场, 应用市场       | 市集, 應用市集       | マーケットプレイス, マーケットプレース, ストア | 市场 / 市集 / マーケットプレイス      | Translate the generic discovery surface. Japanese sources split; select the established AWS spelling and retain exact product names.             |
| Connector           | 连接器, 连接项       | 連接器, 連線項目     | コネクタ, 接続                                 | 连接器 / 連接器 / コネクタ            | The project glossary already defines it as a generic domain noun. Proper directory names such as `Claude Connectors Directory` remain unchanged. |
| Shell               | Shell, 命令行        | Shell, 命令列        | シェル, Shell                                  | Shell / Shell / シェル                | Chinese technical usage keeps the precise shell concept; Japanese has an unambiguous established transliteration.                                |
| Main Agent          | 主 Agent, 主要 Agent | 主 Agent, 主要 Agent | メイン Agent, 主 Agent                         | 主 Agent / 主 Agent / メイン Agent    | Localize the role qualifier while retaining the mandatory `Agent` feature name. The short label `Main` expands to this full localized role.      |

File names, package names, protocol identifiers, URLs, and third-party product names are never
rewritten merely because they contain one of these words. Examples include `specialist.json`,
`openscience-specialist-template.zip`, `Specialist Marketplace protocol`, and
`Claude Connectors Directory`.

## Decision tree

```text
Does the text name a file, package, protocol identifier, URL, model, or third-party product?
├─ Yes → Retain the exact identifier or proper name.
└─ No
   └─ Is it a first-class Open Science feature with a mandatory glossary spelling?
      ├─ Yes → Retain Skill, Agent, Notebook, or model-usage token exactly.
      └─ No
         └─ Is it a generic role, surface, or domain noun with established locale usage?
            ├─ Yes → Translate independently in zh-Hans, zh-Hant, and ja.
            └─ No → Record candidates and defer until evidence or product context resolves it.

For compound labels, apply the tree to each part:
Main Agent → localize Main + retain Agent → 主 Agent / 主 Agent / メイン Agent.
```
